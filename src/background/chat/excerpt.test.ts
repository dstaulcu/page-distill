import { describe, it, expect } from "vitest";
import { makeExcerpt } from "./excerpt";

describe("CF-2.4 makeExcerpt", () => {
  it("returns short text unchanged apart from whitespace", () => {
    expect(makeExcerpt("Hello   world\n\nagain")).toBe("Hello world again");
  });

  it("strips markdown syntax: headings, emphasis, links, images, lists, quotes", () => {
    const md = "# Title\n\n**Bold** and _it_ with [a link](https://x.com/very/long?q=1) ![img](https://x.com/a.png)\n\n- item one\n> quoted";
    expect(makeExcerpt(md)).toBe("Title Bold and it with a link item one quoted");
  });

  it("drops fenced code blocks", () => {
    expect(makeExcerpt("Before\n```\nconst x = 1;\n```\nAfter")).toBe("Before After");
  });

  it("truncates long text on a word boundary with an ellipsis", () => {
    const out = makeExcerpt("word ".repeat(200), 50);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out).not.toMatch(/wor…$/);
  });

  it("returns an empty string for empty input", () => {
    expect(makeExcerpt("")).toBe("");
  });
});
