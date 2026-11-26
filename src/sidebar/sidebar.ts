/**
 * Sidebar entry point — vanilla TypeScript UI for the Distill chat interface.
 *
 * State machine: loading → no-page | free-chat | summarizing → ready → streaming → error → config-error
 * Connects to background via long-lived port ("chat") and exchanges typed port protocol messages.
 */

import { createActiveTabTracker, type ActiveTabTracker } from "./active-tab-tracker";
import { renderMarkdown } from "./markdown";
import {
  type ControllerToSidebarMessage,
  type SidebarToControllerMessage,
  type PortConversationMessage,
  isControllerToSidebarMessage,
} from "@shared/port-protocol";
import { isMessageOfKind, buildMessage } from "@shared/messages";
import { createLogger } from "@shared/logger";
import { PRODUCT_NAME, ASSISTANT_NAME } from "@shared/branding";

// ─── State Machine ───────────────────────────────────────────────────────────

type SidebarState =
  | { readonly phase: "loading" }
  | { readonly phase: "no-page" }
  | {
      readonly phase: "free-chat";
      readonly messages: ReadonlyArray<PortConversationMessage>;
      // Carried over from the request that just finished (CF-3.8/CF-3.9) so
      // the truncation notes stay visible after the reply completes.
      readonly historyTruncated?: boolean;
      readonly contextTruncated?: boolean;
    }
  | {
      readonly phase: "summarizing";
      readonly title: string;
      readonly partialContent: string;
      readonly returnPhase: "ready" | "free-chat";
      // Conversation already on screen when an (updated) summary was requested;
      // the new summary is appended to it rather than replacing it.
      readonly priorMessages: ReadonlyArray<PortConversationMessage>;
      // Set from streamStart's contextTruncated (CF-3.9) — page content was
      // shortened in the summarize request to fit the context window.
      readonly contextTruncated?: boolean;
    }
  | {
      readonly phase: "ready";
      readonly messages: ReadonlyArray<PortConversationMessage>;
      // Carried over from the request that just finished (CF-3.8/CF-3.9) so
      // the truncation notes stay visible after the reply completes.
      readonly historyTruncated?: boolean;
      readonly contextTruncated?: boolean;
    }
  | {
      readonly phase: "streaming";
      readonly messages: ReadonlyArray<PortConversationMessage>;
      readonly partial: string;
      readonly returnPhase: "ready" | "free-chat";
      // Set from streamStart's historyTruncated (CF-3.8) — surfaced as a
      // small note so trimming the oldest turns to fit the model's context
      // window is never silent.
      readonly historyTruncated?: boolean;
      // Set from streamStart's contextTruncated (CF-3.9) — page content was
      // shortened in this request to fit the context window.
      readonly contextTruncated?: boolean;
    }
  | {
      readonly phase: "error";
      readonly reason: string;
      readonly canRetry: boolean;
      readonly showPicker: boolean;
      // The conversation stays visible alongside the error (CF-3.3), and a
      // retried stream returns to the phase the failure came from.
      readonly messages: ReadonlyArray<PortConversationMessage>;
      readonly returnPhase: "ready" | "free-chat";
    }
  | { readonly phase: "config-error"; readonly reason: string };

// Display info for context tabs (subset of what the controller tracks)
interface ContextTabInfo {
  tabId: number;
  url: string;
  title: string;
  confidence: "high" | "medium" | "low" | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MESSAGE_CHAR_LIMIT = 2000;
const EXTENSION_VERSION = browser.runtime.getManifest().version;

// ─── Module State ────────────────────────────────────────────────────────────

let state: SidebarState = { phase: "loading" };
let port: ReturnType<typeof browser.runtime.connect> | null = null;
let tracker: ActiveTabTracker | null = null;
let currentTabId: number | null = null;
// The URL belonging to currentTabId specifically — NOT tracker.getActiveTabUrl(),
// which reports whatever tab currently has browser focus. Those diverge when a
// tab switch is skipped as a context-tab no-op (SF-1), so a reconnect replay
// must use this, or it can pair the wrong tab with the wrong URL and cause the
// background to wrongly treat currentTabId as having navigated away.
let currentTabUrl: string | undefined;
// True from the moment sendToController replays an "init" to resync a
// reconnected port (CF-3.6) until the controller answers it. The reply to
// that replayed init must not clobber whatever the user is already doing
// locally (e.g. a message they just hit Send on) — it's background
// bookkeeping, not a real session start.
let resyncInFlight = false;
let hasSavedPattern = false; // Whether the current site has a saved selector
let lowConfidence = false; // Whether extraction had low confidence
let pageWordCount: number | null = null; // Word count of extracted content (for reading-time estimate)
let configWarning: string | null = null; // Non-blocking AI config warning
let showHelpMenu = false;
let pageExcerpt: string | null = null; // Plain-text preview of the extracted page (shown before summarizing)
let contextKeptPercent: number | null = null; // How much page text survived CF-3.9 shortening, for the notice
let exportStatusEl: HTMLElement | null = null;
let focusAfterRender = false; // Put the cursor in the message box after a reply finishes
let messagesPinnedToBottom = true; // False once the user scrolls up, so streaming stops yanking the view down

// Export sections chosen with the checkboxes in the footer (see renderFooter).
const exportOptions = { summary: true, content: false, qa: false };

// SF-8: gated by settings.debugLogging — read from storage at startup
// (mirroring getDefaultExportDestination's direct-read pattern) and kept live
// by the settingsChanged broadcast the background sends on every save.
let debugLoggingEnabled = false;
const logger = createLogger({ getEnabled: () => debugLoggingEnabled });
try {
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (isMessageOfKind(message, "settingsChanged")) {
      debugLoggingEnabled = message.payload.debugLogging === true;
    }
    return undefined;
  });
} catch {
  // No runtime messaging available — the startup read still applies.
}

// ─── Context Tab State ───────────────────────────────────────────────────────

let contextTabs: ContextTabInfo[] = [];
let openTabsList: { tabId: number; title: string; url: string }[] = [];
let showTabPicker = false;
let contextTabError: string | null = null;
let contextTabErrorTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── DOM References ──────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

// ─── Port Communication ──────────────────────────────────────────────────────

function connectPort(): void {
  logger.debug("Port connecting");
  port = browser.runtime.connect({ name: "chat" });

  port.onMessage.addListener((raw: unknown) => {
    // Clipboard delivery request from the export pipeline (CF-4.4): the
    // background can only reach the clipboard through a document context.
    if (isMessageOfKind(raw, "clipboardWrite")) {
      void handleClipboardWrite(raw.payload.content);
      return;
    }
    if (!isControllerToSidebarMessage(raw)) return;
    handleControllerMessage(raw);
  });

  port.onDisconnect.addListener(() => {
    logger.debug("Port disconnected");
    port = null;
  });
}

