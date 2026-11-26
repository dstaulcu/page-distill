# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source of truth & process rules

**The tests are the specification of intended behavior** — there is no separate requirements
document. Features are tagged with stable IDs that appear in test names and code comments: core
features CF-1…CF-6 (e.g. CF-3.8) and secondary features SF-1…SF-8 (e.g. SF-4). When code and
its tests disagree, fix the code — unless you deliberately change the test first.

Non-negotiable rules for every change:

1. **Every new feature ships with its own unit tests**, written against observable behavior at
   module boundaries (not implementation details).
2. **Nothing is done until `npm test` (full suite) passes** — and a change is not "done" if it
   only passes the regression subset.
3. **A change to a core feature (CF-x) updates its tests first**, then the code.
4. **Bug fixes are verified failing-then-passing**: write the test that proves the bug, watch it
   fail, fix, watch it pass.
5. Tests that verify a CF criterion put the ID in their `describe` name (e.g.
   `describe("CF-4.2 renderFrontmatter", …)`) — that is what makes the regression filter work.
6. Don't silently change observable behavior; if a fix changes something users may rely on,
   flag it. Report test results honestly, including failures.

## Commands

```bash
npm run dev             # Development build with hot reload (vite)
npm run build           # Production build → dist/
npm test                # Full suite (vitest run) — the gate for "done"
npm run test:regression # Core-feature regression suite only (vitest run -t CF-)
npm run test:watch      # Watch mode
npm run typecheck       # tsc --noEmit — must stay clean (vite build does NOT typecheck)

# Run a single test file
npx vitest run src/background/chat/controller.test.ts

# Run property-based tests only
npx vitest run prop.test

# Cut a release: bump version (manifest.json is authoritative, package.json follows),
# run typecheck + full test suite, build, and zip dist/ into
# web-ext-artifacts/distill-<version>.xpi (unsigned). On any failure, version files are
# restored so a failed release never leaves a half-bumped tree.
npm run release -- patch            # 3.0.0 → 3.0.1 (also: minor, major, or an explicit x.y.z)
npm run release -- patch --skip-checks   # skip typecheck + tests — not for real releases
```

Load in Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `dist/manifest.json`.

## Architecture

### Extension Contexts

Four isolated contexts communicate only via typed message passing:

1. **Background (persistent page)** — `src/background/main.ts` is thin wiring; the logic lives in
   factory modules: extraction service (`extraction.ts`), chat controller, settings manager,
   secure store + credentials, export pipeline.
2. **Content Script (per tab)** — `src/content/main.ts`: DOM extraction (Readability → Markdown),
   element picker, selector generation, selector preview.
3. **Sidebar (per window)** — `src/sidebar/sidebar.ts`: chat UI state machine, active-tab
   tracking, clipboard delivery for exports, sanitized markdown rendering (`markdown.ts`).
4. **Options page** — `src/options/options.ts`. Persists settings **through the background**
   (`settingsChanged` / `apiKeySave` messages), never by writing
   settings to storage directly.

### Messaging System

- **One-shot messages**: typed via `@shared/messages.ts` (closed union on `kind`). Use
  `buildMessage()`, `isMessageOfKind()`, `sendToBackground()`, `sendToTab()`.
- **Long-lived port** (`browser.runtime.connect("chat")`): typed via `@shared/port-protocol.ts`
  (union on `type`) for streaming tokens, and session management.
  The sidebar port also receives one-shot-style `clipboardWrite` envelopes for CF-4.4.

### Key Design Patterns

- **Factory functions with injected deps** (`createX(opts)`) everywhere — this is what makes the
  test suite run without a browser. Entry points (`background/main.ts`, `content/main.ts`,
  `sidebar/sidebar.ts`) are tested via a global `browser` mock + dynamic import (see
  `content/main.test.ts` for the canonical pattern).
- **Result unions over exceptions**: `{ ok: true, … } | { ok: false, reason, detail }`.
- **Readonly interfaces throughout**; path aliases `@shared/*`, `@background/*`, `@content/*`,
  `@sidebar/*`, `@options/*` (tsconfig + vite + vitest configs).

### Behavior notes that are easy to get wrong

- **Site patterns**: user patterns ALWAYS beat builtins; the only builtin list lives in
  `site-patterns/matcher.ts` (`BUILTIN_PATTERNS`) — settings hold user patterns only, and
  legacy builtin entries in stored settings are deliberately ignored (CF-6.2).
