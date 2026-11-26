import { extractWithReadability } from "./readability-wrapper";
import { domToMarkdown } from "./dom-to-markdown";
import { extractMetadata } from "./metadata";
import { pickContentElement } from "./candidates";
import { stripNoise } from "./noise";
import { assessConfidence } from "./confidence";
import type { ExtractedArticle } from "@shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  readonly contentSelector?: string;
  readonly doc?: Document;
  readonly url?: string;
}

export type ExtractionResult =
  | { readonly ok: true; readonly article: ExtractedArticle; readonly confidence: "high" | "medium" | "low"; readonly stalePattern?: boolean }
  | { readonly ok: false; readonly reason: "no-content-detected" | "extraction-error"; readonly detail: string };

// ---------------------------------------------------------------------------
// Main extraction orchestrator
// ---------------------------------------------------------------------------

/**
 * Top-level content extraction orchestrator.
 *
 * 1. If `contentSelector` is provided, resolve it to the best-scoring matching
 *    element (text-dense, link-light — not merely the first match).
 *    - If it matches, extract from that element (boilerplate stripped).
 *    - If it matches nothing, fall back to Readability and flag pattern as stale.
 * 2. If no `contentSelector`, run extractWithReadability directly.
 * 3. Convert the HTML content to Markdown via domToMarkdown.
 * 4. Extract metadata via extractMetadata.
 * 5. Assemble the ExtractedArticle; confidence is judged on the final markdown
 *    (length, link density, prose), not on which path produced it.
 */
export async function extract(opts?: ExtractOptions): Promise<ExtractionResult> {
  const doc = opts?.doc ?? document;
  const url = opts?.url ?? doc.URL ?? "";
  const contentSelector = opts?.contentSelector;

  try {
    // --- Path A: contentSelector provided ---
    if (contentSelector) {
      const selectedElement = pickContentElement(doc, contentSelector);

      if (selectedElement) {
        // Run Readability on a scoped document containing only the selected element.
        // This strips boilerplate (engagement widgets, nav chrome) within the selection.
        const scopedDoc = createScopedDocument(selectedElement, url);
        const readabilityResult = extractWithReadability({ doc: scopedDoc, url });

        let markdownOutput: ReturnType<typeof domToMarkdown>;
        if (readabilityResult.ok && readabilityResult.result.textContent.trim().length >= 100) {
          markdownOutput = domToMarkdown(readabilityResult.result.content);
        } else {
          // Readability stripped too much — fall back to the element's own HTML,
          // still with ads / nav / hidden elements removed.
          markdownOutput = domToMarkdown(cleanInnerHtml(selectedElement));
          if (markdownOutput.markdown === "") {
            markdownOutput = domToMarkdown(selectedElement.innerHTML);
          }
        }

        if (markdownOutput.markdown === "") {
          return {
            ok: false,
            reason: "no-content-detected",
            detail: "Content selector matched an element but it contained no renderable content",
          };
        }

        return {
          ok: true,
          article: buildArticle(doc, url, markdownOutput),
          confidence: assessConfidence(markdownOutput.markdown),
        };
      }

      // Selector matched nothing — fall back to Readability, flag stale
      const readabilityOutcome = extractWithReadability({ doc, url });

      if (!readabilityOutcome.ok) {
        return {
          ok: false,
          reason: "no-content-detected",
          detail: "Saved selector matched no elements and Readability detected no content",
        };
      }

      const markdownOutput = domToMarkdown(readabilityOutcome.result.content);
      return {
        ok: true,
        article: buildArticle(doc, url, markdownOutput),
        confidence: assessConfidence(markdownOutput.markdown),
        stalePattern: true,
      };
    }

    // --- Path B: no contentSelector — use Readability directly ---
    const readabilityOutcome = extractWithReadability({ doc, url });

    if (!readabilityOutcome.ok) {
      return {
        ok: false,
        reason: "no-content-detected",
        detail: "Readability detected no suitable content on the page",
      };
    }

    const markdownOutput = domToMarkdown(readabilityOutcome.result.content);
    return {
      ok: true,
      article: buildArticle(doc, url, markdownOutput),
      confidence: assessConfidence(markdownOutput.markdown),
    };
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.slice(0, 200)
      : "An unexpected error occurred during extraction";

    return {
      ok: false,
      reason: "extraction-error",
      detail,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildArticle(
  doc: Document,
  url: string,
  markdownOutput: ReturnType<typeof domToMarkdown>,
): ExtractedArticle {
  const metadata = extractMetadata({ doc, url });
  return {
    title: metadata.title,
    author: metadata.author,
    publicationDate: metadata.publicationDate,
    sourceUrl: metadata.sourceUrl,
    siteName: metadata.siteName,
    bodyMarkdown: markdownOutput.markdown,
    bodyCharacterCount: markdownOutput.bodyCharacterCount,
  };
}

/** innerHTML of a detached copy of `element` with boilerplate removed. */
function cleanInnerHtml(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  stripNoise(copy);
  return copy.innerHTML;
}

/**
 * Creates a minimal HTML document containing only the given element's content,
 * suitable for running Readability on a scoped selection.
 */
function createScopedDocument(element: Element, url: string): Document {
  const html = `<!DOCTYPE html><html><head><base href="${url}"></head><body>${element.innerHTML}</body></html>`;
  const parser = new DOMParser();
  return parser.parseFromString(html, "text/html");
}
