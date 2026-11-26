/**
 * Chat Controller — orchestrates the sidebar chat lifecycle.
 *
 * Manages port connections from the sidebar, session caching via TabStateManager,
 * content extraction, AI summarization with streaming, follow-up Q&A, abort,
 * and retry logic.
 *
 * All external dependencies are injected via the options object for testability.
 */

import type { Settings, TabState, Conversation, ConversationMessage, ExtractedArticle, ContextTabSnapshot } from "@shared/types";
import type {
  SidebarToControllerMessage,
  ControllerToSidebarMessage,
  PortConversationMessage,
} from "@shared/port-protocol";
import { isSidebarToControllerMessage } from "@shared/port-protocol";
import type { ExtractionResult } from "@content/extractor/extract";
import type { TabStateManager } from "@background/tab-state";
import type { SecureStore } from "@background/secure-store";
import type {
  StreamingAiClient,
  StreamingClientOptions,
  ChatMessage,
} from "./streaming-client";
import { fitConversationToBudget, fitArticlesToBudget, computeBudgetChars, computeArticleBudgetChars, DEFAULT_CONTEXT_WINDOW_TOKENS } from "./context-budget";
import { shortenLinkUrls } from "./link-shortener";
import type { Logger } from "@shared/logger";
import { noopLogger } from "@shared/logger";

// ---------------------------------------------------------------------------
// Public Interface
// ---------------------------------------------------------------------------

export interface ChatController {
  /** Handle a new port connection from the sidebar. */
  handleConnect(port: Port): void;
}

