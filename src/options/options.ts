/**
 * Settings page entry point.
 *
 * Vanilla TypeScript UI for configuring AI endpoint, site patterns,
 * and export preferences.
 * Communicates with the background via browser.runtime.sendMessage.
 */

import type { Settings, SitePattern } from "@shared/types";
import { buildMessage, sendToBackground, isMessageOfKind } from "@shared/messages";
import type { FieldError } from "@background/settings/manager";
import { createLogger } from "@shared/logger";
import { backfillDefaults, DEFAULT_SETTINGS } from "@background/settings/defaults";
import { validateContextWindowTokens } from "@shared/context-window";
import { getProviderUi, isAiProvider, DEFAULT_AI_PROVIDER } from "@shared/providers";
import type { AiProvider } from "@shared/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_USER_PATTERNS = 50;
const CONNECTION_TEST_TIMEOUT_MS = 10_000;
const SELECTOR_PREVIEW_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OptionsState {
  settings: Settings | null;
  editingPatternIndex: number | null;
}

const state: OptionsState = {
  settings: null,
  editingPatternIndex: null,
};

// SF-8: reads state.settings directly rather than caching — this module
// already holds current settings synchronously, unlike content script/sidebar.
const logger = createLogger({ getEnabled: () => state.settings?.debugLogging ?? false });

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

function $input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  bindEventListeners();
});

async function loadSettings(): Promise<void> {
  try {
    // Read settings from storage (same key the settings manager uses)
    const stored = await browser.storage.sync.get("settings");
    let settings: Settings | null = stored?.settings as Settings ?? null;
    if (!settings) {
      const local = await browser.storage.local.get("settings");
      settings = local?.settings as Settings ?? null;
    }
    if (!settings) {
      // No settings stored yet — use the defaults (provider: Ollama)
      settings = DEFAULT_SETTINGS;
    }
    // Settings saved by an older version lack newer fields (CF-5.6, SF-8) —
    // fill them in, exactly as the settings manager does, so the form never
    // shows "undefined" and saving an unrelated field never fails validation.
    state.settings = backfillDefaults(settings);
    logger.debug("Settings loaded");
    renderAll();
  } catch (err) {
    logger.warn("Settings load failed", err instanceof Error ? err.message : String(err));
    showSaveStatus("Failed to load settings", true);
  }
}

// ---------------------------------------------------------------------------
// Event Binding
// ---------------------------------------------------------------------------

