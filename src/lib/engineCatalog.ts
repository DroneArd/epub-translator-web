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
    tagline: "Official API blocks browser-origin calls",
    description:
      "DeepL's official docs state that browser requests are blocked by CORS. That means a truly static host cannot call DeepL directly without adding a proxy or backend, which this repo intentionally avoids.",
    status: "blocked",
    browserOnlySupport: "blocked",
    statusLabel: "Blocked in browser-only mode",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "dpl-auth-key",
        required: true,
        help: "Shown for completeness, but the official browser restriction still applies.",
      },
      {
        key: "endpoint",
        label: "API endpoint",
        type: "url",
        placeholder: "https://api-free.deepl.com/v2/translate",
        help: "Use the Free or Pro endpoint that matches your account.",
      },
    ],
    setupSteps: [
      "Create a DeepL API plan and copy your authentication key.",
      "Choose the matching Free or Pro endpoint.",
      "Use a backend proxy if you truly need DeepL, because the browser-only build cannot reach DeepL directly.",
    ],
    notes: [
      "The static build keeps the option visible so the limitation is explicit instead of hidden.",
      "If you need DeepL, the clean fix is a tiny proxy service that only forwards translation calls.",
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
    endpoint: "https://api-free.deepl.com/v2/translate",
  },
};