async function handleClipboardWrite(content: string): Promise<void> {
  const ok = await writeToClipboard(content);
  if (ok) {
    logger.debug("Clipboard write succeeded");
  } else {
    logger.warn("Clipboard write failed");
  }
  if (port) {
    port.postMessage(buildMessage("clipboardResult", ok ? { ok: true } : { ok: false, reason: "clipboard-write-failed" }));
  }
}

async function writeToClipboard(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    // Fall back to execCommand for contexts where the async API is unavailable
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

// Sends a message to the background controller, transparently reconnecting
// the port first if it had gone stale (e.g. the background page was
// idle-unloaded — CF-3.6). A disconnected port must never cause a message
// to be silently dropped.
function sendToController(msg: SidebarToControllerMessage): void {
  const wasDisconnected = !port;
  if (wasDisconnected) {
    connectPort();
  }

  const activePort = port;
  if (!activePort) return;

  if (wasDisconnected && msg.type !== "init" && currentTabId !== null) {
    resyncInFlight = true;
    activePort.postMessage({ type: "init", tabId: currentTabId, url: currentTabUrl });
  }
  activePort.postMessage(msg);
}

function handleControllerMessage(msg: ControllerToSidebarMessage): void {
  switch (msg.type) {
    case "freeChatReady":
      // A resync init (CF-3.6 reconnect replay) answering while the user is
      // already mid-send must not clobber their in-flight conversation.
      if (resyncInFlight) {
        resyncInFlight = false;
        render();
        break;
      }
      // about:blank or similar — enter free-chat mode with no page context
      contextTabs = [];
      state = { phase: "free-chat", messages: msg.messages ? [...msg.messages] : [] };
      configWarning = null;
      render();
      break;

    case "contextLoaded":
      if (resyncInFlight) {
        resyncInFlight = false;
        hasSavedPattern = msg.hasSavedPattern;
        pageWordCount = msg.wordCount;
        render();
        break;
      }
      // Content extracted — go to ready state (user can click Summarize)
      contextTabs = [{ tabId: currentTabId!, url: msg.url, title: msg.title, confidence: msg.confidence }];
      state = { phase: "ready", messages: [] };
      configWarning = null;
      lowConfidence = msg.confidence === "low";
      hasSavedPattern = msg.hasSavedPattern;
      pageWordCount = msg.wordCount;
      pageExcerpt = msg.excerpt?.trim() ? msg.excerpt : null;
      render();
      break;

    case "contextTabAdded":
      // A tab was added to the conversation context
      if (!contextTabs.some((t) => t.tabId === msg.tabId)) {
        contextTabs = [...contextTabs, { tabId: msg.tabId, url: msg.url, title: msg.title, confidence: msg.confidence }];
      }
      // A restored cached session reports its confidence here (not via
      // contextLoaded) — the picker recovery hint must still reflect it (CF-6.3).
      if (msg.tabId === currentTabId) {
        lowConfidence = msg.confidence === "low";
      }
      // Close the tab picker after adding
      showTabPicker = false;
      render();
      break;

    case "contextTabFailed":
      // Tab extraction failed — close picker, don't add to context, and
      // surface the reason (SF-1) instead of failing silently.
      showTabPicker = false;
      contextTabError = msg.reason;
      if (contextTabErrorTimeout) {
        clearTimeout(contextTabErrorTimeout);
      }
      contextTabErrorTimeout = setTimeout(() => {
        contextTabError = null;
        contextTabErrorTimeout = null;
        render();
      }, 5000);
      render();
      break;

    case "contextTabRemoved":
      contextTabs = contextTabs.filter((t) => t.tabId !== msg.tabId);
      render();
      break;

    case "openTabs":
      openTabsList = [...msg.tabs];
      showTabPicker = true;
      render();
      break;

    case "contextError":
      logger.warn("Context error", msg.reason, `canRetry=${msg.canRetry}`);
      if (resyncInFlight) {
        resyncInFlight = false;
        render();
        break;
      }
      // If the error is about page type (about:, moz-extension:, etc.), show a
      // friendly "no page" state instead of a scary error
      if (msg.reason.includes("Cannot extract content from this page type") ||
          msg.reason.includes("Tab not accessible")) {
        state = { phase: "no-page" };
      } else {
        state = {
          phase: "error",
          reason: msg.reason,
          canRetry: msg.canRetry,
          showPicker: true,
          messages: [],
          returnPhase: "ready",
        };
      }
      render();
      break;

    case "conversationRestored":
      if (resyncInFlight) {
        resyncInFlight = false;
        render();
        break;
      }
      state = { phase: "ready", messages: msg.messages };
      render();
      break;

    case "streamStart":
      logger.debug("Stream started", `historyTruncated=${!!msg.historyTruncated}`, `contextTruncated=${!!msg.contextTruncated}`);
      contextKeptPercent = msg.contextKeptPercent ?? null;
      announce("Generating reply");
      if (state.phase === "summarizing") {
        // Stay in summarizing, streaming will come via tokens — but still
        // fold in whether page content was shortened for this request (CF-3.9).
        state = { ...state, contextTruncated: msg.contextTruncated };
      } else if (state.phase === "ready") {
        state = { phase: "streaming", messages: state.messages, partial: "", returnPhase: "ready", historyTruncated: msg.historyTruncated, contextTruncated: msg.contextTruncated };
      } else if (state.phase === "free-chat") {
        state = { phase: "streaming", messages: state.messages, partial: "", returnPhase: "free-chat", historyTruncated: msg.historyTruncated, contextTruncated: msg.contextTruncated };
      } else if (state.phase === "error") {
        // Retried stream — render it exactly like a first attempt (CF-3.3)
        state = { phase: "streaming", messages: state.messages, partial: "", returnPhase: state.returnPhase, historyTruncated: msg.historyTruncated, contextTruncated: msg.contextTruncated };
      } else if (state.phase === "loading") {
        state = { phase: "streaming", messages: [], partial: "", returnPhase: "ready", historyTruncated: msg.historyTruncated, contextTruncated: msg.contextTruncated };
      } else if (state.phase === "streaming") {
        // submitMessage() already optimistically switched to "streaming"
        // before this real streamStart arrived — just fold in the flags.
        state = { ...state, historyTruncated: msg.historyTruncated, contextTruncated: msg.contextTruncated };
      }
      render();
      break;

    case "streamToken": {
      if (state.phase === "summarizing") {
        state = { ...state, partialContent: state.partialContent + msg.token };
        const partialEl = app.querySelector<HTMLElement>(".partial-content");
        if (partialEl) {
          partialEl.innerHTML = renderMarkdown(state.partialContent);
          break; // skip full render — patch only
        }
      } else if (state.phase === "streaming") {
        state = { ...state, partial: state.partial + msg.token };
        const partialEl = app.querySelector<HTMLElement>(".message-partial .message-content");
        if (partialEl) {
          partialEl.innerHTML = renderMarkdown(state.partial);
          const list = app.querySelector(".messages-list");
          if (list && messagesPinnedToBottom) list.scrollTop = list.scrollHeight;
          break; // skip full render — patch only
        }
      }
      render(); // first token (element doesn't exist yet) — do full render to create it
      break;
    }

    case "streamEnd": {
      logger.debug("Stream ended", `chars=${msg.fullContent.length}`);
      announce("Reply complete");
      // An empty fullContent means an aborted stream with nothing received —
      // don't append an empty assistant message.
      const hasContent = msg.fullContent.trim().length > 0;
      const endMsg: PortConversationMessage = {
        role: "assistant",
        content: msg.fullContent,
        timestamp: new Date().toISOString(),
        model: msg.model,
      };
      if (state.phase === "summarizing") {
        const newMessages = hasContent ? [...state.priorMessages, endMsg] : [...state.priorMessages];
        const notes = { contextTruncated: state.contextTruncated };
        state = state.returnPhase === "free-chat"
          ? { phase: "free-chat", messages: newMessages, ...notes }
          : { phase: "ready", messages: newMessages, ...notes };
        focusAfterRender = true;
      } else if (state.phase === "streaming") {
        const returnPhase = state.returnPhase;
        const newMessages = hasContent ? [...state.messages, endMsg] : [...state.messages];
        const notes = { historyTruncated: state.historyTruncated, contextTruncated: state.contextTruncated };
        if (returnPhase === "free-chat") {
          state = { phase: "free-chat", messages: newMessages, ...notes };
        } else {
          state = { phase: "ready", messages: newMessages, ...notes };
        }
        focusAfterRender = true;
      }
      render();
      break;
    }

    case "streamError": {
      logger.warn("Stream error", msg.reason, `canRetry=${msg.canRetry}`);
      announce(`Error: ${msg.reason}`);
      // Keep the conversation visible alongside the error; the controller is
      // the single source of truth for whether retry is still allowed (CF-3.3).
      const prior: { messages: ReadonlyArray<PortConversationMessage>; returnPhase: "ready" | "free-chat" } =
        state.phase === "streaming"
          ? { messages: state.messages, returnPhase: state.returnPhase }
          : state.phase === "free-chat"
            ? { messages: state.messages, returnPhase: "free-chat" }
            : state.phase === "ready"
              ? { messages: state.messages, returnPhase: "ready" }
              : state.phase === "summarizing"
                ? { messages: state.priorMessages, returnPhase: state.returnPhase }
                : { messages: [], returnPhase: "ready" };
      state = {
        phase: "error",
        reason: msg.reason,
        canRetry: msg.canRetry,
        showPicker: false,
        messages: prior.messages,
        returnPhase: prior.returnPhase,
      };
      render();
      break;
    }

    case "configError":
      if (resyncInFlight) {
        resyncInFlight = false;
        configWarning = msg.reason;
        render();
        break;
      }
      if (state.phase === "ready" || state.phase === "summarizing" || state.phase === "free-chat") {
        configWarning = msg.reason;
        // summarizing can't stay mid-stream without AI; drop back to the
        // phase it was summarizing for, preserving free-chat's context
        if (state.phase === "summarizing") state = { phase: state.returnPhase, messages: state.priorMessages };
      } else {
        state = { phase: "config-error", reason: msg.reason };
      }
      render();
      break;

  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function render(): void {
  // The whole tree is rebuilt on every render; remember where the user was
  // reading so a re-render doesn't throw them to the top.
  const previousList = app.querySelector(".messages-list");
  const previousScrollTop = previousList ? previousList.scrollTop : null;
  app.innerHTML = "";

  const container = el("div", "sidebar-container");

  // Header
  container.appendChild(renderHeader());

  // Main content area based on state
  const content = el("div", "sidebar-content");
  switch (state.phase) {
    case "loading":
      content.appendChild(renderLoading());
      break;
    case "no-page":
      content.appendChild(renderNoPage());
      break;
    case "free-chat":
      content.appendChild(renderFreeChat());
      break;
    case "summarizing":
      content.append(...renderTruncationNotices(state));
      content.appendChild(renderSummarizing());
      break;
    case "ready":
      if (state.messages.length === 0) {
        content.appendChild(renderReadyNoSummary());
      } else {
        content.appendChild(renderContextSection());
        content.append(...renderTruncationNotices(state));
        content.appendChild(renderMessages(state.messages));
        if (pageWordCount !== null && pageWordCount > 0) {
          const mins = Math.max(1, Math.ceil(pageWordCount / 200));
          const hint = el("div", "time-saved-hint");
          hint.textContent = `✓ ~${mins} min saved`;
          content.appendChild(hint);
        }
      }
      if (configWarning) {
        content.appendChild(renderConfigWarningBanner());
      }
      if (lowConfidence) {
        content.appendChild(renderLowConfidenceHint());
      }
      if (state.messages.length > 0) {
        content.appendChild(renderInputArea());
      }
      break;
    case "streaming":
      content.append(...renderTruncationNotices(state));
      content.appendChild(renderMessages(state.messages, state.partial));
      content.appendChild(renderStreamingControls());
      break;
    case "error":
      content.appendChild(renderError());
      break;
    case "config-error":
      content.appendChild(renderConfigError());
      break;
  }

  container.appendChild(content);

  // Footer with export controls (visible when content is available)
  if (state.phase === "ready" || state.phase === "streaming" || state.phase === "summarizing" || state.phase === "free-chat" || (state.phase === "config-error" && currentTabId != null)) {
    container.appendChild(renderFooter());
  }

  app.appendChild(container);

  // Keep following the newest content unless the user scrolled up to read
  const messagesEl = app.querySelector(".messages-list");
  if (messagesEl) {
    if (messagesPinnedToBottom || previousScrollTop === null) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      messagesEl.scrollTop = previousScrollTop;
    }
    messagesEl.addEventListener("scroll", () => {
      messagesPinnedToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
      app.querySelector(".scroll-latest")?.classList.toggle("hidden", messagesPinnedToBottom);
    });
    if (state.phase === "streaming") {
      const latestBtn = el("button", "scroll-latest") as HTMLButtonElement;
      latestBtn.textContent = "↓ Latest";
      latestBtn.classList.toggle("hidden", messagesPinnedToBottom);
      latestBtn.addEventListener("click", () => {
        messagesPinnedToBottom = true;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        latestBtn.classList.add("hidden");
      });
      container.appendChild(latestBtn);
    }
  }

  if (focusAfterRender) {
    focusAfterRender = false;
    app.querySelector<HTMLTextAreaElement>(".message-input")?.focus();
  }
}

function renderHeader(): HTMLElement {
  const header = el("header", "sidebar-header");

  // No in-page title: Firefox already shows the sidebar's name in its own title bar.
  const headerControls = el("div", "header-controls");

  // Reset button — visible when we have content loaded
  if (state.phase === "ready" || state.phase === "streaming" || state.phase === "summarizing") {
    const resetBtn = el("button", "btn-reset") as HTMLButtonElement;
    resetBtn.textContent = "↻";
    resetBtn.title = "Re-read page — extract the current page again";
    resetBtn.setAttribute("aria-label", "Re-read page — extract the current page again");
    resetBtn.addEventListener("click", () => {
      if (currentTabId == null) return;
      resetLocalNav();
      render();
      sendToController({ type: "abort" });
      sendToController({ type: "init", tabId: currentTabId });
    });
    headerControls.appendChild(resetBtn);
  }

  // New chat button — visible in page-context states; drops page context and enters free-chat
  if (state.phase === "ready" || state.phase === "streaming" || state.phase === "summarizing") {
    const newChatBtn = el("button", "btn-new-chat") as HTMLButtonElement;
    newChatBtn.textContent = "✦ New chat";
    newChatBtn.title = "New chat — clear page context and start a free chat";
    newChatBtn.setAttribute("aria-label", "New chat — clear page context and start a free chat");
    newChatBtn.addEventListener("click", () => {
      if (currentTabId == null) return;
      resetLocalNav();
      render();
      sendToController({ type: "abort" });
      sendToController({ type: "init", tabId: currentTabId, url: "about:blank" });
    });
    headerControls.appendChild(newChatBtn);
  }

  // Help button — always visible, regardless of phase
  const helpWrapper = el("div", "help-menu");
  const helpBtn = el("button", "btn-help") as HTMLButtonElement;
  helpBtn.textContent = "?";
  helpBtn.title = "Help — version info and links";
  helpBtn.setAttribute("aria-label", "Help — version info and links");
  helpBtn.addEventListener("click", () => {
    showHelpMenu = !showHelpMenu;
    render();
  });
  helpWrapper.appendChild(helpBtn);

  if (showHelpMenu) {
    const helpDropdown = el("div", "help-menu-dropdown");

    const version = el("div", "help-menu-version");
    version.textContent = `${PRODUCT_NAME} v${EXTENSION_VERSION}`;
    helpDropdown.appendChild(version);

    const settingsLink = el("a", "help-menu-link help-menu-settings") as HTMLAnchorElement;
    settingsLink.href = "#";
    settingsLink.textContent = "⚙️ Settings";
    settingsLink.addEventListener("click", (e) => {
      e.preventDefault();
      showHelpMenu = false;
      browser.runtime.openOptionsPage();
      render();
    });
    helpDropdown.appendChild(settingsLink);

    const issuesLink = el("a", "help-menu-link help-menu-external") as HTMLAnchorElement;
    issuesLink.href = "https://github.com/dstaulcu/page-distill/issues";
    issuesLink.target = "_blank";
    issuesLink.rel = "noopener";
    issuesLink.textContent = "Report an issue";
    helpDropdown.appendChild(issuesLink);

    const releasesLink = el("a", "help-menu-link help-menu-external") as HTMLAnchorElement;
    releasesLink.href = "https://github.com/dstaulcu/page-distill/releases";
    releasesLink.target = "_blank";
    releasesLink.rel = "noopener";
    releasesLink.textContent = "Releases";
    helpDropdown.appendChild(releasesLink);

    const closeBtn = el("button", "help-menu-close") as HTMLButtonElement;
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", () => {
      showHelpMenu = false;
      render();
    });
    helpDropdown.appendChild(closeBtn);

    helpWrapper.appendChild(helpDropdown);
  }

  headerControls.appendChild(helpWrapper);

  header.appendChild(headerControls);

  return header;
}

