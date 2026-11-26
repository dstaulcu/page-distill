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

describe("CF-1 portal / homepage pages", () => {
  const card = (i: number) =>
    `<div class="card"><h2><a href="/story/${i}">Story headline number ${i} that is long enough</a></h2><p>Short blurb ${i}.</p></div>`;
  const portal = (extra = "") =>
    `<!DOCTYPE html><html><head><title>News Home</title></head><body><main>` +
    `<div class="lead"><h1>Lead feature</h1>${PARA(1)}</div>` +
    Array.from({ length: 20 }, (_, i) => card(i)).join("") +
    `${extra}</main></body></html>`;

  it("returns the headline list instead of one arbitrary card when the page is a portal", async () => {
    const doc = createDocument(portal(), "https://news.example.com/");
    const result = await extract({ doc, url: "https://news.example.com/", contentSelector: GENERIC, autoSelect: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const md = result.article.bodyMarkdown;
    expect(md).toContain("[Story headline number 0 that is long enough](https://news.example.com/story/0)");
    expect(md).toContain("[Story headline number 19 that is long enough](https://news.example.com/story/19)");
    expect(result.confidence).toBe("medium");
  });

  it("also does it when no selector is given at all", async () => {
    const doc = createDocument(portal(), "https://news.example.com/");
    const result = await extract({ doc, url: "https://news.example.com/" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("Story headline number 5");
  });

  it("leaves a real article alone even if it has a rail of headline links", async () => {
    const rail = Array.from({ length: 14 }, (_, i) => `<h3><a href="/r/${i}">Rail headline number ${i} for other stories</a></h3>`).join("");
    const doc = createDocument(
      `<!DOCTYPE html><html><head><title>A</title></head><body><article><h1>The Story</h1>${PARA(30)}</article><div class="rail">${rail}</div></body></html>`,
    );
    const result = await extract({ doc, contentSelector: GENERIC });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("genuine story text");
    expect(result.article.bodyMarkdown).not.toContain("Rail headline");
  });

  it("respects a user's selector even when its text equals the built-in generic one", async () => {
    const doc = createDocument(portal(), "https://news.example.com/");
    const result = await extract({ doc, url: "https://news.example.com/", contentSelector: GENERIC, autoSelect: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).not.toContain("Story headline number 5 that is long enough");
  });

  it("keeps portal sections called 'Top Stories' / 'Trending' in the headline list", async () => {
    const section = (title: string, from: number) =>
      `<section><h2>${title}</h2>` + Array.from({ length: 8 }, (_, i) => card(from + i)).join("") + `</section>`;
    const doc = createDocument(
      `<!DOCTYPE html><html><head><title>Home</title></head><body><main>${section("Top Stories", 0)}${section("Trending Stories", 100)}${PARA(1)}</main></body></html>`,
      "https://news.example.com/",
    );
    const result = await extract({ doc, url: "https://news.example.com/", autoSelect: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("Story headline number 0 ");
    expect(result.article.bodyMarkdown).toContain("Story headline number 107 ");
  });

  it("respects a selector the user picked themselves (no index override)", async () => {
    const doc = createDocument(portal(), "https://news.example.com/");
    const result = await extract({ doc, url: "https://news.example.com/", contentSelector: ".lead" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("genuine story text");
    expect(result.article.bodyMarkdown).not.toContain("Story headline number 5");
  });

  it("strips an in-article promo module (Popular Reads) from a normal article", async () => {
    const doc = createDocument(
      `<!DOCTYPE html><html><head><title>A</title></head><body><article><h1>The Story</h1>${PARA(8)}` +
        `<section class="MobileContentPromo"><header><h2>Popular Reads</h2></header><ul><li><a href="/p">Another unrelated story headline</a></li></ul></section>` +
        `${PARA(8)}</article></body></html>`,
    );
    const result = await extract({ doc, contentSelector: GENERIC });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.bodyMarkdown).toContain("genuine story text");
    expect(result.article.bodyMarkdown).not.toContain("Popular Reads");
  });
});
