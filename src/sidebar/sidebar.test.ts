/**
 * Sidebar state-machine and rendering tests.
 *
 * Follows the content/main.test.ts pattern: a global `browser` mock plus
 * dynamic import, driving the sidebar through its real init flow and the
 * port protocol, then asserting on the rendered DOM.
 *
 * Covers CF-2.2/2.4/2.5 (streaming render, badges, abort keeps partial),
 * CF-3.3 (error keeps conversation; retried streams render), CF-4.4
 * (default destination, clipboard delivery).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ControllerToSidebarMessage } from "@shared/port-protocol";

// ─── Browser mock ────────────────────────────────────────────────────────────

interface MockPort {
  onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  onDisconnect: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  postMessage: ReturnType<typeof vi.fn>;
}

let portListeners: Array<(msg: unknown) => void>;
let mockPort: MockPort;
let sentRuntimeMessages: unknown[];
let localStorageData: Record<string, unknown>;
let syncStorageData: Record<string, unknown>;
let runtimeSendResponse: unknown;
let tabActivatedListeners: Array<(info: { tabId: number; windowId: number }) => void>;
let runtimeMessageListeners: Array<(msg: unknown) => void>;
let tabUrlById: Record<number, string>;

async function activateTab(tabId: number): Promise<void> {
  for (const cb of tabActivatedListeners) cb({ tabId, windowId: 1 });
  await flush();
}

function installBrowserMock(): void {
  portListeners = [];
  sentRuntimeMessages = [];
  runtimeSendResponse = { payload: { ok: true, filename: "x.md" } };
  tabActivatedListeners = [];
  runtimeMessageListeners = [];
  tabUrlById = {
    42: "https://example.com/article",
    43: "https://example.com/other",
    44: "https://example.com/third",
  };

  mockPort = {
    onMessage: {
      addListener: vi.fn((cb: (msg: unknown) => void) => portListeners.push(cb)),
      removeListener: vi.fn(),
    },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    postMessage: vi.fn(),
  };

  Object.defineProperty(globalThis, "browser", {
    value: {
      runtime: {
        // A real reconnect yields a brand-new Port; the old one never fires
        // again. Clearing portListeners here mirrors that — otherwise the
        // stale pre-disconnect listener stays registered on the same mock
        // object and every subsequent emit() double-dispatches messages.
        connect: vi.fn(() => {
          portListeners = [];
          return mockPort;
        }),
        sendMessage: vi.fn(async (msg: unknown) => {
          sentRuntimeMessages.push(msg);
          return runtimeSendResponse;
        }),
        onMessage: {
          addListener: vi.fn((cb: (msg: unknown) => void) => { runtimeMessageListeners.push(cb); }),
          removeListener: vi.fn(),
        },
        openOptionsPage: vi.fn(),
        getManifest: vi.fn(() => ({ version: "4.0.0" })),
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: localStorageData[key] })),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
        sync: {
          get: vi.fn(async (key: string) => ({ [key]: syncStorageData[key] })),
        },
      },
      windows: {
        getCurrent: vi.fn(async () => ({ id: 1 })),
      },
      tabs: {
        query: vi.fn(async () => [{ id: 42, url: tabUrlById[42], active: true, windowId: 1 }]),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: tabUrlById[tabId], windowId: 1 })),
        onActivated: {
          addListener: vi.fn((cb: (info: { tabId: number; windowId: number }) => void) => {
            tabActivatedListeners.push(cb);
          }),
          removeListener: vi.fn(),
        },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    },
    writable: true,
    configurable: true,
  });
}

async function loadSidebar(): Promise<void> {
  document.body.className = "";
  document.body.innerHTML = '<div id="app"></div>';
  await import("./sidebar");
  // Let the async init sequence settle (storage reads, tracker setup, port init)
  await flush();
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function emit(msg: ControllerToSidebarMessage): void {
  for (const cb of portListeners) cb(msg);
}

function emitRaw(msg: unknown): void {
  for (const cb of portListeners) cb(msg);
}

function app(): HTMLElement {
  return document.getElementById("app")!;
}

const contextLoaded: ControllerToSidebarMessage = {
  type: "contextLoaded",
  title: "Test Article",
  url: "https://example.com/article",
  confidence: "high",
  hasSavedPattern: false,
  wordCount: 1000,
};

beforeEach(() => {
  localStorageData = {};
  syncStorageData = {};
  installBrowserMock();
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sidebar init", () => {
  it("connects the chat port and sends init for the active tab", async () => {
    await loadSidebar();

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "init", tabId: 42 }),
    );
  });

  it("renders no in-page title (Firefox's sidebar title bar already names the extension)", async () => {
    await loadSidebar();

    expect(app().querySelector(".sidebar-header h1")).toBeNull();
    expect(app().querySelector(".sidebar-header .btn-help")).not.toBeNull();
  });
});

describe("SF-7 Help menu", () => {
  it("is present in every phase, closed by default", async () => {
    await loadSidebar();

    expect(app().querySelector(".btn-help")).not.toBeNull();
    expect(app().querySelector(".help-menu-dropdown")).toBeNull();
  });

  it("opens on click and shows the installed version", async () => {
    await loadSidebar();

    (app().querySelector(".btn-help") as HTMLButtonElement).click();

    expect(app().querySelector(".help-menu-version")?.textContent).toContain("4.0.0");
  });

  it("closes when the toggle button is clicked again", async () => {
    await loadSidebar();

    const helpBtn = app().querySelector(".btn-help") as HTMLButtonElement;
    helpBtn.click();
    helpBtn.click();

    expect(app().querySelector(".help-menu-dropdown")).toBeNull();
  });

  it("closes via the explicit close button", async () => {
    await loadSidebar();

    (app().querySelector(".btn-help") as HTMLButtonElement).click();
    (app().querySelector(".help-menu-close") as HTMLButtonElement).click();

    expect(app().querySelector(".help-menu-dropdown")).toBeNull();
  });

  it("links to Issues and Releases safely in a new tab", async () => {
    await loadSidebar();

    (app().querySelector(".btn-help") as HTMLButtonElement).click();

    const links = app().querySelectorAll<HTMLAnchorElement>(".help-menu-external");
    expect(links.length).toBe(2);
    expect(Array.from(links).map((a) => a.href)).toEqual([
      "https://github.com/dstaulcu/page-distill/issues",
      "https://github.com/dstaulcu/page-distill/releases",
    ]);
    for (const link of links) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener");
    }
  });

  it("has a Settings entry that opens the options page and closes the menu", async () => {
    await loadSidebar();

    (app().querySelector(".btn-help") as HTMLButtonElement).click();

    const settingsLink = app().querySelector<HTMLAnchorElement>(".help-menu-settings");
    expect(settingsLink).not.toBeNull();
    expect(settingsLink?.textContent).toContain("Settings");

    settingsLink!.click();

    expect(browser.runtime.openOptionsPage).toHaveBeenCalled();
    expect(app().querySelector(".help-menu-dropdown")).toBeNull();
  });
});

describe("CF-2.4 pre-summary view", () => {
  it("shows the article title, reading-time badge, and Summarize button", async () => {
    await loadSidebar();
    emit(contextLoaded);

    expect(app().querySelector(".page-info-title")?.textContent).toBe("Test Article");
    // 1000 words / 200 wpm = 5 min
    expect(app().querySelector(".page-info-reading-time")?.textContent).toBe("~5 min read");
    expect(app().querySelector(".btn-summarize")).not.toBeNull();
  });

  it("shows the time-saved hint once a summary exists", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "Summary", timestamp: "t" }] });

    expect(app().querySelector(".time-saved-hint")?.textContent).toBe("✓ ~5 min saved");
  });
});

describe("CF-2.2 / CF-2.5 summarization streaming and abort", () => {
  it("streams tokens into the partial content while summarizing", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();

    emit({ type: "streamToken", token: "Hello " });
    emit({ type: "streamToken", token: "world" });

    expect(app().querySelector(".partial-content")?.textContent).toContain("Hello world");
  });

  it("keeps the partial visible after Cancel (abort → streamEnd with partial)", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamToken", token: "Partial summary text" });

    (app().querySelector(".btn-abort") as HTMLButtonElement).click();
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: "abort" });

    // Controller answers the abort with the partial content
    emit({ type: "streamEnd", fullContent: "Partial summary text" });

    const messages = app().querySelectorAll(".message-assistant");
    expect(messages).toHaveLength(1);
    expect(messages[0].textContent).toContain("Partial summary text");
  });

  it("does not append an empty message when an abort produced no content", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamEnd", fullContent: "" });

    expect(app().querySelectorAll(".message")).toHaveLength(0);
    expect(app().querySelector(".btn-summarize")).not.toBeNull(); // back to ready
  });
});

describe("CF-2.8 model attribution", () => {
  it("shows which model produced a freshly streamed summary", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamEnd", fullContent: "Summary text", model: "llama3" });

    expect(app().querySelector(".message-model")?.textContent).toBe("llama3");
  });

  it("shows the model on a restored conversation's message, not just a fresh stream", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({
      type: "conversationRestored",
      messages: [{ role: "assistant", content: "The summary", timestamp: "t", model: "llama3" }],
    });

    expect(app().querySelector(".message-model")?.textContent).toBe("llama3");
  });

  it("does not show a model label for the user's own messages", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({
      type: "conversationRestored",
      messages: [
        { role: "user", content: "Hi", timestamp: "t" },
        { role: "assistant", content: "Hello", timestamp: "t2", model: "llama3" },
      ],
    });

    expect(app().querySelectorAll(".message-model")).toHaveLength(1);
  });
});

describe("SF-2 free-chat summarize", () => {
  const otherTabAdded: ControllerToSidebarMessage = {
    type: "contextTabAdded",
    tabId: 99,
    url: "https://example.com/other",
    title: "Other Article",
    confidence: "high",
  };

  it("offers a Summarize action once a context tab is added, before any messages exist", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });

    // No context yet — no way to summarize nothing.
    expect(app().querySelector(".btn-summarize")).toBeNull();

    emit(otherTabAdded);

    expect(app().querySelector(".btn-summarize")).not.toBeNull();
  });

  it("summarizing from free-chat sends summarize and returns to free-chat (not ready) after the stream ends", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });
    emit(otherTabAdded);

    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "summarize" }),
    );

    emit({ type: "streamStart" });
    emit({ type: "streamEnd", fullContent: "Findings: it's a good article." });

    expect(app().textContent).toContain("Findings");
    // Free-chat's Reset/New Chat header buttons don't show for "ready" —
    // staying out of "ready" proves the round-trip preserved free-chat's
    // multi-tab context semantics instead of collapsing to single-tab "ready".
    expect(app().querySelector(".btn-reset")).toBeNull();
  });

  it("lets the user update the summary after adding a tab, appending it to the chat", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });
    emit(otherTabAdded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart" });
    emit({ type: "streamEnd", fullContent: "First summary." });

    // A summary exists now; the one-shot Summarize action is gone but an update is offered.
    expect(app().querySelector(".btn-summarize")).toBeNull();
    emit({ ...otherTabAdded, tabId: 100, title: "Third Article" });
    const update = app().querySelector(".btn-resummarize") as HTMLButtonElement;
    expect(update).not.toBeNull();

    mockPort.postMessage.mockClear();
    update.click();
    expect(mockPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "summarize" }));

    emit({ type: "streamStart" });
    emit({ type: "streamEnd", fullContent: "Updated summary." });

    expect(app().textContent).toContain("First summary.");
    expect(app().textContent).toContain("Updated summary.");
  });

  it("keeps a previously added context tab when a resync happens mid-add (background idle-unload)", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });
    emit(otherTabAdded);

    expect(app().querySelector(".btn-summarize")).not.toBeNull();

    // Background idle-unloads while the user is about to add a second tab.
    const disconnectCb = mockPort.onDisconnect.addListener.mock.calls[0][0] as () => void;
    disconnectCb();

    // Clicking "+ Add tab" fires getOpenTabs over the stale port, which
    // reconnects and replays init before the real request.
    (app().querySelector(".context-chip-add") as HTMLButtonElement).click();

    // The controller's reply to the replayed init — a fresh free-chat
    // start, since nothing has been cached yet — must not wipe the tab
    // already added or drop back out of free-chat.
    emit({ type: "freeChatReady", messages: [] });

    expect(app().querySelectorAll(".context-chip-remove")).toHaveLength(1);
    expect(app().querySelector(".btn-summarize")).not.toBeNull();

    // The real getOpenTabs response still arrives and adding a second tab
    // still works normally afterward.
    emit({ type: "openTabs", tabs: [{ tabId: 100, title: "Third Article", url: "https://example.com/third" }] });
    (app().querySelector(".tab-picker-item") as HTMLButtonElement).click();
    emit({
      type: "contextTabAdded",
      tabId: 100,
      url: "https://example.com/third",
      title: "Third Article",
      confidence: "high",
    });

    expect(app().querySelectorAll(".context-chip-remove")).toHaveLength(2);
  });
});

describe("CF-3.3 stream errors and retry", () => {
  async function reachStreamingWithHistory(): Promise<void> {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });
    // User sends a follow-up
    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = "What about X?";
    (app().querySelector(".btn-send") as HTMLButtonElement).click();
  }

  it("shows the error alongside the existing conversation, not instead of it", async () => {
    await reachStreamingWithHistory();
    emit({ type: "streamError", reason: "Connection failed", partialContent: "", canRetry: true });

    expect(app().querySelector(".error-reason")?.textContent).toBe("Connection failed");
    // The conversation is still visible
    expect(app().textContent).toContain("The summary");
    expect(app().textContent).toContain("What about X?");
  });

  it("renders a retried stream like a first attempt instead of getting stuck", async () => {
    await reachStreamingWithHistory();
    emit({ type: "streamError", reason: "Connection failed", partialContent: "", canRetry: true });

    (app().querySelector(".btn-retry") as HTMLButtonElement).click();
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: "retry" });

    emit({ type: "streamStart" });
    emit({ type: "streamToken", token: "Retried answer" });
    emit({ type: "streamEnd", fullContent: "Retried answer" });

    // No spinner left behind; the answer is rendered
    expect(app().querySelector(".state-loading")).toBeNull();
    expect(app().textContent).toContain("Retried answer");
  });

  it("offers no Retry button when the controller says retries are exhausted", async () => {
    await reachStreamingWithHistory();
    emit({ type: "streamError", reason: "Connection failed", partialContent: "", canRetry: false });

    expect(app().querySelector(".btn-retry")).toBeNull();
  });
});

describe("CF-3.8 context-window truncation notice", () => {
  async function reachStreamingWithHistory(): Promise<void> {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });
    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = "What about X?";
    (app().querySelector(".btn-send") as HTMLButtonElement).click();
  }

  it("shows a truncation note when the controller reports historyTruncated: true, without dropping the visible conversation", async () => {
    await reachStreamingWithHistory();
    emit({ type: "streamStart", historyTruncated: true });

    expect(app().querySelector(".truncation-notice")).not.toBeNull();
    expect(app().textContent).toContain("The summary");
    expect(app().textContent).toContain("What about X?");
  });

  it("shows no truncation note when historyTruncated is false", async () => {
    await reachStreamingWithHistory();
    emit({ type: "streamStart", historyTruncated: false });

    expect(app().querySelector(".truncation-notice")).toBeNull();
  });

  it("shows no truncation note when historyTruncated is omitted (e.g. summarize, which has no history to trim)", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });
    emit({
      type: "contextTabAdded",
      tabId: 99,
      url: "https://example.com/other",
      title: "Other Article",
      confidence: "high",
    });
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart" });

    expect(app().querySelector(".truncation-notice")).toBeNull();
  });
});

describe("CF-3.9 context truncation notice", () => {
  it("shows the notice during summarize when the controller reports contextTruncated: true", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });
    emit({
      type: "contextTabAdded",
      tabId: 99,
      url: "https://example.com/other",
      title: "Other Article",
      confidence: "high",
    });
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart", contextTruncated: true });

    expect(app().querySelector(".truncation-notice")).not.toBeNull();
    expect(app().textContent).toContain("shortened");
  });

  it("shows no notice during summarize when contextTruncated is false", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });
    emit({
      type: "contextTabAdded",
      tabId: 99,
      url: "https://example.com/other",
      title: "Other Article",
      confidence: "high",
    });
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart", contextTruncated: false });

    expect(app().querySelector(".truncation-notice")).toBeNull();
  });

  it("shows the notice on a Q&A follow-up when the controller reports contextTruncated: true", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });
    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = "What about X?";
    (app().querySelector(".btn-send") as HTMLButtonElement).click();
    emit({ type: "streamStart", historyTruncated: false, contextTruncated: true });

    const notices = app().querySelectorAll(".truncation-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain("shortened");
  });

  it("shows both notices when a request has both history and context tabs truncated", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });
    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = "What about X?";
    (app().querySelector(".btn-send") as HTMLButtonElement).click();
    emit({ type: "streamStart", historyTruncated: true, contextTruncated: true });

    expect(app().querySelectorAll(".truncation-notice")).toHaveLength(2);
  });
});

describe("CF-3.8/CF-3.9 truncation notices persist after the reply completes", () => {
  async function reachReadyWithHistory(): Promise<void> {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });
  }

  function send(text: string): void {
    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = text;
    (app().querySelector(".btn-send") as HTMLButtonElement).click();
  }

  it("keeps the history-trimmed note visible once the answer has finished streaming", async () => {
    await reachReadyWithHistory();
    send("What about X?");
    emit({ type: "streamStart", historyTruncated: true });
    emit({ type: "streamToken", token: "Answer" });
    emit({ type: "streamEnd", fullContent: "Answer" });

    expect(app().textContent).toContain("Answer");
    expect(app().querySelector(".btn-send")).not.toBeNull(); // back in the ready phase
    expect(app().querySelectorAll(".truncation-notice")).toHaveLength(1);
    expect(app().textContent).toContain("trimmed");
  });

  it("keeps the dropped-tabs note visible after a Q&A reply completes, alongside the history note when both apply", async () => {
    await reachReadyWithHistory();
    send("What about X?");
    emit({ type: "streamStart", historyTruncated: true, contextTruncated: true });
    emit({ type: "streamEnd", fullContent: "Answer" });

    expect(app().querySelectorAll(".truncation-notice")).toHaveLength(2);
    expect(app().textContent).toContain("shortened");
  });

  it("keeps the dropped-tabs note visible after a summarize completes", async () => {
    await loadSidebar();
    emit({ type: "freeChatReady", messages: [] });
    emit({ type: "contextTabAdded", tabId: 99, url: "https://example.com/other", title: "Other Article", confidence: "high" });
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart", contextTruncated: true });
    emit({ type: "streamEnd", fullContent: "The summary" });

    expect(app().textContent).toContain("The summary");
    expect(app().textContent).toContain("shortened");
  });

  it("clears the note when the next request starts without truncation", async () => {
    await reachReadyWithHistory();
    send("first");
    emit({ type: "streamStart", historyTruncated: true });
    emit({ type: "streamEnd", fullContent: "A1" });
    expect(app().querySelector(".truncation-notice")).not.toBeNull();

    send("second");
    emit({ type: "streamStart", historyTruncated: false });
    emit({ type: "streamEnd", fullContent: "A2" });
    expect(app().querySelector(".truncation-notice")).toBeNull();
  });

  it("shows no note after a plain reply that was never truncated", async () => {
    await reachReadyWithHistory();
    send("hello");
    emit({ type: "streamStart", historyTruncated: false });
    emit({ type: "streamEnd", fullContent: "Hi" });
    expect(app().querySelector(".truncation-notice")).toBeNull();
  });
});

describe("CF-4.4 export destination and clipboard delivery", () => {
  it("uses the configured default destination for the Export button", async () => {
    syncStorageData.settings = {
      export: { defaultDestination: { kind: "clipboard" } },
    };
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "S", timestamp: "t" }] });

    (app().querySelector(".btn-export") as HTMLButtonElement).click();
    await flush();

    const exportMsg = sentRuntimeMessages.find(
      (m) => (m as { kind?: string }).kind === "exportRequested",
    ) as { payload: { destinations: Array<{ kind: string }> } };
    expect(exportMsg).toBeDefined();
    expect(exportMsg.payload.destinations).toEqual([{ kind: "clipboard" }]);
  });

  it("explains a nothing-to-export failure instead of a bare Failed", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "S", timestamp: "t" }] });
    runtimeSendResponse = { kind: "exportResult", payload: { ok: false, reason: "nothing-to-export", detail: "None of the selected sections has content." } };

    const btn = app().querySelector(".btn-export") as HTMLButtonElement;
    btn.click();
    await flush();

    expect(btn.textContent).toBe("✗ Nothing to export");
    expect(btn.title).toBe("None of the selected sections has content.");
  });

  it("sends the conversation on screen with the export request, so Summary and Q&A survive a restarted background", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({
      type: "conversationRestored",
      messages: [
        { role: "assistant", content: "The summary", timestamp: "t" },
        { role: "user", content: "A question", timestamp: "t" },
        { role: "assistant", content: "An answer", timestamp: "t", model: "m" },
      ],
    });

    (app().querySelector(".btn-export") as HTMLButtonElement).click();
    await flush();

    const exportMsg = sentRuntimeMessages.find(
      (m) => (m as { kind?: string }).kind === "exportRequested",
    ) as { payload: { messages: Array<{ role: string; content: string }> } };
    expect(exportMsg.payload.messages).toEqual([
      { role: "assistant", content: "The summary" },
      { role: "user", content: "A question" },
      { role: "assistant", content: "An answer" },
    ]);
  });

  it("answers clipboardWrite port messages with clipboardResult", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    await loadSidebar();
    emitRaw({ kind: "clipboardWrite", payload: { content: "# Exported" } });
    await flush();

    expect(writeText).toHaveBeenCalledWith("# Exported");
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "clipboardResult", payload: { ok: true } }),
    );
  });
});

describe("CF-6.3 element-picker recovery hint", () => {
  it("shows the picker hint when a fresh extraction reports low confidence", async () => {
    await loadSidebar();
    emit({ ...contextLoaded, confidence: "low" });

    expect(app().querySelector(".picker-link")).not.toBeNull();
  });

  it("does not show the picker hint when confidence is high", async () => {
    await loadSidebar();
    emit(contextLoaded);

    expect(app().querySelector(".picker-link")).toBeNull();
  });

  it("shows the picker hint after a cached low-confidence session is restored via contextTabAdded, not just on fresh contextLoaded", async () => {
    await loadSidebar();

    // A restored cached session (revisiting a tab already seen this browser
    // session) reports its confidence via conversationRestored + contextTabAdded
    // rather than contextLoaded — the recovery hint must still reflect it.
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "Summary", timestamp: "t" }] });
    emit({ type: "contextTabAdded", tabId: 42, url: "https://example.com/article", title: "Thin page", confidence: "low" });

    expect(app().querySelector(".picker-link")).not.toBeNull();
  });

  it("does not leak a secondary context tab's low confidence onto the primary tab's hint", async () => {
    await loadSidebar();
    emit(contextLoaded); // primary tab (42), high confidence

    emit({ type: "contextTabAdded", tabId: 99, url: "https://example.com/other", title: "Other thin page", confidence: "low" });

    expect(app().querySelector(".picker-link")).toBeNull();
  });
});

describe("SF-1 context tab add failures", () => {
  it("surfaces the failure reason instead of silently closing the picker", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "openTabs", tabs: [{ tabId: 99, title: "Other Article", url: "https://example.com/other" }] });

    (app().querySelector(".tab-picker-item") as HTMLButtonElement).click();
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: "addContextTab", tabId: 99 });

    emit({
      type: "contextTabFailed",
      tabId: 99,
      url: "https://example.com/other",
      title: "Other Article",
      reason: "Content script did not respond within 10s",
    });

    expect(app().textContent).toContain("Content script did not respond within 10s");
    // Only the primary tab has a chip — the failed tab never becomes one
    expect(app().querySelectorAll(".context-chip-remove")).toHaveLength(1);
  });

  it("clears the failure message on its own after a timeout", async () => {
    await loadSidebar();
    vi.useFakeTimers();
    try {
      emit(contextLoaded);
      emit({
        type: "contextTabFailed",
        tabId: 99,
        url: "https://example.com/other",
        title: "Other Article",
        reason: "Tab not accessible",
      });
      expect(app().textContent).toContain("Tab not accessible");

      vi.runAllTimers();

      expect(app().textContent).not.toContain("Tab not accessible");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CF-3.6 reconnect before send", () => {
  async function reachReadyWithHistory(): Promise<void> {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });
  }

  it("reconnects and replays init before delivering a message sent after the port disconnected", async () => {
    await reachReadyWithHistory();

    // Simulate the background page idle-unloading: the port disconnects.
    const disconnectCb = mockPort.onDisconnect.addListener.mock.calls[0][0] as () => void;
    disconnectCb();

    const callsBeforeSend = mockPort.postMessage.mock.calls.length;

    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = "Are you still there?";
    (app().querySelector(".btn-send") as HTMLButtonElement).click();

    expect(browser.runtime.connect).toHaveBeenCalledTimes(2);

    const newCalls = mockPort.postMessage.mock.calls.slice(callsBeforeSend);
    expect(newCalls[0][0]).toEqual(expect.objectContaining({ type: "init", tabId: 42 }));
    expect(newCalls[1][0]).toEqual(expect.objectContaining({ type: "sendMessage", text: "Are you still there?" }));
  });

  it("does not discard the in-flight message when the replayed init's response arrives", async () => {
    await reachReadyWithHistory();

    const disconnectCb = mockPort.onDisconnect.addListener.mock.calls[0][0] as () => void;
    disconnectCb();

    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = "Are you still there?";
    (app().querySelector(".btn-send") as HTMLButtonElement).click();

    // The controller answers the replayed init before the real answer streams.
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });

    // The in-flight question must still be visible — not wiped by the resync.
    expect(app().textContent).toContain("Are you still there?");

    // The real answer still streams in normally afterward.
    emit({ type: "streamStart" });
    emit({ type: "streamToken", token: "Yes, still here." });
    emit({ type: "streamEnd", fullContent: "Yes, still here." });

    expect(app().textContent).toContain("Yes, still here.");
    expect(app().textContent).toContain("Are you still there?");
  });
});

describe("SF-1 switching to a tab already in context does not reset the session", () => {
  const otherTabAdded: ControllerToSidebarMessage = {
    type: "contextTabAdded",
    tabId: 43,
    url: "https://example.com/other",
    title: "Other Article",
    confidence: "high",
  };

  it("ignores an active-tab switch to a tab that's already part of the multi-tab context", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit(otherTabAdded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });

    const callsBefore = mockPort.postMessage.mock.calls.length;

    // Switch the browser's active tab to tab 43 — already a context chip.
    await activateTab(43);

    // The chat session does not reset — nothing at all is sent for the switch
    // (in particular no "init").
    const newCalls = mockPort.postMessage.mock.calls.slice(callsBefore).map(([m]) => m as { type: string; tabId?: number });
    expect(newCalls).toEqual([]);

    // Conversation and both chips are still intact.
    expect(app().textContent).toContain("The summary");
    expect(app().querySelectorAll(".context-chip-remove")).toHaveLength(2);
  });

  it("replays init with tab 42's own URL, not the peeked-at tab's URL, after a port drop", async () => {
    await loadSidebar();
    emit(contextLoaded); // primary tab 42, url https://example.com/article
    emit(otherTabAdded); // tab 43, url https://example.com/other
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });

    // Peek at tab 43 (already in context) — the chat session stays on tab 42.
    await activateTab(43);

    // The background page idle-unloads: the port disconnects.
    const disconnectCb = mockPort.onDisconnect.addListener.mock.calls[0][0] as () => void;
    disconnectCb();

    const callsBeforeSend = mockPort.postMessage.mock.calls.length;

    const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
    textarea.value = "Are you still there?";
    (app().querySelector(".btn-send") as HTMLButtonElement).click();

    const newCalls = mockPort.postMessage.mock.calls.slice(callsBeforeSend);
    const initCall = newCalls.find(([m]) => (m as { type: string }).type === "init")![0] as { tabId: number; url?: string };
    expect(initCall.tabId).toBe(42);
    expect(initCall.url).toBe("https://example.com/article");
  });

  it("still resets when switching to a tab that is not part of the current context", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit(otherTabAdded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });

    const callsBefore = mockPort.postMessage.mock.calls.length;

    // Switch to tab 44 — a genuinely different, untracked tab.
    await activateTab(44);

    const newCalls = mockPort.postMessage.mock.calls.slice(callsBefore);
    expect(newCalls.some(([m]) => (m as { type: string }).type === "init" && (m as { tabId: number }).tabId === 44)).toBe(true);
  });
});

describe("SF-8 logging", () => {
  it("produces no console output by default (debugLogging starts false)", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await loadSidebar();
      emit(contextLoaded);
      emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "S", timestamp: "t" }] });
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("logs stream lifecycle events once debugLogging is enabled in settings", async () => {
    syncStorageData.settings = { debugLogging: true };
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await loadSidebar();
      emit(contextLoaded);
      emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "S", timestamp: "t" }] });
      const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
      textarea.value = "What about X?";
      (app().querySelector(".btn-send") as HTMLButtonElement).click();
      emit({ type: "streamStart" });
      emit({ type: "streamEnd", fullContent: "An answer." });

      expect(debugSpy).toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("logs a warn on a stream error once debugLogging is enabled", async () => {
    syncStorageData.settings = { debugLogging: true };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadSidebar();
      emit(contextLoaded);
      emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "S", timestamp: "t" }] });
      const textarea = app().querySelector(".message-input") as HTMLTextAreaElement;
      textarea.value = "What about X?";
      (app().querySelector(".btn-send") as HTMLButtonElement).click();
      emit({ type: "streamError", reason: "Connection failed", partialContent: "", canRetry: true });

      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("SF-8 sidebar picks up debug-logging changes live", () => {
  it("starts logging as soon as a settingsChanged broadcast enables debugLogging, without reopening", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await loadSidebar();
      emit({ type: "streamStart" });
      expect(debugSpy).not.toHaveBeenCalled();

      expect(runtimeMessageListeners.length).toBeGreaterThan(0);
      const settings = {
        schemaVersion: 1, ai: { baseUrl: "", modelId: "", apiKeyRef: null, systemPrompt: "", contextWindowTokens: 8192 },
        export: { filenamePattern: "", defaultDestination: { kind: "download" }, frontmatterFields: [] },
        sitePatterns: [], debugLogging: true,
      };
      for (const cb of runtimeMessageListeners) cb({ kind: "settingsChanged", payload: settings });

      emit({ type: "streamStart" });
      expect(debugSpy).toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe("removed features: auto-export, personas, bot avatar, skills", () => {
  it("shows no auto-export toggle, avatar controls, or skill picker / Add Skill / Clear controls", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });

    expect(app().querySelector(".auto-export-toggle")).toBeNull();
    expect(app().textContent).not.toMatch(/auto-export/i);
    expect(app().querySelector(".bot-avatar")).toBeNull();
    expect(app().querySelector(".btn-choose-avatar")).toBeNull();
    expect(app().querySelector(".skill-section")).toBeNull();
    expect(app().querySelector(".skill-picker")).toBeNull();
    expect(app().querySelector(".btn-clear-skill")).toBeNull();
    expect(app().querySelector("input[type='file']")).toBeNull();
    expect(app().textContent).not.toMatch(/skill|persona|avatar/i);
  });

  it("does not ask the controller for a skill library", async () => {
    await loadSidebar();
    const sent = mockPort.postMessage.mock.calls.map(([m]) => (m as { type: string }).type);
    expect(sent).not.toContain("getLibrary");
  });
});

describe("CF-4 export checkboxes: Summary, Content, Q&A", () => {
  async function reachReady(): Promise<void> {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "The summary", timestamp: "t" }] });
  }

  const boxes = () => Array.from(app().querySelectorAll<HTMLInputElement>(".export-checkbox"));
  const labels = () => Array.from(app().querySelectorAll(".export-checkbox-label")).map((l) => l.textContent!.trim());
  const exportBtn = () => app().querySelector(".btn-export") as HTMLButtonElement;
  const exportPayload = () =>
    (sentRuntimeMessages.find((m) => (m as { kind?: string }).kind === "exportRequested") as {
      payload: { includeSummary: boolean; includeContent: boolean; includeQA: boolean };
    }).payload;

  it("offers three checkboxes in the order Summary, Content, Q&A — only Summary checked by default", async () => {
    await reachReady();
    expect(labels()).toEqual(["Summary", "Content", "Q&A"]);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false]);
  });

  it("the default export asks for the summary only", async () => {
    await reachReady();
    exportBtn().click();
    await flush();
    expect(exportPayload()).toMatchObject({ includeSummary: true, includeContent: false, includeQA: false });
  });

  it("each checkbox maps to its own flag", async () => {
    await reachReady();
    boxes()[0].click(); // summary off
    boxes()[1].click(); // content on
    boxes()[2].click(); // Q&A on
    exportBtn().click();
    await flush();
    expect(exportPayload()).toMatchObject({ includeSummary: false, includeContent: true, includeQA: true });
  });

  it("disables Export while nothing is checked, and re-enables it when something is", async () => {
    await reachReady();
    boxes()[0].click(); // uncheck the only checked box
    expect(exportBtn().disabled).toBe(true);
    boxes()[1].click();
    expect(exportBtn().disabled).toBe(false);
  });

  it("keeps the choices when the sidebar re-renders", async () => {
    await reachReady();
    boxes()[1].click(); // content on
    emit({ type: "contextTabAdded", tabId: 99, url: "https://example.com/o", title: "Other", confidence: "high" }); // re-render
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
  });
});

// ─── UX improvements ─────────────────────────────────────────────────────────

describe("UX: copy buttons", () => {
  const withClipboard = () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, writable: true, configurable: true });
    return writeText;
  };

  async function restore(messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<void> {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: messages.map((m) => ({ ...m, timestamp: "t" })) });
  }

  it("copies an assistant reply's raw markdown, and only assistant replies get the button", async () => {
    const writeText = withClipboard();
    await restore([{ role: "user", content: "Q?" }, { role: "assistant", content: "**Answer** text" }]);

    const buttons = app().querySelectorAll(".message-copy");
    expect(buttons).toHaveLength(1);
    expect(app().querySelector(".message-user .message-copy")).toBeNull();

    (buttons[0] as HTMLButtonElement).click();
    await flush();

    expect(writeText).toHaveBeenCalledWith("**Answer** text");
    expect(buttons[0].textContent).toBe("Copied ✓");
  });

  it("gives each code block its own Copy button that copies only the code", async () => {
    const writeText = withClipboard();
    await restore([{ role: "assistant", content: "Run:\n```\nnpm install\n```\nthen done" }]);

    const codeCopy = app().querySelector(".code-copy") as HTMLButtonElement;
    expect(codeCopy).not.toBeNull();
    codeCopy.click();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain("npm install");
    expect(copied).not.toContain("Copy");
  });

  it("reports a failed copy instead of claiming success", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
      writable: true,
      configurable: true,
    });
    document.execCommand = vi.fn(() => false);
    await restore([{ role: "assistant", content: "text" }]);

    const btn = app().querySelector(".message-copy") as HTMLButtonElement;
    btn.click();
    await flush();

    expect(btn.textContent).toBe("Copy failed");
  });
});

describe("UX: header and first-run setup", () => {
  it("shows Re-read page and Help as labelled icon buttons", async () => {
    await loadSidebar();
    emit(contextLoaded);

    const reread = app().querySelector(".btn-reset") as HTMLButtonElement;
    expect(reread.textContent).toBe("↻");
    expect(reread.getAttribute("aria-label")).toMatch(/Re-read page/);
    const help = app().querySelector(".btn-help") as HTMLButtonElement;
    expect(help.textContent).toBe("?");
    expect(help.getAttribute("aria-label")).toMatch(/Help/);
  });

  it("shows a setup card with steps and an Open Settings button when AI isn't configured", async () => {
    await loadSidebar();
    emit({ type: "configError", reason: "AI not configured. Set the base URL and model in Settings." });

    expect(app().querySelector(".setup-heading")?.textContent).toBe("Set up your AI provider");
    expect(app().querySelectorAll(".setup-steps li").length).toBeGreaterThanOrEqual(3);
    const open = app().querySelector(".settings-link") as HTMLAnchorElement;
    open.click();
    expect((globalThis as unknown as { browser: { runtime: { openOptionsPage: ReturnType<typeof vi.fn> } } }).browser.runtime.openOptionsPage).toHaveBeenCalled();
  });
});

describe("UX: extraction preview before summarizing", () => {
  it("shows an excerpt of the extracted page and a 'not the right content' link", async () => {
    await loadSidebar();
    emit({ ...contextLoaded, excerpt: "The first lines of the page body." });

    expect(app().querySelector(".page-excerpt")?.textContent).toBe("The first lines of the page body.");
    expect(app().querySelector(".wrong-content-link")).not.toBeNull();
  });

  it("omits the excerpt block when none was sent", async () => {
    await loadSidebar();
    emit(contextLoaded);

    expect(app().querySelector(".page-excerpt")).toBeNull();
  });

  it("uses the prominent picker hint, not a second link, when confidence is low", async () => {
    await loadSidebar();
    emit({ ...contextLoaded, confidence: "low", excerpt: "x" });

    expect(app().querySelector(".picker-link")).not.toBeNull();
    expect(app().querySelector(".wrong-content-link")).toBeNull();
  });
});

describe("UX: truncation notice says how much was read", () => {
  it("includes the percentage of the page that fit", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart", contextTruncated: true, contextKeptPercent: 35 });
    emit({ type: "streamToken", token: "Hi" });
    emit({ type: "streamEnd", fullContent: "Hi" });

    expect(app().querySelector(".truncation-notice")?.textContent).toContain("about 35%");
  });

  it("falls back to the plain notice when no percentage is known", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart", contextTruncated: true });
    emit({ type: "streamEnd", fullContent: "Hi" });

    const text = app().querySelector(".truncation-notice")?.textContent ?? "";
    expect(text).toContain("shortened");
    expect(text).not.toContain("%");
  });
});

describe("UX: export feedback", () => {
  async function readyWithSummary(): Promise<void> {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "S", timestamp: "t" }] });
  }

  it("says which file was saved", async () => {
    await readyWithSummary();
    runtimeSendResponse = { kind: "exportResult", payload: { ok: true, filename: "2026-11-25-my-page.md" } };
    (app().querySelector(".btn-export") as HTMLButtonElement).click();
    await flush();

    expect(app().querySelector(".export-status")?.textContent).toBe("Saved 2026-11-25-my-page.md");
  });

  it("says when the export went to the clipboard", async () => {
    syncStorageData.settings = { export: { defaultDestination: { kind: "clipboard" } } };
    await readyWithSummary();
    runtimeSendResponse = { kind: "exportResult", payload: { ok: true, filename: "x.md" } };
    (app().querySelector(".btn-export") as HTMLButtonElement).click();
    await flush();

    expect(app().querySelector(".export-status")?.textContent).toBe("Copied to clipboard");
  });
});

describe("UX: keyboard, focus and screen readers", () => {
  const press = (key: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("Escape cancels a running summary", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    mockPort.postMessage.mockClear();

    press("Escape");

    expect(mockPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "abort" }));
  });

  it("Escape closes the Help menu instead of cancelling anything", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-help") as HTMLButtonElement).click();
    expect(app().querySelector(".help-menu-dropdown")).not.toBeNull();
    mockPort.postMessage.mockClear();

    press("Escape");

    expect(app().querySelector(".help-menu-dropdown")).toBeNull();
    expect(mockPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "abort" }));
  });

  it("puts the cursor in the message box once a reply finishes", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart" });
    emit({ type: "streamEnd", fullContent: "Summary" });

    expect(document.activeElement).toBe(app().querySelector(".message-input"));
  });

  it("announces status changes through a live region without making streamed text live", async () => {
    await loadSidebar();
    emit(contextLoaded);
    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();
    emit({ type: "streamStart" });
    const region = document.getElementById("sr-status")!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("Generating reply");

    emit({ type: "streamEnd", fullContent: "Done" });
    expect(region.textContent).toBe("Reply complete");
    expect(app().querySelector("[aria-live]")).toBeNull();
  });

  it("offers a Latest button while streaming, hidden until the user scrolls up", async () => {
    await loadSidebar();
    emit(contextLoaded);
    emit({ type: "conversationRestored", messages: [{ role: "assistant", content: "S", timestamp: "t" }] });
    expect(app().querySelector(".scroll-latest")).toBeNull();

    emit({ type: "streamStart" });
    emit({ type: "streamToken", token: "a" });

    const latest = app().querySelector(".scroll-latest");
    expect(latest).not.toBeNull();
    // Pinned to the bottom by default, so there is nothing to jump to yet
    expect(latest!.classList.contains("hidden")).toBe(true);
  });
});

describe("UX: context chip favicons", () => {
  it("adds the tab's favicon to its chip without re-rendering the page", async () => {
    await loadSidebar();
    const browserMock = (globalThis as unknown as { browser: { tabs: { get: ReturnType<typeof vi.fn> } } }).browser;
    browserMock.tabs.get = vi.fn(async (id: number) => ({ id, url: tabUrlById[id], favIconUrl: "https://example.com/favicon.ico" }));

    emit(contextLoaded);
    await flush();

    const img = app().querySelector(".context-chip .context-chip-favicon") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.src).toBe("https://example.com/favicon.ico");
    expect(img!.getAttribute("aria-hidden")).toBe("true");
  });

  it("ignores unsafe favicon schemes", async () => {
    await loadSidebar();
    const browserMock = (globalThis as unknown as { browser: { tabs: { get: ReturnType<typeof vi.fn> } } }).browser;
    browserMock.tabs.get = vi.fn(async (id: number) => ({ id, url: tabUrlById[id], favIconUrl: "javascript:alert(1)" }));

    emit(contextLoaded);
    await flush();

    expect(app().querySelector(".context-chip-favicon")).toBeNull();
  });
});