function bindEventListeners(): void {
  // Connection test
  $("btn-test-connection").addEventListener("click", handleConnectionTest);

  // Model fetching
  $("btn-fetch-models").addEventListener("click", handleFetchModels);
  ($("ai-model-select") as HTMLSelectElement).addEventListener("change", handleModelSelect);
  $input("ai-base-url").addEventListener("change", handleFetchModels);
  $("ai-provider").addEventListener("change", () => applyProviderUi(readProvider()));

  // Pattern management
  $("btn-add-pattern").addEventListener("click", handleAddPattern);
  $("btn-save-pattern").addEventListener("click", handleSavePattern);
  $("btn-cancel-pattern").addEventListener("click", handleCancelPattern);

  // Selector preview on input change
  $input("pattern-selector").addEventListener("input", handleSelectorPreview);

  // Save settings
  $("btn-save-settings").addEventListener("click", handleSaveSettings);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll(): void {
  if (!state.settings) return;
  renderAiSection();
  renderExportSection();
  renderPatternsSection();
  renderDebuggingSection();
}

function renderDebuggingSection(): void {
  if (!state.settings) return;
  $input("debug-logging-enabled").checked = state.settings.debugLogging;
}

/** The provider currently selected in the form (falls back to the default). */
function readProvider(): AiProvider {
  const value = ($("ai-provider") as HTMLSelectElement).value;
  return isAiProvider(value) ? value : DEFAULT_AI_PROVIDER;
}

/** Adapt the AI section to the selected provider (CF-5.7): placeholders, hint, and the Ollama-only context window. */
function applyProviderUi(provider: AiProvider): void {
  const ui = getProviderUi(provider);
  $input("ai-base-url").placeholder = ui.baseUrlPlaceholder;
  // A saved key is shown as dots whatever the provider; otherwise the provider's hint
  $input("ai-api-key").placeholder = state.settings?.ai.apiKeyRef ? "••••••••" : ui.apiKeyPlaceholder;
  $("ai-provider-hint").textContent = ui.description;
  $("group-ai-context-window").classList.toggle("hidden", !ui.usesContextWindow);
}

function renderAiSection(): void {
  if (!state.settings) return;
  ($("ai-provider") as HTMLSelectElement).value = state.settings.ai.provider;
  applyProviderUi(state.settings.ai.provider);
  $input("ai-base-url").value = state.settings.ai.baseUrl;
  $input("ai-model-id").value = state.settings.ai.modelId;
  $input("ai-context-window").value = String(state.settings.ai.contextWindowTokens);

  // Set the dropdown to the current model if it's in the list
  const select = $("ai-model-select") as HTMLSelectElement;
  if (state.settings.ai.modelId && select.querySelector(`option[value="${CSS.escape(state.settings.ai.modelId)}"]`)) {
    select.value = state.settings.ai.modelId;
  }

  // API key is not displayed for security — only show placeholder if one is set
  $input("ai-api-key").value = "";

  // Auto-fetch models if base URL is configured
  if (state.settings.ai.baseUrl) {
    handleFetchModels();
  }
}

function renderExportSection(): void {
  if (!state.settings) return;
  $input("export-filename-pattern").value = state.settings.export.filenamePattern;

  // Frontmatter field checkboxes
  const container = $("frontmatter-fields");
  const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
  checkboxes.forEach((cb) => {
    cb.checked = state.settings!.export.frontmatterFields.includes(cb.value);
  });
}

function renderPatternsSection(): void {
  if (!state.settings) return;
  const list = $("patterns-list");
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");

  if (userPatterns.length === 0) {
    list.innerHTML = '<div class="empty-state">No user-defined patterns. Click "Add Pattern" to create one.</div>';
    return;
  }

  list.innerHTML = userPatterns
    .map((pattern, index) => renderPatternItem(pattern, index))
    .join("");

  // Bind edit/delete buttons
  list.querySelectorAll<HTMLButtonElement>("[data-action='edit-pattern']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index!, 10);
      handleEditPattern(idx);
    });
  });

  list.querySelectorAll<HTMLButtonElement>("[data-action='delete-pattern']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index!, 10);
      handleDeletePattern(idx);
    });
  });
}

