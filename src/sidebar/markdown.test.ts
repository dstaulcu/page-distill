/**
 * Tests for the sidebar markdown renderer.
 *
 * CF-3.5: chat content rendered to HTML is sanitized — HTML special
 * characters including quotes are escaped, and links render only with
 * http:/https: schemes. javascript: URLs and attribute injection must
 * not survive rendering.
 */

import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("CF-3.5 markdown sanitization", () => {
  it("escapes angle brackets so raw HTML never executes", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes double quotes so attribute injection is impossible", () => {
    const html = renderMarkdown('He said "hello" loudly');
    expect(html).not.toContain('said "hello"');
    expect(html).toContain("&quot;hello&quot;");
  });

  it("blocks javascript: URLs in links", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    // The link syntax stays as inert text — no anchor, no href
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("blocks data: URLs in links", () => {
    const html = renderMarkdown("[click](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain("<a ");
  });

  it("blocks attribute breakout via quotes inside a link URL", () => {
    const html = renderMarkdown('[x](https://a.example/" onmouseover="alert(1))');
    expect(html).not.toContain('onmouseover="alert(1)"');
    // The quote must arrive escaped if it appears anywhere
    expect(html).not.toMatch(/href="[^"]*" onmouseover=/);
  });

  it("renders normal http and https links", () => {
    const http = renderMarkdown("[site](http://example.com/page)");
    const https = renderMarkdown("[site](https://example.com/page)");
    expect(http).toContain('<a href="http://example.com/page"');
    expect(https).toContain('<a href="https://example.com/page"');
    expect(https).toContain('rel="noopener"');
  });
});

describe("markdown rendering basics", () => {
  it("renders bold and italic", () => {
    expect(renderMarkdown("**bold** and *italic*")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("**bold** and *italic*")).toContain("<em>italic</em>");
  });

  it("renders headings", () => {
    expect(renderMarkdown("## Key Points")).toContain("<h3>Key Points</h3>");
    expect(renderMarkdown("#### Findings")).toContain("<h5>Findings</h5>");
    expect(renderMarkdown("###### Deep")).toContain("<h6>Deep</h6>");
    expect(renderMarkdown("#### Findings")).not.toContain("####");
  });

  it("renders bullet lists", () => {
    const html = renderMarkdown("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("renders inline code and code blocks", () => {
    expect(renderMarkdown("use `foo()`")).toContain("<code>foo()</code>");
    const block = renderMarkdown("```js\nconst a = 1;\n```");
    expect(block).toContain("<pre><code");
    expect(block).toContain("const a = 1;");
  });

  it("splits paragraphs on blank lines", () => {
    const html = renderMarkdown("first\n\nsecond");
    expect(html).toContain("<p>first</p>");
    expect(html).toContain("<p>second</p>");
  });

  it("merges list items separated by blank lines into a single list", () => {
    // LLM output commonly puts a blank line between bullets.
    const html = renderMarkdown("- one\n\n- two\n\n- three");
    expect(html.match(/<ul>/g)?.length).toBe(1);
    expect(html.match(/<\/ul>/g)?.length).toBe(1);
    expect(html).not.toContain("<br>");
  });
});

describe("markdown rendering — extended syntax", () => {
  it("renders numbered lists as a single <ol>, even with blank lines between items", () => {
    const html = renderMarkdown("1. First\n\n2. Second\n3. Third");
    expect(html).toContain("<ol><li>First</li><li>Second</li><li>Third</li></ol>");
    expect(html).not.toContain("<br>");
  });

  it("keeps bullet and numbered lists separate", () => {
    const html = renderMarkdown("- a\n- b\n\n1. x\n2. y");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(html).toContain("<ol><li>x</li><li>y</li></ol>");
  });

  it("renders blockquotes, escaping their content", () => {
    const html = renderMarkdown("> quoted <b>x</b>\n> second");
    expect(html).toContain("<blockquote>quoted &lt;b&gt;x&lt;/b&gt;<br>second</blockquote>");
    expect(html).not.toContain("<p><blockquote>");
  });

  it("renders horizontal rules", () => {
    const html = renderMarkdown("above\n\n---\n\nbelow");
    expect(html).toContain("<hr>");
    expect(html).not.toContain("<p><hr>");
  });

  it("renders pipe tables with a header row and inline formatting in cells", () => {
    const html = renderMarkdown("| Name | Value |\n|------|:-----:|\n| **a** | 1 |\n| b | 2 |");
    expect(html).toContain("<table><thead><tr><th>Name</th><th>Value</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td><strong>a</strong></td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>");
    expect(html).not.toContain("<p><table>");
  });

  it("does not treat a lone pipe line as a table", () => {
    const html = renderMarkdown("a | b");
    expect(html).not.toContain("<table>");
  });

  it("escapes HTML inside table cells", () => {
    const html = renderMarkdown("| h |\n|---|\n| <script>x</script> |");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not reinterpret code contents as markdown", () => {
    const html = renderMarkdown("```\n- not a list\n**not bold** snake_case_name\n```\n\nuse `a_b_c` here");
    expect(html).toContain("- not a list");
    expect(html).toContain("**not bold** snake_case_name");
    expect(html).not.toContain("<li>");
    expect(html).toContain("<code>a_b_c</code>");
    expect(html).not.toContain("<em>");
  });

  it("leaves snake_case words and underscores in link URLs alone", () => {
    const html = renderMarkdown("the my_var_name field, see [doc](https://example.com/a_b_c)");
    expect(html).not.toContain("<em>");
    expect(html).toContain('href="https://example.com/a_b_c"');
  });

  it("still renders word-bounded _italic_ and __bold__", () => {
    expect(renderMarkdown("an _idea_ here")).toContain("<em>idea</em>");
    expect(renderMarkdown("a __bold__ move")).toContain("<strong>bold</strong>");
  });

  it("cannot be tricked into restoring forged placeholders", () => {
    const html = renderMarkdown("`x` \u00000\u0000");
    expect(html).toContain("<code>x</code>");
    expect(html.match(/<code>/g)).toHaveLength(1);
  });

  it("does not wrap h5/h6 headings in paragraphs", () => {
    expect(renderMarkdown("#### Findings")).not.toContain("<p><h5>");
    expect(renderMarkdown("###### Deep")).not.toContain("<p>");
  });

  it("renders inline code inside a link label instead of leaking a placeholder", () => {
    const html = renderMarkdown("[`npm install`](https://example.com/docs)");
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener"><code>npm install</code></a>');
    expect(html).not.toContain("\u0000");
  });

  it("does not turn a line with a pipe followed by a horizontal rule into a table", () => {
    const html = renderMarkdown("Use the a | b operator\n---\nnext");
    expect(html).not.toContain("<table>");
    expect(html).toContain("<hr>");
  });

  it("renders underlined (setext) headings: ==== is a title, ---- is a section heading, not a rule", () => {
    const html = renderMarkdown("Summary of the page\n===================\n\nFindings\n--------\n\n- one\n- two");
    expect(html).toContain("<h2>Summary of the page</h2>");
    expect(html).toContain("<h3>Findings</h3>");
    expect(html).not.toContain("<hr>");
    expect(html).not.toContain("====");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  });

  it("still treats a dashes line after a blank line as a horizontal rule, not a heading", () => {
    const html = renderMarkdown("Above\n\n---\n\nBelow");
    expect(html).toContain("<hr>");
    expect(html).not.toContain("<h3>");
  });

  it("does not make a heading out of list items or quotes followed by dashes", () => {
    const html = renderMarkdown("- item\n---");
    expect(html).not.toContain("<h3>");
  });
});
