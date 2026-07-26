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
      "https://github.com/dstaulcu/distill/issues",
      "https://github.com/dstaulcu/distill/releases",
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

describe("SF-2 persona-chat summarize", () => {
  const otherTabAdded: ControllerToSidebarMessage = {
    type: "contextTabAdded",
    tabId: 99,
    url: "https://example.com/other",
    title: "Other Article",
    confidence: "high",
  };

  it("offers a Summarize action once a context tab is added, before any messages exist", async () => {
    await loadSidebar();
    emit({ type: "personaModeReady", messages: [] });

    // No context yet — no way to summarize nothing.
    expect(app().querySelector(".btn-summarize")).toBeNull();

    emit(otherTabAdded);

    expect(app().querySelector(".btn-summarize")).not.toBeNull();
  });

  it("summarizing from persona-chat sends summarize and returns to persona-chat (not ready) after the stream ends", async () => {
    await loadSidebar();
    emit({ type: "personaModeReady", messages: [] });
    emit(otherTabAdded);

    (app().querySelector(".btn-summarize") as HTMLButtonElement).click();

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "summarize" }),
    );

    emit({ type: "streamStart" });
    emit({ type: "streamEnd", fullContent: "Findings: it's a good article." });

    expect(app().textContent).toContain("Findings");
    // Persona-chat's Reset/New Chat header buttons don't show for "ready" —
    // staying out of "ready" proves the round-trip preserved persona-chat's
    // multi-tab context semantics instead of collapsing to single-tab "ready".
    expect(app().querySelector(".btn-reset")).toBeNull();
  });

  it("keeps a previously added context tab when a resync happens mid-add (background idle-unload)", async () => {
    await loadSidebar();
    emit({ type: "personaModeReady", messages: [] });
    emit(otherTabAdded);

    expect(app().querySelector(".btn-summarize")).not.toBeNull();

    // Background idle-unloads while the user is about to add a second tab.
    const disconnectCb = mockPort.onDisconnect.addListener.mock.calls[0][0] as () => void;
    disconnectCb();

    // Clicking "+ Add tab" fires getOpenTabs over the stale port, which
    // reconnects and replays init before the real request.
    (app().querySelector(".context-chip-add") as HTMLButtonElement).click();

    // The controller's reply to the replayed init — a fresh persona-chat
    // start, since nothing has been cached yet — must not wipe the tab
    // already added or drop back out of persona-chat.
    emit({ type: "personaModeReady", messages: [] });

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

    // Auto-export status still refreshes for the tab now in view, but the
    // chat session itself does not reset — no "init" is sent for the switch.
    const newCalls = mockPort.postMessage.mock.calls.slice(callsBefore).map(([m]) => m as { type: string; tabId?: number });
    expect(newCalls).toEqual([{ type: "autoExportStatusRequest", tabId: 43 }]);

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
