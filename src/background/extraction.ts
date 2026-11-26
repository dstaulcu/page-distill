/**
 * Extraction orchestration service (CF-1).
 *
 * Owns the background side of content extraction: privileged-page guard,
 * site-pattern → selector resolution, the content-script round trip with
 * timeout, stale-pattern flagging, and the "has the user saved a pattern
 * for this site" check. Extracted from main.ts so it is testable with
 * injected dependencies.
 */

import type { Settings, SitePattern } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import type { MessageOf } from "@shared/messages";
import { buildMessage } from "@shared/messages";
import { matchSitePattern, patternMatchesUrl } from "./site-patterns/matcher";
import type { Logger } from "@shared/logger";
import { noopLogger } from "@shared/logger";

export interface ExtractionServiceDeps {
  /** Resolves a tab's current URL; rejects/throws when the tab is inaccessible. */
  readonly getTabUrl: (tabId: number) => Promise<string>;
  /** Sends the extractRequested message to the tab's content script. */
  readonly sendExtractMessage: (tabId: number, msg: MessageOf<"extractRequested">) => Promise<unknown>;
  readonly getSettings: () => Promise<Settings>;
  /** Persists an updated sitePatterns array (used for stale flagging). */
  readonly updateSitePatterns: (patterns: ReadonlyArray<SitePattern>) => Promise<void>;
  /** Content-script response timeout; defaults to 10 s (CF-1.6). */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export interface ExtractionService {
  extractContent(tabId: number, selector?: string): Promise<ExtractionResult>;
  /** CF-1.1: true only when a USER-saved pattern matches the URL — builtins don't count. */
  hasSavedPattern(url: string): Promise<boolean>;
}

const PRIVILEGED_PREFIXES = ["about:", "moz-extension:", "chrome:"];

export function createExtractionService(deps: ExtractionServiceDeps): ExtractionService {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const logger = deps.logger ?? noopLogger;

  async function markPatternStale(url: string, selector: string): Promise<void> {
    const settings = await deps.getSettings();
    // CF-1.4: flag only the user pattern that actually matched this URL with
    // this selector — never builtins, never same-selector patterns for other sites.
    const patterns = settings.sitePatterns.map((p) =>
      p.source === "user" && p.contentSelector === selector && !p.stale && patternMatchesUrl(p, url)
        ? { ...p, stale: true }
        : p,
    );
    if (patterns.some((p, i) => p !== settings.sitePatterns[i])) {
      await deps.updateSitePatterns(patterns);
    }
  }

  return {
    async extractContent(tabId: number, selector?: string): Promise<ExtractionResult> {
      // Pre-check: skip extraction for pages where content scripts can't run (CF-1.5)
      let tabUrl = "";
      try {
        tabUrl = await deps.getTabUrl(tabId);
        if (tabUrl === "" || PRIVILEGED_PREFIXES.some((prefix) => tabUrl.startsWith(prefix))) {
          return { ok: false, reason: "extraction-error", detail: "Cannot extract content from this page type" };
        }
      } catch {
        return { ok: false, reason: "extraction-error", detail: "Tab not accessible" };
      }

      // If no explicit selector provided, look up saved site patterns for this URL.
      // A selector that came from the built-in list (or no selector at all) is
      // "automatic"; one the user saved or passed explicitly must be respected.
      let autoSelect = !selector;
      if (!selector) {
        const settings = await deps.getSettings();
        const match = matchSitePattern({ patterns: settings.sitePatterns, url: tabUrl });
        if (match.ok) {
          selector = match.pattern.contentSelector;
          autoSelect = match.pattern.source === "builtin";
        }
      }

      const msg = buildMessage("extractRequested", { tabId, selector, autoSelect });

      let response: unknown;
      try {
        response = await Promise.race([
          deps.sendExtractMessage(tabId, msg),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Content script did not respond within ${timeoutMs / 1000}s`)), timeoutMs),
          ),
        ]);
      } catch (err) {
        // sendMessage throws if no content script is listening
        const detail = err instanceof Error ? err.message : "Content script unavailable";
        return { ok: false, reason: "extraction-error", detail };
      }

      if (response && typeof response === "object" && "payload" in (response as object)) {
        const result = (response as MessageOf<"extractResult">).payload;
        if (result.ok) {
          // If the content script reports a stale pattern, mark it in settings
          if (result.stalePattern && selector && tabUrl) {
            markPatternStale(tabUrl, selector);
          }
          logger.debug("Extraction succeeded for tab", tabId, `confidence=${result.confidence}`);
          return {
            ok: true,
            article: result.article!,
            confidence: result.confidence!,
          };
        }
        logger.warn("Extraction failed for tab", tabId, result.reason, result.detail);
        return {
          ok: false,
          reason: (result.reason as "no-content-detected" | "extraction-error") ?? "extraction-error",
          detail: result.detail ?? "Extraction failed",
        };
      }
      logger.warn("Extraction failed for tab", tabId, "no response from content script");
      return { ok: false, reason: "extraction-error", detail: "No response from content script" };
    },

    async hasSavedPattern(url: string): Promise<boolean> {
      const settings = await deps.getSettings();
      const match = matchSitePattern({ patterns: settings.sitePatterns, url });
      return match.ok && match.pattern.source === "user";
    },
  };
}
