/**
 * Bounds and validation for `ai.contextWindowTokens` (CF-5.6). Shared by the
 * settings manager and the options page so both reject the same values.
 */

/** Below this, the CF-3.8 budget (tokens × 4 chars, minus the 25% reserved for the reply) is too small to hold any useful prompt. */
export const MIN_CONTEXT_WINDOW_TOKENS = 512;

/** Sanity ceiling — comfortably above any real model's window today. */
export const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;

/** Returns an error message, or null when the value is a valid context-window size. */
export function validateContextWindowTokens(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "Context window must be a whole number of tokens";
  }
  if (value < MIN_CONTEXT_WINDOW_TOKENS || value > MAX_CONTEXT_WINDOW_TOKENS) {
    return `Context window must be between ${MIN_CONTEXT_WINDOW_TOKENS} and ${MAX_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")} tokens`;
  }
  return null;
}