function renderLoading(): HTMLElement {
  const wrapper = el("div", "state-loading");
  const spinner = el("div", "spinner");
  const text = el("p", "loading-text");
  text.textContent = "Loading…";
  wrapper.appendChild(spinner);
  wrapper.appendChild(text);
  return wrapper;
}

function renderNoPage(): HTMLElement {
  const wrapper = el("div", "state-no-page");
  const text = el("p", "no-page-text");
  text.textContent = `Navigate to a web page to get started. ${PRODUCT_NAME} can't extract content from browser internal pages.`;
  wrapper.appendChild(text);
  return wrapper;
}

function renderFreeChat(): HTMLElement {
  const wrapper = el("div", "state-free-chat");
  const freeChatState = state as Extract<SidebarState, { phase: "free-chat" }>;

  // Context section (prominent — it's the main action here)
  wrapper.appendChild(renderContextSection());

  if (configWarning) {
    wrapper.appendChild(renderConfigWarningBanner());
  }

  // Chat messages (if any)
  if (freeChatState.messages.length > 0) {
    wrapper.append(...renderTruncationNotices(freeChatState));
    wrapper.appendChild(renderMessages(freeChatState.messages));
  } else if (contextTabs.length > 0) {
    // Context has been added but no conversation started yet — offer the
    // same Summarize entry point the "ready" phase gives for a single page,
    // rather than leaving only open-ended chat as the sole way in.
    wrapper.appendChild(renderFreeChatSummarizeAction());
  } else {
    // Empty state hint
    const hint = el("p", "free-chat-hint");
    hint.textContent = "Add page context above, then start chatting.";
    wrapper.appendChild(hint);
  }

  // Chat input — always visible in free-chat mode
  wrapper.appendChild(renderInputArea());

  return wrapper;
}

