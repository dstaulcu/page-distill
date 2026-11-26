import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChatController, type Port, type CreateChatControllerOptions } from "./controller";
import type { Settings, TabState, Conversation, AiProvider } from "@shared/types";
import { inferProvider } from "@shared/providers";
import type { ExtractionResult } from "@content/extractor/extract";
import type { TabStateManager } from "@background/tab-state";
import type { SecureStore } from "@background/secure-store";
import type {
  StreamingAiClient,
  StreamingClientOptions,
  StreamChatCompletionRequest,
  StreamChatCompletionResult,
} from "./streaming-client";
import type { ControllerToSidebarMessage } from "@shared/port-protocol";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Budgeting (CF-3.8/3.9) applies only to Ollama-style endpoints. */
const OLLAMA_URL = "http://localhost:11434";

function createMockSettings(overrides?: Partial<Settings["ai"]>): Settings {
  return {
    schemaVersion: 1,
    ai: {
      baseUrl: "https://api.example.com",
      // Defaults to what the URL implies (localhost → ollama); tests can override.
      provider: inferProvider(overrides?.baseUrl ?? "https://api.example.com"),
      modelId: "gpt-4",
      apiKeyRef: "ref-123",
      systemPrompt: "You are a helpful assistant.",
      contextWindowTokens: 8192,
      ...overrides,
    },
    export: {
      filenamePattern: "YYYY-MM-DD-slugified-title",
      defaultDestination: { kind: "download" },
      frontmatterFields: ["title"],
    },
    sitePatterns: [],
    debugLogging: false,
  };
}

function createMockSecureStore(apiKey: string = "sk-test"): SecureStore {
  return {
    setSecret: vi.fn(),
    getSecret: vi.fn().mockResolvedValue(apiKey),
    deleteSecret: vi.fn(),
    createRef: vi.fn().mockReturnValue("new-ref"),
  };
}

function createMockTabState(): TabStateManager {
  const store = new Map<number, TabState>();
  return {
    get: vi.fn((tabId: number) => store.get(tabId)),
    set: vi.fn((tabId: number, state: TabState) => { store.set(tabId, state); }),
    update: vi.fn((tabId: number, patch: Partial<TabState>) => {
      const existing = store.get(tabId);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch } as TabState;
      store.set(tabId, updated);
      return updated;
    }),
    remove: vi.fn((tabId: number) => { store.delete(tabId); }),
    has: vi.fn((tabId: number) => store.has(tabId)),
  };
}

function createSuccessfulExtractionResult(): ExtractionResult {
  return {
    ok: true,
    article: {
      title: "Test Article",
      author: "Author",
      publicationDate: "2024-01-01",
      sourceUrl: "https://example.com/article",
      siteName: "Example",
      bodyMarkdown: "This is the article content.",
      bodyCharacterCount: 27,
    },
    confidence: "high",
  };
}

function createMockStreamingClient(
  result?: StreamChatCompletionResult,
  onCall?: (req: StreamChatCompletionRequest) => void,
): StreamingAiClient {
  const defaultResult: StreamChatCompletionResult = {
    ok: true,
    content: "Summary content here.",
  };
  return {
    streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
      onCall?.(req);
      // Simulate token delivery
      const r = result ?? defaultResult;
      if (r.ok) {
        for (const char of r.content) {
          req.onToken(char);
        }
      }
      return r;
    }),
  };
}

