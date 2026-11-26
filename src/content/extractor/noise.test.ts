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

describe("CF-1 stripNoise: promo sections and ad labels inside the article", () => {
  const prose = (n: number) => "A full sentence of real article prose that readers came for. ".repeat(n);

  it("removes a 'Popular Reads' style module by its heading, even with meaningless class names", () => {
    const root = body(
      `<div><p>${prose(12)}</p>` +
        `<section class="x1 y2"><header><h2>Popular Reads</h2></header><ul><li><a href="/a">Some other story headline</a></li><li><a href="/b">And yet another headline</a></li></ul></section>` +
        `<p>${prose(12)}</p></div>`,
    );
    stripNoise(root);
    expect(root.textContent).not.toContain("Popular Reads");
    expect(root.textContent).not.toContain("Some other story");
    expect(root.textContent).toContain("real article prose");
  });

  it("removes related / trending / recommended / sponsored modules", () => {
    for (const heading of ["Related Stories", "Trending Now", "Recommended for you", "More from Example", "You may also like", "Most Read", "Sponsored Content", "Around the web"]) {
      const root = body(`<div><p>${prose(12)}</p><div class="q"><h3>${heading}</h3><p><a href="/z">A teaser line for something else</a></p></div></div>`);
      stripNoise(root);
      expect(root.textContent, heading).not.toContain(heading);
      expect(root.textContent, heading).not.toContain("teaser line");
    }
  });

  it("keeps an ordinary section whose heading merely contains a promo word", () => {
    const root = body(`<div><section><h2>Why popular reads matter in publishing</h2><p>${prose(12)}</p></section></div>`);
    stripNoise(root);
    expect(root.textContent).toContain("Why popular reads matter");
  });

  it("never removes a promo-headed container that holds most of the text", () => {
    const root = body(`<div><section><h2>Related Reading</h2><p>${prose(20)}</p></section><p>short</p></div>`);
    stripNoise(root);
    expect(root.textContent).toContain("real article prose");
  });

  it("removes standalone 'Advertisement' / 'Story continues below' labels but not those words inside a sentence", () => {
    const root = body(
      `<p>${prose(10)}</p><div>Advertisement</div><span>STORY CONTINUES BELOW ADVERTISEMENT</span><div>Sponsored</div>` +
        `<p>The advertisement industry changed. ${prose(2)}</p>`,
    );
    stripNoise(root);
    expect(root.textContent).not.toMatch(/^Advertisement$/m);
    expect(root.textContent).not.toContain("STORY CONTINUES");
    expect(root.textContent).not.toContain("Sponsored");
    expect(root.textContent).toContain("The advertisement industry changed.");
  });

  it("matches CamelCase promo class names such as MobileContentPromo", () => {
    const root = body(`<p>${prose(12)}</p><section class="MobileContentPromo Kiog"><span>Buy things now from our partner</span></section>`);
    stripNoise(root);
    expect(root.textContent).not.toContain("Buy things now");
  });
});