function renderFreeChatSummarizeAction(): HTMLElement {
  const wrapper = el("div", "free-chat-summarize-action");

  const hint = el("p", "free-chat-hint");
  hint.textContent = "Context added — summarize it, or start chatting below.";
  wrapper.appendChild(hint);

  const summarizeBtn = el("button", "btn btn-summarize") as HTMLButtonElement;
  summarizeBtn.textContent = "Summarize";
  summarizeBtn.addEventListener("click", () => {
    sendToController({ type: "summarize" });
    state = { phase: "summarizing", title: "", partialContent: "", returnPhase: "free-chat", priorMessages: [] };
    render();
  });
  wrapper.appendChild(summarizeBtn);

  return wrapper;
}

function renderReadyNoSummary(): HTMLElement {
  const wrapper = el("div", "state-ready-no-summary");

  wrapper.appendChild(renderContextSection());

  const pageInfo = el("div", "page-info");

  const primaryTab = contextTabs[0];
  if (primaryTab?.title) {
    const titleEl = el("p", "page-info-title");
    titleEl.textContent = primaryTab.title;
    titleEl.title = primaryTab.url;
    pageInfo.appendChild(titleEl);
  }

  if (pageWordCount !== null && pageWordCount > 0) {
    const mins = Math.max(1, Math.ceil(pageWordCount / 200));
    const badge = el("span", "page-info-reading-time");
    badge.textContent = `~${mins} min read`;
    pageInfo.appendChild(badge);
  }

  wrapper.appendChild(pageInfo);

  // Preview of what was extracted, so a wrong grab is obvious before a summary is spent on it
  if (pageExcerpt) {
    const excerpt = el("p", "page-excerpt");
    excerpt.textContent = pageExcerpt;
    wrapper.appendChild(excerpt);
  }
  if (!lowConfidence) {
    // (When confidence is low the prominent picker hint below already covers this)
    const wrongLink = el("a", "wrong-content-link") as HTMLAnchorElement;
    wrongLink.href = "#";
    wrongLink.textContent = hasSavedPattern ? "Not the right content? Update selector" : "Not the right content? Pick the area";
    wrongLink.addEventListener("click", async (e) => {
      e.preventDefault();
      const original = wrongLink.textContent!;
      await activatePicker(
        () => { wrongLink.textContent = "Selecting…"; },
        () => { wrongLink.textContent = original; },
      );
    });
    wrapper.appendChild(wrongLink);
  }

  const actions = el("div", "ready-actions");

  const summarizeBtn = el("button", "btn btn-summarize") as HTMLButtonElement;
  summarizeBtn.textContent = "Summarize";
  summarizeBtn.addEventListener("click", () => {
    sendToController({ type: "summarize" });
    state = { phase: "summarizing", title: "", partialContent: "", returnPhase: "ready", priorMessages: [] };
    render();
  });
  actions.appendChild(summarizeBtn);

  wrapper.appendChild(actions);
  return wrapper;
}

