import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extract } from "./extract";

function createDocument(html: string, url = "https://example.com/story"): Document {
  return new JSDOM(html, { url }).window.document;
}

const GENERIC =
  "article, [role='article'], main article, .post-content, .article-body, .entry-content, main, body";

const PARA = (n: number) =>
  Array.from({ length: n }, (_, i) => `<p>Paragraph ${i}: the genuine story text that readers came for, written as a full sentence with enough words to count as prose.</p>`).join("");

const JUNK = [
  "BUY CHEAP WIDGETS TODAY",
  "SPONSORED: Ten tricks doctors hate",
  "We use cookies to improve your experience",
  "Subscribe to our newsletter",
];

function pageWithJunk(articleHtml: string): string {
  return `<!DOCTYPE html><html><head><title>Story</title></head><body>
    <nav><a href="/">Home</a><a href="/news">News</a></nav>
    <div class="ad-slot">${JUNK[0]}</div>
    <div id="cookie-banner">${JUNK[2]}</div>
    ${articleHtml}
    <aside class="sponsored">${JUNK[1]}</aside>
    <div class="newsletter-signup">${JUNK[3]}</div>
    <footer>Copyright</footer>
  </body></html>`;
}

describe("CF-1 extraction accuracy", () => {
  it("keeps ads, banners and chrome out of the markdown (generic selector path)", async () => {
    const doc = createDocument(pageWithJunk(`<article><h1>Big Story</h1>${PARA(8)}</article>`));
    const result = await extract({ doc, contentSelector: GENERIC });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("genuine story text");
    for (const junk of JUNK) expect(result.article.bodyMarkdown).not.toContain(junk);
    expect(result.confidence).toBe("high");
  });

  it("keeps ads and chrome out when there is no selector (Readability path)", async () => {
    const doc = createDocument(pageWithJunk(`<main><h1>Big Story</h1>${PARA(8)}</main>`));
    const result = await extract({ doc });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("genuine story text");
    for (const junk of JUNK) expect(result.article.bodyMarkdown).not.toContain(junk);
  });

  it("picks the real article over teaser <article> elements that come first in the DOM", async () => {
    const teasers = Array.from(
      { length: 3 },
      (_, i) => `<article><a href="/s/${i}">Teaser headline ${i}</a></article>`,
    ).join("");
    const doc = createDocument(pageWithJunk(`${teasers}<article><h1>The Real Story</h1>${PARA(8)}</article>`));
    const result = await extract({ doc, contentSelector: GENERIC });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("genuine story text");
    expect(result.article.bodyMarkdown).not.toContain("Teaser headline");
  });

  it("strips ads from a selected element even when Readability returns too little (raw fallback)", async () => {
    const doc = createDocument(
      `<!DOCTYPE html><html><head><title>t</title></head><body>
        <div id="box"><p>Short but real text.</p><div class="advertisement">${JUNK[0]}</div></div>
      </body></html>`,
    );
    const result = await extract({ doc, contentSelector: "#box" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("Short but real text.");
    expect(result.article.bodyMarkdown).not.toContain(JUNK[0]);
  });

  it("rates a menu / related-links grab as low confidence instead of high", async () => {
    const links = Array.from(
      { length: 40 },
      (_, i) => `<li><a href="/s/${i}">Related headline number ${i} that goes on a bit</a></li>`,
    ).join("");
    const doc = createDocument(`<!DOCTYPE html><html><head><title>t</title></head><body><div id="menu"><ul>${links}</ul></div></body></html>`);
    const result = await extract({ doc, contentSelector: "#menu" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confidence).toBe("low");
  });

  it("does not lose the article when the whole page is wrapped in a boilerplate-named container", async () => {
    const doc = createDocument(
      `<!DOCTYPE html><html><head><title>t</title></head><body><div class="sidebar-layout social"><article><h1>Kept</h1>${PARA(8)}</article></div></body></html>`,
    );
    const result = await extract({ doc });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("genuine story text");
  });

  it("does not mutate the live page while stripping", async () => {
    const doc = createDocument(pageWithJunk(`<article><h1>Big Story</h1>${PARA(8)}</article>`));
    await extract({ doc, contentSelector: GENERIC });

    expect(doc.querySelector(".ad-slot")).not.toBeNull();
    expect(doc.querySelector("nav")).not.toBeNull();
    expect(doc.querySelector("footer")).not.toBeNull();
  });
});
