/**
 * AI providers (CF-5.7). A provider says what KIND of server the base URL
 * points at, which decides a few behaviors that used to be guessed from the URL:
 *
 *   - "ollama":            a local/self-hosted Ollama server. Gets the `num_ctx`
 *                          override (CF-5.5) and client-side prompt budgeting
 *                          (CF-3.8/CF-3.9), because Ollama silently truncates the
 *                          front of an oversized prompt. The API key is optional.
 *   - "openai-compatible": any other server that speaks the OpenAI chat-completions
 *                          API (OpenAI, Azure gateways, LM Studio, vLLM, llama.cpp…).
 *                          Never receives Ollama-only fields and is never trimmed —
 *                          such servers report an overflow explicitly.
 *
 * Both talk to `<baseUrl>/v1/chat/completions`.
 */

import type { AiProvider } from "./types";

export const AI_PROVIDERS: ReadonlyArray<AiProvider> = ["ollama", "openai-compatible"];

export const DEFAULT_AI_PROVIDER: AiProvider = "ollama";

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as ReadonlyArray<string>).includes(value);
}

/**
 * Heuristic for "this URL is probably a local Ollama server": loopback hosts or
 * Ollama's default port. Only used to pick a provider for settings saved before
 * providers existed — afterwards the stored provider is authoritative.
 */
export function isOllamaLikeEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "0.0.0.0") {
      return true;
    }
    return url.port === "11434";
  } catch {
    return false;
  }
}

/**
 * Provider for settings saved before providers existed. An empty endpoint
 * (not configured yet) gets the default; otherwise the URL decides, erring on
 * the side of "openai-compatible" so an upgrade never starts sending
 * Ollama-only fields to a hosted API.
 */
export function inferProvider(baseUrl: string): AiProvider {
  if (baseUrl === "") return DEFAULT_AI_PROVIDER;
  return isOllamaLikeEndpoint(baseUrl) ? "ollama" : "openai-compatible";
}

export interface ProviderUi {
  readonly label: string;
  readonly baseUrlPlaceholder: string;
  readonly apiKeyPlaceholder: string;
  readonly apiKeyOptional: boolean;
  /** Whether the context-window setting does anything for this provider. */
  readonly usesContextWindow: boolean;
  /** One-line explanation shown under the provider picker. */
  readonly description: string;
}

const PROVIDER_UI: Readonly<Record<AiProvider, ProviderUi>> = {
  ollama: {
    label: "Ollama",
    baseUrlPlaceholder: "http://localhost:11434",
    apiKeyPlaceholder: "Optional — leave empty for a local server",
    apiKeyOptional: true,
    usesContextWindow: true,
    description: "A local or self-hosted Ollama server. No API key needed unless it sits behind a proxy.",
  },
  "openai-compatible": {
    label: "OpenAI-compatible",
    baseUrlPlaceholder: "https://api.openai.com",
    apiKeyPlaceholder: "sk-...",
    apiKeyOptional: false,
    usesContextWindow: false,
    description: "OpenAI or any server with the OpenAI chat-completions API (LM Studio, vLLM, llama.cpp, gateways).",
  },
};

export function getProviderUi(provider: AiProvider): ProviderUi {
  return PROVIDER_UI[provider];
}