// ─── Context Section ─────────────────────────────────────────────────────────

function renderContextSection(): HTMLElement {
  const strip = el("div", "context-strip");

  for (const tab of contextTabs) {
    const chip = el("div", "context-chip");
    chip.dataset.tabId = String(tab.tabId);

    const cachedFavicon = faviconCache.get(tab.tabId);
    if (cachedFavicon) {
      chip.appendChild(makeFaviconImg(cachedFavicon));
    } else if (cachedFavicon === undefined) {
      requestFavicon(tab.tabId);
    }

    const titleSpan = el("span", "context-chip-title");
    titleSpan.textContent = truncate(tab.title || tab.url, 22);
    titleSpan.title = `${tab.title}\n${tab.url}`;
    chip.appendChild(titleSpan);

    const removeBtn = el("button", "context-chip-remove") as HTMLButtonElement;
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${tab.title} from context`;
    removeBtn.setAttribute("aria-label", `Remove ${tab.title} from context`);
    const tabId = tab.tabId;
    removeBtn.addEventListener("click", () => {
      sendToController({ type: "removeContextTab", tabId });
    });
    chip.appendChild(removeBtn);

    strip.appendChild(chip);
  }

  // "+" chip — opens/closes the tab picker
  const addBtn = el("button", "context-chip context-chip-add") as HTMLButtonElement;
  addBtn.textContent = "＋ Add tab";
  addBtn.title = "Add an open tab to this conversation's context";
  addBtn.setAttribute("aria-label", "Add an open tab to this conversation's context");
  addBtn.addEventListener("click", () => {
    if (showTabPicker) {
      showTabPicker = false;
      render();
    } else {
      sendToController({ type: "getOpenTabs" });
    }
  });
  strip.appendChild(addBtn);

  if (showTabPicker) {
    const picker = el("div", "tab-picker-dropdown");

    const contextTabIds = new Set(contextTabs.map((t) => t.tabId));
    const available = openTabsList.filter((t) => !contextTabIds.has(t.tabId));

    if (available.length === 0) {
      const empty = el("div", "tab-picker-empty");
      empty.textContent = openTabsList.length > 0
        ? "All open tabs are already in context."
        : "No open tabs available.";
      picker.appendChild(empty);
    } else {
      for (const tab of available) {
        const item = el("button", "tab-picker-item") as HTMLButtonElement;
        item.textContent = truncate(tab.title || tab.url, 45);
        item.title = `${tab.title}\n${tab.url}`;
        const tabId = tab.tabId;
        item.addEventListener("click", () => {
          sendToController({ type: "addContextTab", tabId });
          showTabPicker = false;
          render();
        });
        picker.appendChild(item);
      }
    }

    const closeBtn = el("button", "tab-picker-close") as HTMLButtonElement;
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", () => {
      showTabPicker = false;
      render();
    });
    picker.appendChild(closeBtn);

    strip.appendChild(picker);
  }

  if (contextTabError) {
    const errorEl = el("div", "context-tab-error");
    errorEl.textContent = contextTabError;
    strip.appendChild(errorEl);
  }

  return strip;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

function renderSummarizing(): HTMLElement {
  const wrapper = el("div", "state-summarizing");

  const titleEl = el("p", "summarizing-title");
  titleEl.textContent = `Summarizing: ${(state as { title: string }).title}`;
  wrapper.appendChild(titleEl);

  const partial = (state as { partialContent: string }).partialContent;
  if (partial) {
    const contentEl = el("div", "partial-content");
    contentEl.innerHTML = renderMarkdown(partial);
    wrapper.appendChild(contentEl);
  }

  const spinner = el("div", "spinner");
  wrapper.appendChild(spinner);

  // Abort button during summarization. The controller answers the abort with
  // a streamEnd carrying the partial content, which stays visible (CF-2.5) —
  // so don't reset the view here.
  const abortBtn = el("button", "btn btn-abort") as HTMLButtonElement;
  abortBtn.textContent = "Cancel";
  abortBtn.addEventListener("click", () => {
    sendToController({ type: "abort" });
    abortBtn.disabled = true;
    abortBtn.textContent = "Cancelling…";
  });
  wrapper.appendChild(abortBtn);

  return wrapper;
}

function renderMessages(messages: ReadonlyArray<PortConversationMessage>, partial?: string): HTMLElement {
  const wrapper = el("div", "messages-list");

  for (const msg of messages) {
    const msgEl = el("div", `message message-${msg.role}`);
    const roleLabel = el("span", "message-role");
    roleLabel.textContent = msg.role === "user" ? "You" : ASSISTANT_NAME;
    msgEl.appendChild(roleLabel);

    if (msg.role === "assistant" && msg.model) {
      const modelLabel = el("span", "message-model");
      modelLabel.textContent = msg.model;
      msgEl.appendChild(modelLabel);
    }


    if (msg.role === "assistant" && msg.content) {
      const content = msg.content;
      msgEl.appendChild(makeCopyButton("message-copy", "Copy this reply", () => content));
    }

    const contentEl = el("div", "message-content");
    contentEl.innerHTML = renderMarkdown(msg.content);
    addCodeCopyButtons(contentEl);
    msgEl.appendChild(contentEl);

    wrapper.appendChild(msgEl);
  }

  // Partial streaming content or waiting indicator
  if (partial !== undefined) {
    const partialEl = el("div", "message message-assistant message-partial");
    const roleLabel = el("span", "message-role");
    roleLabel.textContent = ASSISTANT_NAME;
    partialEl.appendChild(roleLabel);

    if (partial) {
      const contentEl = el("div", "message-content");
      contentEl.innerHTML = renderMarkdown(partial);
      partialEl.appendChild(contentEl);
    } else {
      const spinner = el("div", "spinner spinner-inline");
      partialEl.appendChild(spinner);
    }

    wrapper.appendChild(partialEl);
  }

  return wrapper;
}

/** The CF-3.8 / CF-3.9 notes a finished (or in-flight) request carries, in display order. */
function renderTruncationNotices(
  flags: { readonly historyTruncated?: boolean; readonly contextTruncated?: boolean },
): HTMLElement[] {
  const notices: HTMLElement[] = [];
  if (flags.historyTruncated) notices.push(renderTruncationNotice());
  if (flags.contextTruncated) notices.push(renderContextTruncationNotice());
  return notices;
}

function renderTruncationNotice(): HTMLElement {
  // CF-3.8: earlier conversation turns were dropped to fit the model's
  // configured context window — surfaced so the trim is never silent.
  const wrapper = el("div", "truncation-notice");
  wrapper.textContent = "Earlier messages were trimmed to fit the model's context window.";
  return wrapper;
}

function renderContextTruncationNotice(): HTMLElement {
  // CF-3.9: the page content (or added tabs) was longer than the model's
  // configured context window, so each was cut short — surfaced so it is
  // never a silent truncation.
  const wrapper = el("div", "truncation-notice");
  wrapper.textContent = contextKeptPercent !== null
    ? `Page content was shortened to fit the model's context window — about ${contextKeptPercent}% of it was read.`
    : "Page content was shortened to fit the model's context window.";
  return wrapper;
}

function renderLowConfidenceHint(): HTMLElement {
  const wrapper = el("div", "low-confidence-hint");
  const link = el("a", "picker-link") as HTMLAnchorElement;
  link.href = "#";
  link.textContent = hasSavedPattern ? "Update selector" : "Wrong content? Pick the right area";
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    const original = link.textContent!;
    await activatePicker(
      () => { link.textContent = "Selecting…"; },
      () => { link.textContent = original; }
    );
  });
  wrapper.appendChild(link);
  return wrapper;
}

