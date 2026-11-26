import { describe, it, expect } from "vitest";
import {
  fitConversationToBudget,
  fitArticlesToBudget,
  computeBudgetChars,
  MIN_ARTICLE_BODY_CHARS,
  ARTICLE_FRAMING_SLACK_CHARS,
  computeArticleBudgetChars,
  computeKeptPercent,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  CHARS_PER_TOKEN_ESTIMATE,
  RESPONSE_RESERVE_FRACTION,
} from "./context-budget";
import type { ChatMessage } from "./streaming-client";
import type { ExtractedArticle } from "@shared/types";

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

function article(title: string, bodyMarkdown: string): ExtractedArticle {
  return {
    title,
    author: null,
    publicationDate: null,
    sourceUrl: `https://example.com/${title}`,
    siteName: "",
    bodyMarkdown,
    bodyCharacterCount: bodyMarkdown.length,
  };
}

describe("CF-3.8 computeBudgetChars", () => {
  it("applies the 4-chars-per-token estimate with 25% reserved for the reply", () => {
    expect(computeBudgetChars(8192)).toBe(Math.floor(8192 * CHARS_PER_TOKEN_ESTIMATE * (1 - RESPONSE_RESERVE_FRACTION)));
    expect(computeBudgetChars(1000)).toBe(Math.floor(1000 * 4 * 0.75));
  });
});

describe("CF-3.8 fitConversationToBudget", () => {
  it("returns everything unchanged when well under budget", () => {
    const pinnedBefore = [msg("system", "sys"), msg("user", "page context")];
    const history = [msg("user", "q1"), msg("assistant", "a1")];
    const pinnedAfter = [msg("user", "q2")];

    const result = fitConversationToBudget(pinnedBefore, history, pinnedAfter, 100_000);

    expect(result.historyTruncated).toBe(false);
    expect(result.messages).toEqual([...pinnedBefore, ...history, ...pinnedAfter]);
  });

  it("drops the oldest history turns first, keeping a contiguous newest suffix", () => {
    const pinnedBefore = [msg("system", "x".repeat(10))];
    const pinnedAfter = [msg("user", "x".repeat(10))];
    const history = [
      msg("user", "x".repeat(20)), // oldest
      msg("assistant", "x".repeat(20)),
      msg("user", "x".repeat(20)), // newest
    ];
    // Budget: 20 (pinned) + room for exactly the newest history turn.
    const budget = 20 + 20;

    const result = fitConversationToBudget(pinnedBefore, history, pinnedAfter, budget);

    expect(result.historyTruncated).toBe(true);
    expect(result.messages).toEqual([...pinnedBefore, history[2], ...pinnedAfter]);
  });

  it("never touches pinned messages, even if the budget is smaller than pinned content alone", () => {
    const pinnedBefore = [msg("system", "x".repeat(500))];
    const pinnedAfter = [msg("user", "x".repeat(500))];
    const history = [msg("user", "q1"), msg("assistant", "a1")];

    const result = fitConversationToBudget(pinnedBefore, history, pinnedAfter, 10);

    expect(result.historyTruncated).toBe(true);
    expect(result.messages).toEqual([...pinnedBefore, ...pinnedAfter]);
  });

  it("is a no-op (historyTruncated: false) when history is already empty", () => {
    const pinnedBefore = [msg("system", "sys")];
    const pinnedAfter = [msg("user", "hi")];

    const result = fitConversationToBudget(pinnedBefore, [], pinnedAfter, 5);

    expect(result.historyTruncated).toBe(false);
    expect(result.messages).toEqual([...pinnedBefore, ...pinnedAfter]);
  });

  it("stops dropping as soon as a contiguous newest suffix fits, without leaving gaps", () => {
    const pinnedBefore: ChatMessage[] = [];
    const pinnedAfter: ChatMessage[] = [];
    const history = [
      msg("user", "a".repeat(5)),
      msg("assistant", "b".repeat(5)),
      msg("user", "c".repeat(5)),
      msg("assistant", "d".repeat(5)),
    ];
    // Room for the newest two turns (5+5=10) but not three (15).
    const result = fitConversationToBudget(pinnedBefore, history, pinnedAfter, 10);

    expect(result.historyTruncated).toBe(true);
    expect(result.messages).toEqual([history[2], history[3]]);
  });

  it("exports a sane default context window token count", () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(8192);
  });
});