export interface CreateChatControllerOptions {
  readonly getSettings: () => Promise<Settings>;
  readonly getSecureStore: () => SecureStore;
  readonly extractContent: (tabId: number, selector?: string) => Promise<ExtractionResult>;
  readonly createStreamingClient: (opts: StreamingClientOptions) => StreamingAiClient;
  readonly tabState: TabStateManager;
  readonly hasSavedPattern?: (url: string) => Promise<boolean>;
  readonly queryOpenTabs?: () => Promise<ReadonlyArray<{ readonly tabId: number; readonly title: string; readonly url: string }>>;
  readonly clock?: () => string; // ISO timestamp
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Port abstraction (matches browser.runtime.Port shape)
// ---------------------------------------------------------------------------

export interface Port {
  readonly name: string;
  postMessage(msg: ControllerToSidebarMessage): void;
  onMessage: {
    addListener(cb: (msg: unknown) => void): void;
    removeListener(cb: (msg: unknown) => void): void;
  };
  onDisconnect: {
    addListener(cb: () => void): void;
    removeListener(cb: () => void): void;
  };
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface ContextTabEntry {
  readonly url: string;
  readonly title: string;
  content: string | null;
  readonly confidence: "high" | "medium" | "low" | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PAGE_CONTENT_CHARS = 50_000;

/** Fixed text around page content in Q&A — counted by the CF-3.9 budget. */
const PAGE_CONTEXT_PREFIX = "Here is the page content for context:\n\n";
const PAGE_CONTEXT_ACK = "I've read the page content. How can I help you?";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatController(opts: CreateChatControllerOptions): ChatController {
  const { getSettings, getSecureStore, extractContent, createStreamingClient, tabState } = opts;
  const hasSavedPattern = opts.hasSavedPattern ?? (async () => false);
  const queryOpenTabs = opts.queryOpenTabs ?? (async () => []);
  const clock = opts.clock ?? (() => new Date().toISOString());
  const logger = opts.logger ?? noopLogger;

  return {
    handleConnect(port: Port): void {
      let currentTabId: number | null = null;
      let abortController: AbortController | null = null;
      let lastUserMessage: string | null = null;
      // Map of tabId → context entry (replaces single pageContent variable)
      const contextTabs = new Map<number, ContextTabEntry>();
      const send = (msg: ControllerToSidebarMessage): void => {
        port.postMessage(msg);
      };

      const onMessage = (raw: unknown): void => {
        if (!isSidebarToControllerMessage(raw)) return;
        const msg = raw as SidebarToControllerMessage;

        switch (msg.type) {
          case "init":
            handleInit(msg.tabId, (msg as { url?: string }).url);
            break;
          case "summarize":
            handleSummarize();
            break;
          case "sendMessage":
            handleSendMessage(msg.text);
            break;
          case "abort":
            handleAbort();
            break;
          case "retry":
            handleRetry();
            break;
          case "addContextTab":
            handleAddContextTab((msg as { tabId: number }).tabId);
            break;
          case "removeContextTab":
            handleRemoveContextTab((msg as { tabId: number }).tabId);
            break;
          case "getOpenTabs":
            handleGetOpenTabs();
            break;
          default:
            break;
        }
      };

      const onDisconnect = (): void => {
        // Cancel any in-flight request when port disconnects
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      };

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);

      // -----------------------------------------------------------------------
      // init handler
      // -----------------------------------------------------------------------

      // Restores previously-added secondary context tabs (SF-1) from a
      // persisted snapshot — content is left null and lazily re-extracted
      // on demand (ensureContextContent), same as the primary tab restore.
      // Must run AFTER the mode-establishing message (freeChatReady /
      // conversationRestored) so the sidebar doesn't wipe these chips via
      // its own "start of a fresh session" reset logic.
      function restoreContextTabs(snapshots: ReadonlyArray<ContextTabSnapshot> | undefined): void {
        for (const snap of snapshots ?? []) {
          contextTabs.set(snap.tabId, { url: snap.url, title: snap.title, content: null, confidence: snap.confidence });
          send({ type: "contextTabAdded", tabId: snap.tabId, url: snap.url, title: snap.title, confidence: snap.confidence });
        }
      }

      // Persists the current in-memory context-tab set (minus the primary
      // tab, which is the TabState entry itself) so it survives a reconnect.
      function persistContextTabs(): void {
        if (currentTabId === null) return;
        if (!tabState.has(currentTabId)) return;
        const snapshot: ContextTabSnapshot[] = [];
        for (const [tabId, ctx] of contextTabs) {
          if (tabId === currentTabId) continue;
          snapshot.push({ tabId, url: ctx.url, title: ctx.title, confidence: ctx.confidence });
        }
        tabState.update(currentTabId, { contextTabs: snapshot });
      }

      async function handleInit(tabId: number, initUrl?: string): Promise<void> {
        currentTabId = tabId;
        contextTabs.clear();

        // Cancel any in-flight request from a previous page
        if (abortController) {
          abortController.abort();
          abortController = null;
        }

        // Special case: about:blank → free-chat mode (no page, no extraction)
        if (initUrl === "about:blank") {
          const cached = tabState.get(tabId);
          if (cached && cached.url === "about:blank") {
            // Restore cached free-chat conversation
            const messages: PortConversationMessage[] = cached.conversation.messages.map((m) => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              isPartial: m.isPartial,
              model: m.model,
            }));
            send({ type: "freeChatReady", messages });
            restoreContextTabs(cached.contextTabs);
            return;
          }

          // New free-chat session
          if (cached) {
            tabState.remove(tabId);
          }
          const now = clock();
          const conversation: Conversation = {
            tabId,
            url: "about:blank",
            title: "Chat",
            messages: [],
            createdAt: now,
            updatedAt: now,
          };
          tabState.set(tabId, {
            url: "about:blank",
            title: "Chat",
            summary: null,
            conversation,
            extractionConfidence: null,
            consecutiveFailures: 0,
          });

          send({ type: "freeChatReady" });

          const settings = await getSettings();
          if (!settings.ai.baseUrl || !settings.ai.modelId) {
            send({ type: "configError", reason: "AI not configured. Set the base URL and model in Settings to enable chat." });
          }
          return;
        }

        // Check for cached session — restore if URL matches or if caller didn't provide a URL
        const cached = tabState.get(tabId);
        if (cached && (!initUrl || cached.url === initUrl)) {
          // URL matches — restore cached session
          const messages: PortConversationMessage[] = cached.conversation.messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            isPartial: m.isPartial,
            model: m.model,
          }));

          send({ type: "conversationRestored", messages });
          // Rebuild context tab entry for the cached session (content lazily re-extracted on demand)
          contextTabs.set(tabId, { url: cached.url, title: cached.title, content: null, confidence: cached.extractionConfidence });
          send({ type: "contextTabAdded", tabId, url: cached.url, title: cached.title, confidence: cached.extractionConfidence });
          restoreContextTabs(cached.contextTabs);
          return;
        }

        // URL changed or no cache — discard old session if exists
        if (cached) {
          tabState.remove(tabId);
        }