function createMockPort(): Port & { messages: ControllerToSidebarMessage[]; messageListeners: Array<(msg: unknown) => void>; disconnectListeners: Array<() => void> } {
  const messages: ControllerToSidebarMessage[] = [];
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    name: "chat",
    messages,
    messageListeners,
    disconnectListeners,
    postMessage: vi.fn((msg: ControllerToSidebarMessage) => { messages.push(msg); }),
    onMessage: {
      addListener: vi.fn((cb: (msg: unknown) => void) => { messageListeners.push(cb); }),
      removeListener: vi.fn((cb: (msg: unknown) => void) => {
        const idx = messageListeners.indexOf(cb);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((cb: () => void) => { disconnectListeners.push(cb); }),
      removeListener: vi.fn(),
    },
  };
}

interface TestContext {
  controller: ReturnType<typeof createChatController>;
  port: ReturnType<typeof createMockPort>;
  tabState: TabStateManager;
  settings: Settings;
  secureStore: SecureStore;
  extractContent: ReturnType<typeof vi.fn>;
  mockClient: StreamingAiClient;
  createStreamingClient: ReturnType<typeof vi.fn>;
  clock: () => string;
}

function setup(overrides?: {
  settings?: Settings;
  extractionResult?: ExtractionResult;
  streamResult?: StreamChatCompletionResult;
  onStreamCall?: (req: StreamChatCompletionRequest) => void;
  logger?: CreateChatControllerOptions["logger"];
}): TestContext {
  const settings = overrides?.settings ?? createMockSettings();
  const secureStore = createMockSecureStore();
  const tabState = createMockTabState();
  const extractContent = vi.fn().mockResolvedValue(
    overrides?.extractionResult ?? createSuccessfulExtractionResult(),
  );
  const mockClient = createMockStreamingClient(overrides?.streamResult, overrides?.onStreamCall);
  const createStreamingClientFn = vi.fn().mockReturnValue(mockClient);
  const clock = () => "2024-01-15T10:00:00.000Z";

  const opts: CreateChatControllerOptions = {
    getSettings: vi.fn().mockResolvedValue(settings),
    getSecureStore: () => secureStore,
    extractContent,
    createStreamingClient: createStreamingClientFn,
    tabState,
    clock,
    logger: overrides?.logger,
  };

  const controller = createChatController(opts);
  const port = createMockPort();

  return {
    controller,
    port,
    tabState,
    settings,
    secureStore,
    extractContent,
    mockClient,
    createStreamingClient: createStreamingClientFn,
    clock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CF-2/CF-3 createChatController", () => {
  describe("handleConnect", () => {
    it("registers message and disconnect listeners on the port", () => {
      const { controller, port } = setup();
      controller.handleConnect(port);

      expect(port.onMessage.addListener).toHaveBeenCalledTimes(1);
      expect(port.onDisconnect.addListener).toHaveBeenCalledTimes(1);
    });
  });

  describe("init message", () => {
    it("contextLoaded carries a plain-text excerpt of the extracted page", async () => {
      const { controller, port } = setup();
      controller.handleConnect(port);
      port.messageListeners[0]({ type: "init", tabId: 42 });

      await vi.waitFor(() => expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true));
      const loaded = port.messages.find((m) => m.type === "contextLoaded") as { excerpt?: string };
      expect(loaded.excerpt).toBe("This is the article content.");
    });

    it("extracts content and sends contextLoaded; summarize triggers streaming", async () => {
      const { controller, port, extractContent } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(extractContent).toHaveBeenCalledWith(42);
      });

      // Init should produce contextLoaded but NOT start streaming
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      expect(port.messages.some((m) => m.type === "streamStart")).toBe(false);

      // Summarization is user-triggered
      listener({ type: "summarize" });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("streamStart");
        expect(types).toContain("streamEnd");
      });
    });

    it("restores cached session when tab state exists", async () => {
      const { controller, port, tabState } = setup();

      // Pre-populate tab state
      const existingState: TabState = {
        url: "https://example.com/page",
        title: "Cached Page",
        summary: "Cached summary",
        conversation: {
          tabId: 42,
          url: "https://example.com/page",
          title: "Cached Page",
          messages: [
            { role: "assistant", content: "Cached summary", timestamp: "2024-01-15T09:00:00.000Z" },
          ],
          createdAt: "2024-01-15T09:00:00.000Z",
          updatedAt: "2024-01-15T09:00:00.000Z",
        },
        extractionConfidence: "high",
        consecutiveFailures: 0,
      };
      tabState.set(42, existingState);

      controller.handleConnect(port);
      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("conversationRestored");
        expect(types).not.toContain("contextLoaded");
      });

      const restored = port.messages.find((m) => m.type === "conversationRestored");
      expect(restored).toBeDefined();
      if (restored && restored.type === "conversationRestored") {
        expect(restored.messages).toHaveLength(1);
        expect(restored.messages[0].content).toBe("Cached summary");
      }
    });

    it("sends configError when AI endpoint is not configured", async () => {
      const { controller, port } = setup({
        settings: createMockSettings({ baseUrl: "", modelId: "" }),
      });
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("configError");
      });
    });

    it("sends contextError when extraction fails", async () => {
      const { controller, port } = setup({
        extractionResult: {
          ok: false,
          reason: "no-content-detected",
          detail: "No content found on page",
        },
      });
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("contextError");
      });

      const errorMsg = port.messages.find((m) => m.type === "contextError");
      if (errorMsg && errorMsg.type === "contextError") {
        expect(errorMsg.canRetry).toBe(true);
      }
    });

    it("sends contextError when extraction throws", async () => {
      const { controller, port, extractContent } = setup();
      extractContent.mockRejectedValue(new Error("Timeout"));
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const errorMsg = port.messages.find((m) => m.type === "contextError");
        expect(errorMsg).toBeDefined();
        if (errorMsg && errorMsg.type === "contextError") {
          expect(errorMsg.reason).toBe("Timeout");
          expect(errorMsg.canRetry).toBe(true);
        }
      });
    });

    it("sends streamError when summarization fails", async () => {
      const { controller, port } = setup({
        streamResult: {
          ok: false,
          reason: "network",
          detail: "Connection refused",
          partialContent: "Partial",
        },
      });
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("streamError");
      });

      const errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.reason).toBe("Connection refused");
        expect(errorMsg.partialContent).toBe("Partial");
        expect(errorMsg.canRetry).toBe(true);
      }
    });
  });

  describe("sendMessage", () => {
    it("streams a response with conversation context", async () => {
      const { controller, port, tabState, mockClient } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Clear messages
      port.messages.length = 0;

      // Send a follow-up message
      listener({ type: "sendMessage", text: "What is the main point?" });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("streamStart");
        expect(types).toContain("streamEnd");
      });

      // Verify the streaming client was called with conversation context
      expect(mockClient.streamChatCompletion).toHaveBeenCalledTimes(2);
    });

    it("sends configError when AI is not configured during sendMessage", async () => {
      const settings = createMockSettings({ baseUrl: "", modelId: "" });
      const { controller, port, tabState } = setup({ settings });

      // Manually set up tab state to bypass init
      tabState.set(42, {
        url: "https://example.com",
        title: "Test",
        summary: "Summary",
        conversation: {
          tabId: 42, url: "https://example.com", title: "Test",
          messages: [], createdAt: "2024-01-01", updatedAt: "2024-01-01",
        },
        extractionConfidence: "high",
        consecutiveFailures: 0,
      });

      controller.handleConnect(port);
      const listener = port.messageListeners[0];

      // Restore session first
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "conversationRestored")).toBe(true);
      });

      port.messages.length = 0;
      listener({ type: "sendMessage", text: "Hello" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "configError")).toBe(true);
      });
    });
  });

  describe("abort", () => {
    it("cancels in-flight request and retains partial content", async () => {
      let capturedReq: StreamChatCompletionRequest | null = null;
      const { controller, port } = setup({
        streamResult: {
          ok: false,
          reason: "aborted",
          detail: "Request was aborted",
          partialContent: "Partial summary",
        },
        onStreamCall: (req) => { capturedReq = req; },
      });

      controller.handleConnect(port);
      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // The aborted result sends streamEnd with partial content
      const endMsg = port.messages.find((m) => m.type === "streamEnd");
      if (endMsg && endMsg.type === "streamEnd") {
        expect(endMsg.fullContent).toBe("Partial summary");
      }
    });

    it("abort message triggers abort on the controller", async () => {
      // We need a streaming client that doesn't resolve immediately
      let resolveStream: ((result: StreamChatCompletionResult) => void) | null = null;
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn((req: StreamChatCompletionRequest) => {
          return new Promise<StreamChatCompletionResult>((resolve) => {
            resolveStream = resolve;
            // Listen for abort
            req.signal.addEventListener("abort", () => {
              resolve({
                ok: false,
                reason: "aborted",
                detail: "Aborted",
                partialContent: "partial",
              });
            });
          });
        }),
      };

      const tabState = createMockTabState();
      const extractContent = vi.fn().mockResolvedValue(createSuccessfulExtractionResult());
      const settings = createMockSettings();

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(settings),
        getSecureStore: () => createMockSecureStore(),
        extractContent,
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState,
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      // Wait for streaming to start
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamStart")).toBe(true);
      });

      // Send abort
      listener({ type: "abort" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });
    });
  });

  describe("retry", () => {
    it("re-sends the last failed user message on retry", async () => {
      let callCount = 0;
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
          callCount++;
          if (callCount <= 2) {
            // First two calls: explicit summarize (success) + sendMessage (fail)
            if (callCount === 1) {
              req.onToken("Summary");
              return { ok: true, content: "Summary" };
            }
            return {
              ok: false,
              reason: "network",
              detail: "Connection failed",
              partialContent: "",
            };
          }
          // Third call: retry succeeds
          req.onToken("Retry response");
          return { ok: true, content: "Retry response" };
        }),
      };

      const tabState = createMockTabState();
      const settings = createMockSettings();

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(settings),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState,
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);
      const listener = port.messageListeners[0];

      // Init + explicit summarize
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      port.messages.length = 0;

      // Send message that fails
      listener({ type: "sendMessage", text: "Hello" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      port.messages.length = 0;

      // Retry
      listener({ type: "retry" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const endMsg = port.messages.find((m) => m.type === "streamEnd");
      if (endMsg && endMsg.type === "streamEnd") {
        expect(endMsg.fullContent).toBe("Retry response");
      }
    });

    it("disables retry after 3 consecutive failures", async () => {
      let callCount = 0;
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
          callCount++;
          if (callCount === 1) {
            // Summarization succeeds
            req.onToken("Summary");
            return { ok: true, content: "Summary" };
          }
          // All subsequent calls fail
          return {
            ok: false,
            reason: "network",
            detail: "Connection failed",
            partialContent: "",
          };
        }),
      };

      const tabState = createMockTabState();
      const settings = createMockSettings();

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(settings),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState,
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);
      const listener = port.messageListeners[0];

      // Init + explicit summarize (succeeds)
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });
      port.messages.length = 0;

      // Send message that fails (failure 1)
      listener({ type: "sendMessage", text: "Hello" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      let errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.canRetry).toBe(true);
      }
      port.messages.length = 0;

      // Retry (failure 2)
      listener({ type: "retry" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.canRetry).toBe(true);
      }
      port.messages.length = 0;

      // Retry (failure 3)
      listener({ type: "retry" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.canRetry).toBe(false);
      }
      port.messages.length = 0;

      // Retry should be a no-op now (failures >= 3)
      listener({ type: "retry" });
      // Give it a moment to potentially process
      await new Promise((r) => setTimeout(r, 50));
      expect(port.messages).toHaveLength(0);
    });
  });

  describe("session management", () => {
    it("stores tab state after successful summarization", async () => {
      const { controller, port, tabState } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      expect(tabState.set).toHaveBeenCalled();
      const state = tabState.get(42);
      expect(state).toBeDefined();
      expect(state?.url).toBe("https://example.com/article");
      expect(state?.title).toBe("Test Article");
    });

    it("records user and assistant messages in conversation", async () => {
      const { controller, port, tabState } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      port.messages.length = 0;
      listener({ type: "sendMessage", text: "What is this about?" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const state = tabState.get(42);
      expect(state).toBeDefined();
      // Should have: summary (assistant) + user message + assistant response
      expect(state!.conversation.messages.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("port disconnect", () => {
    it("cancels in-flight request on disconnect", async () => {
      let resolveStream: ((result: StreamChatCompletionResult) => void) | null = null;
      const captured: { signal?: AbortSignal } = {};

      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn((req: StreamChatCompletionRequest) => {
          captured.signal = req.signal;
          return new Promise<StreamChatCompletionResult>((resolve) => {
            resolveStream = resolve;
            req.signal.addEventListener("abort", () => {
              resolve({
                ok: false,
                reason: "aborted",
                detail: "Aborted",
                partialContent: "",
              });
            });
          });
        }),
      };

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(createMockSettings()),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState: createMockTabState(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      // Wait for streaming to start
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamStart")).toBe(true);
      });

      // Disconnect
      port.disconnectListeners[0]();

      // The abort signal should have been triggered
      expect(captured.signal?.aborted).toBe(true);
    });
  });

  describe("message validation", () => {
    it("ignores invalid messages", async () => {
      const { controller, port } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];

      // Send invalid messages
      listener(null);
      listener(undefined);
      listener({ type: "unknown" });
      listener("not an object");
      listener(42);

      // No messages should be sent to the port
      expect(port.messages).toHaveLength(0);
    });
  });

  describe("streaming token delivery", () => {
    it("delivers tokens incrementally during summarization", async () => {
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
          req.onToken("Hello");
          req.onToken(" ");
          req.onToken("world");
          return { ok: true, content: "Hello world" };
        }),
      };

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(createMockSettings()),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState: createMockTabState(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const tokenMessages = port.messages.filter((m) => m.type === "streamToken");
      expect(tokenMessages.length).toBe(3);
      expect(tokenMessages.map((m) => m.type === "streamToken" && (m as any).token)).toEqual([
        "Hello", " ", "world",
      ]);
    });
  });

  describe("API key retrieval", () => {
    it("retrieves API key from secure store using apiKeyRef", async () => {
      const secureStore = createMockSecureStore("sk-real-key");
      const { controller, port, createStreamingClient: csClient } = setup();

      // Override the controller with our custom secure store
      const customController = createChatController({
        getSettings: vi.fn().mockResolvedValue(createMockSettings()),
        getSecureStore: () => secureStore,
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: csClient,
        tabState: createMockTabState(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const customPort = createMockPort();
      customController.handleConnect(customPort);

      const listener = customPort.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(customPort.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      await vi.waitFor(() => {
        expect(secureStore.getSecret).toHaveBeenCalledWith("ref-123");
      });

      await vi.waitFor(() => {
        expect(csClient).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: "sk-real-key" }),
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// CF-3.2 / CF-3.3 retry semantics (Q6 decision) and SF-1 cached confidence
// ---------------------------------------------------------------------------

describe("CF-3.3 retry accounting — controller is the single source of truth", () => {
  it("disables retry on the third consecutive summarize failure (same rule as the Q&A path)", async () => {
    const { controller, port } = setup({
      streamResult: { ok: false, reason: "network", detail: "boom", partialContent: "" },
    });
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    const errorsSeen = () =>
      port.messages.filter((m) => m.type === "streamError") as Array<{ canRetry: boolean }>;

    listener({ type: "summarize" });
    await vi.waitFor(() => expect(errorsSeen()).toHaveLength(1));
    listener({ type: "retry" });
    await vi.waitFor(() => expect(errorsSeen()).toHaveLength(2));
    listener({ type: "retry" });
    await vi.waitFor(() => expect(errorsSeen()).toHaveLength(3));

    expect(errorsSeen()[0].canRetry).toBe(true);
    expect(errorsSeen()[1].canRetry).toBe(true);
    expect(errorsSeen()[2].canRetry).toBe(false);
  });

  it("CF-3.2 a retried message appears exactly once in the AI context", async () => {
    const requests: StreamChatCompletionRequest[] = [];
    let callCount = 0;
    const mockClient: StreamingAiClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
        requests.push(req);
        callCount++;
        if (callCount === 1) {
          return { ok: false, reason: "network", detail: "fail", partialContent: "" };
        }
        req.onToken("ok");
        return { ok: true, content: "ok" };
      }),
    };
    const controller = createChatController({
      getSettings: vi.fn().mockResolvedValue(createMockSettings()),
      getSecureStore: () => createMockSecureStore(),
      extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
      createStreamingClient: vi.fn().mockReturnValue(mockClient),
      tabState: createMockTabState(),
    });
    const port = createMockPort();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 7 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    listener({ type: "sendMessage", text: "What is X?" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
    });

    listener({ type: "retry" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const retryRequest = requests[1];
    const occurrences = retryRequest.messages.filter(
      (m) => m.role === "user" && m.content === "What is X?",
    ).length;
    expect(occurrences).toBe(1);
  });

  it("retry with no message and no context answers with a streamError instead of silence", async () => {
    const { controller, port } = setup();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 9, url: "about:blank" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "freeChatReady")).toBe(true);
    });

    listener({ type: "retry" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
    });
    const err = port.messages.find((m) => m.type === "streamError") as { canRetry: boolean };
    expect(err.canRetry).toBe(false);
  });
});

describe("CF-3.8 context-window budget", () => {
  function setupWithHistory(overrides: { contextWindowTokens: number; oldTurnChars: number }) {
    const settings = createMockSettings({ baseUrl: OLLAMA_URL, contextWindowTokens: overrides.contextWindowTokens });

    let capturedReq: StreamChatCompletionRequest | null = null;
    const ctx = setup({
      settings,
      onStreamCall: (req) => { capturedReq = req; },
    });

    ctx.tabState.set(42, {
      url: "https://example.com",
      title: "Test",
      summary: "Summary",
      conversation: {
        tabId: 42,
        url: "https://example.com",
        title: "Test",
        messages: [
          { role: "user", content: "OLD_QUESTION_" + "x".repeat(overrides.oldTurnChars), timestamp: "2024-01-01T00:00:00.000Z" },
          { role: "assistant", content: "OLD_ANSWER_" + "y".repeat(overrides.oldTurnChars), timestamp: "2024-01-01T00:01:00.000Z" },
          { role: "user", content: "recent question", timestamp: "2024-01-01T00:02:00.000Z" },
          { role: "assistant", content: "recent answer", timestamp: "2024-01-01T00:03:00.000Z" },
        ],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:03:00.000Z",
      },
      extractionConfidence: "high",
      consecutiveFailures: 0,
    });

    return { ...ctx, getCapturedReq: () => capturedReq };
  }

  it("drops the oldest history turns first when they exceed the configured context window, keeping recent turns and the new message", async () => {
    // budgetChars = floor(700 * 4 * 0.75) = 2100 — comfortably fits the system
    // prompt, page context, the two short recent turns, and the new message,
    // but not the two ~60,000-char turns.
    const { controller, port, getCapturedReq } = setupWithHistory({ contextWindowTokens: 700, oldTurnChars: 60_000 });
    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "conversationRestored")).toBe(true);
    });

    listener({ type: "sendMessage", text: "follow-up question" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const req = getCapturedReq()!;
    const contents = req.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("OLD_QUESTION_"))).toBe(false);
    expect(contents.some((c) => c.includes("OLD_ANSWER_"))).toBe(false);
    expect(contents).toContain("recent question");
    expect(contents).toContain("recent answer");
    expect(contents).toContain("follow-up question");

    const streamStart = port.messages.find((m) => m.type === "streamStart") as { historyTruncated?: boolean };
    expect(streamStart.historyTruncated).toBe(true);
  });

  it("does not truncate and reports historyTruncated: false when history fits the configured window", async () => {
    const { controller, port, getCapturedReq } = setupWithHistory({ contextWindowTokens: 8192, oldTurnChars: 50 });
    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "conversationRestored")).toBe(true);
    });

    listener({ type: "sendMessage", text: "another question" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const req = getCapturedReq()!;
    const contents = req.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("OLD_QUESTION_"))).toBe(true);
    expect(contents.some((c) => c.includes("OLD_ANSWER_"))).toBe(true);

    const streamStart = port.messages.find((m) => m.type === "streamStart") as { historyTruncated?: boolean };
    expect(streamStart.historyTruncated).toBe(false);
  });
});

