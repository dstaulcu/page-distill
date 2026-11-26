/**
 * Shared type definitions for Distill v3.
 *
 * Result unions, data models, and settings interfaces used across
 * all extension contexts (background, content, sidebar, options).
 */

// ---------------------------------------------------------------------------
// Result Unions
// ---------------------------------------------------------------------------

/**
 * Discriminated union for expected operation outcomes.
 * The `ok` field is the sole discriminant for TypeScript control-flow narrowing.
 *
 * Success branch carries the payload T.
 * Failure branch carries a typed `reason` (string literal union R) and a
 * human-readable `detail` string (max 200 chars).
 */
export type Result<T, R extends string> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: R; readonly detail: string };

// ---------------------------------------------------------------------------
// Settings & Configuration
// ---------------------------------------------------------------------------

export interface Settings {
  readonly schemaVersion: 1;
  readonly ai: AiConfig;
  readonly export: ExportConfig;
  readonly sitePatterns: ReadonlyArray<SitePattern>;
  /** Gates [Distill]-prefixed console output in every context (SF-8); default false. */
  readonly debugLogging: boolean;
}

/** What kind of server the base URL points at (CF-5.7) — see @shared/providers. */
export type AiProvider = "ollama" | "openai-compatible";

export interface AiConfig {
  /** Server kind; decides Ollama-only behavior (num_ctx, prompt budgeting) instead of guessing from the URL. */
  readonly provider: AiProvider;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKeyRef: string | null;
  readonly systemPrompt: string;
  /** Model's context-window size in tokens; drives CF-3.8 prompt budgeting and CF-5.5 num_ctx. */
  readonly contextWindowTokens: number;
}

export interface ExportConfig {
  readonly filenamePattern: string;
  readonly defaultDestination: ExportDestination;
  readonly frontmatterFields: ReadonlyArray<string>;
}

export interface SitePattern {
  readonly id: string;
  readonly source: "builtin" | "user";
  readonly urlMatchPattern: string;
  readonly contentSelector: string;
  readonly stale?: boolean;
}

export type ExportDestination =
  | { readonly kind: "download" }
  | { readonly kind: "clipboard" };

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface Conversation {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly messages: ReadonlyArray<ConversationMessage>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly isPartial?: boolean;
  // The AI model that produced this message (assistant messages only) —
  // the configured model ID at the time this specific request was made (CF-2.8).
  readonly model?: string;
}

// ---------------------------------------------------------------------------
// Extracted Article
// ---------------------------------------------------------------------------

export interface ExtractedArticle {
  readonly title: string;
  readonly author: string | null;
  readonly publicationDate: string | null;
  readonly sourceUrl: string;
  readonly siteName: string;
  readonly bodyMarkdown: string;
  readonly bodyCharacterCount: number;
}

// ---------------------------------------------------------------------------
// Tab State
// ---------------------------------------------------------------------------

// A secondary context tab (SF-1, added via "+") as persisted alongside a
// session's own TabState — content is deliberately excluded and is lazily
// re-extracted on demand, same as the primary tab's own cached restore.
export interface ContextTabSnapshot {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly confidence: "high" | "medium" | "low" | null;
}

export interface TabState {
  readonly url: string;
  readonly title: string;
  readonly summary: string | null;
  readonly conversation: Conversation;
  readonly extractionConfidence: "high" | "medium" | "low" | null;
  readonly consecutiveFailures: number;
  // Secondary context tabs (SF-1) added via "+" during this session — the
  // primary tab itself is this TabState entry, not part of this list.
  readonly contextTabs?: ReadonlyArray<ContextTabSnapshot>;
}
