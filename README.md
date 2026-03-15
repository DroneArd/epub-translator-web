# EPUB Translator Web

Static EPUB translation with a live reader preview, concurrent translation batches, and `.epub` export.

This project is based on the original workspace `main.py`, but rebuilt as a browser-first TypeScript app. The EPUB is parsed and rewritten locally in the tab. Google and OpenAI are called directly from the browser. DeepL is routed through a same-origin Cloudflare Pages Function because DeepL blocks direct browser-origin requests with CORS.

## What the app does

- Loads an `.epub` file locally in the browser.
- Parses `META-INF/container.xml`, the OPF package, and the spine to open a preview immediately.
- Lets the user choose a translation engine and enter the required key/config fields.
- Estimates token or character usage before translation starts and shows actual usage while batches finish.
- Translates in asynchronous batches with configurable concurrency.
- Supports two export modes:
  - translated text only
  - original and translated text side by side in columns
- Shows a dry-run preview before translation completes:
  - single-column mode looks like the original book
  - parallel mode shows the original text in both columns until translated batches arrive
- Exports a modified `.epub` without uploading the source archive to your own server.

## Architecture

- EPUB parsing, preview, batching, and export stay in the browser.
- Google and OpenAI requests go directly from the browser to the provider.
- DeepL requests go from the browser to `/api/deepl` on Cloudflare Pages, then from Cloudflare to DeepL.

That means the DeepL API key and translated text batches pass through Cloudflare's edge function. The original `.epub` archive does not.

## Cloudflare deployment

This repository is set up for Cloudflare Pages already:

- Static frontend output: `dist`
- DeepL proxy route: [`functions/api/deepl.ts`](/Users/richard/Projekte/ePubTranslator/epub-translate-main/epub-translator-web/functions/api/deepl.ts)
- Wrangler config: [`wrangler.jsonc`](/Users/richard/Projekte/ePubTranslator/epub-translate-main/epub-translator-web/wrangler.jsonc)

### Option 1: Deploy with Git integration

This is the easiest path and the one I recommend.

1. Push this repository to GitHub or GitLab.
2. In the Cloudflare dashboard, go to `Workers & Pages`.
3. Select `Create application`.
4. Select the `Pages` tab.
5. Select `Import an existing Git repository`.
6. Choose this repository and begin setup.
7. In build settings, use:
   - Framework preset: `React (Vite)` or `None`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: leave blank unless you move this project into a monorepo
8. Deploy.

After the first deployment, your app will be live at `https://<your-project>.pages.dev`.

### Option 2: Deploy with Wrangler CLI

If you prefer direct CLI deploys:

```bash
npm install
npm run build
npx wrangler@latest pages deploy
```

Because this project includes a `functions/` directory, do not rely on drag-and-drop dashboard uploads of just `dist/`. Cloudflare's Pages docs say dashboard drag-and-drop does not compile a `functions` folder; use Git integration or Wrangler instead.

## Exact DeepL setup

After the site is deployed on Cloudflare Pages, DeepL works like this:

1. The user visits the website.
2. The user chooses `DeepL`.
3. The user pastes their DeepL API key into the form.
4. The browser sends text batches to `/api/deepl` on the same site.
5. The Cloudflare Pages Function forwards the request to DeepL and returns the translated batch.

Nothing needs to run locally on the user's machine.

### DeepL Free vs Pro

- DeepL Free default endpoint: `https://api-free.deepl.com`
- DeepL Pro endpoint: `https://api.deepl.com`

The UI exposes a `DeepL server URL` field for this. Leave it blank for Free. Set it to `https://api.deepl.com` for Pro.

### Optional site-owned DeepL key

If you want the site to use one shared DeepL key instead of asking each user for theirs:

1. Open your Pages project in Cloudflare.
2. Go to `Settings > Variables and Secrets`.
3. Add a secret named `DEEPL_AUTH_KEY`.
4. Redeploy.

You can also set `DEEPL_SERVER_URL` there if you want the site to default to Pro instead of Free.

If `DEEPL_AUTH_KEY` is not configured, the function expects the user to paste a key into the website.

## Verify the deployment

After deployment, open:

```text
https://<your-project>.pages.dev/api/deepl
```

You should see JSON similar to:

```json
{
  "ok": true,
  "provider": "deepl",
  "route": "/api/deepl",
  "siteKeyConfigured": false,
  "defaultServerUrl": "https://api-free.deepl.com"
}
```

If that works, the DeepL proxy route is live.

## Local development

Frontend only:

```bash
npm install
npm run dev
```

Cloudflare Pages local dev, including the DeepL function:

```bash
npm install
npm run cf:dev
```

If you want to test with a local site-owned DeepL key, create `.dev.vars` from [`.dev.vars.example`](/Users/richard/Projekte/ePubTranslator/epub-translate-main/epub-translator-web/.dev.vars.example):

```bash
cp .dev.vars.example .dev.vars
```

Then fill in:

```dotenv
DEEPL_AUTH_KEY=your-key
DEEPL_SERVER_URL=https://api-free.deepl.com
```

Do not commit `.dev.vars`.

## Build

```bash
npm run build
```

The generated `dist/` directory is the static frontend bundle. On Cloudflare Pages, the `functions/` directory is deployed alongside it.

## Files added for Cloudflare

- [`functions/api/deepl.ts`](/Users/richard/Projekte/ePubTranslator/epub-translate-main/epub-translator-web/functions/api/deepl.ts): same-origin DeepL proxy for Pages Functions
- [`wrangler.jsonc`](/Users/richard/Projekte/ePubTranslator/epub-translate-main/epub-translator-web/wrangler.jsonc): local/dev/deploy config for Pages
- [`.dev.vars.example`](/Users/richard/Projekte/ePubTranslator/epub-translate-main/epub-translator-web/.dev.vars.example): optional local secrets for `wrangler pages dev`

## Limits and caveats

- The preview is intentionally text-first and does not aim to reproduce every original EPUB stylesheet perfectly.
- The export pipeline rewrites translatable XHTML/XML content but keeps the rest of the archive unchanged.
- Parallel mode is applied to spine content documents. Navigation files stay single-column so the EPUB remains usable.
- OpenAI usage in a client-side flow is a user-controlled compromise, not a best-practice recommendation.
- DeepL is no longer a pure browser-to-DeepL flow. It now depends on a Cloudflare Pages Function because DeepL's official API blocks direct browser CORS requests.