describe("SF-8 logging", () => {
  function makeSpyLogger() {
    return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it("logs a debug message when history is truncated to fit the context window (CF-3.8)", async () => {
    const logger = makeSpyLogger();
    const settings = createMockSettings({ baseUrl: OLLAMA_URL, contextWindowTokens: 700 });
    const { controller, port } = setup({ settings, logger });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    // Build up enough conversation history via successive sendMessage calls
    // that the small configured window forces a truncation on a later turn.
    for (let i = 0; i < 3; i++) {
      listener({ type: "sendMessage", text: "x".repeat(2000) });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });
      port.messages.length = 0;
    }

    listener({ type: "sendMessage", text: "one more" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    expect(logger.debug).toHaveBeenCalled();
    const debugArgs = logger.debug.mock.calls.flat();
    expect(debugArgs.some((a) => typeof a === "string" && a.includes("CF-3.8"))).toBe(true);
  });

  it("logs a warn when a Q&A stream fails", async () => {
    const logger = makeSpyLogger();
    const { controller, port } = setup({
      logger,
      streamResult: { ok: false, reason: "network", detail: "Network error", partialContent: "" },
    });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
    });

    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("SF-1 / CF-3.2 summarize includes every context tab's content", () => {
  it("includes all three articles in the summarize request, not just the primary tab", async () => {
    const articlesByTab: Record<number, { title: string; bodyMarkdown: string; sourceUrl: string }> = {
      42: { title: "Primary Article", bodyMarkdown: "Primary content.", sourceUrl: "https://example.com/primary" },
      43: { title: "Second Article", bodyMarkdown: "Second content.", sourceUrl: "https://example.com/second" },
      44: { title: "Third Article", bodyMarkdown: "Third content.", sourceUrl: "https://example.com/third" },
    };

    let capturedRequest: StreamChatCompletionRequest | undefined;
    const { controller, port, extractContent } = setup({
      onStreamCall: (req) => {
        capturedRequest = req;
      },
    });

    extractContent.mockImplementation(async (tabId: number) => {
      const a = articlesByTab[tabId];
      return {
        ok: true,
        article: {
          title: a.title,
          author: null,
          publicationDate: null,
          sourceUrl: a.sourceUrl,
          siteName: "",
          bodyMarkdown: a.bodyMarkdown,
          bodyCharacterCount: a.bodyMarkdown.length,
        },
        confidence: "high",
      };
    });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    listener({ type: "addContextTab", tabId: 43 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(1);
    });

    listener({ type: "addContextTab", tabId: 44 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(2);
    });

    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    expect(capturedRequest).toBeDefined();
    const userMessage = capturedRequest!.messages.find((m) => m.role === "user")!;
    expect(userMessage.content).toContain("Primary content.");
    expect(userMessage.content).toContain("Second content.");
    expect(userMessage.content).toContain("Third content.");
    expect(userMessage.content).toContain("Primary Article");
    expect(userMessage.content).toContain("Second Article");
    expect(userMessage.content).toContain("Third Article");
  });

  it("tells the model explicitly it has multiple separate sources, not just one page", async () => {
    let capturedRequest: StreamChatCompletionRequest | undefined;
    const { controller, port } = setup({
      settings: createMockSettings({ systemPrompt: "" }),
      onStreamCall: (req) => {
        capturedRequest = req;
      },
    });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    listener({ type: "addContextTab", tabId: 43 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(1);
    });
    listener({ type: "addContextTab", tabId: 44 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(2);
    });

    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const systemMessage = capturedRequest!.messages.find((m) => m.role === "system")!;
    expect(systemMessage.content).toContain("3 separate web pages");
    expect(systemMessage.content).toContain('never refer to them collectively as "the article"');
  });

  it("does not add multi-source guidance to the default system prompt for a single article", async () => {
    let capturedRequest: StreamChatCompletionRequest | undefined;
    const { controller, port } = setup({
      settings: createMockSettings({ systemPrompt: "" }),
      onStreamCall: (req) => {
        capturedRequest = req;
      },
    });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const systemMessage = capturedRequest!.messages.find((m) => m.role === "system")!;
    expect(systemMessage.content).not.toContain("separate web pages");
  });

  it("keeps all three articles available for a follow-up asked immediately after summarize (no reconnect at all)", async () => {
    const articlesByTab: Record<number, { title: string; bodyMarkdown: string; sourceUrl: string }> = {
      42: { title: "Primary Article", bodyMarkdown: "Primary content.", sourceUrl: "https://example.com/primary" },
      43: { title: "Second Article", bodyMarkdown: "Second content.", sourceUrl: "https://example.com/second" },
      44: { title: "Third Article", bodyMarkdown: "Third content.", sourceUrl: "https://example.com/third" },
    };

    let capturedRequest: StreamChatCompletionRequest | undefined;
    const { controller, port, extractContent } = setup({
      onStreamCall: (req) => {
        capturedRequest = req;
      },
    });

    extractContent.mockImplementation(async (tabId: number) => {
      const a = articlesByTab[tabId];
      return {
        ok: true,
        article: {
          title: a.title,
          author: null,
          publicationDate: null,
          sourceUrl: a.sourceUrl,
          siteName: "",
          bodyMarkdown: a.bodyMarkdown,
          bodyCharacterCount: a.bodyMarkdown.length,
        },
        confidence: "high",
      };
    });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    listener({ type: "addContextTab", tabId: 43 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(1);
    });
    listener({ type: "addContextTab", tabId: 44 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(2);
    });

    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    // No reconnect, no tab switch — straight to the follow-up.
    listener({ type: "sendMessage", text: "What articles were cited for this summary?" });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "streamEnd")).toHaveLength(2);
    });

    const userMessages = capturedRequest!.messages.filter((m) => m.role === "user");
    const combined = userMessages.map((m) => m.content).join("\n");
    expect(combined).toContain("Second Article");
    expect(combined).toContain("Third Article");
    expect(combined).toContain("https://example.com/second");
    expect(combined).toContain("https://example.com/third");
  });

  it("keeps all three articles available for a follow-up question after a same-tab reconnect (no tab switch)", async () => {
    const articlesByTab: Record<number, { title: string; bodyMarkdown: string; sourceUrl: string }> = {
      42: { title: "Primary Article", bodyMarkdown: "Primary content.", sourceUrl: "https://example.com/primary" },
      43: { title: "Second Article", bodyMarkdown: "Second content.", sourceUrl: "https://example.com/second" },
      44: { title: "Third Article", bodyMarkdown: "Third content.", sourceUrl: "https://example.com/third" },
    };

    let capturedRequest: StreamChatCompletionRequest | undefined;
    const { controller, port, extractContent } = setup({
      onStreamCall: (req) => {
        capturedRequest = req;
      },
    });

    extractContent.mockImplementation(async (tabId: number) => {
      const a = articlesByTab[tabId];
      return {
        ok: true,
        article: {
          title: a.title,
          author: null,
          publicationDate: null,
          sourceUrl: a.sourceUrl,
          siteName: "",
          bodyMarkdown: a.bodyMarkdown,
          bodyCharacterCount: a.bodyMarkdown.length,
        },
        confidence: "high",
      };
    });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    listener({ type: "addContextTab", tabId: 43 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(1);
    });
    listener({ type: "addContextTab", tabId: 44 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(2);
    });

    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    // Simulate the background page idle-unloading and the sidebar's
    // reconnect-replay re-initializing the SAME tab (no tab switch at all —
    // this is the CF-3.6 resync path, distinct from an SF-1 tab switch).
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "conversationRestored")).toHaveLength(1);
    });

    listener({ type: "sendMessage", text: "What articles were cited for this summary?" });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "streamEnd")).toHaveLength(2);
    });

    const userMessages = capturedRequest!.messages.filter((m) => m.role === "user");
    const combined = userMessages.map((m) => m.content).join("\n");
    expect(combined).toContain("Second Article");
    expect(combined).toContain("Third Article");
  });

  it("keeps both added tabs available in free-chat mode after a same-tab reconnect", async () => {
    const articlesByTab: Record<number, { title: string; bodyMarkdown: string; sourceUrl: string }> = {
      43: { title: "Second Article", bodyMarkdown: "Second content.", sourceUrl: "https://example.com/second" },
      44: { title: "Third Article", bodyMarkdown: "Third content.", sourceUrl: "https://example.com/third" },
    };

    let capturedRequest: StreamChatCompletionRequest | undefined;
    const { controller, port, extractContent } = setup({
      onStreamCall: (req) => {
        capturedRequest = req;
      },
    });

    extractContent.mockImplementation(async (tabId: number) => {
      const a = articlesByTab[tabId];
      return {
        ok: true,
        article: {
          title: a.title,
          author: null,
          publicationDate: null,
          sourceUrl: a.sourceUrl,
          siteName: "",
          bodyMarkdown: a.bodyMarkdown,
          bodyCharacterCount: a.bodyMarkdown.length,
        },
        confidence: "high",
      };
    });

    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 9, url: "about:blank" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "freeChatReady")).toBe(true);
    });

    listener({ type: "addContextTab", tabId: 43 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(1);
    });
    listener({ type: "addContextTab", tabId: 44 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(2);
    });

    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    // Same-tab reconnect — no tab switch, just a resync of free-chat.
    listener({ type: "init", tabId: 9, url: "about:blank" });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "freeChatReady")).toHaveLength(2);
    });
    // Both previously-added tabs are restored, not just wiped.
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(4);
    });

    listener({ type: "sendMessage", text: "What were the sources?" });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "streamEnd")).toHaveLength(2);
    });

    const userMessages = capturedRequest!.messages.filter((m) => m.role === "user");
    const combined = userMessages.map((m) => m.content).join("\n");
    expect(combined).toContain("Second Article");
    expect(combined).toContain("Third Article");
  });
});

