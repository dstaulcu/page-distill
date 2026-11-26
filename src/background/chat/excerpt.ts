/**
 * A short plain-text preview of extracted markdown, shown before summarizing
 * so a wrong extraction is obvious before a summary is spent on it.
 */

const DEFAULT_MAX_CHARS = 240;

export function makeExcerpt(markdown: string, maxChars = DEFAULT_MAX_CHARS): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")               // fenced code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")         // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")       // links → label
    .replace(/^#{1,6}\s+/gm, "")                   // heading markers
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")     // list markers
    .replace(/^>\s?/gm, "")                        // quotes
    .replace(/[*_`~]/g, "")                        // emphasis / inline code marks
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= maxChars) return plain;
  // Cut on a word boundary when one is close enough
  const cut = plain.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
