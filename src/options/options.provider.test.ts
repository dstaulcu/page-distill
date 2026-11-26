/**
 * CF-5.7 — the options page's provider picker: loads the real options.html
 * into jsdom, runs options.ts, and checks the observable behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(__dirname, "options.html"), "utf-8");
const bodyHtml = html.slice(html.indexOf("<body"), html.indexOf("</body>")).replace(/<body[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/g, "");

let syncData: Record<string, unknown>;
let sentMessages: Array<{ kind: string; payload: unknown }>;

function installBrowser(): void {
  // jsdom has no CSS.escape (the options page uses it to select the saved model).
  const g = globalThis as unknown as { CSS?: { escape?: (v: string) => string } };
  g.CSS = { ...(g.CSS ?? {}), escape: (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
  Object.defineProperty(globalThis, "browser", {
    configurable: true,
    writable: true,
    value: {
      storage: {
        sync: { get: vi.fn(async (key: string) => ({ [key]: syncData[key] })) },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      },
      runtime: {
        sendMessage: vi.fn(async (msg: { kind: string; payload: unknown }) => {
          sentMessages.push(msg);
          if (msg.kind === "settingsChanged") return { kind: "settingsSaveResult", payload: { ok: true } };
          return { kind: "noop", payload: {} };
        }),
        onMessage: { addListener: vi.fn() },
      },
      tabs: { query: vi.fn(async () => []), sendMessage: vi.fn() },
    },
  });
}

async function loadOptions(): Promise<void> {
  document.body.innerHTML = bodyHtml;
  vi.resetModules();
  await import("./options");
  document.dispatchEvent(new Event("DOMContentLoaded"));
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

const select = () => document.getElementById("ai-provider") as HTMLSelectElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const contextGroup = () => document.getElementById("group-ai-context-window")!;

function legacyStored(baseUrl: string): Record<string, unknown> {
  // Settings as saved before providers existed: no `provider`, no `debugLogging`.
  return {
    settings: {
      schemaVersion: 1,
      ai: { baseUrl, modelId: "m", apiKeyRef: null, systemPrompt: "", contextWindowTokens: 8192 },
      export: { filenamePattern: "YYYY-MM-DD-slugified-title", defaultDestination: { kind: "download" }, frontmatterFields: ["title"] },
      sitePatterns: [],
    },
  };
}

describe("CF-5.7 options page provider picker", () => {
  beforeEach(() => {
    syncData = {};
    sentMessages = [];
    installBrowser();
  });

  afterEach(() => {
    delete (globalThis as unknown as { browser?: unknown }).browser;
  });

  it("offers Ollama and OpenAI-compatible, and defaults a fresh install to Ollama with the context window shown", async () => {
    await loadOptions();
    expect(Array.from(select().options).map((o) => o.value)).toEqual(["ollama", "openai-compatible"]);
    expect(select().value).toBe("ollama");
    expect(input("ai-base-url").placeholder).toBe("http://localhost:11434");
    expect(contextGroup().classList.contains("hidden")).toBe(false);
    expect(document.getElementById("ai-provider-hint")!.textContent).toMatch(/Ollama/);
  });

  it("switching to OpenAI-compatible changes the placeholders and hides the Ollama-only context window", async () => {
    await loadOptions();
    select().value = "openai-compatible";
    select().dispatchEvent(new Event("change"));

    expect(input("ai-base-url").placeholder).toBe("https://api.openai.com");
    expect(contextGroup().classList.contains("hidden")).toBe(true);
    expect(document.getElementById("ai-provider-hint")!.textContent).toMatch(/OpenAI/);

    select().value = "ollama";
    select().dispatchEvent(new Event("change"));
    expect(contextGroup().classList.contains("hidden")).toBe(false);
  });

  it("shows the provider's key hint on a fresh install, and dots (not the hint) once a key is saved", async () => {
    await loadOptions();
    expect(input("ai-api-key").placeholder).toBe("Optional — leave empty for a local server");

    syncData = legacyStored("http://localhost:11434");
    (syncData.settings as { ai: { apiKeyRef: string | null } }).ai.apiKeyRef = "ref-1";
    await loadOptions();
    expect(input("ai-api-key").placeholder).toBe("••••••••");

    // Switching provider must not drop the saved-key indicator
    select().value = "openai-compatible";
    select().dispatchEvent(new Event("change"));
    expect(input("ai-api-key").placeholder).toBe("••••••••");
  });

  it("shows the provider inferred for settings saved before providers existed (hosted URL → OpenAI-compatible)", async () => {
    syncData = legacyStored("https://api.openai.com");
    await loadOptions();
    expect(select().value).toBe("openai-compatible");
    expect(contextGroup().classList.contains("hidden")).toBe(true);
  });

  it("saving sends the chosen provider with the settings", async () => {
    syncData = legacyStored("http://localhost:11434");
    await loadOptions();
    expect(select().value).toBe("ollama");

    select().value = "openai-compatible";
    select().dispatchEvent(new Event("change"));
    (document.getElementById("btn-save-settings") as HTMLButtonElement).click();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

    const saved = sentMessages.find((m) => m.kind === "settingsChanged");
    expect(saved).toBeDefined();
    expect((saved!.payload as { ai: { provider: string } }).ai.provider).toBe("openai-compatible");
  });

  it("saving with a non-Ollama provider doesn't validate the hidden context-window field", async () => {
    syncData = legacyStored("https://api.openai.com");
    await loadOptions();
    input("ai-context-window").value = ""; // would fail validation if it were checked
    (document.getElementById("btn-save-settings") as HTMLButtonElement).click();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

    const saved = sentMessages.find((m) => m.kind === "settingsChanged");
    expect(saved).toBeDefined();
    expect((saved!.payload as { ai: { contextWindowTokens: number } }).ai.contextWindowTokens).toBe(8192);
  });
});
