import { describe, it, expect } from "vitest";
import { stripNoise } from "./noise";

function body(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, "text/html");
  return doc.body;
}

const PROSE = "Real article prose that readers actually came for. ".repeat(10);

describe("CF-1 stripNoise", () => {
  it("removes scripts, styles, iframes and other never-content tags", () => {
    const root = body(`<p>${PROSE}</p><script>x()</script><style>p{}</style><iframe src="a"></iframe><noscript>n</noscript>`);
    stripNoise(root);
    expect(root.querySelector("script, style, iframe, noscript")).toBeNull();
    expect(root.textContent).toContain("Real article prose");
  });

  it("removes nav, aside and footer chrome around the article", () => {
    const root = body(`<nav>Home About</nav><div><p>${PROSE}</p></div><aside>Subscribe!</aside><footer>© Co</footer>`);
    stripNoise(root);
    expect(root.textContent).not.toContain("Home About");
    expect(root.textContent).not.toContain("Subscribe!");
    expect(root.textContent).not.toContain("© Co");
    expect(root.textContent).toContain("Real article prose");
  });

  it("removes ads, sponsored blocks, cookie banners and related lists by class or id token", () => {
    const root = body(
      `<p>${PROSE}</p>` +
        `<div class="ad-slot">BUY NOW</div>` +
        `<div class="adsbygoogle">AD2</div>` +
        `<section class="sponsored-content">PAID</section>` +
        `<div id="cookie-banner">We use cookies</div>` +
        `<ul class="related">More stories</ul>`,
    );
    stripNoise(root);
    for (const junk of ["BUY NOW", "AD2", "PAID", "We use cookies", "More stories"]) {
      expect(root.textContent).not.toContain(junk);
    }
    expect(root.textContent).toContain("Real article prose");
  });

  it("removes hidden elements (attribute, aria-hidden, inline display:none)", () => {
    const root = body(
      `<p>${PROSE}</p><div hidden>H1</div><div aria-hidden="true">H2</div><div style="display: none">H3</div><div style="visibility:hidden">H4</div>`,
    );
    stripNoise(root);
    for (const junk of ["H1", "H2", "H3", "H4"]) expect(root.textContent).not.toContain(junk);
  });

  it("removes ARIA landmark chrome and ad-labelled regions", () => {
    const root = body(
      `<p>${PROSE}</p><div role="navigation">NAVROLE</div><div role="complementary">COMPROLE</div><div aria-label="Advertisement">ADLABEL</div>`,
    );
    stripNoise(root);
    for (const junk of ["NAVROLE", "COMPROLE", "ADLABEL"]) expect(root.textContent).not.toContain(junk);
  });

  it("matches whole class tokens, so look-alike class names survive", () => {
    const root = body(`<div class="ad-free-reading"><p>${PROSE}</p></div><div class="shadow"><p>KEEPME ${PROSE}</p></div><div class="loader">KEEPLOADER</div>`);
    stripNoise(root);
    expect(root.textContent).toContain("KEEPME");
    expect(root.textContent).toContain("KEEPLOADER");
  });

  it("never removes a wrapper that holds most of the text, even if it looks like boilerplate", () => {
    const root = body(`<div class="sidebar"><p>${PROSE}</p></div><div>tiny</div>`);
    stripNoise(root);
    expect(root.textContent).toContain("Real article prose");
  });

  it("does not remove the root itself", () => {
    const root = body(`<p>${PROSE}</p>`);
    root.className = "ad";
    stripNoise(root);
    expect(root.textContent).toContain("Real article prose");
  });

  it("reports how many elements it removed", () => {
    const root = body(`<p>${PROSE}</p><script>1</script><nav>x</nav>`);
    expect(stripNoise(root)).toBe(2);
  });
});