        // No cached session (or URL changed) — trigger extraction
        const settings = await getSettings();

        // Small delay to let the page's content script fully initialize after navigation
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Extract content (always — needed for export even without AI)
        let extractionResult: ExtractionResult;
        try {
          extractionResult = await extractContent(tabId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Content extraction failed";
          logger.warn("Extraction threw for tab", tabId, reason);
          send({ type: "contextError", reason, canRetry: true });
          return;
        }

        if (!extractionResult.ok) {
          logger.warn("Extraction failed for tab", tabId, extractionResult.reason, extractionResult.detail);
          send({
            type: "contextError",
            reason: extractionResult.detail,
            canRetry: true,
          });
          return;
        }

        const article = extractionResult.article;
        logger.debug("Extraction succeeded for tab", tabId, `confidence=${extractionResult.confidence}`, `chars=${article.bodyCharacterCount}`);
        const content = shortenLinkUrls(article.bodyMarkdown).slice(0, MAX_PAGE_CONTENT_CHARS);

        contextTabs.set(tabId, { url: article.sourceUrl, title: article.title, content, confidence: extractionResult.confidence });

        const patternExists = await hasSavedPattern(article.sourceUrl);
        send({ type: "contextLoaded", title: article.title, url: article.sourceUrl, confidence: extractionResult.confidence, hasSavedPattern: patternExists, wordCount: Math.round(article.bodyCharacterCount / 5) });

        // Initialize tab state
        const now = clock();
        const conversation: Conversation = {
          tabId,
          url: article.sourceUrl,
          title: article.title,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };

        const newState: TabState = {
          url: article.sourceUrl,
          title: article.title,
          summary: null,
          conversation,
          extractionConfidence: extractionResult.confidence,
          consecutiveFailures: 0,
        };

        tabState.set(tabId, newState);

        // Warn early if AI is unconfigured so the user knows before clicking Summarize
        if (!settings.ai.baseUrl || !settings.ai.modelId) {
          send({ type: "configError", reason: "AI not configured. Extraction and export are available. Set the base URL and model in Settings to enable summaries and Q&A." });
        }
      }

      // -----------------------------------------------------------------------
      // Context tab management handlers
      // -----------------------------------------------------------------------

