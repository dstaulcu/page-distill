import { describe, it, expect } from "vitest";
import {
  validateContextWindowTokens,
  MIN_CONTEXT_WINDOW_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
} from "./context-window";

describe("CF-5.6 validateContextWindowTokens", () => {
  it("accepts the documented bounds and the default", () => {
    expect(MIN_CONTEXT_WINDOW_TOKENS).toBe(512);
    expect(MAX_CONTEXT_WINDOW_TOKENS).toBe(10_000_000);
    expect(validateContextWindowTokens(512)).toBeNull();
    expect(validateContextWindowTokens(8192)).toBeNull();
    expect(validateContextWindowTokens(10_000_000)).toBeNull();
  });

  it("rejects values below the minimum, including the typo case that gives a ~24-char budget", () => {
    expect(validateContextWindowTokens(511)).toMatch(/512/);
    expect(validateContextWindowTokens(8)).not.toBeNull();
    expect(validateContextWindowTokens(0)).not.toBeNull();
    expect(validateContextWindowTokens(-1)).not.toBeNull();
  });

  it("rejects values above the maximum", () => {
    expect(validateContextWindowTokens(10_000_001)).toMatch(/10,000,000/);
  });

  it("rejects non-integers, NaN and undefined", () => {
    expect(validateContextWindowTokens(1000.5)).not.toBeNull();
    expect(validateContextWindowTokens(Number.NaN)).not.toBeNull();
    expect(validateContextWindowTokens(undefined)).not.toBeNull();
  });
});
