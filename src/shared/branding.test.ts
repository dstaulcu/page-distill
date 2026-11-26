import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { PRODUCT_NAME, ASSISTANT_NAME, LOG_PREFIX } from "./branding";

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8").replace(/\r\n/g, "\n");
const messages = JSON.parse(read("public/_locales/en/messages.json")) as Record<string, { message: string }>;

describe("branding: single source of truth", () => {
  it("exposes the strings from public/_locales/en/messages.json", () => {
    expect(PRODUCT_NAME).toBe(messages.extName.message);
    expect(ASSISTANT_NAME).toBe(messages.assistantName.message);
    expect(LOG_PREFIX).toBe(messages.logPrefix.message);
  });

  it("starts out as Page Distill", () => {
    expect(PRODUCT_NAME).toBe("Page Distill");
    expect(ASSISTANT_NAME).toBe("Page Distill");
    expect(LOG_PREFIX).toBe("[Page Distill]");
  });

  it("is what the manifest uses: every __MSG_ placeholder resolves and a default locale is set", () => {
    const manifestText = read("manifest.json");
    const manifest = JSON.parse(manifestText) as { default_locale?: string };
    expect(manifest.default_locale).toBe("en");

    const used = Array.from(manifestText.matchAll(/__MSG_(\w+)__/g)).map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(messages[key]?.message, `missing message "${key}"`).toBeTruthy();
  });

  it("keeps the toolbar tooltip and name consistent with the product name", () => {
    expect(messages.toggleSidebarTitle.message).toContain(PRODUCT_NAME);
  });
});

describe("branding: HTML fallbacks match the configured names", () => {
  it("sidebar page title", () => {
    expect(read("src/sidebar/sidebar.html")).toContain(`<title>${PRODUCT_NAME}</title>`);
  });

  it("settings page title and every data-brand fallback", () => {
    const html = read("src/options/options.html");
    expect(html).toContain(`<title>${PRODUCT_NAME} Settings</title>`);

    const values: Record<string, string> = { product: PRODUCT_NAME, logPrefix: LOG_PREFIX };
    const spans = Array.from(html.matchAll(/data-brand="(\w+)">([^<]*)</g));
    expect(spans.length).toBeGreaterThan(0);
    for (const [, kind, text] of spans) expect(text).toBe(values[kind]);
  });
});

describe("branding: no hard-coded product name in the UI code", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|html|css)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  }

  it("keeps the capitalized product name out of source files apart from comments, branding.ts and HTML fallbacks", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(resolve(root, "src"))) {
      if (file.endsWith("branding.ts")) continue;
      read(file.slice(root.length + 1).replace(/\\/g, "/"))
        .split("\n")
        .forEach((line, i) => {
          const trimmed = line.trim();
          if (!/Distill/.test(trimmed)) return; // user-visible names are capitalized; lowercase "distill" is storage keys, DOM attributes and URLs
          if (/^(\/\/|\/\*|\*)/.test(trimmed)) return;            // comments
          if (/^<!--/.test(trimmed)) return;
          if (file.endsWith(".html") && (/data-brand=/.test(line) || /<title>/.test(line))) return; // fallbacks, tested above
          offenders.push(`${file.slice(root.length + 1)}:${i + 1}: ${trimmed}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