- **AI providers** (`@shared/providers`, CF-5.7): `settings.ai.provider` is `"ollama"` (default) or `"openai-compatible"` and — not the URL — decides Ollama-only behavior (`num_ctx` override, prompt budgeting). Both talk to `<baseUrl>/v1/chat/completions`. Settings saved before providers existed are migrated by `backfillDefaults` using `inferProvider(baseUrl)` (loopback / port 11434 → ollama, else openai-compatible, empty → default), so an upgrade never starts sending Ollama-only fields to a hosted API.
- **API keys**: settings hold only `apiKeyRef`; the key is stored via `secure-store.ts` through
  `credentials.ts` (`apiKeySave` message). Empty key = keyless endpoint (Ollama at home); the
  work fork requires the key path to genuinely authenticate (CF-5.3). No Authorization header
  is sent when the key is empty.
- **Removed features**: auto-export (scheduler, per-origin configs, `alarms` permission), personas, skills (upload, library, picker, composite prompt) and the bot avatar are all gone. Storage from older versions is cleaned up at background startup by `removeLegacyStorage` (`legacy-cleanup.ts`: `distill_skill_library`, `distill_active_skill`, `distill_bot_avatar`), and `settings.autoExportConfigs` is ignored and dropped on the next save. The sidebar's no-page chat (about:blank) is the "free-chat" mode (`freeChatReady`).
- **Export sections** (CF-4): the sidebar has three checkboxes — Summary (on), Content (off), Q&A (off), kept in module state across re-renders — sent as `includeSummary` / `includeContent` / `includeQA`. The Export button is disabled when none is checked, and the manager returns `nothing-to-export` rather than writing a frontmatter-only file. Document order is Summary → Q&A → Content.
- **Extraction accuracy** (`content/extractor/`, CF-1): a selector is resolved by `candidates.ts` — each top-level part of a selector list in priority order, and within a part the highest text-density / lowest link-density match (not `querySelector`'s first). `noise.ts` strips ads, nav/aside/footer, cookie banners and hidden elements from a DETACHED clone (never the live page) before Readability and in the raw-innerHTML fallback; it matches whole class/id tokens only and never removes an element holding >60% of the text. `confidence.ts` rates the FINAL markdown (length, link density, real paragraphs) — a matched selector is no longer automatically "high".
- **Retry**: the controller is the single source of truth (< 3 consecutive failures); the
  sidebar keeps no counter, and a retried message appears exactly once in the prompt (CF-3.2/3.3).
- **Context budget** (`background/chat/context-budget.ts`, CF-3.8): prompts are fitted to the configured context window (4 chars/token estimate, 25% reserved for the reply) by dropping the OLDEST conversation turns first — never the system prompt or the new message (a retried message is pinned, not droppable history). Article bodies are fitted first (CF-3.9): shortened — never dropped — by water-filling against the budget minus the pinned prompt text (`contextTruncated`). The budget applies ONLY when `settings.ai.provider === "ollama"`; OpenAI-compatible providers get an infinite budget and are never trimmed.
- **Debug logging** (`shared/logger.ts`, SF-8): factories take an optional `logger` (default `noopLogger`); output is gated by a `getEnabled()` setting and prefixed `[Distill]`. Inject it rather than calling `console` directly.
- **Markdown rendering** (`sidebar/markdown.ts`) is a security boundary: quotes are escaped and
  only http(s) links become anchors (CF-3.5). Never render untrusted text via innerHTML
  without it.

## Testing

Three-tier strategy with vitest (jsdom, globals on):

- `*.test.ts` — unit tests with mocked deps
- `*.prop.test.ts` — property-based tests (fast-check); excluded from the regression filter by
  convention (no CF- tag) to keep it fast
- `*.integration.test.ts` — cross-module flows

All external deps (browser APIs, fetch, crypto) are injected. The suite must pass in full and
`npm run typecheck` must stay clean before any change is considered done.

## Key Dependencies

- `@mozilla/readability` — content extraction (always run on a clone; it mutates the DOM)
- `turndown` + `turndown-plugin-gfm` — HTML → Markdown
- `vite-plugin-web-extension` — builds from `manifest.json`
- `fast-check` — property-based testing

## Reference

- `AUDIT.md` — the 2026-07 audit that drove the current test coverage and defect fixes
- `README.md` — short user-facing docs (install, setup, privacy); architecture notes live here, not in the README
- `scripts/release.mjs` — version bump + build + packaging (`npm run release`); produces the
  unsigned `.xpi` artifacts in `web-ext-artifacts/` (git-ignored)
