/**
 * Simple markdown-to-HTML renderer for chat messages (CF-3.5).
 * Handles: bold, italic, headings (h1–h6), bullet and numbered lists,
 * blockquotes, tables, horizontal rules, code blocks, inline code, links.
 *
 * The output is injected via innerHTML into the privileged sidebar document,
 * and the input (AI responses, page-derived text) is untrusted — so escaping
 * and link-scheme filtering here are a security boundary, not cosmetics.
 */

const BLOCK_TAGS = "h[2-6]|ul|ol|pre|table|blockquote|hr";

/** Split a table row like `| a | b |` into trimmed cells. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Convert pipe tables (header row + separator row + body rows) to <table>. */
function renderTables(html: string): string {
  const lines = html.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes("|")) {
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j]));
        j++;
      }
      const head = `<thead><tr>${header.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
      const body = rows
        .map((r) => `<tr>${header.map((_, k) => `<td>${r[k] ?? ""}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table>${head}<tbody>${body}</tbody></table>`);
      i = j;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join("\n");
}

export function renderMarkdown(text: string): string {
  // Placeholders (\u0000N\u0000) protect code from the formatting passes below;
  // make sure the input can't forge one.
  const stash: string[] = [];
  const hold = (htmlFragment: string): string => {
    stash.push(htmlFragment);
    return `\u0000${stash.length - 1}\u0000`;
  };

  // Escape HTML first — including quotes, so untrusted text can never break
  // out of an attribute value (CF-3.5)
  let html = text
    .replace(/\u0000/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Code blocks (``` ... ```) and inline code — set aside so their contents
  // are never reinterpreted as bold/italic/lists
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) =>
    hold(`<pre><code class="lang-${lang}">${code}</code></pre>`),
  );
  html = html.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${code}</code>`));

  // Links [text](url) — only http(s) schemes become anchors; anything else
  // (javascript:, data:, etc.) stays as plain escaped text (CF-3.5). Set aside
  // so underscores/asterisks inside URLs aren't treated as emphasis.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, url: string) => {
    if (!/^https?:\/\//i.test(url)) {
      return match;
    }
    return hold(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
  });

  // Tables
  html = renderTables(html);

  // Horizontal rules
  html = html.replace(/^(?:-{3,}|\*{3,}|_{3,})$/gm, "<hr>");

  // Headings (# … ######)
  html = html.replace(/^#{5,6} (.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#### (.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // Bold (**text** or __text__)
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/gm, "$1<strong>$2</strong>");

  // Italic (*text* or _text_) — underscores only at word boundaries so
  // snake_case_names stay intact
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/gm, "$1<em>$2</em>");

  // Blockquotes (the escaped ">" is "&gt;")
  html = html.replace(/(^&gt; ?.*(?:\n|$))+/gm, (block) => {
    const inner = block
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => l.replace(/^&gt; ?/, ""))
      .join("<br>");
    return `<blockquote>${inner}</blockquote>`;
  });

  // Numbered lists (1. item / 1) item). Blank lines between items are collapsed
  // first, as for bullets below — LLM output commonly separates items.
  html = html.replace(/^(\d+[.)] .+)\n+(?=\d+[.)] )/gm, "$1\n");
  html = html.replace(/^\d+[.)] (.+)$/gm, "<oli>$1</oli>");
  html = html.replace(/(<oli>.*<\/oli>\n?)+/g, (m) => `<ol>${m.replace(/\n/g, "")}</ol>`);

  // Unordered lists (lines starting with * or - or +)
  // Collapse blank lines between consecutive bullets first — LLM output
  // commonly separates list items with a blank line, and without this the
  // list-grouping step below would split them into one <ul> per item.
  html = html.replace(/^([\*\-\+] .+)\n+(?=[\*\-\+] )/gm, "$1\n");
  html = html.replace(/^[\*\-\+] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
  // The newlines that separated bullet lines are still sitting inside the
  // <ul>; left alone they'd later become stray <br> tags between items.
  html = html.replace(/<ul>[\s\S]*?<\/ul>/g, (match) => match.replace(/\n/g, ""));

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, "</p><p>");
  html = "<p>" + html + "</p>";

  // Clean up empty paragraphs and paragraphs wrapped around block elements
  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(new RegExp(`<p>(<(?:${BLOCK_TAGS})>)`, "g"), "$1");
  html = html.replace(new RegExp(`(</(?:${BLOCK_TAGS})>)</p>`, "g"), "$1");
  html = html.replace(/<p>(<hr>)/g, "$1").replace(/(<hr>)<\/p>/g, "$1");

  // Single newlines → <br> (within paragraphs); not right after a block element
  html = html.replace(new RegExp(`(</(?:${BLOCK_TAGS})>|<hr>)\\n`, "g"), "$1");
  html = html.replace(/\n/g, "<br>");

  // Numbered-list items were kept as <oli> so the bullet pass above ignored them
  html = html.replace(/<(\/?)oli>/g, "<$1li>");

  // Restore protected code and links
  // A stashed fragment can itself contain placeholders (a link label holding inline
  // code), so restore until none remain. Fragments only ever reference EARLIER
  // entries and input NULs were stripped, so this terminates and can't be forged.
  for (let pass = 0; pass <= stash.length; pass++) {
    const restored = html.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => stash[Number(n)] ?? "");
    if (restored === html) break;
    html = restored;
  }

  return html;
}
