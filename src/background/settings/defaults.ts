/**
 * Default settings for Distill v3.
 *
 * Applied on first install and used as the base when no persisted
 * settings exist in storage.
 */

import type { Settings } from "@shared/types";
import { DEFAULT_AI_PROVIDER, inferProvider, isAiProvider } from "@shared/providers";

// ---------------------------------------------------------------------------
// Default Settings
//
// Note: built-in site patterns are NOT seeded into settings. The canonical
// builtin list lives in @background/site-patterns/matcher (BUILTIN_PATTERNS)
// and is applied at match time, so settings only ever hold user patterns.
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  ai: {
    provider: DEFAULT_AI_PROVIDER,
    baseUrl: "",
    modelId: "",
    apiKeyRef: null,
    systemPrompt: "",
    contextWindowTokens: 8192,
  },
  export: {
    filenamePattern: "YYYY-MM-DD-slugified-title",
    defaultDestination: { kind: "download" },
    frontmatterFields: ["title", "author", "source_url", "publication_date", "capture_date", "site_name"],
  },
  sitePatterns: [],
  debugLogging: false,
};

// ---------------------------------------------------------------------------
// Back-compat — settings persisted before a field existed (e.g.
// ai.contextWindowTokens CF-5.6, ai.provider CF-5.7, debugLogging SF-8) come back from storage
// without it; treat that as the default rather than letting it read as
// `undefined` (which would fail validation on every future update, including
// ones that never touch the field's own section). Used by the settings
// manager AND the options page, which reads storage directly to populate
// its form.
// ---------------------------------------------------------------------------

export function backfillDefaults(settings: Settings): Settings {
  const needsContextWindowBackfill = settings.ai.contextWindowTokens === undefined;
  const needsProviderBackfill = !isAiProvider(settings.ai.provider);
  const needsDebugLoggingBackfill = settings.debugLogging === undefined;
  if (!needsContextWindowBackfill && !needsProviderBackfill && !needsDebugLoggingBackfill) return settings;
  return {
    ...settings,
    ai: needsContextWindowBackfill || needsProviderBackfill
      ? {
          ...settings.ai,
          // CF-5.7: settings saved before providers existed get the provider their URL implies.
          provider: needsProviderBackfill ? inferProvider(settings.ai.baseUrl ?? "") : settings.ai.provider,
          contextWindowTokens: needsContextWindowBackfill
            ? DEFAULT_SETTINGS.ai.contextWindowTokens
            : settings.ai.contextWindowTokens,
        }
      : settings.ai,
    debugLogging: needsDebugLoggingBackfill ? DEFAULT_SETTINGS.debugLogging : settings.debugLogging,
  };
}

// ---------------------------------------------------------------------------
// Storage Key
// ---------------------------------------------------------------------------

export const SETTINGS_STORAGE_KEY = "settings";
