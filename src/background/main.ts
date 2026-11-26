/**
 * Background script entry point (persistent page, Firefox MV3).
 *
 * Initializes all background modules and wires up message routing,
 * port connections, tab events, and the element picker flow.
 *
 * Features: CF-1, CF-4, CF-5, CF-6, SF-4.
 */

import {
  isMessageOfKind,
  buildMessage,
  sendToTab,
} from "@shared/messages";
import type {
  AnyMessage,
  MessageOf,
  ClipboardResultPayload,
} from "@shared/messages";
import { isAnyMessage } from "@shared/messages";
import {
  isSidebarToControllerMessage,
} from "@shared/port-protocol";
import type {
  SidebarToControllerMessage,
  ControllerToSidebarMessage,
} from "@shared/port-protocol";
import { createLogger } from "@shared/logger";
import { createSettingsManager } from "@background/settings/manager";
import { createSecureStore } from "@background/secure-store";
import { createTabStateManager } from "@background/tab-state";
import { createChatController } from "@background/chat/controller";
import { createStreamingClient } from "@background/chat/streaming-client";
import { createExportManager } from "@background/export/manager";
import type { ClipboardResult } from "@background/export/manager";
import { createExtractionService } from "@background/extraction";
import { createAiClient } from "@background/ai/client";
import type { ExtractionResult } from "@content/extractor/extract";
import { removeLegacyStorage } from "@background/legacy-cleanup";
import { createLocalStorageAdapter } from "@shared/storage";
import { createApiKeySaver, resolveApiKey } from "@background/credentials";
import type { Runtime } from "webextension-polyfill";

// ---------------------------------------------------------------------------
// Module Initialization
// ---------------------------------------------------------------------------

// SF-8: debug logging, gated by settings.debugLogging. `logger` is a stable
// closure over this flag, so it can be constructed before settingsManager
// and passed to every factory below regardless of init order.
let debugLoggingEnabled = false;
const logger = createLogger({ getEnabled: () => debugLoggingEnabled });

const settingsManager = createSettingsManager({ logger });
settingsManager.get()
  .then((s) => { debugLoggingEnabled = s.debugLogging; })
  .catch(() => { /* storage unavailable at startup — stay off until the next settings change */ });
settingsManager.onChange((s) => { debugLoggingEnabled = s.debugLogging; });

const secureStore = createSecureStore({ logger });
const tabState = createTabStateManager();

/**
 * Extraction orchestration (CF-1): privileged-page guard, pattern → selector
 * resolution, content-script round trip with timeout, and stale flagging.
 * Logic lives in @background/extraction; only the browser bindings are here.
 */
const extractionService = createExtractionService({
  getTabUrl: async (tabId: number) => {
    const tab = await browser.tabs.get(tabId);
    return tab.url ?? "";
  },
  sendExtractMessage: (tabId, msg) => browser.tabs.sendMessage(tabId, msg),
  getSettings: () => settingsManager.get(),
  updateSitePatterns: async (patterns) => {
    await settingsManager.update({ sitePatterns: patterns });
  },
  logger,
});

function extractContent(tabId: number, selector?: string): Promise<ExtractionResult> {
  return extractionService.extractContent(tabId, selector);
}

const saveApiKey = createApiKeySaver({
  getSettings: () => settingsManager.get(),
  updateSettings: (patch) => settingsManager.update(patch),
  secureStore,
  logger,
});

// Drop storage left by removed features (skills, personas, bot avatar) — idempotent
void removeLegacyStorage(createLocalStorageAdapter(), logger);

const chatController = createChatController({
  getSettings: () => settingsManager.get(),
  getSecureStore: () => secureStore,
  extractContent,
  createStreamingClient,
  tabState,
  logger,
  hasSavedPattern: (url: string) => extractionService.hasSavedPattern(url),
  queryOpenTabs: async () => {
    const tabs = await browser.tabs.query({});
    return tabs
      .filter((t) => t.id != null && t.url && !t.url.startsWith("about:") && !t.url.startsWith("moz-extension:") && !t.url.startsWith("chrome:"))
      .map((t) => ({ tabId: t.id!, title: t.title ?? "", url: t.url! }));
  },
});

// Track active sidebar ports for clipboard and picker flows
const sidebarPorts = new Map<number, Runtime.Port>();

/**
 * Clipboard delivery via sidebar context.
 * Sends clipboardWrite to the sidebar port and waits for clipboardResult.
 */
function createClipboardDelivery(tabId: number): (content: string) => Promise<ClipboardResult> {
  return (content: string): Promise<ClipboardResult> => {
    const port = sidebarPorts.get(tabId);
    if (!port) {
      return Promise.resolve({
        ok: false,
        reason: "clipboard-not-available",
        detail: "No sidebar port connected for clipboard delivery",
      });
    }

    return new Promise<ClipboardResult>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ ok: false, reason: "clipboard-timeout", detail: "Clipboard operation timed out" });
      }, 5000);

      const listener = (raw: unknown): void => {
        if (isMessageOfKind(raw, "clipboardResult")) {
          clearTimeout(timeout);
          port.onMessage.removeListener(listener);
          const payload = (raw as MessageOf<"clipboardResult">).payload;
          if (payload.ok) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, reason: payload.reason ?? "clipboard-failed", detail: payload.reason ?? "Clipboard write failed" });
          }
        }
      };

      port.onMessage.addListener(listener);
      const msg = buildMessage("clipboardWrite", { content });
      port.postMessage(msg);
    });
  };
}

