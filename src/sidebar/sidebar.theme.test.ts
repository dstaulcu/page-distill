import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(resolve(__dirname, "sidebar.css"), "utf-8").replace(/\r?\n/g, "\n");

describe("sidebar theme", () => {
  it("follows the system dark setting", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/color-scheme:\s*light dark/);
  });

  it("defines every variable it uses", () => {
    const defined = new Set(Array.from(css.matchAll(/^\s*(--[\w-]+):/gm)).map((m) => m[1]));
    const used = new Set(Array.from(css.matchAll(/var\((--[\w-]+)/g)).map((m) => m[1]));
    const missing = [...used].filter((v) => !defined.has(v));
    expect(missing).toEqual([]);
  });

  it("gives the dark theme a value for every themed variable", () => {
    const root = css.match(/:root \{([\s\S]*?)\n\}/)![1];
    const dark = css.match(/prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/)![1];
    const names = (block: string) => new Set(Array.from(block.matchAll(/(--[\w-]+):/g)).map((m) => m[1]));
    const light = names(root);
    const darkNames = names(dark);
    // Colors that are intentionally identical in both themes need no dark override
    const sameInBoth = new Set(["--link-bg", "--link-bg-hover"]);
    const missing = [...light].filter((v) => !darkNames.has(v) && !sameInBoth.has(v) && v !== "--link-bg-hover");
    expect(missing).toEqual([]);
  });

  it("has no hard-coded colors outside the theme blocks, except white text on accent fills", () => {
    const withoutThemes = css
      .replace(/:root \{[\s\S]*?\n\}/, "")
      .replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}\n/, "");
    const hardcoded = withoutThemes
      .split("\n")
      .filter((line) => /#[0-9a-fA-F]{3,6}\b/.test(line))
      .map((line) => line.trim());
    expect(hardcoded.every((l) => l === "color: #fff;")).toBe(true);
  });

  it("keeps muted text readable (no light greys like #94a3b8)", () => {
    expect(css).not.toMatch(/#94a3b8/i);
  });
});
