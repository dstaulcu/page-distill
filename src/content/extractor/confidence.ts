/**
 * Content-quality confidence for the FINAL extracted markdown. Length alone
 * rates an ad- or nav-heavy grab as "high"; this also looks at link density
 * (share of text that is link text — high means menus / "related" lists) and
 * whether there is any real prose (paragraph-length blocks).
 */

export type Confidence = "high" | "medium" | "low";

const LONG_PARAGRAPH_CHARS = 80;

export interface ContentMetrics {
  readonly textLength: number;
  readonly linkDensity: number;
  readonly longParagraphs: number;
}

export function measureMarkdown(markdown: string): ContentMetrics {
  // Link labels vs. everything else, ignoring URLs and markdown punctuation
  let linkChars = 0;
  const withoutLinks = markdown.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_m, label: string) => {
    linkChars += label.length;
    return label;
  });
  const text = withoutLinks.replace(/\s+/g, " ").trim();
  const textLength = text.length;

  // Line by line: converted markdown keeps each paragraph / list item on its own
  // line, and a bullet list must not count as one long paragraph.
  const longParagraphs = markdown
    .split("\n")
    .map((block) => block.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[#>*\-+\d.\s]+/, "").trim())
    .filter((block) => block.length >= LONG_PARAGRAPH_CHARS).length;

  return {
    textLength,
    linkDensity: textLength === 0 ? 0 : Math.min(1, linkChars / textLength),
    longParagraphs,
  };
}

export function assessConfidence(markdown: string): Confidence {
  const { textLength, linkDensity, longParagraphs } = measureMarkdown(markdown);
  if (textLength < 100 || linkDensity > 0.7) return "low";
  if (textLength < 500 || linkDensity > 0.4 || longParagraphs === 0) return "medium";
  return "high";
}