function renderConfigWarningBanner(): HTMLElement {
  const wrapper = el("div", "config-warning-banner");

  const icon = el("span", "config-warning-icon");
  icon.textContent = "⚙️";
  wrapper.appendChild(icon);

  const text = el("span", "config-warning-text");
  text.textContent = configWarning ?? "AI not configured";
  wrapper.appendChild(text);

  const link = el("a", "settings-link-inline") as HTMLAnchorElement;
  link.textContent = "Settings";
  link.href = "#";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
  wrapper.appendChild(link);

  return wrapper;
}

function renderInputArea(): HTMLElement {
  const wrapper = el("div", "input-area");

  const textarea = document.createElement("textarea");
  textarea.className = "message-input";
  textarea.placeholder = "Ask a follow-up question…";
  textarea.maxLength = MESSAGE_CHAR_LIMIT;
  textarea.rows = 3;
  textarea.setAttribute("aria-label", "Message input");

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage(textarea.value);
    }
  });

  const sendBtn = el("button", "btn btn-send") as HTMLButtonElement;
  sendBtn.textContent = "Send";
  sendBtn.addEventListener("click", () => {
    submitMessage(textarea.value);
  });

  wrapper.appendChild(textarea);

  const controls = el("div", "input-controls");
  controls.appendChild(sendBtn);

  // Context may have changed since the last summary (e.g. a tab was added):
  // let the user summarize again. The new summary is appended to the chat.
  if ((state.phase === "ready" || state.phase === "free-chat") && state.messages.length > 0 && contextTabs.length > 0) {
    const phase = state.phase;
    const messages = state.messages;
    const resummarizeBtn = el("button", "btn btn-resummarize") as HTMLButtonElement;
    resummarizeBtn.textContent = "↻ Update summary";
    resummarizeBtn.title = "Summarize the current context tabs again";
    resummarizeBtn.addEventListener("click", () => {
      sendToController({ type: "summarize" });
      state = { phase: "summarizing", title: "", partialContent: "", returnPhase: phase, priorMessages: messages };
      render();
    });
    controls.appendChild(resummarizeBtn);
  }
  wrapper.appendChild(controls);

  return wrapper;
}

function renderStreamingControls(): HTMLElement {
  const wrapper = el("div", "streaming-controls");

  const abortBtn = el("button", "btn btn-abort") as HTMLButtonElement;
  abortBtn.textContent = "Stop";
  abortBtn.setAttribute("aria-label", "Stop streaming");
  abortBtn.addEventListener("click", () => {
    sendToController({ type: "abort" });
  });
  wrapper.appendChild(abortBtn);

  return wrapper;
}

function renderError(): HTMLElement {
  const wrapper = el("div", "state-error");
  const errorState = state as {
    reason: string;
    canRetry: boolean;
    showPicker: boolean;
    messages: ReadonlyArray<PortConversationMessage>;
    returnPhase: "ready" | "free-chat";
  };

  // The conversation stays visible; the error renders alongside it (CF-3.3)
  if (errorState.messages.length > 0) {
    wrapper.appendChild(renderMessages(errorState.messages));
  }

  const icon = el("div", "error-icon");
  icon.textContent = "⚠️";
  wrapper.appendChild(icon);

  const reason = el("p", "error-reason");
  reason.textContent = errorState.reason;
  wrapper.appendChild(reason);

  const actions = el("div", "error-actions");

  if (errorState.canRetry) {
    const retryBtn = el("button", "btn btn-retry") as HTMLButtonElement;
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      if (errorState.showPicker) {
        // Context/extraction error — the fix is a fresh init, not a re-send
        if (currentTabId == null) return;
        resetLocalNav();
        render();
        sendToController({ type: "init", tabId: currentTabId });
        return;
      }
      // Enter streaming immediately so the retried stream renders like a
      // first attempt instead of leaving the view on a spinner (CF-3.3)
      state = { phase: "streaming", messages: errorState.messages, partial: "", returnPhase: errorState.returnPhase };
      render();
      sendToController({ type: "retry" });
    });
    actions.appendChild(retryBtn);
  }

  if (errorState.showPicker) {
    const pickerBtn = el("button", "btn btn-picker") as HTMLButtonElement;
    pickerBtn.textContent = hasSavedPattern ? "Update selector" : "Select content area";
    pickerBtn.addEventListener("click", async () => {
      const original = pickerBtn.textContent!;
      await activatePicker(
        () => { pickerBtn.disabled = true; pickerBtn.textContent = "Selecting…"; },
        () => { pickerBtn.disabled = false; pickerBtn.textContent = original; }
      );
    });
    actions.appendChild(pickerBtn);
  }

  wrapper.appendChild(actions);
  return wrapper;
}