      async function handleAddContextTab(tabId: number): Promise<void> {
        // Don't add a tab that's already in context
        if (contextTabs.has(tabId)) return;

        let tabUrl = "";
        let tabTitle = "";
        try {
          // Get URL/title from the open tabs list (requires queryOpenTabs)
          const openTabs = await queryOpenTabs();
          const found = openTabs.find((t) => t.tabId === tabId);
          if (found) {
            tabUrl = found.url;
            tabTitle = found.title;
          }
        } catch {
          // Will be filled in from extraction result
        }

        let extractionResult: ExtractionResult;
        try {
          extractionResult = await extractContent(tabId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Content extraction failed";
          logger.warn("Context tab extraction threw for tab", tabId, reason);
          send({
            type: "contextTabFailed",
            tabId,
            url: tabUrl,
            title: tabTitle || `Tab ${tabId}`,
            reason,
          });
          return;
        }

        if (!extractionResult.ok) {
          logger.warn("Context tab extraction failed for tab", tabId, extractionResult.reason, extractionResult.detail);
          send({
            type: "contextTabFailed",
            tabId,
            url: tabUrl,
            title: tabTitle || `Tab ${tabId}`,
            reason: extractionResult.detail,
          });
          return;
        }

        const article = extractionResult.article;
        const content = shortenLinkUrls(article.bodyMarkdown).slice(0, MAX_PAGE_CONTENT_CHARS);
        contextTabs.set(tabId, { url: article.sourceUrl, title: article.title, content, confidence: extractionResult.confidence });
        send({ type: "contextTabAdded", tabId, url: article.sourceUrl, title: article.title, confidence: extractionResult.confidence });
        persistContextTabs();
      }

      function handleRemoveContextTab(tabId: number): void {
        contextTabs.delete(tabId);
        send({ type: "contextTabRemoved", tabId });
        persistContextTabs();
      }

      async function handleGetOpenTabs(): Promise<void> {
        const tabs = await queryOpenTabs();
        send({ type: "openTabs", tabs });
      }

      // -----------------------------------------------------------------------
      // Build context articles from current contextTabs
      // -----------------------------------------------------------------------

      async function ensureContextContent(): Promise<void> {
        for (const [tabId, ctx] of contextTabs) {
          if (ctx.content === null) {
            try {
              const result = await extractContent(tabId);
              if (result.ok) {
                ctx.content = shortenLinkUrls(result.article.bodyMarkdown).slice(0, MAX_PAGE_CONTENT_CHARS);
              }
            } catch {
              // Continue without content for this tab
            }
          }
        }
      }

      function buildContextArticles(): ExtractedArticle[] {
        const articles: ExtractedArticle[] = [];
        for (const ctx of contextTabs.values()) {
          if (ctx.content) {
            articles.push({
              title: ctx.title,
              sourceUrl: ctx.url,
              bodyMarkdown: ctx.content,
              author: null,
              publicationDate: null,
              siteName: "",
              bodyCharacterCount: ctx.content.length,
            });
          }
        }
        return articles;
      }

      // -----------------------------------------------------------------------
      // summarize handler (user-triggered)
      // -----------------------------------------------------------------------

      async function handleSummarize(): Promise<void> {
        if (currentTabId === null) return;

        const settings = await getSettings();

        if (!settings.ai.baseUrl || !settings.ai.modelId) {
          send({ type: "configError", reason: "AI not configured. Set the base URL and model in Settings." });
          return;
        }

        if (contextTabs.size === 0) {
          send({ type: "streamError", reason: "No page context loaded. Add a tab to the context before summarizing.", partialContent: "", canRetry: false });
          return;
        }

        await ensureContextContent();
        const articles = buildContextArticles();

        if (articles.length === 0) {
          send({ type: "streamError", reason: "Could not extract content from the context tabs.", partialContent: "", canRetry: false });
          return;
        }

        await streamSummarization(settings, articles);
      }

      // -----------------------------------------------------------------------
      // Summarization streaming
      // -----------------------------------------------------------------------

      async function streamSummarization(
        settings: Settings,
        articles: ExtractedArticle[],
      ): Promise<void> {
        if (currentTabId === null) return;

        const secureStore = getSecureStore();
        const apiKey = settings.ai.apiKeyRef
          ? await secureStore.getSecret(settings.ai.apiKeyRef)
          : null;

        const client = createStreamingClient({
          baseUrl: settings.ai.baseUrl,
          provider: settings.ai.provider,
          apiKey: apiKey ?? "",
          contextWindowTokens: settings.ai.contextWindowTokens,
          logger,
        });

        const budgetChars = getBudgetChars(settings);
        // CF-3.9: bodies only get what's left after the system prompt text and
        // the summarize instruction (both measured with bodies emptied — the
        // instruction already carries each article's title/URL framing).
        const bodilessArticles = articles.map((a) => ({ ...a, bodyMarkdown: "" }));
        const fixedChars =
          buildSystemPrompt(settings, articles.length).length +
          buildSummarizationUserMessage(bodilessArticles).length;
        const articleBudgetChars = computeArticleBudgetChars(budgetChars, fixedChars);
        const { articles: keptArticles, contextTruncated } = fitArticlesToBudget(articles, articleBudgetChars);
        if (contextTruncated) {
          logger.debug(
            "CF-3.9: shortened page content to fit the budget",
            `articles=${articles.length}`,
            `budgetChars=${budgetChars}`,
            `articleBudgetChars=${articleBudgetChars}`,
          );
        }

        const systemPrompt = buildSystemPrompt(settings, keptArticles.length);

        const userContent = buildSummarizationUserMessage(keptArticles);

        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ];

        abortController = new AbortController();

        send({ type: "streamStart", contextTruncated });

        const result = await client.streamChatCompletion({
          model: settings.ai.modelId,
          messages,
          signal: abortController.signal,
          onToken: (token) => {
            send({ type: "streamToken", token });
          },
        });

        abortController = null;

        if (result.ok) {
          send({ type: "streamEnd", fullContent: result.content, model: settings.ai.modelId });

          // Update tab state with summary
          if (currentTabId !== null) {
            const now = clock();
            const assistantMsg: ConversationMessage = {
              role: "assistant",
              content: result.content,
              timestamp: now,
              model: settings.ai.modelId,
            };

            const state = tabState.get(currentTabId);
            if (state) {
              tabState.update(currentTabId, {
                summary: result.content,
                conversation: {
                  ...state.conversation,
                  messages: [...state.conversation.messages, assistantMsg],
                  updatedAt: now,
                },
                consecutiveFailures: 0,
              });
            }
          }
        } else {
          if (result.reason === "aborted") {
            // Retain partial content on abort
            send({ type: "streamEnd", fullContent: result.partialContent, model: settings.ai.modelId });
            if (currentTabId !== null) {
              const state = tabState.get(currentTabId);
              if (state && result.partialContent) {
                const now = clock();
                tabState.update(currentTabId, {
                  summary: result.partialContent,
                  conversation: {
                    ...state.conversation,
                    messages: [
                      ...state.conversation.messages,
                      { role: "assistant", content: result.partialContent, timestamp: now, isPartial: true, model: settings.ai.modelId },
                    ],
                    updatedAt: now,
                  },
                });
              }
            }
          } else {
            // Same accounting as the Q&A path: increment first, then decide —
            // the third consecutive failure disables retry (CF-3.3)
            incrementFailures();
            const canRetry = getConsecutiveFailures() < MAX_CONSECUTIVE_FAILURES;
            logger.warn("Summarize stream failed", result.reason, result.detail, `canRetry=${canRetry}`);
            if (!canRetry) {
              logger.warn("Retry exhausted after 3 consecutive failures (summarize)");
            }
            send({
              type: "streamError",
              reason: result.detail,
              partialContent: result.partialContent,
              canRetry,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // sendMessage handler
      // -----------------------------------------------------------------------

      async function handleSendMessage(text: string): Promise<void> {
        lastUserMessage = text;
        await doSendMessage(text, false);
      }

      async function doSendMessage(text: string, isRetry: boolean): Promise<void> {
        if (currentTabId === null) return;

        const settings = await getSettings();

        // Check AI configuration
        if (!settings.ai.baseUrl || !settings.ai.modelId) {
          logger.debug("Q&A blocked: AI endpoint not configured");
          send({ type: "configError", reason: "AI endpoint not configured. Please set the base URL and model ID in Settings." });
          return;
        }

        const secureStore = getSecureStore();
        const apiKey = settings.ai.apiKeyRef
          ? await secureStore.getSecret(settings.ai.apiKeyRef)
          : null;

        const client = createStreamingClient({
          baseUrl: settings.ai.baseUrl,
          provider: settings.ai.provider,
          apiKey: apiKey ?? "",
          contextWindowTokens: settings.ai.contextWindowTokens,
          logger,
        });

        // Ensure context tab content is loaded (lazy re-extraction for cached sessions)
        await ensureContextContent();
        const articles = buildContextArticles();

        const budgetChars = getBudgetChars(settings);
        // CF-3.9: bodies only get what's left after the system prompt text and
        // the new user message (history is trimmed separately, CF-3.8).
        // The bodies travel in a separate page-context message: a fixed prefix,
        // an assistant acknowledgement, and per-article title/URL framing.
        const pageContextFixedChars = articles.length > 0
          ? PAGE_CONTEXT_PREFIX.length + PAGE_CONTEXT_ACK.length
          : 0;
        const fixedChars = buildSystemPrompt(settings, articles.length).length + text.length + pageContextFixedChars;
        const articleBudgetChars = computeArticleBudgetChars(budgetChars, fixedChars, articles);
        const { articles: keptArticles, contextTruncated } = fitArticlesToBudget(articles, articleBudgetChars);
        if (contextTruncated) {
          logger.debug(
            "CF-3.9: shortened page content to fit the budget",
            `articles=${articles.length}`,
            `budgetChars=${budgetChars}`,
            `articleBudgetChars=${articleBudgetChars}`,
          );
        }

        // Build context messages
        const systemPrompt = buildSystemPrompt(settings, keptArticles.length);

        const contextMessages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
        ];

        // Add the page content as context
        if (keptArticles.length > 0) {
          let pageContextText: string;
          if (keptArticles.length === 1) {
            pageContextText = `${PAGE_CONTEXT_PREFIX}${keptArticles[0].bodyMarkdown}`;
          } else {
            const combined = keptArticles
              .map((a, i) => `### Page ${i + 1}: ${a.title}\nURL: ${a.sourceUrl}\n\n${a.bodyMarkdown}`)
              .join("\n\n---\n\n");
            pageContextText = `${PAGE_CONTEXT_PREFIX}${combined}`;
          }
          contextMessages.push({ role: "user", content: pageContextText });
          contextMessages.push({ role: "assistant", content: PAGE_CONTEXT_ACK });
        }

        // Conversation history — collected separately (rather than pushed
        // straight into contextMessages) so it can be trimmed to fit the
        // configured context window (CF-3.8) without touching the system
        // prompt, page context, or the new message.
        const state = tabState.get(currentTabId);
        const historyMessages: ChatMessage[] = [];
        if (state) {
          for (const msg of state.conversation.messages) {
            historyMessages.push({
              role: msg.role === "user" ? "user" : "assistant",
              content: msg.content,
            });
          }
        }

        // The new user message — unless this is a retry and the failed
        // attempt already recorded it as the last history entry, in which
        // case historyMessages already includes it (CF-3.2)
        const lastHistory = state?.conversation.messages[state.conversation.messages.length - 1];
        const alreadyInContext = isRetry && lastHistory?.role === "user" && lastHistory.content === text;
        // On a retry the recorded message IS the new message: pin it (CF-3.8 —
        // never droppable) instead of leaving it in the trimmable history.
        if (alreadyInContext) historyMessages.pop();
        const pinnedAfter: ChatMessage[] = [{ role: "user", content: text }];

        const { messages: budgetedMessages, historyTruncated } = fitConversationToBudget(
          contextMessages,
          historyMessages,
          pinnedAfter,
          budgetChars,
        );
        if (historyTruncated) {
          logger.debug(
            "CF-3.8: dropped oldest conversation turns to fit the budget",
            `kept=${budgetedMessages.length - contextMessages.length - pinnedAfter.length}/${historyMessages.length}`,
            `budgetChars=${budgetChars}`,
          );
        }

        // Record user message in state (only for new messages, not retries)
        if (!isRetry && state) {
          const now = clock();
          const userMsg: ConversationMessage = {
            role: "user",
            content: text,
            timestamp: now,
          };
          tabState.update(currentTabId, {
            conversation: {
              ...state.conversation,
              messages: [...state.conversation.messages, userMsg],
              updatedAt: now,
            },
            consecutiveFailures: 0,
          });
        }

        abortController = new AbortController();

        send({ type: "streamStart", historyTruncated, contextTruncated });

        const result = await client.streamChatCompletion({
          model: settings.ai.modelId,
          messages: budgetedMessages,
          signal: abortController.signal,
          onToken: (token) => {
            send({ type: "streamToken", token });
          },
        });

        abortController = null;

        if (result.ok) {
          send({ type: "streamEnd", fullContent: result.content, model: settings.ai.modelId });

          // Record assistant message in state
          if (currentTabId !== null) {
            const updatedState = tabState.get(currentTabId);
            if (updatedState) {
              const assistantMsg: ConversationMessage = {
                role: "assistant",
                content: result.content,
                timestamp: clock(),
                model: settings.ai.modelId,
              };
              tabState.update(currentTabId, {
                conversation: {
                  ...updatedState.conversation,
                  messages: [...updatedState.conversation.messages, assistantMsg],
                  updatedAt: clock(),
                },
                consecutiveFailures: 0,
              });
            }
          }
        } else {
          if (result.reason === "aborted") {
            // Retain partial content on abort
            send({ type: "streamEnd", fullContent: result.partialContent, model: settings.ai.modelId });
            if (currentTabId !== null) {
              const updatedState = tabState.get(currentTabId);
              if (updatedState && result.partialContent) {
                tabState.update(currentTabId, {
                  conversation: {
                    ...updatedState.conversation,
                    messages: [
                      ...updatedState.conversation.messages,
                      { role: "assistant", content: result.partialContent, timestamp: clock(), isPartial: true, model: settings.ai.modelId },
                    ],
                    updatedAt: clock(),
                  },
                });
              }
            }
          } else {
            incrementFailures();
            const canRetry = getConsecutiveFailures() < MAX_CONSECUTIVE_FAILURES;
            logger.warn("Q&A stream failed", result.reason, result.detail, `canRetry=${canRetry}`);
            if (!canRetry) {
              logger.warn("Retry exhausted after 3 consecutive failures (Q&A)");
            }
            send({
              type: "streamError",
              reason: result.detail,
              partialContent: result.partialContent,
              canRetry,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // abort handler
      // -----------------------------------------------------------------------

      function handleAbort(): void {
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
      }

      // -----------------------------------------------------------------------
      // retry handler
      // -----------------------------------------------------------------------

      async function handleRetry(): Promise<void> {
        if (currentTabId === null) return;

        const failures = getConsecutiveFailures();
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          // Retry disabled after 3 consecutive failures
          return;
        }

        if (lastUserMessage !== null) {
          // Re-send the last user message (as a retry, not a new message)
          await doSendMessage(lastUserMessage, true);
        } else {
          // Retry summarization
          const settings = await getSettings();
          if (!settings.ai.baseUrl || !settings.ai.modelId) {
            send({ type: "configError", reason: "AI endpoint not configured. Please set the base URL and model ID in Settings." });
            return;
          }

          await ensureContextContent();
          const articles = buildContextArticles();
          if (articles.length > 0) {
            await streamSummarization(settings, articles);
          } else {
            // Nothing to re-send and nothing to summarize — answer instead of
            // leaving the sidebar waiting (CF-3.3)
            send({
              type: "streamError",
              reason: "Nothing to retry — no page context is loaded.",
              partialContent: "",
              canRetry: false,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // clearConversation helper
      // -----------------------------------------------------------------------

      function clearConversation(): void {
        if (currentTabId === null) return;

        const state = tabState.get(currentTabId);
        if (state) {
          const now = clock();
          tabState.update(currentTabId, {
            summary: null,
            conversation: {
              ...state.conversation,
              messages: [],
              updatedAt: now,
            },
            consecutiveFailures: 0,
          });
        }

        // Notify sidebar that the conversation is now empty
        send({ type: "conversationRestored", messages: [] });
      }

      // -----------------------------------------------------------------------
      // Helpers
      // -----------------------------------------------------------------------

      function getConsecutiveFailures(): number {
        if (currentTabId === null) return 0;
        const state = tabState.get(currentTabId);
        return state?.consecutiveFailures ?? 0;
      }

      function incrementFailures(): void {
        if (currentTabId === null) return;
        const state = tabState.get(currentTabId);
        if (state) {
          tabState.update(currentTabId, {
            consecutiveFailures: state.consecutiveFailures + 1,
          });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Prompt budget in chars (CF-3.8/CF-3.9). Only the Ollama provider is
 * budgeted — Ollama silently truncates the front of an oversized prompt (and
 * is the one we send num_ctx to, CF-5.5). OpenAI-compatible servers report an
 * overflow explicitly, so they get an unlimited budget: nothing is trimmed,
 * shortened or flagged.
 */
function getBudgetChars(settings: Settings): number {
  if (settings.ai.provider !== "ollama") return Number.POSITIVE_INFINITY;
  return computeBudgetChars(settings.ai.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS);
}

/** The system prompt the controller sends: the user's custom prompt, else the default. */
function buildSystemPrompt(settings: Settings, articleCount: number): string {
  return settings.ai.systemPrompt || buildDefaultSystemPrompt(articleCount);
}

function buildDefaultSystemPrompt(articleCount: number): string {
  const sourceGuidance = articleCount > 1
    ? `\n\nYou have been given ${articleCount} separate web pages as context, each in its own "Page N" section below. Treat them as distinct sources: synthesize across them where relevant, but never refer to them collectively as "the article" — call them "these ${articleCount} articles" or refer to them by their individual titles.`
    : "";
  return `You are a helpful assistant that summarizes web page content. When summarizing, produce output with three sections:
- **Findings**: Key information and facts from the page
- **Key Points**: The most important takeaways
- **Action Items**: Suggested next steps or actions based on the content${sourceGuidance}

Format your response using Markdown bullet lists.`;
}

function buildSummarizationUserMessage(articles: ExtractedArticle[]): string {
  if (articles.length === 0) {
    return "Please summarize the provided content.";
  }
  if (articles.length === 1) {
    const a = articles[0];
    return `Please summarize the following web page:\n\nTitle: ${a.title}\nURL: ${a.sourceUrl}\n\nContent:\n${a.bodyMarkdown}`;
  }
  const pagesText = articles
    .map((a, i) => `## Page ${i + 1}: ${a.title}\nURL: ${a.sourceUrl}\n\n${a.bodyMarkdown}`)
    .join("\n\n---\n\n");
  return `Please summarize the following web pages:\n\n${pagesText}`;
}
