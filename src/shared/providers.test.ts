import { describe, it, expect } from "vitest";
import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER,
  isAiProvider,
  inferProvider,
  isOllamaLikeEndpoint,
  getProviderUi,
} from "./providers";

describe("CF-5.7 AI providers", () => {
  it("offers Ollama and OpenAI-compatible, defaulting to Ollama", () => {
    expect(AI_PROVIDERS).toEqual(["ollama", "openai-compatible"]);
    expect(DEFAULT_AI_PROVIDER).toBe("ollama");
  });

  it("isAiProvider accepts only the known provider ids", () => {
    expect(isAiProvider("ollama")).toBe(true);
    expect(isAiProvider("openai-compatible")).toBe(true);
    expect(isAiProvider("openai")).toBe(false);
    expect(isAiProvider("")).toBe(false);
    expect(isAiProvider(undefined)).toBe(false);
    expect(isAiProvider(42)).toBe(false);
  });

  describe("inferProvider (for settings saved before providers existed)", () => {
    it("treats loopback hosts and Ollama's default port as Ollama", () => {
      expect(inferProvider("http://localhost:11434")).toBe("ollama");
      expect(inferProvider("http://127.0.0.1:8080")).toBe("ollama");
      expect(inferProvider("http://gpu-box.lan:11434")).toBe("ollama");
    });

    it("treats other endpoints as OpenAI-compatible so hosted APIs never receive Ollama-only fields", () => {
      expect(inferProvider("https://api.openai.com")).toBe("openai-compatible");
      expect(inferProvider("https://llm.mycorp.example/v1")).toBe("openai-compatible");
    });

    it("falls back to the default (Ollama) when no endpoint is configured yet or the URL is unparseable", () => {
      expect(inferProvider("")).toBe("ollama");
      expect(inferProvider("not a url")).toBe("openai-compatible");
    });
  });

  it("isOllamaLikeEndpoint keeps the loopback / port-11434 heuristic", () => {
    expect(isOllamaLikeEndpoint("http://localhost:1234")).toBe(true);
    expect(isOllamaLikeEndpoint("https://api.openai.com")).toBe(false);
    expect(isOllamaLikeEndpoint("garbage")).toBe(false);
  });

  describe("getProviderUi", () => {
    it("Ollama: local URL placeholder, optional key, uses the context window", () => {
      const ui = getProviderUi("ollama");
      expect(ui.label).toBe("Ollama");
      expect(ui.baseUrlPlaceholder).toBe("http://localhost:11434");
      expect(ui.apiKeyOptional).toBe(true);
      expect(ui.usesContextWindow).toBe(true);
    });

    it("OpenAI-compatible: hosted URL placeholder, no context-window control", () => {
      const ui = getProviderUi("openai-compatible");
      expect(ui.label).toBe("OpenAI-compatible");
      expect(ui.baseUrlPlaceholder).toBe("https://api.openai.com");
      expect(ui.usesContextWindow).toBe(false);
    });
  });
});
