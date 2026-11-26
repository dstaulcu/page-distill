/**
 * Boilerplate / ad stripping applied to a DETACHED copy of the page before
 * conversion. Removing obvious non-content (ads, nav, cookie banners, hidden
 * elements) keeps it out of the summary and out of the context budget, and
 * gives Readability a cleaner tree to score.
 *
 * Deliberately conservative: it looks at tags, ARIA roles, hidden state, whole
 * class/id tokens, and only two kinds of text — the heading that introduces a
 * "Related stories"-style module and tiny "Advertisement" labels. It refuses to
 * remove an element that holds most of the root's text (a mislabelled wrapper
 * must not take the article with it).
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
  /advert|sponsor|adsbygoogle|google_ads|cookie-?(banner|notice|consent)|gdpr|newsletter-?(signup|form)|taboola|outbrain|promo[-_]?(box|banner|module|unit|slot|block|widget|card|tile|strip)|(content|mobile|inline|native|sidebar|article)[-_]?promo(?![a-z])/;

/**
 * Heading text that marks a module of OTHER content (related / recommended /
 * sponsored …). Class names on such modules are often obfuscated, so the
 * heading is the reliable signal. Matched against the whole heading.
 *
 * "Top stories", "Trending", "Latest news" are on this list because inside an
 * article page they are side modules — but on a portal page they are the main
 * sections, which is why `stripNoise` can be told to skip this (promoModules).
 */
const PROMO_HEADING =
  /^(popular( reads| stories| now)?|trending( now| videos| stories)?|related( (articles|stories|posts|content|reading|links|videos|coverage))?|recommended( for you| stories| reading| videos)?|more (from .+|stories|on this|news|to explore|headlines)|you (may|might) (also )?(like|enjoy|be interested in)|most (read|popular|viewed|shared|emailed)|read more|around the web|top stories|sponsored( content| stories)?|paid content|from our partners|also read|up next|watch (more|next)|latest (news|headlines|stories|videos))$/i;

/** A whole element whose entire text is one of these labels is an ad marker. */
const AD_LABEL =
  /^(advertisement|ad|ads|sponsored( content)?|story continues below( advertisement)?|continue reading below|scroll to continue|paid content|promoted( content)?)$/i;

/** Only these tags are treated as ad labels — never table cells, list items, links, buttons or code. */
const AD_LABEL_TAGS = new Set(["div", "span", "p", "small", "label", "em", "strong", "b", "i"]);

const PROMO_CONTAINER_TAGS = new Set(["section", "aside", "div", "ul", "ol", "nav"]);

/** How far above a promo heading to look for the module's container. */
const PROMO_CLIMB_LEVELS = 6;

/** An element holding more than this share of the root's text is kept regardless. */
const MAX_REMOVABLE_TEXT_SHARE = 0.6;

export interface StripNoiseOptions {
  /**
   * Remove modules introduced by "Related stories" / "Popular Reads" style
   * headings (default true). Turn off for portal pages, where headings like
   * "Top Stories" name the page's real content.
   */
  readonly promoModules?: boolean;
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

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

/** A tiny leaf-like element that only says "Advertisement" / "Story continues below" and the like. */
function isAdLabel(el: Element): boolean {
  // Cheap rejects first: this runs on every element, so it must not read the
  // text of large containers.
  if (!AD_LABEL_TAGS.has(el.tagName.toLowerCase())) return false;
  if (el.childElementCount > 2) return false;
  const raw = el.textContent ?? "";
  if (raw.length > 120) return false;
  const text = normalize(raw);
  return text.length > 0 && text.length <= 40 && AD_LABEL.test(text);
}

/**
 * Finds modules introduced by a "Popular Reads" / "Related stories" style
 * heading. Works from the (few) matching headings upward, so the cost is
 * proportional to the number of promo headings, not the size of the page.
 * The module is the largest ancestor (within a few levels) whose text still
 * STARTS with the heading and that holds a small share of the page — so a
 * long article that merely has such a heading further down is not matched.
 */
function findPromoModules(root: Element, totalText: number): Element[] {
  const modules: Element[] = [];
  for (const heading of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const headingText = normalize(heading.textContent);
    if (!PROMO_HEADING.test(headingText)) continue;

    let best: Element | null = null;
    let candidate: Element | null = heading.parentElement;
    for (let level = 0; candidate && candidate !== root && level < PROMO_CLIMB_LEVELS; level++, candidate = candidate.parentElement) {
      const text = normalize(candidate.textContent);
      if (!text.startsWith(headingText)) break;
      if (totalText > 0 && text.length / totalText > MAX_REMOVABLE_TEXT_SHARE) break;
      if (PROMO_CONTAINER_TAGS.has(candidate.tagName.toLowerCase())) best = candidate;
    }
    if (best) modules.push(best);
  }
  return modules;
}

/**
 * Removes boilerplate descendants of `root` in place (root itself is never
 * removed). Callers must pass a detached clone, never the live page.
 * Returns the number of elements removed.
 */
export function stripNoise(root: Element, options: StripNoiseOptions = {}): number {
  const totalText = (root.textContent ?? "").length;
  let removed = 0;

  if (options.promoModules !== false) {
    for (const module of findPromoModules(root, totalText)) {
      if (!root.contains(module)) continue;
      module.remove();
      removed++;
    }
  }

  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!root.contains(el)) continue; // already gone with a removed ancestor

    const tag = el.tagName.toLowerCase();
    if (ALWAYS_REMOVED_TAGS.has(tag)) {
      el.remove();
      removed++;
      continue;
    }

    if (!isHiddenByAttribute(el) && !hasNoiseSignal(el) && !isAdLabel(el)) continue;

    const share = totalText === 0 ? 0 : (el.textContent ?? "").length / totalText;
    if (share > MAX_REMOVABLE_TEXT_SHARE) continue;

    el.remove();
    removed++;
  }
  return removed;
}
