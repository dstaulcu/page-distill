/**
 * Context-window budget (CF-3.8) — fits a Q&A prompt into the model's
 * configured context window by dropping the oldest conversation turns
 * first, never the system prompt, page context, or the new message.
 */

import type { ChatMessage } from "./streaming-client";
import type { ExtractedArticle } from "@shared/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches the historical hardcoded Ollama num_ctx default (CF-5.5). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192;

/** Conservative chars-per-token approximation for English text; no tokenizer dependency. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Fraction of the window reserved for the model's reply, not counted against the prompt budget. */
export const RESPONSE_RESERVE_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

export function computeBudgetChars(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * (1 - RESPONSE_RESERVE_FRACTION));
}

export interface FitConversationResult {
  readonly messages: ChatMessage[];
  readonly historyTruncated: boolean;
}

/**
 * Fits `history` into whatever budget remains after `pinnedBefore` and
 * `pinnedAfter` (which are always sent in full). Drops the oldest history
 * turns first, keeping a contiguous newest suffix — never a gap.
 */
export function fitConversationToBudget(
  pinnedBefore: ReadonlyArray<ChatMessage>,
  history: ReadonlyArray<ChatMessage>,
  pinnedAfter: ReadonlyArray<ChatMessage>,
  budgetChars: number,
): FitConversationResult {
  if (history.length === 0) {
    return { messages: [...pinnedBefore, ...pinnedAfter], historyTruncated: false };
  }

  const pinnedChars = sumContentLength(pinnedBefore) + sumContentLength(pinnedAfter);
  const available = budgetChars - pinnedChars;

  let firstKeptIndex = history.length;
  let runningTotal = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    runningTotal += history[i].content.length;
    if (runningTotal > available) break;
    firstKeptIndex = i;
  }

  // Never start the kept history on an assistant turn: strict chat templates
  // reject assistant-first / assistant-after-assistant sequences. Only needed
  // when something was actually dropped — untrimmed history is left as-is.
  if (firstKeptIndex > 0) {
    while (firstKeptIndex < history.length && history[firstKeptIndex].role === "assistant") {
      firstKeptIndex++;
    }
  }

  const kept = history.slice(firstKeptIndex);
  return {
    messages: [...pinnedBefore, ...kept, ...pinnedAfter],
    historyTruncated: kept.length < history.length,
  };
}

function sumContentLength(messages: ReadonlyArray<ChatMessage>): number {
  return messages.reduce((total, m) => total + m.content.length, 0);
}

/**
 * No article body is ever shortened below this, so a prompt whose fixed text
 * (system prompt) eats the whole budget still leaves the model
 * something of every page to work with.
 */
export const MIN_ARTICLE_BODY_CHARS = 200;

/** Per-article slack for the "### Page N:" heading, "URL:" line and separators wrapped around a body. */
export const ARTICLE_FRAMING_SLACK_CHARS = 30;

/**
 * Budget available for article BODIES (CF-3.9): the total budget minus
 * everything else pinned in the prompt — `fixedChars` (the system prompt text
 * built with article bodies emptied, plus the new user message or summarize
 * instruction) and, for `framedArticles`, each article's title/URL framing.
 * Pass the articles only when `fixedChars` does not already include their
 * framing. Never negative.
 */
export function computeArticleBudgetChars(
  budgetChars: number,
  fixedChars: number,
  framedArticles: ReadonlyArray<ExtractedArticle> = [],
): number {
  const framing = framedArticles.reduce(
    (total, a) => total + a.title.length + a.sourceUrl.length + ARTICLE_FRAMING_SLACK_CHARS,
    0,
  );
  return Math.max(0, budgetChars - fixedChars - framing);
}

export interface FitArticlesResult {
  readonly articles: ExtractedArticle[];
  /** At least one article body was shortened to fit. */
  readonly contextTruncated: boolean;
}

/**
 * Fits article bodies into `bodyBudgetChars` (CF-3.9). If they already fit,
 * nothing changes. Otherwise bodies are shortened (keeping the START of each)
 * by water-filling: a short article keeps all it needs and the remainder is
 * split evenly among the longer ones, never below MIN_ARTICLE_BODY_CHARS. Every
 * article stays in the prompt — nothing is dropped.
 */
export function fitArticlesToBudget(
  articles: ReadonlyArray<ExtractedArticle>,
  bodyBudgetChars: number,
): FitArticlesResult {
  const total = articles.reduce((n, a) => n + a.bodyMarkdown.length, 0);
  if (articles.length === 0 || total <= bodyBudgetChars) {
    return { articles: [...articles], contextTruncated: false };
  }

  const limits = new Map<number, number>();
  let remaining = Math.max(0, bodyBudgetChars);
  const byLength = articles.map((a, i) => i).sort((x, y) => articles[x].bodyMarkdown.length - articles[y].bodyMarkdown.length);
  byLength.forEach((index, rank) => {
    const share = Math.max(MIN_ARTICLE_BODY_CHARS, Math.floor(remaining / (byLength.length - rank)));
    const allotted = Math.min(articles[index].bodyMarkdown.length, share);
    limits.set(index, allotted);
    remaining = Math.max(0, remaining - allotted);
  });

  let contextTruncated = false;
  const fitted = articles.map((a, i) => {
    const limit = limits.get(i)!;
    if (a.bodyMarkdown.length <= limit) return a;
    contextTruncated = true;
    return { ...a, bodyMarkdown: a.bodyMarkdown.slice(0, limit), bodyCharacterCount: limit };
  });
  return { articles: fitted, contextTruncated };
}