function renderConfigError(): HTMLElement {
  const wrapper = el("div", "state-config-error");
  const configState = state as { reason: string };

  const icon = el("div", "error-icon");
  icon.textContent = "⚙️";
  wrapper.appendChild(icon);

  const heading = el("h2", "setup-heading");
  heading.textContent = "Set up your AI provider";
  wrapper.appendChild(heading);

  const reason = el("p", "config-error-reason");
  reason.textContent = configState.reason;
  wrapper.appendChild(reason);

  const steps = el("ol", "setup-steps");
  for (const step of [
    "Choose Ollama (a model on your computer) or an OpenAI-compatible service.",
    "Enter the server address and pick a model.",
    "Use Test connection, then Save.",
  ]) {
    const li = document.createElement("li");
    li.textContent = step;
    steps.appendChild(li);
  }
  wrapper.appendChild(steps);

  const link = el("a", "settings-link btn") as HTMLAnchorElement;
  link.textContent = "Open Settings";
  link.href = "#";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
  wrapper.appendChild(link);

  return wrapper;
}

function renderFooter(): HTMLElement {
  const footer = el("footer", "sidebar-footer");

  // Export controls — only shown when there's page context (not in pure free-chat mode with no tabs)
  if (state.phase !== "free-chat" || contextTabs.length > 0) {
    const exportSection = el("div", "export-section");

    const exportCheckboxes = el("div", "export-checkboxes");

    // Which sections go into the export. Summary is on by default; page content
    // and the follow-up Q&A are opt-in. Kept at module level so the choices
    // survive the footer being re-rendered.
    const exportBtn = el("button", "btn btn-export") as HTMLButtonElement;
    const syncExportButton = (): void => {
      exportBtn.disabled = !(exportOptions.summary || exportOptions.content || exportOptions.qa);
    };
    const addExportCheckbox = (key: keyof typeof exportOptions, text: string, ariaLabel: string): void => {
      const label = el("label", "export-checkbox-label");
      const checkbox = document.createElement("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.className = "export-checkbox";
      checkbox.checked = exportOptions[key];
      checkbox.setAttribute("aria-label", ariaLabel);
      checkbox.addEventListener("change", () => {
        exportOptions[key] = checkbox.checked;
        syncExportButton();
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(` ${text}`));
      exportCheckboxes.appendChild(label);
    };
    addExportCheckbox("summary", "Summary", "Include AI summary in export");
    addExportCheckbox("content", "Content", "Include page content in export");
    addExportCheckbox("qa", "Q&A", "Include follow-up Q&A in export");

    exportSection.appendChild(exportCheckboxes);

    // Export button
    exportBtn.textContent = "Export";
    syncExportButton();
    exportBtn.addEventListener("click", async () => {
      if (currentTabId == null) return;
      exportBtn.disabled = true;
      exportBtn.textContent = "Exporting...";
      try {
        const destination = await getDefaultExportDestination();
        logger.debug("Export requested", destination.kind);
        const response = await browser.runtime.sendMessage({
          kind: "exportRequested",
          payload: {
            tabId: currentTabId,
            includeSummary: exportOptions.summary,
            includeContent: exportOptions.content,
            includeQA: exportOptions.qa,
            destinations: [destination],
          },
        });
        if (response && typeof response === "object") {
          const result = response as { ok?: boolean; payload?: { ok?: boolean; filename?: string; reason?: string; detail?: string } };
          const payload = result.payload ?? result;
          if (payload.ok) {
            logger.debug("Export succeeded", (payload as { filename?: string }).filename);
            exportBtn.textContent = "✓ Exported";
            const filename = (payload as { filename?: string }).filename;
            setExportStatus(destination.kind === "clipboard" ? "Copied to clipboard" : filename ? `Saved ${filename}` : "Exported");
            setTimeout(() => { exportBtn.textContent = "Export"; }, 2000);
          } else {
            const failure = payload as { reason?: string; detail?: string };
            logger.warn("Export failed", failure.detail);
            // Say why when the user can act on it (e.g. exporting before summarizing)
            exportBtn.textContent = failure.reason === "nothing-to-export" ? "✗ Nothing to export" : "✗ Failed";
            exportBtn.title = failure.detail ?? "";
            setExportStatus("");
            setTimeout(() => { exportBtn.textContent = "Export"; exportBtn.title = ""; }, 3000);
          }
        } else {
          logger.warn("Export failed: no response from background");
          exportBtn.textContent = "✗ No response";
          setTimeout(() => { exportBtn.textContent = "Export"; }, 3000);
        }
      } catch (err) {
        logger.warn("Export failed with an error", err instanceof Error ? err.message : String(err));
        exportBtn.textContent = "✗ Error";
        setTimeout(() => { exportBtn.textContent = "Export"; }, 3000);
      } finally {
        syncExportButton();
      }
    });
    exportSection.appendChild(exportBtn);

    footer.appendChild(exportSection);

    // Says where the export went (filename or clipboard) instead of a bare tick
    const exportStatus = el("div", "export-status");
    exportStatus.setAttribute("role", "status");
    footer.appendChild(exportStatus);
    exportStatusEl = exportStatus;
  }

  return footer;
}

/**
 * Reads the configured default export destination (CF-4.4). Mirrors the
 * settings manager's read order: sync first, then local, then the default.
 */
async function getDefaultExportDestination(): Promise<{ kind: "download" } | { kind: "clipboard" }> {
  try {
    interface StoredExportSettings {
      export?: { defaultDestination?: { kind?: string } };
    }
    const stored = await browser.storage.sync.get("settings");
    let settings = stored?.settings as StoredExportSettings | undefined;
    if (!settings) {
      const local = await browser.storage.local.get("settings");
      settings = local?.settings as StoredExportSettings | undefined;
    }
    return settings?.export?.defaultDestination?.kind === "clipboard"
      ? { kind: "clipboard" }
      : { kind: "download" };
  } catch {
    return { kind: "download" };
  }
}

/**
 * Reads the debug-logging flag (SF-8) at startup. Same read order as
 * getDefaultExportDestination; defaults to disabled on any failure.
 */
async function refreshDebugLoggingFlag(): Promise<void> {
  try {
    interface StoredDebugSettings {
      debugLogging?: boolean;
    }
    const stored = await browser.storage.sync.get("settings");
    let settings = stored?.settings as StoredDebugSettings | undefined;
    if (!settings) {
      const local = await browser.storage.local.get("settings");
      settings = local?.settings as StoredDebugSettings | undefined;
    }
    if (typeof settings?.debugLogging === "boolean") {
      debugLoggingEnabled = settings.debugLogging;
    }
  } catch {
    // Storage unavailable — default to disabled.
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function submitMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MESSAGE_CHAR_LIMIT) return;

  // Add user message to current messages
  const userMsg: PortConversationMessage = {
    role: "user",
    content: trimmed,
    timestamp: new Date().toISOString(),
  };

  if (state.phase === "ready") {
    state = { phase: "streaming", messages: [...state.messages, userMsg], partial: "", returnPhase: "ready" };
  } else if (state.phase === "free-chat") {
    state = { phase: "streaming", messages: [...state.messages, userMsg], partial: "", returnPhase: "free-chat" };
  }

  messagesPinnedToBottom = true; // sending means "follow the reply"
  sendToController({ type: "sendMessage", text: trimmed });
  render();
}

// ─── Utilities ───────────────────────────────────────────────────────────────

// Resets navigation-local state when leaving the current page session.
// Called from header buttons and the active-tab-change handler.
function resetLocalNav(): void {
  configWarning = null;
  contextTabs = [];
  showTabPicker = false;
  pageWordCount = null;
  pageExcerpt = null;
  contextKeptPercent = null;
  messagesPinnedToBottom = true;
  contextTabError = null;
  if (contextTabErrorTimeout) {
    clearTimeout(contextTabErrorTimeout);
    contextTabErrorTimeout = null;
  }
  state = { phase: "loading" };
}

// Sets state to "ready" or keeps "free-chat" (preserving the phase) and
// replaces messages. Eliminates the repeated if/else branching across handlers.
function setReadyPhase(msgs: ReadonlyArray<PortConversationMessage> = []): void {
  state = state.phase === "free-chat"
    ? { phase: "free-chat", messages: msgs }
    : { phase: "ready", messages: msgs };
}

// Fires the element-picker flow and re-inits on success.
// onPending / onCancel update the calling button's visual state.
async function activatePicker(onPending: () => void, onCancel: () => void): Promise<void> {
  if (currentTabId == null) return;
  onPending();
  try {
    const response = await browser.runtime.sendMessage({
      kind: "pickerActivate",
      payload: { tabId: currentTabId },
    });
    const payload = response && typeof response === "object" && "payload" in response
      ? (response as { payload: { ok: boolean } }).payload
      : null;
    if (payload?.ok) {
      state = { phase: "loading" };
      contextTabs = [];
      render();
      sendToController({ type: "init", tabId: currentTabId });
    } else {
      onCancel();
    }
  } catch {
    onCancel();
  }
}

// Screen-reader announcements. The chat tree is rebuilt on every render, so a
// persistent visually-hidden live region outside #app carries status changes
// (streaming content itself is deliberately not live: it would be re-read on
// every token).
function announce(text: string): void {
  let region = document.getElementById("sr-status");
  if (!region) {
    region = document.createElement("div");
    region.id = "sr-status";
    region.className = "sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  region.textContent = text;
}

/** Briefly relabel a button ("Copied ✓"), then restore it. */
function setExportStatus(text: string): void {
  if (!exportStatusEl) return;
  exportStatusEl.textContent = text;
  if (text) {
    const target = exportStatusEl;
    setTimeout(() => { if (target.textContent === text) target.textContent = ""; }, 6000);
  }
}

function flashButton(btn: HTMLButtonElement, text: string, ms = 1500): void {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, ms);
}

function makeCopyButton(className: string, label: string, getText: () => string): HTMLButtonElement {
  const btn = el("button", className) as HTMLButtonElement;
  btn.type = "button";
  btn.textContent = "Copy";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", async () => {
    const ok = await writeToClipboard(getText());
    flashButton(btn, ok ? "Copied ✓" : "Copy failed");
  });
  return btn;
}