function renderPatternItem(pattern: SitePattern, index: number): string {
  const staleClass = pattern.stale ? " stale" : "";
  const staleBadge = pattern.stale
    ? '<span class="pattern-item-stale-badge">⚠ Stale — selector may need updating</span>'
    : "";

  return `
    <div class="pattern-item${staleClass}">
      <div class="pattern-item-info">
        <div class="pattern-item-url">${escapeHtml(pattern.urlMatchPattern)}${staleBadge}</div>
        <div class="pattern-item-selector">${escapeHtml(pattern.contentSelector)}</div>
      </div>
      <div class="pattern-item-actions">
        <button class="btn-small btn-secondary" data-action="edit-pattern" data-index="${index}">Edit</button>
        <button class="btn-small btn-danger" data-action="delete-pattern" data-index="${index}">Delete</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Handlers: AI Connection Test
// ---------------------------------------------------------------------------

async function handleConnectionTest(): Promise<void> {
  const statusEl = $("connection-status");
  const btn = $("btn-test-connection") as HTMLButtonElement;

  const baseUrl = $input("ai-base-url").value.trim();
  const modelId = $input("ai-model-id").value.trim();
  const apiKey = $input("ai-api-key").value.trim();

  // Client-side validation
  if (!baseUrl) {
    showConnectionStatus("Base URL is required", "error");
    return;
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    showConnectionStatus("Base URL must start with http:// or https://", "error");
    return;
  }

  btn.disabled = true;
  showConnectionStatus("Testing...", "testing");

  try {
    const response = await Promise.race([
      sendToBackground("connectionTest", { baseUrl, apiKey, modelId }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), CONNECTION_TEST_TIMEOUT_MS)
      ),
    ]);

    if (response && typeof response === "object" && isMessageOfKind(response, "connectionTestResult")) {
      const result = response.payload;
      if (result.ok) {
        logger.debug("Connection test succeeded");
        showConnectionStatus("Connected successfully", "success");
      } else {
        logger.warn("Connection test failed", result.reason);
        showConnectionStatus(result.reason ?? "Connection failed", "error");
      }
    } else if (response && typeof response === "object") {
      // Direct result from background handler
      const result = response as { ok: boolean; reason?: string; detail?: string };
      if (result.ok) {
        logger.debug("Connection test succeeded");
        showConnectionStatus("Connected successfully", "success");
      } else {
        logger.warn("Connection test failed", result.detail ?? result.reason);
        showConnectionStatus(result.detail ?? result.reason ?? "Connection failed", "error");
      }
    } else {
      logger.warn("Connection test failed: unexpected response shape");
      showConnectionStatus("Unexpected response", "error");
    }
  } catch (err) {
    logger.warn("Connection test failed with an error", err instanceof Error ? err.message : String(err));
    const message = err instanceof Error && err.message === "timeout"
      ? "Connection timed out (10s)"
      : "Connection failed";
    showConnectionStatus(message, "error");
  } finally {
    btn.disabled = false;
  }
}

function showConnectionStatus(text: string, type: "success" | "error" | "testing"): void {
  const el = $("connection-status");
  el.textContent = text;
  el.className = `connection-status ${type}`;
}

// ---------------------------------------------------------------------------
// Handlers: Model Fetching
// ---------------------------------------------------------------------------

async function handleFetchModels(): Promise<void> {
  const baseUrl = $input("ai-base-url").value.trim();
  if (!baseUrl) return;

  const select = $("ai-model-select") as HTMLSelectElement;
  const btn = $("btn-fetch-models") as HTMLButtonElement;
  const apiKey = $input("ai-api-key").value.trim();

  // Use stored key if input is empty
  const effectiveKey = apiKey || "";

  btn.disabled = true;
  select.disabled = true;

  // Preserve current selection
  const currentModel = $input("ai-model-id").value.trim() || select.value;

  try {
    const endpoint = baseUrl.replace(/\/+$/, "") + "/v1/models";
    const response = await fetch(endpoint, {
      method: "GET",
      headers: effectiveKey
        ? { Authorization: `Bearer ${effectiveKey}` }
        : {},
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      // Silently fail — user can still type manually
      return;
    }

    const json = await response.json() as { data?: Array<{ id: string }> };
    const models = json.data ?? [];

    // Clear existing options (keep the placeholder)
    select.innerHTML = '<option value="">— Select a model —</option>';

    // Sort models alphabetically
    models.sort((a, b) => a.id.localeCompare(b.id));

    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.id;
      select.appendChild(option);
    }

    // Restore selection
    if (currentModel) {
      const matchingOption = select.querySelector(`option[value="${CSS.escape(currentModel)}"]`);
      if (matchingOption) {
        select.value = currentModel;
      } else if (currentModel) {
        // Add the current model as an option even if not in the list
        const option = document.createElement("option");
        option.value = currentModel;
        option.textContent = `${currentModel} (not found on server)`;
        select.appendChild(option);
        select.value = currentModel;
      }
    }
  } catch {
    // Silently fail — models endpoint might not be available
  } finally {
    btn.disabled = false;
    select.disabled = false;
  }
}

function handleModelSelect(): void {
  const select = $("ai-model-select") as HTMLSelectElement;
  const modelInput = $input("ai-model-id");

  if (select.value) {
    modelInput.value = select.value;
  }
}

// ---------------------------------------------------------------------------
// Handlers: Site Patterns
// ---------------------------------------------------------------------------

function handleAddPattern(): void {
  if (!state.settings) return;
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  if (userPatterns.length >= MAX_USER_PATTERNS) {
    showSaveStatus(`Maximum of ${MAX_USER_PATTERNS} user-defined patterns reached`, true);
    return;
  }

  state.editingPatternIndex = null;
  showPatternEditor("Add Site Pattern", "", "");
}

function handleEditPattern(userIndex: number): void {
  if (!state.settings) return;
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  const pattern = userPatterns[userIndex];
  if (!pattern) return;

  state.editingPatternIndex = userIndex;
  showPatternEditor("Edit Site Pattern", pattern.urlMatchPattern, pattern.contentSelector);
}

function handleDeletePattern(userIndex: number): void {
  if (!state.settings) return;
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  const pattern = userPatterns[userIndex];
  if (!pattern) return;

  // Remove from settings
  const updatedPatterns = state.settings.sitePatterns.filter((p) => p.id !== pattern.id);
  state.settings = { ...state.settings, sitePatterns: updatedPatterns };
  renderPatternsSection();
}

function handleSavePattern(): void {
  if (!state.settings) return;

  const urlPattern = $input("pattern-url").value.trim();
  const selector = $input("pattern-selector").value.trim();

  // Client-side validation
  const errors = validatePatternFields(urlPattern, selector);
  showPatternErrors(errors);
  if (errors.length > 0) return;

  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  const builtinPatterns = state.settings.sitePatterns.filter((p) => p.source === "builtin");

  if (state.editingPatternIndex !== null) {
    // Editing existing
    const existing = userPatterns[state.editingPatternIndex];
    const updated: SitePattern = {
      ...existing,
      urlMatchPattern: urlPattern,
      contentSelector: selector,
      stale: false,
    };
    userPatterns[state.editingPatternIndex] = updated;
  } else {
    // Adding new
    const newPattern: SitePattern = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: "user",
      urlMatchPattern: urlPattern,
      contentSelector: selector,
    };
    userPatterns.push(newPattern);
  }

  state.settings = { ...state.settings, sitePatterns: [...userPatterns, ...builtinPatterns] };
  hidePatternEditor();
  renderPatternsSection();
}

function handleCancelPattern(): void {
  hidePatternEditor();
}

function showPatternEditor(title: string, url: string, selector: string): void {
  $("pattern-editor-title").textContent = title;
  $input("pattern-url").value = url;
  $input("pattern-selector").value = selector;
  $("pattern-editor").classList.remove("hidden");
  $("selector-preview").textContent = "No preview available";
  clearPatternErrors();
}

function hidePatternEditor(): void {
  $("pattern-editor").classList.add("hidden");
  state.editingPatternIndex = null;
  clearPatternErrors();
}

function validatePatternFields(urlPattern: string, selector: string): FieldError[] {
  const errors: FieldError[] = [];

  if (!urlPattern) {
    errors.push({ field: "pattern-url", message: "URL match pattern is required" });
  }

  if (!selector) {
    errors.push({ field: "pattern-selector", message: "Content selector is required" });
  } else if (selector.length > 1024) {
    errors.push({ field: "pattern-selector", message: "Selector must be at most 1024 characters" });
  } else {
    // Validate CSS selector syntax
    try {
      document.querySelector(selector);
    } catch {
      errors.push({ field: "pattern-selector", message: "Invalid CSS selector syntax" });
    }
  }

  return errors;
}

function showPatternErrors(errors: FieldError[]): void {
  clearPatternErrors();
  for (const error of errors) {
    const el = document.getElementById(`error-${error.field}`);
    if (el) {
      el.textContent = error.message;
    }
    const input = document.getElementById(error.field);
    if (input) {
      input.classList.add("has-error");
    }
  }
}

function clearPatternErrors(): void {
  const errorEls = document.querySelectorAll<HTMLElement>("#pattern-editor .field-error");
  errorEls.forEach((el) => (el.textContent = ""));
  const inputs = document.querySelectorAll<HTMLElement>("#pattern-editor input");
  inputs.forEach((el) => el.classList.remove("has-error"));
}

async function handleSelectorPreview(): Promise<void> {
  const selector = $input("pattern-selector").value.trim();
  const previewEl = $("selector-preview");

  if (!selector) {
    previewEl.textContent = "No preview available";
    return;
  }

  // Try to get preview from the current active tab
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0 || !tabs[0].id) {
      previewEl.textContent = "No active tab available for preview";
      return;
    }

    // Ask the content script for the matched element's text (CF-6.5)
    const response = await browser.tabs.sendMessage(
      tabs[0].id,
      buildMessage("selectorPreview", { selector }),
    );

    if (isMessageOfKind(response, "selectorPreviewResult")) {
      if (response.payload.ok) {
        const text = response.payload.text ?? "";
        const truncated = text.length > SELECTOR_PREVIEW_MAX_CHARS
          ? text.slice(0, SELECTOR_PREVIEW_MAX_CHARS) + "…"
          : text;
        previewEl.textContent = truncated || "Selector matched but no text content found";
      } else {
        previewEl.textContent = response.payload.reason ?? "No preview available";
      }
    } else {
      previewEl.textContent = "No preview available (content script not responding)";
    }
  } catch {
    previewEl.textContent = "No preview available";
  }
}

// ---------------------------------------------------------------------------
// Handlers: Save Settings
// ---------------------------------------------------------------------------

async function handleSaveSettings(): Promise<void> {
  if (!state.settings) return;

  // Gather current form values
  const provider = readProvider();
  const baseUrl = $input("ai-base-url").value.trim();
  const modelId = $input("ai-model-id").value.trim();
  const apiKey = $input("ai-api-key").value.trim();
  // The context window only applies to Ollama (CF-5.7); for other providers the
  // control is hidden, so keep the stored value instead of validating a hidden field.
  const contextWindowTokens = getProviderUi(provider).usesContextWindow
    ? Number($input("ai-context-window").value.trim())
    : state.settings.ai.contextWindowTokens;
  const filenamePattern = $input("export-filename-pattern").value.trim();
  const debugLogging = $input("debug-logging-enabled").checked;

  // Gather frontmatter fields
  const frontmatterFields: string[] = [];
  const checkboxes = $("frontmatter-fields").querySelectorAll<HTMLInputElement>("input[type='checkbox']");
  checkboxes.forEach((cb) => {
    if (cb.checked) frontmatterFields.push(cb.value);
  });

  // Client-side validation
  const errors = validateFormFields(baseUrl, filenamePattern, contextWindowTokens);
  clearAllFieldErrors();
  if (errors.length > 0) {
    displayFieldErrors(errors);
    return;
  }

  // Build the complete settings object
  const settingsToSave: Settings = {
    ...state.settings,
    ai: {
      ...state.settings.ai,
      provider,
      baseUrl,
      modelId,
      contextWindowTokens,
    },
    export: {
      ...state.settings.export,
      filenamePattern,
      frontmatterFields,
    },
    debugLogging,
  };

  const btn = $("btn-save-settings") as HTMLButtonElement;
  btn.disabled = true;

  try {
    // Persist through the settings manager (CF-5.2): it validates, handles
    // the sync→local quota fallback, and broadcasts the change to all contexts.
    const saveResponse = await sendToBackground("settingsChanged", settingsToSave);
    if (isMessageOfKind(saveResponse, "settingsSaveResult") && !saveResponse.payload.ok) {
      logger.warn("Settings save rejected: validation failed", saveResponse.payload.errors);
      displayFieldErrors(saveResponse.payload.errors ?? []);
      showSaveStatus("Settings not saved — fix the highlighted fields", true);
      return;
    }

    // Handle API key: store via SecureStore in the background (CF-5.3).
    // The background records the resulting apiKeyRef in settings itself.
    let finalSettings = settingsToSave;
    if (apiKey) {
      const response = await sendToBackground("apiKeySave", { apiKey });
      if (isMessageOfKind(response, "apiKeySaveResult") && response.payload.ok && response.payload.ref) {
        finalSettings = { ...settingsToSave, ai: { ...settingsToSave.ai, apiKeyRef: response.payload.ref } };
        $input("ai-api-key").value = "";
      } else {
        logger.warn("Settings saved, but API key save failed");
        showSaveStatus("Settings saved, but storing the API key failed", true);
        state.settings = settingsToSave;
        renderAll();
        return;
      }
    }

    state.settings = finalSettings;
    logger.debug("Settings saved");
    showSaveStatus("Settings saved", false);
    renderAll();
  } catch (err) {
    logger.warn("Settings save failed with an error", err instanceof Error ? err.message : String(err));
    showSaveStatus("Failed to save settings", true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Client-Side Validation
// ---------------------------------------------------------------------------

function validateFormFields(baseUrl: string, filenamePattern: string, contextWindowTokens: number): FieldError[] {
  const errors: FieldError[] = [];

  // AI base URL: must start with http:// or https:// when non-empty
  if (baseUrl !== "" && !/^https?:\/\//.test(baseUrl)) {
    errors.push({ field: "ai.baseUrl", message: "Base URL must start with http:// or https://" });
  }

  // Context window: integer within the CF-5.6 bounds
  const contextWindowError = validateContextWindowTokens(contextWindowTokens);
  if (contextWindowError) {
    errors.push({ field: "ai.contextWindowTokens", message: contextWindowError });
  }

  // Filename pattern: must be non-empty
  if (filenamePattern.trim() === "") {
    errors.push({ field: "export.filenamePattern", message: "Filename pattern must not be empty" });
  }

  return errors;
}

function displayFieldErrors(errors: ReadonlyArray<FieldError>): void {
  for (const error of errors) {
    // Map field paths to DOM element IDs
    const elementId = fieldToElementId(error.field);
    const errorEl = document.getElementById(`error-${elementId}`);
    if (errorEl) {
      errorEl.textContent = error.message;
    }
    const inputEl = document.getElementById(elementId);
    if (inputEl) {
      inputEl.classList.add("has-error");
    }
  }
}

function clearAllFieldErrors(): void {
  document.querySelectorAll<HTMLElement>(".field-error").forEach((el) => (el.textContent = ""));
  document.querySelectorAll<HTMLElement>(".has-error").forEach((el) => el.classList.remove("has-error"));
}

function fieldToElementId(field: string): string {
  const map: Record<string, string> = {
    "ai.provider": "ai-provider",
    "ai.baseUrl": "ai-base-url",
    "ai.modelId": "ai-model-id",
    "ai.apiKey": "ai-api-key",
    "ai.contextWindowTokens": "ai-context-window",
    "export.filenamePattern": "export-filename-pattern",
  };
  return map[field] ?? field;
}

// ---------------------------------------------------------------------------
// Status Display
// ---------------------------------------------------------------------------

function showSaveStatus(message: string, isError: boolean): void {
  const el = $("save-status");
  el.textContent = message;
  el.className = `save-status ${isError ? "error" : "success"}`;
  if (!isError) {
    setTimeout(() => {
      el.textContent = "";
      el.className = "save-status";
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str.replace(/[&"'<>]/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return ch;
    }
  });
}

function showFieldError(field: string, message: string): void {
  const el = document.getElementById(`error-${field}`);
  if (el) el.textContent = message;
}

function clearFieldErrors(fields: string[]): void {
  for (const field of fields) {
    const el = document.getElementById(`error-${field}`);
    if (el) el.textContent = "";
  }
}
