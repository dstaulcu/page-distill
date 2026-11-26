import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractUnreleased, hasEntries, promoteUnreleased, buildReleaseNotes } from "./changelog.mjs";

const sample = `# Changelog

## [Unreleased]

### Added
- A new thing.

### Fixed
- A bug.

## [1.2.0] - 2026-01-02

### Added
- Older thing.

[Unreleased]: https://github.com/o/r/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/o/r/releases/tag/v1.2.0
`;

describe("changelog: extractUnreleased / hasEntries", () => {
  it("returns the Unreleased section only, without the next version or link references", () => {
    const body = extractUnreleased(sample);
    expect(body).toContain("A new thing.");
    expect(body).toContain("A bug.");
    expect(body).not.toContain("Older thing.");
    expect(body).not.toContain("compare/v1.2.0");
  });

  it("returns null when there is no Unreleased heading", () => {
    expect(extractUnreleased("# Changelog\n\n## [1.0.0] - 2026-01-01\n- x\n")).toBeNull();
  });

  it("handles an Unreleased section that is the last one, and CRLF files", () => {
    const body = extractUnreleased("# C\r\n\r\n## [Unreleased]\r\n\r\n- Only entry\r\n");
    expect(body).toBe("- Only entry");
  });

  it("detects whether any bullet entry exists", () => {
    expect(hasEntries("### Added\n- something")).toBe(true);
    expect(hasEntries("* star bullet")).toBe(true);
    expect(hasEntries("### Added\n")).toBe(false);
    expect(hasEntries("")).toBe(false);
    expect(hasEntries(null)).toBe(false);
  });
});

describe("changelog: promoteUnreleased", () => {
  it("moves entries under a dated version heading and leaves a fresh Unreleased section", () => {
    const out = promoteUnreleased(sample, "1.3.0", "2026-03-04");
    expect(out).toContain("## [Unreleased]\n\n## [1.3.0] - 2026-03-04\n\n### Added\n- A new thing.");
    expect(extractUnreleased(out)).toBe("");
    expect(out.indexOf("[1.3.0] - 2026-03-04")).toBeLessThan(out.indexOf("[1.2.0] - 2026-01-02"));
  });

  it("keeps the compare and release link references current", () => {
    const out = promoteUnreleased(sample, "1.3.0", "2026-03-04");
    expect(out).toContain("[Unreleased]: https://github.com/o/r/compare/v1.3.0...HEAD");
    expect(out).toContain("[1.3.0]: https://github.com/o/r/releases/tag/v1.3.0");
    expect(out).toContain("[1.2.0]: https://github.com/o/r/releases/tag/v1.2.0");
  });

  it("refuses to promote a version that already has an entry, or a file with no Unreleased section", () => {
    expect(() => promoteUnreleased(sample, "1.2.0", "2026-03-04")).toThrow(/already has an entry/);
    expect(() => promoteUnreleased("# Changelog\n", "1.3.0", "2026-03-04")).toThrow(/Unreleased/);
  });

  it("preserves CRLF line endings", () => {
    const out = promoteUnreleased(sample.replace(/\n/g, "\r\n"), "1.3.0", "2026-03-04");
    expect(out).toContain("## [1.3.0] - 2026-03-04\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("changelog: buildReleaseNotes", () => {
  const notes = buildReleaseNotes({ version: "1.3.0", body: "### Added\n- A new thing." });

  it("includes the entries, the install steps and a link to the full changelog at that tag", () => {
    expect(notes).toContain("## Page Distill 1.3.0");
    expect(notes).toContain("- A new thing.");
    expect(notes).toContain("distill-1.3.0.xpi");
    expect(notes).toContain("about:debugging#/runtime/this-firefox");
    expect(notes).toContain("[CHANGELOG.md](https://github.com/dstaulcu/page-distill/blob/v1.3.0/CHANGELOG.md)");
  });
});

describe("changelog: the real CHANGELOG.md", () => {
  const real = readFileSync(resolve(__dirname, "../CHANGELOG.md"), "utf8");

  it("has an Unreleased section and a heading for the current manifest version", () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../manifest.json"), "utf8"));
    expect(extractUnreleased(real)).not.toBeNull();
    expect(real).toContain("## [" + manifest.version + "]");
  });
});
