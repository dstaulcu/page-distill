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
  /advert|sponsor|promo|adsbygoogle|google_ads|cookie-?(banner|notice|consent)|gdpr|newsletter-?(signup|form)|taboola|outbrain/;

/**
 * Heading text that marks a module of OTHER content (related / trending /
 * sponsored …). Class names on such modules are often obfuscated, so the
 * heading is the reliable signal. Matched against the whole heading.
 */
const PROMO_HEADING =
  /^(popular( reads| stories| now)?|trending( now| videos| stories)?|related( (articles|stories|posts|content|reading|links|videos|coverage))?|recommended( for you| stories| reading| videos)?|more (from .+|stories|on this|news|to explore|headlines)|you (may|might) (also )?(like|enjoy|be interested in)|most (read|popular|viewed|shared|emailed)|read more|around the web|top stories|sponsored( content| stories)?|paid content|from our partners|also read|up next|watch (more|next)|latest (news|headlines|stories|videos))$/i;

/** A whole element whose entire text is one of these labels is an ad marker. */
const AD_LABEL =
  /^(advertisement|ad|ads|sponsored( content)?|story continues below( advertisement)?|continue reading below|scroll to continue|paid content|promoted( content)?)$/i;

const PROMO_CONTAINER_TAGS = "section, aside, div, ul, ol, nav";

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

/** A tiny element that only says "Advertisement" / "Story continues below" and the like. */
function isAdLabel(el: Element): boolean {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= 40 && AD_LABEL.test(text);
}

/**
 * A module introduced by a "Popular Reads" / "Related stories" style heading:
 * the heading is the first thing in the container, so a long article that merely
 * has such a heading further down (or inside a sentence) is not matched.
 */
function isPromoModule(el: Element): boolean {
  if (!el.matches(PROMO_CONTAINER_TAGS)) return false;
  const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
  if (!heading) return false;
  const headingText = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!PROMO_HEADING.test(headingText)) return false;
  const containerText = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return containerText.startsWith(headingText);
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

    const signalled = isHiddenByAttribute(el) || hasNoiseSignal(el) || isAdLabel(el) || isPromoModule(el);
    if (!signalled) continue;

    const share = totalText === 0 ? 0 : (el.textContent ?? "").length / totalText;
    if (share > MAX_REMOVABLE_TEXT_SHARE) continue;

    el.remove();
    removed++;
  }
  return removed;
}
