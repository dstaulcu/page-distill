import { describe, it, expect } from "vitest";
import { isSamePageNavigation } from "./url-utils";

describe("url-utils", () => {
  describe("isSamePageNavigation", () => {
    it("returns true when URLs are identical", () => {
      const url = "https://example.com/page?q=1#section";
      expect(isSamePageNavigation(url, url)).toBe(true);
    });

    it("returns true when only the fragment differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page?q=1#section1",
          "https://example.com/page?q=1#section2",
        ),
      ).toBe(true);
    });

    it("returns true when one URL has a fragment and the other does not", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page",
          "https://example.com/page#top",
        ),
      ).toBe(true);
    });

    it("returns false when the pathname differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page-a",
          "https://example.com/page-b",
        ),
      ).toBe(false);
    });

    it("returns false when the query string differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page?q=1",
          "https://example.com/page?q=2",
        ),
      ).toBe(false);
    });

    it("returns false when the origin differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page",
          "https://other.com/page",
        ),
      ).toBe(false);
    });

    it("returns false when the protocol differs", () => {
      expect(
        isSamePageNavigation(
          "http://example.com/page",
          "https://example.com/page",
        ),
      ).toBe(false);
    });

    it("returns false when the port differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com:443/page",
          "https://example.com:8080/page",
        ),
      ).toBe(false);
    });

    it("returns false for malformed old URL", () => {
      expect(isSamePageNavigation("not-a-url", "https://example.com")).toBe(false);
    });

    it("returns false for malformed new URL", () => {
      expect(isSamePageNavigation("https://example.com", "not-a-url")).toBe(false);
    });

    it("returns false when both URLs are malformed", () => {
      expect(isSamePageNavigation("bad", "also-bad")).toBe(false);
    });

    it("returns true when query is empty on both and fragments differ", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/docs#intro",
          "https://example.com/docs#conclusion",
        ),
      ).toBe(true);
    });

    it("returns false when one has a query and the other does not", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page",
          "https://example.com/page?new=true",
        ),
      ).toBe(false);
    });
  });
});
