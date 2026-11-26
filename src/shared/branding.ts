/**
 * Brand strings — the single place the product's user-visible names live.
 *
 * They are defined once, in `public/_locales/en/messages.json`. Firefox reads
 * that file directly for the manifest (`__MSG_extName__` …), and this module
 * imports the same file for everything the UI renders, so renaming the product
 * is a one-file edit. (`branding.test.ts` fails if a hard-coded copy sneaks back in.)
 *
 * Not user settings: these are fixed at build time.
 */

import messages from "../../public/_locales/en/messages.json";

type BrandKey = keyof typeof messages;

function brand(key: BrandKey): string {
  return messages[key].message;
}

/** The product name, e.g. in titles, the help menu and settings page. */
export const PRODUCT_NAME: string = brand("extName");

/** The speaker label above each AI reply in the chat. */
export const ASSISTANT_NAME: string = brand("assistantName");

/** Prefix on debug-log lines. */
export const LOG_PREFIX: string = brand("logPrefix");
