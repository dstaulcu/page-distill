import { describe, it, expect } from "vitest";
import { pickContentElement, scoreElement, splitSelectorList } from "./candidates";

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, "text/html");
}

const PROSE = (n: number) => "A full sentence of genuine article prose, long enough to count. ".repeat(n);

describe("CF-1 splitSelectorList", () => {
  it("splits on top-level commas and keeps order", () => {
    expect(splitSelectorList("article, main, body")).toEqual(["article", "main", "body"]);
  });

  it("does not split on commas inside brackets, parens or quotes", () => {
    expect(splitSelectorList(`a[title="x,y"], :is(b, i), [data-x='1,2']`)).toEqual([
      `a[title="x,y"]`,
      ":is(b, i)",
      "[data-x='1,2']",
    ]);
  });
});

describe("CF-1 scoreElement", () => {
  it("scores prose above link-only lists of the same length", () => {
    const d = doc(
      `<div id="prose"><p>${PROSE(4)}</p></div><ul id="links">${Array.from({ length: 12 }, (_, i) => `<li><a href="/${i}">${"Related headline number " + i}</a></li>`).join("")}</ul>`,
    );
    expect(scoreElement(d.querySelector("#prose")!)).toBeGreaterThan(scoreElement(d.querySelector("#links")!));
  });

  it("scores an empty element zero", () => {
    expect(scoreElement(doc(`<div id="e"></div>`).querySelector("#e")!)).toBe(0);
  });
});

describe("CF-1 pickContentElement", () => {
  it("picks the substantial match, not the first teaser, when several elements match", () => {
    const d = doc(
      `<article id="teaser"><a href="/x">Read more about this</a></article>` +
        `<article id="real"><h1>Title</h1><p>${PROSE(6)}</p></article>` +
        `<article id="teaser2"><a href="/y">Another teaser</a></article>`,
    );
    expect(pickContentElement(d, "article")?.id).toBe("real");
  });

  it("respects selector-list priority: article beats the larger main/body", () => {
    const d = doc(`<main><p>${PROSE(30)}</p><article id="a"><p>${PROSE(6)}</p></article></main>`);
    expect(pickContentElement(d, "article, main, body")?.id).toBe("a");
  });

  it("falls through to a later part when earlier parts match only stubs", () => {
    const d = doc(`<article id="stub">Short</article><main id="m"><p>${PROSE(6)}</p></main>`);
    expect(pickContentElement(d, "article, main, body")?.id).toBe("m");
  });

  it("returns the best stub when nothing is substantial", () => {
    const d = doc(`<article id="a">A bit</article><article id="b">A bit more text</article>`);
    expect(pickContentElement(d, "article")?.id).toBe("b");
  });

  it("returns null when nothing matches or the selector is invalid", () => {
    const d = doc(`<p>x</p>`);
    expect(pickContentElement(d, ".missing")).toBeNull();
    expect(pickContentElement(d, "###not a selector")).toBeNull();
  });
});
