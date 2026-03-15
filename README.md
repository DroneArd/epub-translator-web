# EPUB Translator Web

Static, browser-only EPUB translation with a live reader preview, concurrent translation batches, and `.epub` export.

This repository is derived from the translation flow in the original workspace `main.py`: unzip the EPUB, walk the XHTML/XML documents, translate only text nodes, and write a new EPUB. The difference is that this version runs entirely in the browser.

## What it does

- Loads an `.epub` file locally in the browser.
- Parses `META-INF/container.xml`, the OPF package, and the spine to open a text-first preview immediately.
- Lets the reader choose an engine and enter the needed API key/config fields at runtime.
- Translates in asynchronous batches with configurable concurrency.
- Supports two output modes:
  - translated text only
  - original and translated text side by side in two columns
- Shows dry-run preview behavior before translation:
  - single-column mode looks like the original text
  - parallel mode shows the original text in both columns until translated batches arrive
- Exports a modified `.epub` without sending the source archive to your hosting server.

## Why some engines differ

This repo is intentionally honest about provider constraints in a browser-only architecture.

- Google Cloud Translation Basic v2 is the best fit for a static site because it can be called with an API key, and Google documents browser-oriented API key restrictions like HTTP referrer limits:
  [Cloud Translation Basic](https://cloud.google.com/translate/docs/basic/translating-text) · [API key restrictions](https://cloud.google.com/api-keys/docs/add-restrictions-api-keys)
- OpenAI can be called directly from the browser, but OpenAI's own security guidance says standard API keys should not be exposed in client-side code. This repo still supports it because the user explicitly enters the key at runtime, but the UI warns about the tradeoff:
  [OpenAI authentication](https://platform.openai.com/docs/api-reference/authentication) · [OpenAI key safety best practices](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)
- DeepL's official documentation states that browser-origin requests are blocked by CORS, so a truly static host cannot call DeepL directly without adding a proxy/backend:
  [DeepL browser guidance](https://developers.deepl.com/docs/getting-started/browser)

## Privacy model

- The EPUB file is parsed in browser memory.
- The static host does not receive the uploaded book or the runtime API key.
- Only extracted text fragments are sent to the selected translation engine.
- No server component is included in this repository.

## Stack

- React + TypeScript
- Vite
- JSZip

## Local development

```bash
npm install
npm run dev
```

Build for static hosting:

```bash
npm run build
```

The generated `dist/` folder can be deployed to GitHub Pages, Netlify, Cloudflare Pages, or any other static host.

## Notes and limitations

- The preview is intentionally text-first and does not aim to perfectly reproduce every original EPUB stylesheet.
- The export pipeline rewrites translatable XHTML/XML content but keeps the rest of the archive local and unchanged.
- Parallel mode is applied to spine content documents. Navigation files stay single-column so the EPUB remains usable.
- OpenAI usage in a client-only app is a user-controlled compromise, not a best-practice recommendation.
