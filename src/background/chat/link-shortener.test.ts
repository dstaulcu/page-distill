import { describe, it, expect } from "vitest";
import { shortenLinkUrls } from "./link-shortener";

const TRACKING =
  "https://r.financebuzz.com/aff_c?source=%2Fmoney-moves&offer_id=25672&aff_id=1006&aff_sub5={impressionid}&ml_sort_id=66ad0e93-9d67-4208-9241-33688c39acfa&widget_type=&cms_cc_id=7";

describe("CF-3.8 shortenLinkUrls", () => {
  it("drops the query string of a long link but keeps the label", () => {
    const out = shortenLinkUrls(`See [Apply now](${TRACKING}) today`);
    expect(out).toBe("See [Apply now](https://r.financebuzz.com/aff_c) today");
  });

  it("leaves short links exactly as they are, query string included", () => {
    const md = "[video](https://www.youtube.com/watch?v=abc123) and [home](/about)";
    expect(shortenLinkUrls(md)).toBe(md);
  });

  it("shortens image targets and collapses data URIs", () => {
    const out = shortenLinkUrls(`![chart](data:image/png;base64,${"A".repeat(5000)}) ![x](${TRACKING})`);
    expect(out).toBe("![chart](data:…) ![x](https://r.financebuzz.com/aff_c)");
  });

  it("caps a very long path and marks the cut", () => {
    const out = shortenLinkUrls(`[a](https://example.com/${"p".repeat(200)}?q=1)`);
    expect(out).toMatch(/^\[a\]\(https:\/\/example\.com\/p+…\)$/);
    expect(out.length).toBeLessThan(120);
  });

  it("handles long relative links without a query", () => {
    const out = shortenLinkUrls(`[a](/${"x".repeat(100)}?utm=1)`);
    expect(out).not.toContain("utm");
  });

  it("preserves a link title attribute", () => {
    const out = shortenLinkUrls(`[a](${TRACKING} "Sponsored")`);
    expect(out).toBe(`[a](https://r.financebuzz.com/aff_c "Sponsored")`);
  });

  it("does not touch plain text containing brackets or parentheses", () => {
    const md = "Use arr[0] and call fn(x) [not a link] (nor this)";
    expect(shortenLinkUrls(md)).toBe(md);
  });

  it("makes a tracking-heavy page substantially smaller", () => {
    const md = Array.from({ length: 20 }, (_, i) => `## Offer ${i}\n\nText.\n\n[Apply](${TRACKING}&i=${i})`).join("\n\n");
    expect(shortenLinkUrls(md).length).toBeLessThan(md.length * 0.5);
  });
});
