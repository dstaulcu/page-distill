# Changelog

All notable changes to Page Distill are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Add entries under **Unreleased** as you work. `npm run release` moves them under the new
version heading and publishes them in the release notes.

## [Unreleased]

### Added
- Copy button on every reply and on each code block.
- Dark mode: the sidebar follows the system light/dark setting.
- First-run setup card ("Set up your AI provider") when no model is configured.
- Pre-summary preview: an excerpt of the extracted page and a "Not the right content? Pick the area" link.
- Truncation notice says how much of the page was read (for example "about 35%").
- Export status line says which file was saved, or that it was copied.
- Favicons on the context-tab chips.
- Esc cancels a running reply or closes a menu; the cursor returns to the message box after a reply; screen readers are told when a reply starts, finishes or fails; a "Latest" button appears if you scroll up while a reply streams.
- Portal and front pages (news homepages) now produce a list of headlines with links instead of a single story card.
- Debug logging reports which export sections were requested and found.
- This changelog. Every GitHub release now includes its entries and links back to it.

### Changed
- The product is now named **Page Distill**. Names live in one file, `public/_locales/en/messages.json`.
- Header buttons are icons: Re-read page (↻) and Help (?).
- The exported Summary is the most recent summary, so "Update summary" no longer exports a stale one. A chat with no summary exports its first answer as Q&A.
- Content extraction removes promo modules ("Popular Reads", "Related stories", "Sponsored Content") and standalone "Advertisement" labels, and is much faster on large pages.

### Fixed
- Exporting Summary or Q&A no longer fails with "Nothing to export" after the background page was unloaded: the sidebar now sends the conversation it is showing.
- Underlined headings (`Title` over `=====`, `Section` over `-----`) render as headings instead of rules and stray `=` lines.
- Stray `## Popular Reads` headings in exported content.
- A selector you saved or picked is never replaced by the automatic headline list.

### Removed
- `.vscode/` settings, `AUDIT.md`, the GitHub Actions workflows, and a few unused code paths and styles.

## [4.1.1] - 2026-11-25

### Added
- Better page extraction: the best matching article is chosen instead of the first match, ads, navigation and cookie banners are filtered out, and confidence reflects content quality (length, link density, real paragraphs).
- Long tracking links are shortened in what is sent to the model, so more real content fits in the context window.
- Richer reply formatting: all heading levels, numbered lists, tables, quotes and horizontal rules; code and `snake_case` words are no longer mangled.
- "Update summary" button after adding tabs to a chat.

### Changed
- The README was rewritten for users; developer notes moved to `CLAUDE.md`.
- Removed the duplicate title at the top of the sidebar.

### Fixed
- The selector preview in settings now shows the element extraction would actually use.
- Inline code inside a link label, and a `|` line followed by a rule, no longer render wrongly.
- Export shows "Nothing to export" with a reason instead of a bare failure.
- The saved-key placeholder in settings survives a provider change.

## [4.1.0] - 2026-11-25

### Added
- **AI provider** setting: Ollama (default) or OpenAI-compatible. Settings saved by older versions are migrated automatically.
- Export has three checkboxes: Summary (on by default), Content and Q&A.
- Prompts are fitted to the model's context window for Ollama (oldest chat turns dropped first, long pages shortened rather than dropped).

### Removed
- Skills (upload, library, picker), personas, auto-export and the bot avatar. Leftover data is cleaned up at startup.
- The `alarms` permission, `REQUIREMENTS.md` and the `.kiro` steering files; the tests are the specification now.

## [4.0.x] - 2026-07

Initial releases of the Firefox extension: summarize the current page in the sidebar, follow-up
chat with streaming replies, Markdown export, site patterns and an element picker for fixing
extraction, and encrypted API-key storage. Includes a Settings link in the Help menu and a fix
for the picker recovery hint after a cached session. Builds 4.0.1 to 4.0.3 were local packaging
runs, so no separate version bumps were committed.

[Unreleased]: https://github.com/dstaulcu/page-distill/compare/v4.1.1...HEAD
[4.1.1]: https://github.com/dstaulcu/page-distill/releases/tag/v4.1.1