const exportManager = createExportManager({
  extractContent: (tabId: number) => extractContent(tabId),
  getSettings: () => settingsManager.get(),
  getConversation: (tabId: number) => {
    const state = tabState.get(tabId);
    return state?.conversation ?? null;
  },
  deliverToClipboard: async (content: string): Promise<ClipboardResult> => {
    // Try each connected sidebar until one succeeds
    let lastFailure: ClipboardResult | null = null;
    for (const tabId of sidebarPorts.keys()) {
      const result = await createClipboardDelivery(tabId)(content);
      if (result.ok) return result;
      lastFailure = result;
    }
    return lastFailure ?? { ok: false, reason: "clipboard-not-available", detail: "No sidebar port connected" };
  },
  logger,
});

// ---------------------------------------------------------------------------
// Message Dispatch (browser.runtime.onMessage)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(
  (message: unknown, sender: Runtime.MessageSender): undefined | Promise<unknown> => {
    if (!isAnyMessage(message)) return undefined;

    const msg = message as AnyMessage;

    switch (msg.kind) {
      case "extractRequested":
        return handleExtractRequested(msg as MessageOf<"extractRequested">);

      case "exportRequested":
        return handleExportRequested(msg as MessageOf<"exportRequested">);

      case "connectionTest":
        return handleConnectionTest(msg as MessageOf<"connectionTest">);

      case "patternSave":
        return handlePatternSave(msg as MessageOf<"patternSave">);

      case "settingsChanged":
        return handleSettingsChanged(msg as MessageOf<"settingsChanged">);

      case "pickerActivate":
        return handlePickerActivateMessage(msg as MessageOf<"pickerActivate">);

      case "apiKeySave":
        return handleApiKeySave(msg as MessageOf<"apiKeySave">);

      default:
        return undefined;
    }
  },
);

// ---------------------------------------------------------------------------
// Message Handlers
// ---------------------------------------------------------------------------

async function handleExtractRequested(msg: MessageOf<"extractRequested">): Promise<MessageOf<"extractResult">> {
  const { tabId, selector } = msg.payload;
  const result = await extractContent(tabId, selector);

  if (result.ok) {
    return buildMessage("extractResult", {
      ok: true,
      article: result.article,
      confidence: result.confidence,
    }, msg.requestId);
  }

  return buildMessage("extractResult", {
    ok: false,
    reason: result.reason,
    detail: result.detail,
  }, msg.requestId);
}

async function handleExportRequested(msg: MessageOf<"exportRequested">): Promise<MessageOf<"exportResult">> {
  const { tabId, includeSummary, includeContent, includeQA, messages, destinations } = msg.payload;

  const result = await exportManager.export({ tabId, includeSummary, includeContent, includeQA, messages, destinations: [...destinations] });

  if (result.ok) {
    return buildMessage("exportResult", {
      ok: true,
      filename: result.filename,
      outcomes: result.outcomes.map((o) => {
        if (o.ok) return { destination: o.destination, ok: true as const };
        return { destination: o.destination, ok: false as const, reason: o.reason, detail: o.detail };
      }),
    }, msg.requestId);
  }

  return buildMessage("exportResult", {
    ok: false,
    reason: result.reason,
    detail: result.detail,
  }, msg.requestId);
}

async function handleApiKeySave(msg: MessageOf<"apiKeySave">): Promise<MessageOf<"apiKeySaveResult">> {
  const result = await saveApiKey(msg.payload.apiKey);
  if (result.ok) {
    return buildMessage("apiKeySaveResult", { ok: true, ref: result.ref }, msg.requestId);
  }
  return buildMessage("apiKeySaveResult", { ok: false, reason: result.reason, detail: result.detail }, msg.requestId);
}

async function handleConnectionTest(msg: MessageOf<"connectionTest">): Promise<MessageOf<"connectionTestResult">> {
  const { baseUrl, apiKey, modelId } = msg.payload;

  // A key typed into the form wins; otherwise fall back to the stored secret
  const settings = await settingsManager.get();
  const effectiveKey = await resolveApiKey({ settings, secureStore, override: apiKey });

  const client = createAiClient({ baseUrl, apiKey: effectiveKey ?? "", model: modelId });
  const result = await client.testConnection();

  if (result.ok) {
    return buildMessage("connectionTestResult", { ok: true }, msg.requestId);
  }

  return buildMessage("connectionTestResult", {
    ok: false,
    reason: result.reason,
    detail: result.detail,
  }, msg.requestId);
}

