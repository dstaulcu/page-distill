import { describe, it, expect } from "vitest";
import { assessConfidence, measureMarkdown } from "./confidence";

const PARA = "This is a genuine paragraph of article prose that is comfortably longer than eighty characters. ";

describe("CF-1 assessConfidence", () => {
  it("is high for long, link-light prose", () => {
    expect(assessConfidence((PARA.repeat(2) + "\n\n").repeat(4))).toBe("high");
  });

  it("is low for very short content", () => {
    expect(assessConfidence("Some content here.")).toBe("low");
  });

  it("is medium for moderate-length prose", () => {
    expect(assessConfidence(PARA.repeat(2) + "\n\n" + PARA)).toBe("medium");
  });

  it("is low for a link farm (menus / related lists) even when long", () => {
    const links = Array.from({ length: 40 }, (_, i) => `- [Related headline number ${i} goes here](https://example.com/${i})`).join("\n");
    expect(measureMarkdown(links).linkDensity).toBeGreaterThan(0.7);
    expect(assessConfidence(links)).toBe("low");
  });

  it("downgrades long content that has no real paragraphs", () => {
    const bullets = Array.from({ length: 60 }, (_, i) => `- item ${i}`).join("\n");
    expect(assessConfidence(bullets)).toBe("medium");
  });

  it("downgrades prose with a heavy share of links", () => {
    const mixed = (`[${"linked words ".repeat(8)}](https://e.com) ${PARA}\n\n`).repeat(5);
    const m = measureMarkdown(mixed);
    expect(m.linkDensity).toBeGreaterThan(0.4);
    expect(assessConfidence(mixed)).toBe("medium");
  });

  it("ignores URLs when measuring text length and counts image alt text as text only", () => {
    const m = measureMarkdown("![alt](https://example.com/a/very/long/url/that/should/not/count.png)");
    expect(m.textLength).toBe(3);
  });
});
