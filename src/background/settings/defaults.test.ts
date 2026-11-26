import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, backfillDefaults } from "./defaults";
import type { Settings } from "@shared/types";

// Settings persisted by an older version, before these fields (context window, provider, debug logging) existed.
function legacySettings(): Settings {
  const { contextWindowTokens: _c, provider: _p, ...aiWithout } = DEFAULT_SETTINGS.ai;
  const { debugLogging: _d, ...rest } = DEFAULT_SETTINGS;
  return { ...rest, ai: { ...aiWithout, modelId: "my-model" } } as unknown as Settings;
}

describe("CF-5.6 backfillDefaults", () => {
  it("fills contextWindowTokens (8192) and debugLogging (false) for settings that predate them, keeping everything else", () => {
    const result = backfillDefaults(legacySettings());
    expect(result.ai.contextWindowTokens).toBe(8192);
    expect(result.debugLogging).toBe(false);
    expect(result.ai.modelId).toBe("my-model");
  });

  it("returns the same object when nothing needs backfilling", () => {
    const current: Settings = { ...DEFAULT_SETTINGS, debugLogging: true, ai: { ...DEFAULT_SETTINGS.ai, contextWindowTokens: 4096 } };
    expect(backfillDefaults(current)).toBe(current);
  });

  it("does not overwrite explicit values", () => {
    const current: Settings = { ...DEFAULT_SETTINGS, debugLogging: true, ai: { ...DEFAULT_SETTINGS.ai, contextWindowTokens: 4096 } };
    const result = backfillDefaults(current);
    expect(result.ai.contextWindowTokens).toBe(4096);
    expect(result.debugLogging).toBe(true);
  });
});

describe("CF-5.7 provider defaults and backfill", () => {
  function withBaseUrl(baseUrl: string): Settings {
    const legacy = legacySettings();
    return { ...legacy, ai: { ...legacy.ai, baseUrl } } as Settings;
  }

  it("defaults new installs to the Ollama provider", () => {
    expect(DEFAULT_SETTINGS.ai.provider).toBe("ollama");
  });

  it("infers Ollama for legacy settings pointing at a local / port-11434 endpoint, or with no endpoint yet", () => {
    expect(backfillDefaults(withBaseUrl("http://localhost:11434")).ai.provider).toBe("ollama");
    expect(backfillDefaults(withBaseUrl("")).ai.provider).toBe("ollama");
  });

  it("infers OpenAI-compatible for legacy settings pointing at a hosted endpoint, so upgrading never starts sending Ollama-only fields to it", () => {
    expect(backfillDefaults(withBaseUrl("https://api.openai.com")).ai.provider).toBe("openai-compatible");
  });

  it("never overwrites an explicitly stored provider", () => {
    const current: Settings = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "http://localhost:1234", provider: "openai-compatible" },
    };
    expect(backfillDefaults(current)).toBe(current);
  });

  it("treats an unrecognized stored provider like a missing one", () => {
    const bad = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.openai.com", provider: "bogus" } } as unknown as Settings;
    expect(backfillDefaults(bad).ai.provider).toBe("openai-compatible");
  });
});
