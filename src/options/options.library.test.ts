/**
 * The Skill Library, Personas and auto-export sections are gone from the
 * options page — nothing about them renders, and loading the page leaves any
 * data an older version stored untouched (the background removes it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(__dirname, "options.html"), "utf-8");
const bodyHtml = html.slice(html.indexOf("<body"), html.indexOf("</body>")).replace(/<body[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/g, "");

function installBrowser(): void {
  const g = globalThis as unknown as { CSS?: { escape?: (v: string) => string } };
  g.CSS = { ...(g.CSS ?? {}), escape: (v: string) => v };
  Object.defineProperty(globalThis, "browser", {
    configurable: true,
    writable: true,
    value: {
      storage: {
        sync: { get: vi.fn(async () => ({})) },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      },
      runtime: { sendMessage: vi.fn(async () => ({ kind: "noop", payload: {} })), onMessage: { addListener: vi.fn() } },
      tabs: { query: vi.fn(async () => []), sendMessage: vi.fn() },
    },
  });
}

describe("options page after removing skills, personas and auto-export", () => {
  beforeEach(installBrowser);
  afterEach(() => {
    delete (globalThis as unknown as { browser?: unknown }).browser;
  });

  it("has no skill library, persona or auto-export UI", async () => {
    document.body.innerHTML = bodyHtml;
    vi.resetModules();
    await import("./options");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

    for (const id of ["section-skills", "skills-list", "btn-add-skill", "skill-file-input", "personas-list", "auto-export-list"]) {
      expect(document.getElementById(id), id).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/skill|persona|auto-export/i);
    // The page still works: the AI section is there.
    expect(document.getElementById("ai-provider")).not.toBeNull();
  });

  it("never reads or writes the old skill library key", async () => {
    document.body.innerHTML = bodyHtml;
    vi.resetModules();
    await import("./options");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

    const b = (globalThis as unknown as { browser: { storage: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } } } }).browser;
    expect(JSON.stringify(b.storage.local.get.mock.calls)).not.toContain("distill_skill_library");
    expect(b.storage.local.set).not.toHaveBeenCalled();
  });
});