describe("CF-2.8 model attribution", () => {
  it("includes the model on streamEnd for a summarize response", async () => {
    const { controller, port } = setup();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const streamEnd = port.messages.find((m) => m.type === "streamEnd") as { model?: string };
    expect(streamEnd.model).toBe("gpt-4");
  });

  it("persists the model on the stored assistant message so it survives a reconnect", async () => {
    const { controller, port } = setup();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    // Reconnect on the same tab (resync) — the restored message should carry the model.
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "conversationRestored")).toHaveLength(1);
    });

    const restored = port.messages.find((m) => m.type === "conversationRestored") as unknown as {
      messages: ReadonlyArray<{ model?: string }>;
    };
    expect(restored.messages[0].model).toBe("gpt-4");
  });

  it("includes the model on streamEnd for a Q&A follow-up", async () => {
    const { controller, port } = setup();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    listener({ type: "summarize" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    listener({ type: "sendMessage", text: "What about X?" });
    await vi.waitFor(() => {
      expect(port.messages.filter((m) => m.type === "streamEnd")).toHaveLength(2);
    });

    const streamEnds = port.messages.filter((m) => m.type === "streamEnd") as Array<{ model?: string }>;
    expect(streamEnds[1].model).toBe("gpt-4");
  });

  it("includes the model on a retried Q&A message that succeeds", async () => {
    const requests: StreamChatCompletionRequest[] = [];
    let callCount = 0;
    const mockClient: StreamingAiClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
        requests.push(req);
        callCount++;
        if (callCount === 1) {
          return { ok: false, reason: "network", detail: "fail", partialContent: "" };
        }
        req.onToken("ok");
        return { ok: true, content: "ok" };
      }),
    };
    const controller = createChatController({
      getSettings: vi.fn().mockResolvedValue(createMockSettings()),
      getSecureStore: () => createMockSecureStore(),
      extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
      createStreamingClient: vi.fn().mockReturnValue(mockClient),
      tabState: createMockTabState(),
    });
    const port = createMockPort();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 7 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    listener({ type: "sendMessage", text: "What is X?" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
    });

    listener({ type: "retry" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const streamEnd = port.messages.find((m) => m.type === "streamEnd") as { model?: string };
    expect(streamEnd.model).toBe("gpt-4");
  });
});

