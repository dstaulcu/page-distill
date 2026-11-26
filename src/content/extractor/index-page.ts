/**
 * Headline index for portal / homepage pages.
 *
 * A news front page has no single "article": Readability picks one story card
 * and the other hundred headlines vanish. For those pages the useful content
 * IS the list of headlines, so this builds it from headings that contain links.
 * The caller decides when to use it (see `isIndexPage` in extract.ts).
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

function resolveHttpUrl(href: string | null, base: string): string | null {
  if (!href || href.startsWith("#")) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
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

  const body = doc.body.cloneNode(true) as HTMLElement; // never touch the live page
  stripNoise(body);

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
