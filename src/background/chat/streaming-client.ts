/**
 * Streaming AI Client for OpenAI-compatible endpoints.
 *
 * Parses SSE streams, delivers tokens via callback, and enforces
 * a configurable token timeout. Uses dependency injection for fetch.
 */

import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "./context-budget";
import type { AiProvider } from "@shared/types";
import { isOllamaLikeEndpoint } from "@shared/providers";
import type { Logger } from "@shared/logger";
import { noopLogger } from "@shared/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface StreamChatCompletionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly signal: AbortSignal;
  readonly onToken: (token: string) => void;
}

export type StreamChatCompletionResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason: "timeout" | "network" | "non-2xx" | "malformed" | "aborted";
      readonly statusCode?: number;
      readonly detail: string;
      readonly partialContent: string;
    };

export interface StreamingAiClient {
  streamChatCompletion(req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult>;
}

export interface StreamingClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Server kind (CF-5.7). "ollama" gets the num_ctx override; "openai-compatible"
   * never does. When omitted, it is inferred from the base URL (legacy callers).
   */
  readonly provider?: AiProvider;
  readonly tokenTimeoutMs?: number; // Default: 30_000
  readonly fetch?: typeof globalThis.fetch;
  /** Model's context window in tokens (CF-5.6); sourced from settings.ai.contextWindowTokens, default 8192. */
  readonly contextWindowTokens?: number;
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

// Ollama defaults every request to a 2048-token context window regardless of
// what the model itself supports, unless the request explicitly overrides
// it — silently truncating long multi-article conversations from the front
// (dropping the earliest content: system prompt, page context, article
// titles/URLs) once the total exceeds that. 8192 (DEFAULT_CONTEXT_WINDOW_TOKENS)
// matches llama3's native context and is used when the user hasn't configured
// ai.contextWindowTokens (CF-5.6).

// Re-exported for existing importers; the heuristic now lives in @shared/providers
// and is only a fallback when no provider is given (CF-5.7).
export { isOllamaLikeEndpoint };

export function createStreamingClient(opts: StreamingClientOptions): StreamingAiClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const tokenTimeoutMs = opts.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  const endpoint = opts.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";
  const ollamaLike = opts.provider !== undefined ? opts.provider === "ollama" : isOllamaLikeEndpoint(opts.baseUrl);
  const logger = opts.logger ?? noopLogger;

  return {
    async streamChatCompletion(req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> {
      let partialContent = "";

      // Check if already aborted
      if (req.signal.aborted) {
        return {
          ok: false,
          reason: "aborted",
          detail: "Request was aborted before starting",
          partialContent,
        };
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`;
      }

      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        stream: true,
      };
      if (ollamaLike) {
        const numCtx = opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
        body.options = { num_ctx: numCtx };
        logger.debug("Applying Ollama num_ctx override", numCtx);
      }

      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err: unknown) {
        if (isAbortError(err)) {
          return {
            ok: false,
            reason: "aborted",
            detail: "Request was aborted",
            partialContent,
          };
        }
        const detail = err instanceof Error ? err.message : "Network error";
        logger.warn("Streaming request failed with a network error", detail);
        return {
          ok: false,
          reason: "network",
          detail,
          partialContent,
        };
      }

      if (!response.ok) {
        logger.warn("Streaming request returned a non-2xx response", response.status);
        return {
          ok: false,
          reason: "non-2xx",
          statusCode: response.status,
          detail: `Server returned ${response.status}`,
          partialContent,
        };
      }

      if (!response.body) {
        logger.warn("Streaming response had no body");
        return {
          ok: false,
          reason: "malformed",
          detail: "Response body is null",
          partialContent,
        };
      }

      // Parse SSE stream
      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Track last token time and check on each read
        let lastTokenTime = Date.now();

        const checkTimeout = () => {
          if (Date.now() - lastTokenTime > tokenTimeoutMs) {
            throw new TokenTimeoutError();
          }
        };

        // Set up abort listener
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reader.cancel().catch(() => {});
        };
        req.signal.addEventListener("abort", onAbort);

        try {
          while (true) {
            if (aborted) {
              return {
                ok: false,
                reason: "aborted",
                detail: "Request was aborted during streaming",
                partialContent,
              };
            }

            checkTimeout();

            // Read with a timeout race; the timer is cancelled as soon as the
            // race settles so completed reads don't leave timers behind
            const readTimeout = createReadTimeout(tokenTimeoutMs - (Date.now() - lastTokenTime));
            let readResult: ReadableStreamReadResult<Uint8Array>;
            try {
              readResult = await Promise.race([reader.read(), readTimeout.promise]);
            } finally {
              readTimeout.cancel();
            }

            if (aborted) {
              return {
                ok: false,
                reason: "aborted",
                detail: "Request was aborted during streaming",
                partialContent,
              };
            }

            if (readResult.done) {
              break;
            }

            buffer += decoder.decode(readResult.value, { stream: true });

            // Process complete lines from buffer
            const lines = buffer.split("\n");
            // Keep the last incomplete line in the buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();

              if (trimmed === "") {
                continue;
              }

              if (!trimmed.startsWith("data: ")) {
                continue;
              }

              const data = trimmed.slice(6); // Remove "data: " prefix

              if (data === "[DONE]") {
                return { ok: true, content: partialContent };
              }

              try {
                const parsed = JSON.parse(data);
                const token = parsed?.choices?.[0]?.delta?.content;
                if (typeof token === "string" && token.length > 0) {
                  partialContent += token;
                  lastTokenTime = Date.now();
                  req.onToken(token);
                }
              } catch {
                // Skip malformed JSON lines — some SSE streams include comments or metadata
              }
            }
          }
        } finally {
          req.signal.removeEventListener("abort", onAbort);
        }

        // Stream ended without [DONE] — still return what we have as success
        return { ok: true, content: partialContent };
      } catch (err: unknown) {
        if (err instanceof TokenTimeoutError) {
          logger.warn("Streaming request timed out", `${tokenTimeoutMs}ms`);
          return {
            ok: false,
            reason: "timeout",
            detail: `No token received within ${tokenTimeoutMs}ms`,
            partialContent,
          };
        }
        if (isAbortError(err)) {
          return {
            ok: false,
            reason: "aborted",
            detail: "Request was aborted during streaming",
            partialContent,
          };
        }
        const detail = err instanceof Error ? err.message : "Stream read error";
        logger.warn("Streaming request failed while reading the response", detail);
        return {
          ok: false,
          reason: "network",
          detail,
          partialContent,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TokenTimeoutError extends Error {
  constructor() {
    super("Token timeout");
    this.name = "TokenTimeoutError";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function createReadTimeout(ms: number): { readonly promise: Promise<never>; readonly cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TokenTimeoutError());
    }, Math.max(ms, 0));
  });
  return {
    promise,
    cancel: () => clearTimeout(timeoutId),
  };
}