describe("SF-1 restored sessions report cached confidence honestly", () => {
  it("passes null confidence through instead of defaulting to high", async () => {
    const { controller, port, tabState } = setup();
    tabState.set(42, {
      url: "https://example.com/article",
      title: "Cached",
      summary: null,
      conversation: {
        tabId: 42,
        url: "https://example.com/article",
        title: "Cached",
        messages: [],
        createdAt: "t",
        updatedAt: "t",
      },
      extractionConfidence: null,
      consecutiveFailures: 0,
    });
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42, url: "https://example.com/article" });

    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextTabAdded")).toBe(true);
    });
    const added = port.messages.find((m) => m.type === "contextTabAdded") as {
      confidence: "high" | "medium" | "low" | null;
    };
    expect(added.confidence).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review fixes — CF-3.8 retry pinning, CF-3.9 overhead accounting
// ---------------------------------------------------------------------------

describe("CF-3.8 retry never drops the retried message", () => {
  it("keeps the retried question as the final message even when it doesn't fit alongside the page context", async () => {
    // budgetChars = floor(700 * 4 * 0.75) = 2100. The page context (~1,000 chars)
    // leaves ~1,100 chars of room — less than the 1,500-char question. A retried
    // message that is treated as droppable history would vanish from the prompt.
    const bigQuestion = "RETRIED_QUESTION_" + "q".repeat(1500);
    const requests: StreamChatCompletionRequest[] = [];
    let call = 0;
    const mockClient: StreamingAiClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
        call++;
        requests.push(req);
        if (call === 1) return { ok: false, reason: "network", detail: "boom", partialContent: "" };
        req.onToken("ok");
        return { ok: true, content: "ok" };
      }),
    };
    const controller = createChatController({
      getSettings: vi.fn().mockResolvedValue(createMockSettings({ baseUrl: OLLAMA_URL, contextWindowTokens: 700 })),
      getSecureStore: () => createMockSecureStore(),
      extractContent: vi.fn().mockResolvedValue({
        ok: true,
        article: {
          title: "T", author: null, publicationDate: null, sourceUrl: "https://example.com/a",
          siteName: "", bodyMarkdown: "P".repeat(1000), bodyCharacterCount: 1000,
        },
        confidence: "high",
      }),
      createStreamingClient: vi.fn().mockReturnValue(mockClient),
      tabState: createMockTabState(),
      clock: () => "2024-01-15T10:00:00.000Z",
    });
    const port = createMockPort();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];

    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true));
    listener({ type: "sendMessage", text: bigQuestion });
    await vi.waitFor(() => expect(port.messages.some((m) => m.type === "streamError")).toBe(true));
    port.messages.length = 0;
    listener({ type: "retry" });
    await vi.waitFor(() => expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true));

    const retryReq = requests[1];
    const last = retryReq.messages[retryReq.messages.length - 1];
    expect(last).toEqual({ role: "user", content: bigQuestion });
    // ...and it appears exactly once (CF-3.2/3.3)
    expect(retryReq.messages.filter((m) => m.content === bigQuestion)).toHaveLength(1);
  });
});

