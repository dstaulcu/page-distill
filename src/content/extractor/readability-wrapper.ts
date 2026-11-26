import { Readability } from "@mozilla/readability";
import { stripNoise } from "./noise";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReadabilityOptions {
  readonly doc?: Document;
  readonly url?: string;
}

export interface ReadabilityOutput {
  readonly title: string;
  readonly content: string; // HTML string of extracted content
  readonly textContent: string; // Plain text
  readonly length: number; // Character count
  readonly excerpt: string;
  readonly byline: string | null;
  readonly siteName: string | null;
}

export type ReadabilityOutcome =
  | { readonly ok: true; readonly result: ReadabilityOutput; readonly confidence: "high" | "medium" | "low" }
  | { readonly ok: false; readonly reason: "no-content-detected" };

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

function computeConfidence(contentLength: number): "high" | "medium" | "low" {
  if (contentLength > 500) return "high";
  if (contentLength >= 100) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Runs @mozilla/readability on a cloned document and returns the result
 * with a confidence score based on content length.
 *
 * Accepts `doc` and `url` as injectable dependencies for testing with jsdom.
 * Defaults to the global `document` and `location.href` in production.
 */
export function extractWithReadability(opts?: ReadabilityOptions): ReadabilityOutcome {
  const doc = opts?.doc ?? document;
  const url = opts?.url ?? doc.baseURI;

  // Readability mutates the document, so every attempt works on a fresh clone.
  const parseClone = (stripBoilerplate: boolean) => {
    const clonedDoc = doc.cloneNode(true) as Document;

    // Set the document URL for Readability's internal link resolution
    if (url && clonedDoc.head) {
      const base = clonedDoc.createElement("base");
      base.setAttribute("href", url);
      clonedDoc.head.appendChild(base);
    }

    if (stripBoilerplate && clonedDoc.body) {
      stripNoise(clonedDoc.body);
    }
    return new Readability(clonedDoc).parse();
  };

  // Ads / nav / hidden elements out first so they can't win Readability's
  // scoring; if that leaves nothing, retry on the untouched page.
  let parsed = parseClone(true);
  if (parsed === null || parsed.textContent.trim().length === 0) {
    parsed = parseClone(false);
  }

  if (parsed === null || parsed.textContent.trim().length === 0) {
    return { ok: false, reason: "no-content-detected" };
  }

  const result: ReadabilityOutput = {
    title: parsed.title,
    content: parsed.content,
    textContent: parsed.textContent,
    length: parsed.textContent.length,
    excerpt: parsed.excerpt,
    byline: parsed.byline || null,
    siteName: parsed.siteName || null,
  };

  const confidence = computeConfidence(parsed.textContent.length);

  return { ok: true, result, confidence };
}
