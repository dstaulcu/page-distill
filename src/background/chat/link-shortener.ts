/**
 * Shortens markdown link / image targets before page text goes into a prompt.
 *
 * Affiliate and tracking links carry hundreds of characters of query string
 * (one real listicle was ~40% URL text) that a model can't use but that eat
 * the context budget and push real content out of the window. The link LABEL
 * is untouched; only long targets lose their query string and fragment.
 * Short URLs are left exactly as they are, so ordinary links keep working in Q&A.
 *
 * Applies to the prompt copy only — exports keep the original URLs.
 */

/** Targets up to this long are kept verbatim. */
const MAX_KEPT_URL_CHARS = 80;

function shortenUrl(url: string): string {
  if (url.length <= MAX_KEPT_URL_CHARS) return url;
  if (/^data:/i.test(url)) return "data:…";

  let shortened = url;
  try {
    const parsed = new URL(url);
    shortened = parsed.origin + parsed.pathname;
  } catch {
    // Relative or unparseable: just drop everything after the query marker
    shortened = url.split(/[?#]/)[0];
  }
  return shortened.length > MAX_KEPT_URL_CHARS ? shortened.slice(0, MAX_KEPT_URL_CHARS) + "…" : shortened;
}

export function shortenLinkUrls(markdown: string): string {
  return markdown.replace(
    /(!?\[[^\]]*\])\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (_match, label: string, url: string, title: string) => `${label}(${shortenUrl(url)}${title})`,
  );
}
