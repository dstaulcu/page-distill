/**
 * Content script entry point.
 *
 * Listens for messages from the background script via browser.runtime.onMessage.
 * Validates incoming messages using the typed message system, then dispatches
 * to the appropriate handler based on message kind.
 */

import { isMessageOfKind, buildMessage } from "@shared/messages";
import type { MessageOf, ExtractResultPayload, PickerResultPayload, SelectorPreviewResultPayload } from "@shared/messages";
import { extract } from "./extractor/extract";
import { createElementPicker } from "./element-picker";
import { createLogger } from "@shared/logger";

// ─── SF-8 debug logging ─────────────────────────────────────────────────────
//
// Cached at module load (best-effort — storage may be unavailable) and kept
// current via the debugLoggingChanged message the background sends to every
// tab on each settings save.

let debugLoggingEnabled = false;
// Set once a live message has told us the value: a slower storage read that
// started earlier must not overwrite it with a stale one.
let flagSetByMessage = false;
const logger = createLogger({ getEnabled: () => debugLoggingEnabled });

async function refreshDebugLoggingFlag(): Promise<void> {
  try {
    const synced = (await browser.storage.sync.get("settings")) as { settings?: { debugLogging?: boolean } };
    if (flagSetByMessage) return;
    if (typeof synced.settings?.debugLogging === "boolean") {
      debugLoggingEnabled = synced.settings.debugLogging;
      return;
    }
    const local = (await browser.storage.local.get("settings")) as { settings?: { debugLogging?: boolean } };
    if (!flagSetByMessage && typeof local.settings?.debugLogging === "boolean") {
      debugLoggingEnabled = local.settings.debugLogging;
    }
  } catch {
    // Storage unavailable — default to disabled; never block content-script init.
  }
}

// ─── Message Handlers ────────────────────────────────────────────────────────

async function handleExtractRequested(
  msg: MessageOf<"extractRequested">,
): Promise<MessageOf<"extractResult">> {
  const { selector } = msg.payload;

  const result = await extract({
    contentSelector: selector,
  });

  let payload: ExtractResultPayload;

  if (result.ok) {
    logger.debug("Extraction succeeded", `confidence=${result.confidence}`, `chars=${result.article.bodyCharacterCount}`);
    payload = {
      ok: true,
      article: result.article,
      confidence: result.confidence,
      stalePattern: result.stalePattern,
    };
  } else {
    logger.warn("Extraction failed", result.reason, result.detail);
    payload = {
      ok: false,
      reason: result.reason,
      detail: result.detail,
    };
  }

  return buildMessage("extractResult", payload, msg.requestId);
}

async function handlePickerActivate(
  msg: MessageOf<"pickerActivate">,
): Promise<MessageOf<"pickerResult">> {
  logger.debug("Picker activated");
  const picker = createElementPicker();
  const result = await picker.pick();

  let payload: PickerResultPayload;
  if (result) {
    logger.debug("Picker selection made", result.selector);
    payload = {
      ok: true,
      selector: result.selector,
      previewText: result.previewText,
    };
  } else {
    logger.debug("Picker cancelled");
    payload = {
      ok: false,
      reason: "Selection cancelled",
    };
  }

  return buildMessage("pickerResult", payload, msg.requestId);
}

const SELECTOR_PREVIEW_MAX_CHARS = 500;

/**
 * Live selector preview for the options page (CF-6.5): returns the first
 * matched element's text so users can see what a selector captures.
 */
function handleSelectorPreview(
  msg: MessageOf<"selectorPreview">,
): MessageOf<"selectorPreviewResult"> {
  const { selector } = msg.payload;

  let payload: SelectorPreviewResultPayload;
  try {
    const element = document.querySelector(selector);
    if (element) {
      const text = (element.textContent ?? "").trim().slice(0, SELECTOR_PREVIEW_MAX_CHARS);
      payload = { ok: true, text };
    } else {
      payload = { ok: false, reason: "Selector matched no elements" };
    }
  } catch {
    payload = { ok: false, reason: "Invalid CSS selector syntax" };
  }

  return buildMessage("selectorPreviewResult", payload, msg.requestId);
}

// ─── Listener Registration ───────────────────────────────────────────────────

export function registerMessageListener(): void {
  browser.runtime.onMessage.addListener(
    (message: unknown): undefined | Promise<MessageOf<"extractResult"> | MessageOf<"pickerResult"> | MessageOf<"selectorPreviewResult">> => {
      if (isMessageOfKind(message, "extractRequested")) {
        return handleExtractRequested(message);
      }

      if (isMessageOfKind(message, "pickerActivate")) {
        return handlePickerActivate(message);
      }

      if (isMessageOfKind(message, "selectorPreview")) {
        return Promise.resolve(handleSelectorPreview(message));
      }

      // SF-8: the background sends the new debug-logging flag to every tab on
      // each settings save; refresh the cached flag, fire-and-forget.
      if (isMessageOfKind(message, "debugLoggingChanged")) {
        flagSetByMessage = true;
        debugLoggingEnabled = message.payload.enabled;
        return undefined;
      }

      // Invalid or unrecognized messages are discarded silently.
      return undefined;
    },
  );
}

// ─── Initialize ──────────────────────────────────────────────────────────────

registerMessageListener();
void refreshDebugLoggingFlag();
