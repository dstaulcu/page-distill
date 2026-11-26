/**
 * Headline index for portal / homepage pages.
 *
 * A news front page has no single "article": Readability picks one story card
 * and the other hundred headlines vanish. For those pages the useful content
 * IS the list of headlines, so this builds it from headings that contain links.
 * The caller decides when to use it (see `extract()` in extract.ts).
 */

import { stripNoise } from "./noise";

const HEADLINE_MIN_CHARS = 15;
/** Fewer than this many headline links is not an index page. */
export const MIN_HEADLINES = 12;
const MAX_HEADLINES = 60;

export interface HeadlineIndex {
  /** Markdown list of `- [headline](url)` lines. */
  readonly markdown: string;
  readonly count: number;
  /** Visible text length of the page after boilerplate was stripped. */
  readonly pageTextLength: number;
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function withoutHash(href: string): string {
  return href.split("#")[0];
}

/**
 * Resolves a heading link to an absolute http(s) URL, or null when it isn't a
 * link to another page (in-page anchors, javascript:, a permalink back to this
 * very page). Parentheses are percent-encoded so they can't end the markdown link.
 */
function resolveHttpUrl(href: string | null, base: string): string | null {
  if (!href || href.startsWith("#")) return null;
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (withoutHash(url.href) === withoutHash(new URL(base).href)) return null; // self-anchor / permalink
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

/**
 * Collects the page's linked headings (h1–h4), de-duplicated, from a stripped
 * copy of the page. Returns null when there are too few to be an index.
 */
export function buildHeadlineIndex(doc: Document, baseUrl: string): HeadlineIndex | null {
  if (!doc.body) return null;

  // Cheap pre-check on the live page (read-only) so ordinary articles never
  // pay for cloning and stripping the whole document.
  if (doc.body.querySelectorAll("h1 a[href], h2 a[href], h3 a[href], h4 a[href], a[href] h1, a[href] h2, a[href] h3, a[href] h4").length < MIN_HEADLINES) {
    return null;
  }

  const body = doc.body.cloneNode(true) as HTMLElement; // never touch the live page
  // "Top Stories" / "Trending" are the page's real sections here, not promo modules
  stripNoise(body, { promoModules: false });

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const heading of Array.from(body.querySelectorAll("h1, h2, h3, h4"))) {
    const anchor = heading.querySelector("a[href]") ?? heading.closest("a[href]");
    if (!anchor) continue;

    const text = normalize(heading.textContent).replace(/[[\]]/g, "");
    if (text.length < HEADLINE_MIN_CHARS || seen.has(text)) continue;

    const url = resolveHttpUrl(anchor.getAttribute("href"), baseUrl);
    if (!url) continue;

    seen.add(text);
    lines.push(`- [${text}](${url})`);
    if (lines.length >= MAX_HEADLINES) break;
  }

  if (lines.length < MIN_HEADLINES) return null;

  return {
    markdown: lines.join("\n"),
    count: lines.length,
    pageTextLength: normalize(body.textContent).length,
  };
}