describe("CF-3.9 context content budget", () => {
  const articleOf = (title: string, body: string) => ({
    title, author: null, publicationDate: null,
    sourceUrl: `https://example.com/${title.toLowerCase()}`, siteName: "",
    bodyMarkdown: body, bodyCharacterCount: body.length,
  });

  type Ctx = ReturnType<typeof setup>;

  function build(opts: { baseUrl: string; provider?: AiProvider; contextWindowTokens: number; systemPrompt?: string; bodies: Record<number, string> }) {
    let captured: StreamChatCompletionRequest | undefined;
    const ctx = setup({
      settings: createMockSettings({
        baseUrl: opts.baseUrl,
        provider: opts.provider ?? (opts.baseUrl === OLLAMA_URL ? "ollama" : "openai-compatible"),
        contextWindowTokens: opts.contextWindowTokens,
        systemPrompt: opts.systemPrompt ?? "S".repeat(100),
      }),
      onStreamCall: (req) => { captured = req; },
    });
    ctx.extractContent.mockImplementation(async (tabId: number) => ({
      ok: true, article: articleOf(`Tab${tabId}`, opts.bodies[tabId]), confidence: "high",
    }));
    return { ...ctx, getCaptured: () => captured! };
  }

  async function connect(ctx: Ctx, extraTabs: number[] = []): Promise<(m: unknown) => void> {
    ctx.controller.handleConnect(ctx.port);
    const listener = ctx.port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => expect(ctx.port.messages.some((m) => m.type === "contextLoaded")).toBe(true));
    for (let i = 0; i < extraTabs.length; i++) {
      listener({ type: "addContextTab", tabId: extraTabs[i] });
      await vi.waitFor(() => expect(ctx.port.messages.filter((m) => m.type === "contextTabAdded")).toHaveLength(i + 1));
    }
    return listener;
  }

  async function finish(ctx: Ctx): Promise<void> {
    await vi.waitFor(() => expect(ctx.port.messages.some((m) => m.type === "streamEnd")).toBe(true));
  }

  const totalChars = (req: StreamChatCompletionRequest) => req.messages.reduce((n, m) => n + m.content.length, 0);
  const startMsg = (ctx: Ctx) =>
    ctx.port.messages.find((m) => m.type === "streamStart") as { contextTruncated?: boolean; historyTruncated?: boolean };

  it("summarize: sends every tab in full when everything fits", async () => {
    const ctx = build({ baseUrl: OLLAMA_URL, contextWindowTokens: 8192, bodies: { 42: "PRIMARY_" + "p".repeat(500), 43: "SECOND_" + "s".repeat(500) } });
    const listener = await connect(ctx, [43]);
    listener({ type: "summarize" });
    await finish(ctx);

    const user = ctx.getCaptured().messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("p".repeat(500));
    expect(user).toContain("s".repeat(500));
    expect(startMsg(ctx).contextTruncated).toBe(false);
  });

  it("summarize: long tracking URLs are shortened in the prompt so real content fits (labels kept)", async () => {
    const tracking = "https://r.example.com/aff?" + "utm_junk=1&".repeat(40);
    const body = "Intro text. " + Array.from({ length: 5 }, (_, i) => `[Offer ${i}](${tracking})`).join(" ");
    const ctx = build({ baseUrl: OLLAMA_URL, contextWindowTokens: 8192, bodies: { 42: body } });
    const listener = await connect(ctx);
    listener({ type: "summarize" });
    await finish(ctx);

    const user = ctx.getCaptured().messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("[Offer 0](https://r.example.com/aff)");
    expect(user).toContain("[Offer 4](https://r.example.com/aff)");
    expect(user).not.toContain("utm_junk");
  });

  it("summarize: shortens every tab (keeping the start of each) so the prompt fits the window", async () => {
    // budgetChars = floor(400 * 4 * 0.75) = 1200
    const ctx = build({ baseUrl: OLLAMA_URL, contextWindowTokens: 400, bodies: { 42: "PRIMARY_" + "p".repeat(3000), 43: "SECOND_" + "s".repeat(3000) } });
    const listener = await connect(ctx, [43]);
    listener({ type: "summarize" });
    await finish(ctx);

    const user = ctx.getCaptured().messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("PRIMARY_");
    expect(user).toContain("SECOND_");
    expect(totalChars(ctx.getCaptured())).toBeLessThanOrEqual(1200);
    expect(startMsg(ctx).contextTruncated).toBe(true);
    const kept = (startMsg(ctx) as { contextKeptPercent?: number }).contextKeptPercent!;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(100);
  });

  it("Q&A: shortens tab content so the prompt (system prompt, page-context wrapper, bodies, question) fits the window", async () => {
    const ctx = build({ baseUrl: OLLAMA_URL, contextWindowTokens: 400, bodies: { 42: "PRIMARY_" + "p".repeat(3000), 43: "SECOND_" + "s".repeat(3000) } });
    const listener = await connect(ctx, [43]);
    listener({ type: "sendMessage", text: "question?" });
    await finish(ctx);

    const all = ctx.getCaptured().messages.map((m) => m.content).join("\n");
    expect(all).toContain("PRIMARY_");
    expect(all).toContain("SECOND_");
    expect(totalChars(ctx.getCaptured())).toBeLessThanOrEqual(1200);
    expect(startMsg(ctx).contextTruncated).toBe(true);
  });

  it("never budgets a non-Ollama endpoint: huge pages, tabs and history go through untouched, with no truncation flags", async () => {
    const ctx = build({
      baseUrl: "https://api.example.com", contextWindowTokens: 512,
      bodies: { 42: "PRIMARY_" + "p".repeat(20_000), 43: "SECOND_" + "s".repeat(20_000) },
    });
    const listener = await connect(ctx, [43]);
    listener({ type: "sendMessage", text: "question?" });
    await finish(ctx);

    const all = ctx.getCaptured().messages.map((m) => m.content).join("\n");
    expect(all).toContain("p".repeat(20_000));
    expect(all).toContain("s".repeat(20_000));
    expect(startMsg(ctx).contextTruncated).toBeFalsy();
    expect(startMsg(ctx).historyTruncated).toBeFalsy();
  });

  it("never trims conversation history on a non-Ollama endpoint", async () => {
    let captured: StreamChatCompletionRequest | undefined;
    const ctx = setup({
      settings: createMockSettings({ baseUrl: "https://api.example.com", contextWindowTokens: 512 }),
      onStreamCall: (req) => { captured = req; },
    });
    ctx.tabState.set(42, {
      url: "https://example.com", title: "Test", summary: "Summary",
      conversation: {
        tabId: 42, url: "https://example.com", title: "Test",
        messages: [
          { role: "user", content: "OLD_QUESTION_" + "x".repeat(50_000), timestamp: "2024-01-01T00:00:00.000Z" },
          { role: "assistant", content: "OLD_ANSWER_" + "y".repeat(50_000), timestamp: "2024-01-01T00:01:00.000Z" },
        ],
        createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:01:00.000Z",
      },
      extractionConfidence: "high", consecutiveFailures: 0,
    });
    ctx.controller.handleConnect(ctx.port);
    const listener = ctx.port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => expect(ctx.port.messages.some((m) => m.type === "conversationRestored")).toBe(true));
    listener({ type: "sendMessage", text: "next?" });
    await finish(ctx);

    const contents = captured!.messages.map((m) => m.content);
    expect(contents.some((c) => c.startsWith("OLD_QUESTION_"))).toBe(true);
    expect(contents.some((c) => c.startsWith("OLD_ANSWER_"))).toBe(true);
    const start = ctx.port.messages.find((m) => m.type === "streamStart") as { historyTruncated?: boolean };
    expect(start.historyTruncated).toBeFalsy();
  });
});