describe("CF-3.8 kept history starts on a user turn", () => {
  it("drops a leading assistant turn left at the front after trimming", () => {
    // Budget 16: only the last 3 turns (5+5+5) fit, which would start with an assistant turn.
    const history = [msg("user", "u".repeat(100)), msg("assistant", "a1111"), msg("user", "u2222"), msg("assistant", "a3333")];
    const { messages, historyTruncated } = fitConversationToBudget([], history, [], 16);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0].content).toBe("u2222");
    expect(historyTruncated).toBe(true);
  });

  it("drops all history when only assistant turns would remain", () => {
    const history = [msg("user", "u".repeat(100)), msg("assistant", "a1111")];
    const { messages, historyTruncated } = fitConversationToBudget([msg("system", "s")], history, [msg("user", "q")], 10);
    expect(messages.map((m) => m.content)).toEqual(["s", "q"]);
    expect(historyTruncated).toBe(true);
  });

  it("leaves untrimmed history untouched even if it begins with an assistant turn", () => {
    const history = [msg("assistant", "a"), msg("user", "u")];
    const { messages, historyTruncated } = fitConversationToBudget([], history, [], 1000);
    expect(messages).toHaveLength(2);
    expect(historyTruncated).toBe(false);
  });
});

describe("CF-3.9 fitArticlesToBudget", () => {
  it("returns every article untouched when the bodies fit the budget", () => {
    const articles = [article("a", "x".repeat(300)), article("b", "y".repeat(200))];
    const result = fitArticlesToBudget(articles, 500);
    expect(result.articles).toEqual(articles);
    expect(result.contextTruncated).toBe(false);
  });

  it("handles no articles", () => {
    expect(fitArticlesToBudget([], 100)).toEqual({ articles: [], contextTruncated: false });
  });

  it("shortens bodies to fit — every article stays present and keeps the START of its body", () => {
    const articles = [article("a", "A" + "x".repeat(4999)), article("b", "B" + "y".repeat(4999))];
    const result = fitArticlesToBudget(articles, 2000);
    expect(result.contextTruncated).toBe(true);
    expect(result.articles).toHaveLength(2);
    expect(result.articles[0].bodyMarkdown.startsWith("Axxx")).toBe(true);
    expect(result.articles[1].bodyMarkdown.startsWith("Byyy")).toBe(true);
    const total = result.articles.reduce((n, a) => n + a.bodyMarkdown.length, 0);
    expect(total).toBeLessThanOrEqual(2000);
    expect(result.articles[0].bodyCharacterCount).toBe(result.articles[0].bodyMarkdown.length);
  });

  it("gives a short article all it needs and splits the rest among the long ones", () => {
    const small = article("small", "s".repeat(100));
    const bigA = article("bigA", "a".repeat(10_000));
    const bigB = article("bigB", "b".repeat(10_000));
    const result = fitArticlesToBudget([bigA, small, bigB], 1100);
    expect(result.articles[1].bodyMarkdown).toHaveLength(100);
    expect(result.articles[0].bodyMarkdown).toHaveLength(500);
    expect(result.articles[2].bodyMarkdown).toHaveLength(500);
    expect(result.contextTruncated).toBe(true);
  });

  it("never shortens a body below MIN_ARTICLE_BODY_CHARS, even with a zero budget", () => {
    const result = fitArticlesToBudget([article("a", "x".repeat(5000))], 0);
    expect(result.articles[0].bodyMarkdown).toHaveLength(MIN_ARTICLE_BODY_CHARS);
    expect(result.contextTruncated).toBe(true);
  });

  it("is a no-op with an infinite budget (endpoints that aren't budgeted)", () => {
    const articles = [article("a", "x".repeat(100_000))];
    const result = fitArticlesToBudget(articles, Number.POSITIVE_INFINITY);
    expect(result.articles).toEqual(articles);
    expect(result.contextTruncated).toBe(false);
  });
});

describe("CF-3.9 computeArticleBudgetChars", () => {
  it("subtracts the fixed text and framing, never going negative", () => {
    expect(computeArticleBudgetChars(1000, 300)).toBe(700);
    expect(computeArticleBudgetChars(1000, 5000)).toBe(0);
    expect(computeArticleBudgetChars(1000, 300, [article("t", "")])).toBe(
      700 - ("t".length + "https://example.com/t".length + ARTICLE_FRAMING_SLACK_CHARS),
    );
  });

});

describe("CF-3.9 computeKeptPercent", () => {
  const art = (body: string): ExtractedArticle => ({
    title: "t", author: null, publicationDate: null, sourceUrl: "https://e.com", siteName: "",
    bodyMarkdown: body, bodyCharacterCount: body.length,
  });

  it("is 100 when nothing was cut", () => {
    expect(computeKeptPercent([art("x".repeat(100))], [art("x".repeat(100))])).toBe(100);
  });

  it("reports the share of body text that survived, across all articles", () => {
    expect(computeKeptPercent([art("a".repeat(600)), art("b".repeat(400))], [art("a".repeat(200)), art("b".repeat(100))])).toBe(30);
  });

  it("never reports 0 or 100 when something was cut", () => {
    expect(computeKeptPercent([art("a".repeat(10000))], [art("a")])).toBe(1);
    expect(computeKeptPercent([art("a".repeat(1000))], [art("a".repeat(999))])).toBe(99);
  });

  it("is 100 for empty input", () => {
    expect(computeKeptPercent([], [])).toBe(100);
  });
});
