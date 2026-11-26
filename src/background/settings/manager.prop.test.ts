import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { validateSettings } from "./manager";
import { DEFAULT_SETTINGS } from "./defaults";
import type { Settings, SitePattern } from "@shared/types";

// ---------------------------------------------------------------------------
// Property 12: Settings validation rejects invalid values
// Validates: Requirements 8.7
// ---------------------------------------------------------------------------

describe("Property 12: Settings validation rejects invalid values", () => {
  it("rejects non-empty baseUrl that does not start with http:// or https://", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter(
          (s) => !s.startsWith("http://") && !s.startsWith("https://"),
        ),
        (invalidUrl) => {
          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            ai: { ...DEFAULT_SETTINGS.ai, baseUrl: invalidUrl },
          };
          const errors = validateSettings(settings);
          const urlErrors = errors.filter((e) => e.field === "ai.baseUrl");
          expect(urlErrors.length).toBe(1);
          expect(urlErrors[0].message).toBeTruthy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects empty or whitespace-only filenamePattern", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r", "\f")).chain((ws) =>
          fc.constant(ws),
        ),
        (whitespaceOnly) => {
          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            export: { ...DEFAULT_SETTINGS.export, filenamePattern: whitespaceOnly },
          };
          const errors = validateSettings(settings);
          const patternErrors = errors.filter((e) => e.field === "export.filenamePattern");
          expect(patternErrors.length).toBe(1);
          expect(patternErrors[0].message).toBeTruthy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects more than 50 user-defined site patterns", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 51, max: 200 }),
        (count) => {
          const userPatterns: SitePattern[] = Array.from({ length: count }, (_, i) => ({
            id: `user-${i}`,
            source: "user" as const,
            urlMatchPattern: `*://*.site${i}.com/*`,
            contentSelector: ".content",
          }));
          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            sitePatterns: userPatterns,
          };
          const errors = validateSettings(settings);
          const patternErrors = errors.filter((e) => e.field === "sitePatterns");
          expect(patternErrors.length).toBe(1);
          expect(patternErrors[0].message).toBeTruthy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts valid settings with no validation errors", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    const validBaseUrl = fc.oneof(
      fc.constant(""),
      fc.webUrl().map((url) => url), // webUrl generates http/https URLs
    );

    const validFilenamePattern = fc.string({ minLength: 1 }).filter(
      (s) => s.trim().length > 0,
    );

    const validSitePatterns = fc.array(
      fc.record({
        id: fc.string({ minLength: 1 }),
        source: fc.constant("user" as const),
        urlMatchPattern: fc.string({ minLength: 1 }),
        contentSelector: fc.string({ minLength: 1 }),
      }),
      { minLength: 0, maxLength: 50 },
    );

    fc.assert(
      fc.property(
        validBaseUrl,
        validFilenamePattern,
        validSitePatterns,
        (baseUrl, filenamePattern, sitePatterns) => {
          const settings: Settings = {
            schemaVersion: 1,
            ai: {
              provider: "ollama",
              baseUrl,
              modelId: "gpt-4",
              apiKeyRef: null,
              systemPrompt: "",
              contextWindowTokens: 8192,
            },
            export: {
              filenamePattern,
              defaultDestination: { kind: "download" },
              frontmatterFields: ["title"],
            },
            sitePatterns,
            debugLogging: false,
          };
          const errors = validateSettings(settings);
          expect(errors).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
