/**
 * One-time cleanup of storage written by features that have been removed
 * (skills / skill library, personas, bot avatar). Runs at background startup;
 * safe to run repeatedly.
 */

import type { StorageAdapter } from "@shared/storage";
import type { Logger } from "@shared/logger";
import { noopLogger } from "@shared/logger";

/** `browser.storage.local` keys owned by removed features. */
export const LEGACY_LOCAL_STORAGE_KEYS: ReadonlyArray<string> = [
  "distill_skill_library", // skills + personas + active selection
  "distill_active_skill", // the pre-library single active skill
  "distill_bot_avatar", // sidebar bot avatar data URI
];

export async function removeLegacyStorage(storage: StorageAdapter, logger: Logger = noopLogger): Promise<void> {
  for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
    try {
      await storage.remove(key);
    } catch (err) {
      logger.warn("Legacy storage cleanup failed", key, err instanceof Error ? err.message : String(err));
    }
  }
}
