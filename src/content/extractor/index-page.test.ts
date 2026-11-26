import { describe, it, expect } from "vitest";
import { buildHeadlineIndex } from "./index-page";

function doc(html: string, url = "https://news.example.com/"): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><head><base href="${url}"></head><body>${html}</body></html>`, "text/html");
}

const headlines = (n: number, tag = "h2") =>
  Array.from({ length: n }, (_, i) => `<${tag}><a href="/story/${i}">Headline number ${i} about something happening</a></${tag}>`).join("");

describe("CF-1 buildHeadlineIndex", () => {
  it("lists headline links as markdown with absolute URLs", () => {
    const idx = buildHeadlineIndex(doc(headlines(14)), "https://news.example.com/")!;
    expect(idx.count).toBe(14);
    expect(idx.markdown.split("\n")[0]).toBe("- [Headline number 0 about something happening](https://news.example.com/story/0)");
  });

  it("returns null when there are too few headlines to be an index page", () => {
    expect(buildHeadlineIndex(doc(headlines(5)), "https://news.example.com/")).toBeNull();
  });

  it("skips duplicates, short labels, headings without links, and non-http targets", () => {
    const html =
      headlines(12) +
      `<h2><a href="/story/0">Headline number 0 about something happening</a></h2>` + // duplicate
      `<h2><a href="/x">Short</a></h2>` +
      `<h2>A heading that has no link at all in it</h2>` +
      `<h2><a href="javascript:void(0)">A scripted pseudo link heading here</a></h2>` +
      `<h2><a href="#top">An in-page anchor heading goes here too</a></h2>`;
    const idx = buildHeadlineIndex(doc(html), "https://news.example.com/")!;
    expect(idx.count).toBe(12);
    expect(idx.markdown).not.toContain("Short");
    expect(idx.markdown).not.toContain("javascript");
    expect(idx.markdown).not.toContain("#top");
  });

  it("ignores headlines inside ad / nav chrome", () => {
    const html = headlines(12) + `<nav><h3><a href="/n">Navigation menu pseudo headline text</a></h3></nav><div class="ad-slot"><h3><a href="/ad">Buy a thing you do not need</a></h3></div>`;
    const idx = buildHeadlineIndex(doc(html), "https://news.example.com/")!;
    expect(idx.markdown).not.toContain("Navigation menu");
    expect(idx.markdown).not.toContain("Buy a thing");
  });

  it("finds headlines whose link wraps the heading", () => {
    const html = Array.from({ length: 12 }, (_, i) => `<a href="/w/${i}"><h3>Wrapped headline number ${i} is here</h3></a>`).join("");
    expect(buildHeadlineIndex(doc(html), "https://news.example.com/")!.count).toBe(12);
  });

  it("caps the list and reports the page's text size", () => {
    const idx = buildHeadlineIndex(doc(headlines(100)), "https://news.example.com/")!;
    expect(idx.count).toBe(60);
    expect(idx.pageTextLength).toBeGreaterThan(1000);
  });

  it("does not modify the live page", () => {
    const d = doc(headlines(14) + `<nav>menu</nav>`);
    buildHeadlineIndex(d, "https://news.example.com/");
    expect(d.querySelector("nav")).not.toBeNull();
  });
});
