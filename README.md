# Page Distill

Page Distill is a Firefox extension that summarizes the web page you're reading and lets you ask
follow-up questions about it. It uses an AI model that you choose, such as a local Ollama
model or any OpenAI-compatible service.

## What you can do

- **Summarize a page** in the sidebar: findings, key points and action items.
- **Ask follow-up questions** about the page and get answers as they're written.
- **Combine pages.** Add more tabs to the same chat, then ask for an updated summary.
- **Chat without a page** using "New chat".
- **Export to Markdown.** Choose what goes in the file: the summary (on by default), the
  page content, and your Q&A.
- **Copy** any reply, or a single code block, with one click.
- **Dark mode.** The sidebar follows your system theme.
- **Fix a bad extraction.** If Page Distill grabs the wrong part of a page, pick the right
  element with the element picker and it remembers your choice for that site.

## Install

You need Firefox 109 or newer and [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run build
```

Then, in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Choose `dist/manifest.json`.

Temporary add-ons disappear when Firefox restarts, so you'll need to load it again then.

## Set it up

Open the extension's settings (right-click the toolbar icon, then **Manage Extension**,
then **Options**).

| Setting | What it means |
|---------|---------------|
| **Provider** | **Ollama** (default) for a model running on your computer, or **OpenAI-compatible** for OpenAI, LM Studio and similar services. |
| **Base URL** | Where the AI server lives, e.g. `http://localhost:11434` for Ollama or `https://api.openai.com`. |
| **Model** | The model to use. Use **Test connection** to check your settings, and the model list fills in once the URL is right. |
| **API key** | Only needed for hosted services. Leave it empty for a local Ollama. |
| **Context window** | Ollama only. How much text the model can read at once. Long pages are shortened to fit. |
| **Filename pattern** | How exported files are named. |
| **Site patterns** | Per-site rules for which part of a page to read. |

## Privacy

Page Distill sends the page text you ask about to the AI server you configured, and nowhere
else. With a local Ollama model, nothing leaves your computer. Your API key is stored
separately from your other settings.

## For developers

```bash
npm run dev          # development build
npm test             # full test suite
npm run typecheck    # type check
npm run release -- patch   # bump version, test, build, zip to web-ext-artifacts/
```

Architecture notes, conventions and testing rules are in [CLAUDE.md](CLAUDE.md). What changed in
each release is in [CHANGELOG.md](CHANGELOG.md).

## License

Private. Not published to any registry.
