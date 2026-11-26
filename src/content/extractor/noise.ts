/**
 * Boilerplate / ad stripping applied to a DETACHED copy of the page before
 * conversion. Removing obvious non-content (ads, nav, cookie banners, hidden
 * elements) keeps it out of the summary and out of the context budget, and
 * gives Readability a cleaner tree to score.
 *
 * Deliberately conservative: it only looks at tags, ARIA roles, hidden state
 * and whole class/id tokens — never at text — and it refuses to remove an
 * element that holds most of the root's text (a mislabelled wrapper must not
 * take the article with it).
 */

/** Tags that are never article content. */
const ALWAYS_REMOVED_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed", "canvas",
]);

/** Structural tags that are page chrome, removed unless they hold most of the text. */
const CHROME_TAGS = new Set(["nav", "aside", "footer", "dialog"]);

const CHROME_ROLES = new Set([
  "navigation", "banner", "complementary", "contentinfo", "dialog", "alertdialog",
]);

/** Whole class/id tokens that mark boilerplate. */
const NOISE_TOKENS = new Set([
  "ad", "ads", "adsbygoogle", "advert", "advertisement", "ad-slot", "ad-container",
  "ad-wrapper", "sponsored", "promo", "promoted", "related", "related-posts",
  "recommended", "share", "social", "newsletter", "cookie", "cookie-banner",
  "cookie-consent", "consent", "popup", "modal", "sidebar",
]);

/** Substrings of class/id/aria-label that are unambiguous enough to match anywhere. */
const NOISE_SUBSTRING =
  /advert|sponsor|adsbygoogle|google_ads|cookie-?(banner|notice|consent)|gdpr|newsletter-?(signup|form)|taboola|outbrain/;

/** An element holding more than this share of the root's text is kept regardless. */
const MAX_REMOVABLE_TEXT_SHARE = 0.6;

function isHiddenByAttribute(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const style = (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function hasNoiseSignal(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (CHROME_TAGS.has(tag)) return true;
  const role = el.getAttribute("role");
  if (role && CHROME_ROLES.has(role.toLowerCase())) return true;

  const classAndId = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`.toLowerCase();
  const tokens = classAndId.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => NOISE_TOKENS.has(t))) return true;
  if (NOISE_SUBSTRING.test(classAndId)) return true;
  if (NOISE_SUBSTRING.test((el.getAttribute("aria-label") ?? "").toLowerCase())) return true;
  return false;
}

/**
 * Removes boilerplate descendants of `root` in place (root itself is never
 * removed). Callers must pass a detached clone, never the live page.
 * Returns the number of elements removed.
 */
export function stripNoise(root: Element): number {
  const totalText = (root.textContent ?? "").length;
  let removed = 0;

  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!root.contains(el)) continue; // already gone with a removed ancestor

    const tag = el.tagName.toLowerCase();
    if (ALWAYS_REMOVED_TAGS.has(tag)) {
      el.remove();
      removed++;
      continue;
    }

    if (!isHiddenByAttribute(el) && !hasNoiseSignal(el)) continue;

    const share = totalText === 0 ? 0 : (el.textContent ?? "").length / totalText;
    if (share > MAX_REMOVABLE_TEXT_SHARE) continue;

    el.remove();
    removed++;
  }
  return removed;
}
