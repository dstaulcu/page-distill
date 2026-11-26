/**
 * Picks the best content element for a selector instead of trusting
 * `querySelector`'s first match. A page can have many `article` elements
 * (teasers, related posts); the real one is the text-dense, link-light one.
 */

/** A candidate with at least this much text is "good enough" to stop searching. */
const GOOD_ENOUGH_CHARS = 200;

/** A paragraph-like block counts toward the score at this length. */
const LONG_BLOCK_CHARS = 80;

/**
 * Splits a selector list on its top-level commas (ignoring commas inside
 * brackets, parentheses and quotes), preserving order — earlier parts are
 * higher priority.
 */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

/**
 * Text-density score: readable (non-link) characters, plus a bonus per
 * paragraph-like block. Link-heavy containers (nav, "related" lists) score low.
 */
export function scoreElement(el: Element): number {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return 0;

  let linkChars = 0;
  for (const a of Array.from(el.querySelectorAll("a"))) {
    linkChars += (a.textContent ?? "").replace(/\s+/g, " ").trim().length;
  }
  const readable = Math.max(0, text.length - linkChars);

  let longBlocks = 0;
  for (const p of Array.from(el.querySelectorAll("p, li, blockquote, pre"))) {
    if ((p.textContent ?? "").trim().length >= LONG_BLOCK_CHARS) longBlocks++;
  }
  return readable + longBlocks * 40;
}

function safeQueryAll(doc: Document, selector: string): Element[] {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch (error) {
    // An invalid selector just matches nothing; anything else is a real failure.
    if ((error as { name?: string } | null)?.name === "SyntaxError") return [];
    throw error;
  }
}

function bestOf(elements: Element[]): { el: Element; score: number } | null {
  let best: { el: Element; score: number } | null = null;
  for (const el of elements) {
    const score = scoreElement(el);
    if (best === null || score > best.score) best = { el, score };
  }
  return best;
}

/**
 * Resolves `selector` to a single element:
 *  - each top-level part of a selector list is tried in order (priority);
 *  - within a part, the highest-scoring match wins (not merely the first);
 *  - the first part whose winner is substantial (≥ GOOD_ENOUGH_CHARS of text)
 *    is taken; otherwise the best-scoring winner across all parts.
 * Returns null when nothing matches.
 */
export function pickContentElement(doc: Document, selector: string): Element | null {
  let fallback: { el: Element; score: number } | null = null;

  for (const part of splitSelectorList(selector)) {
    const winner = bestOf(safeQueryAll(doc, part));
    if (!winner) continue;

    if ((winner.el.textContent ?? "").trim().length >= GOOD_ENOUGH_CHARS) {
      return winner.el;
    }
    if (fallback === null || winner.score > fallback.score) fallback = winner;
  }
  return fallback?.el ?? null;
}
