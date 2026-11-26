import { describe, it, expect, vi } from "vitest";
import { LEGACY_LOCAL_STORAGE_KEYS, removeLegacyStorage } from "./legacy-cleanup";
import type { StorageAdapter } from "@shared/storage";

function mockStorage(initial: Record<string, unknown>): StorageAdapter & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)) as StorageAdapter["get"],
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, value); return { ok: true as const }; }) as StorageAdapter["set"],
    remove: vi.fn(async (key: string) => { data.delete(key); }),
    subscribe: () => () => {},
  };
}

describe("removed features: legacy storage cleanup", () => {
  it("lists every key written by features that no longer exist", () => {
    expect([...LEGACY_LOCAL_STORAGE_KEYS].sort()).toEqual(
      ["distill_active_skill", "distill_bot_avatar", "distill_skill_library"],
    );
  });

  it("deletes the stored skill library, the pre-library active skill and the bot avatar, and leaves everything else", async () => {
    const storage = mockStorage({
      distill_skill_library: { schemaVersion: 1, skills: [], active: { kind: "none" } },
      distill_active_skill: { name: "Old" },
      distill_bot_avatar: "data:image/png;base64,AAAA",
      settings: { keep: true },
      distill_secure: "keep",
    });

    await removeLegacyStorage(storage);

    expect([...storage.data.keys()].sort()).toEqual(["distill_secure", "settings"]);
  });

  it("is a no-op when nothing legacy is stored, and never throws if storage fails", async () => {
    const empty = mockStorage({ settings: { keep: true } });
    await removeLegacyStorage(empty);
    expect(empty.data.get("settings")).toEqual({ keep: true });

    const failing: StorageAdapter = { ...mockStorage({}), remove: vi.fn(async () => { throw new Error("boom"); }) };
    await expect(removeLegacyStorage(failing)).resolves.toBeUndefined();
  });
});