/** Adds a Copy button to every code block inside rendered markdown. */
function addCodeCopyButtons(container: HTMLElement): void {
  for (const pre of Array.from(container.querySelectorAll("pre"))) {
    pre.appendChild(makeCopyButton("code-copy", "Copy code", () => pre.querySelector("code")?.textContent ?? ""));
  }
}

// Favicons for the context chips. Looked up lazily and patched into the chip
// in place — a full render() would wipe whatever the user is typing.
const faviconCache = new Map<number, string | null>();
const faviconRequested = new Set<number>();

function safeFaviconUrl(url: unknown): string | null {
  return typeof url === "string" && /^(https?:|data:image\/)/i.test(url) ? url : null;
}

function makeFaviconImg(url: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "context-chip-favicon";
  img.src = url;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.addEventListener("error", () => img.remove());
  return img;
}

function requestFavicon(tabId: number): void {
  if (faviconRequested.has(tabId)) return;
  faviconRequested.add(tabId);
  const tabsApi = (browser as unknown as { tabs?: { get?: (id: number) => Promise<{ favIconUrl?: string }> } }).tabs;
  if (typeof tabsApi?.get !== "function") return;
  tabsApi.get(tabId).then(
    (tab) => {
      const url = safeFaviconUrl(tab?.favIconUrl);
      faviconCache.set(tabId, url);
      const chip = app.querySelector(`.context-chip[data-tab-id="${tabId}"]`);
      if (url && chip && !chip.querySelector(".context-chip-favicon")) {
        chip.insertBefore(makeFaviconImg(url), chip.firstChild);
      }
    },
    () => { faviconCache.set(tabId, null); },
  );
}

function el(tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  return element;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) {
    // Future time
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60_000) return "< 1 min";
    if (absDiff < 3_600_000) return `in ${Math.round(absDiff / 60_000)} min`;
    return `in ${Math.round(absDiff / 3_600_000)} hr`;
  }

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)} min ago`;
  return `${Math.round(diffMs / 3_600_000)} hr ago`;
}

// ─── Initialization ──────────────────────────────────────────────────────────

async function init(): Promise<void> {
  document.title = PRODUCT_NAME;

  // Esc: close an open picker / help menu, or cancel a running stream
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (showTabPicker || showHelpMenu) {
      showTabPicker = false;
      showHelpMenu = false;
      render();
    } else if (state.phase === "streaming" || state.phase === "summarizing") {
      sendToController({ type: "abort" });
    }
  });

  // Render initial loading state immediately
  render();

  // Restore persisted UI settings
  await refreshDebugLoggingFlag();
  render();

  // Connect to background
  connectPort();

  // Initialize active tab tracker
  try {
    tracker = await createActiveTabTracker();
    const tabId = tracker.getActiveTabId();

    if (tabId == null) {
      state = { phase: "no-page" };
      render();
    } else {
      currentTabId = tabId;
      currentTabUrl = tracker.getActiveTabUrl() ?? undefined;
      sendToController({ type: "init", tabId, url: currentTabUrl });
    }

    // Listen for tab changes
    tracker.onActiveTabChanged((newTabId: number, newUrl: string) => {
      // If the newly active tab is already part of this session's multi-tab
      // context (SF-1 — the primary tab or one added via "+"), treat the
      // switch as a no-op for the chat session: peeking at a citation tab
      // you already added shouldn't reset the conversation or drop the
      // other context tabs.
      if (contextTabs.some((t) => t.tabId === newTabId)) {
        return;
      }

      currentTabId = newTabId;
      currentTabUrl = newUrl;
      resetLocalNav();
      render();

      // Reconnect port if disconnected
      if (!port) {
        connectPort();
      }

      sendToController({ type: "init", tabId: newTabId, url: newUrl });
    });
  } catch {
    state = { phase: "no-page" };
    render();
  }
}

// Start the sidebar
init();
