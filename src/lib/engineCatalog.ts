import type { EngineDefinition, EngineId } from "../types";

export const ENGINE_CATALOG: Record<EngineId, EngineDefinition> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    tagline: "Flexible prompt-based translation batches",
    description:
      "Calls the OpenAI Responses API directly from the browser. This works, but OpenAI recommends keeping API keys off the client, so users should create a scoped key just for this app.",
    status: "caution",
    browserOnlySupport: "warn",
    statusLabel: "Works with a caution",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "sk-...",
        required: true,
        help: "Use a dedicated project key with a spending limit.",
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        placeholder: "gpt-4.1-mini",
        required: true,
        help: "Any text model that follows the Responses API.",
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url",
        placeholder: "https://api.openai.com/v1",
        help: "Leave blank unless you intentionally use a compatible gateway.",
      },
    ],
    setupSteps: [
      "Create or open an OpenAI project and generate a new API key for that project.",
      "Set a budget or rate limit on the project so the browser key is constrained if it leaks.",
      "Pick a text model and paste both the key and model into the form.",
    ],
    notes: [
      "OpenAI's docs advise against exposing standard API keys in browser code.",
      "This app never stores the key on your server; it only keeps it in browser memory for the current tab.",
    ],
  },
  google: {
    id: "google",
    label: "Google Translate",
    tagline: "Cloud Translation Basic (v2) over REST",
    description:
      "Uses the Google Cloud Translation Basic v2 endpoint with an API key. This is the cleanest fully static option here because the endpoint accepts browser requests and the key can be locked down with referrer restrictions.",
    status: "ready",
    browserOnlySupport: "direct",
    statusLabel: "Ready for browser-only use",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "AIza...",
        required: true,
        help: "Create it in Google Cloud and restrict it to your site origin.",
      },
    ],
    setupSteps: [
      "Create a Google Cloud project and enable Cloud Translation API.",
      "Generate an API key in Google Cloud and add HTTP referrer restrictions for your deployed domain.",
      "Paste the API key here and choose source and target languages.",
    ],
    notes: [
      "Google API keys can be restricted to specific site origins, which makes browser-only deployment much safer.",
      "This app sends only the extracted text batches to Google, never the original EPUB archive itself.",
    ],
  },
  deepl: {
    id: "deepl",
    label: "DeepL",
    tagline: "DeepL through a same-origin Cloudflare proxy route",
    description:
      "DeepL still cannot be called directly from a normal webpage because of CORS. This repo solves that with a Cloudflare Pages Function at /api/deepl, so the user only visits the site and enters a key while the proxy hop happens on Cloudflare's edge.",
    status: "caution",
    browserOnlySupport: "warn",
    statusLabel: "Works through Cloudflare proxy",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "dpl-auth-key",
        required: true,
        help: "This is forwarded to the Cloudflare Pages Function and then to DeepL.",
      },
      {
        key: "serverUrl",
        label: "DeepL server URL",
        type: "url",
        placeholder: "https://api-free.deepl.com",
        help: "Optional. Leave blank for Free, or use https://api.deepl.com for Pro.",
      },
    ],
    setupSteps: [
      "Create a DeepL API plan and copy your authentication key.",
      "Deploy this repo to Cloudflare Pages so the /api/deepl function exists on the same domain as the app.",
      "Paste your DeepL API key into the form when you use the site.",
      "Leave the server URL blank for DeepL Free, or set it to https://api.deepl.com if you use DeepL Pro.",
    ],
    notes: [
      "DeepL's docs explicitly recommend a proxy for browser-based apps because direct browser calls are blocked by CORS.",
      "With Cloudflare Pages, the EPUB still stays in the browser, but the API key and text batches pass through Cloudflare before reaching DeepL.",
    ],
  },
};

export const ENGINE_ORDER: EngineId[] = ["google", "openai", "deepl"];

export const DEFAULT_PROVIDER_CONFIG = {
  openai: {
    apiKey: "",
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
  },
  google: {
    apiKey: "",
  },
  deepl: {
    apiKey: "",
    serverUrl: "",
  },
};