async function handlePatternSave(msg: MessageOf<"patternSave">): Promise<MessageOf<"patternSaveResult">> {
  const { origin, urlMatchPattern, contentSelector } = msg.payload;

  const settings = await settingsManager.get();
  const existingPatterns = [...settings.sitePatterns];

  // Find existing user pattern for this origin or create new one
  const existingIndex = existingPatterns.findIndex(
    (p) => p.source === "user" && p.urlMatchPattern === urlMatchPattern,
  );

  const newPattern = {
    id: `user-${origin}-${Date.now()}`,
    source: "user" as const,
    urlMatchPattern,
    contentSelector,
  };

  if (existingIndex >= 0) {
    existingPatterns[existingIndex] = newPattern;
  } else {
    existingPatterns.push(newPattern);
  }

  const updateResult = await settingsManager.update({ sitePatterns: existingPatterns });

  if (updateResult.ok) {
    return buildMessage("patternSaveResult", { ok: true }, msg.requestId);
  }

  return buildMessage("patternSaveResult", {
    ok: false,
    reason: "validation-failed",
    detail: updateResult.errors.map((e) => e.message).join("; "),
  }, msg.requestId);
}

async function handleSettingsChanged(msg: MessageOf<"settingsChanged">): Promise<MessageOf<"settingsSaveResult">> {
  // Settings update received from options page — apply via settings manager
  // (validation, quota fallback, and change broadcast all live there)
  const payload = msg.payload;
  const result = await settingsManager.update({
    ai: payload.ai,
    export: payload.export,
    sitePatterns: [...payload.sitePatterns],
    debugLogging: payload.debugLogging,
  });

  if (result.ok) {
    return buildMessage("settingsSaveResult", { ok: true }, msg.requestId);
  }
  return buildMessage("settingsSaveResult", { ok: false, errors: result.errors }, msg.requestId);
}

async function handlePickerActivateMessage(msg: MessageOf<"pickerActivate">): Promise<MessageOf<"pickerResult">> {
  const { tabId } = msg.payload;

  // Forward pickerActivate to the content script and await its response
  const response = await sendToTab(tabId, "pickerActivate", { tabId }, msg.requestId);

  if (!response || typeof response !== "object" || !("payload" in (response as object))) {
    return buildMessage("pickerResult", { ok: false, reason: "No response from content script" }, msg.requestId);
  }

  const result = (response as MessageOf<"pickerResult">).payload;
  if (!result.ok || !result.selector) {
    return buildMessage("pickerResult", { ok: false, reason: result.reason ?? "Selection cancelled" }, msg.requestId);
  }

  // Save the selected element as a site pattern for this hostname
  const tab = await browser.tabs.get(tabId);
  if (tab.url) {
    try {
      const parsedUrl = new URL(tab.url);
      const urlMatchPattern = `*://${parsedUrl.hostname}/*`;
      await handlePatternSave(buildMessage("patternSave", {
        origin: parsedUrl.origin,
        urlMatchPattern,
        contentSelector: result.selector,
      }));
    } catch {
      // URL parse failure — pattern not saved, but extraction still proceeds
    }
  }

  return buildMessage("pickerResult", { ok: true, selector: result.selector, previewText: result.previewText }, msg.requestId);
}

// ---------------------------------------------------------------------------
// Port Connections (browser.runtime.onConnect)
// ---------------------------------------------------------------------------

browser.runtime.onConnect.addListener((port: Runtime.Port) => {
  if (port.name !== "chat") return;

  // Track the port for clipboard/picker flows
  let connectedTabId: number | null = null;

  const portMessageListener = (raw: unknown): void => {
    // Track which tab this sidebar port belongs to
    if (isSidebarToControllerMessage(raw)) {
      const msg = raw as SidebarToControllerMessage;

      switch (msg.type) {
        case "init": {
          connectedTabId = msg.tabId;
          sidebarPorts.set(msg.tabId, port);
          break;
        }
        default:
          break;
      }
    }

    // Handle clipboardResult from sidebar
    if (isMessageOfKind(raw, "clipboardResult")) {
      // Already handled by the clipboard delivery promise listener
      return;
    }
  };

  // Add our interceptor first
  port.onMessage.addListener(portMessageListener);

  // Delegate to chat controller for chat-related messages
  chatController.handleConnect(port);

  port.onDisconnect.addListener(() => {
    if (connectedTabId !== null) {
      sidebarPorts.delete(connectedTabId);
    }
    port.onMessage.removeListener(portMessageListener);
  });
});

// ---------------------------------------------------------------------------
// Tab Events
// ---------------------------------------------------------------------------

/** Clean up tab state when a tab is closed. */
browser.tabs.onRemoved.addListener((tabId: number) => {
  tabState.remove(tabId);
  sidebarPorts.delete(tabId);
});

// ---------------------------------------------------------------------------
// Browser Action (Toggle Sidebar)
// ---------------------------------------------------------------------------

/**
 * Toggle sidebar when the extension action icon is clicked.
 */
browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

// ---------------------------------------------------------------------------
// Element Picker Flow
// ---------------------------------------------------------------------------

// Export for testing
export { extractContent };
