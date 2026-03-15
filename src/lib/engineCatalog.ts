import type { EngineDefinition, EngineId } from "../types";

export const ENGINE_CATALOG: Record<EngineId, EngineDefinition> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    tagline: "Good quality, but use with care",
    description:
      "This option sends the text straight from your browser to OpenAI. It works well, but OpenAI recommends not exposing standard API keys in websites, so it is best to use a separate key with a spending limit.",
    status: "caution",
    browserOnlySupport: "warn",
    statusLabel: "Available",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "sk-...",
        required: true,
        help: "Use a separate key for this website if possible.",
      },
      {
        key: "model",
        label: "Model name",
        type: "text",
        placeholder: "gpt-4.1-mini",
        required: true,
        help: "If you are unsure, keep the default model name.",
      },
      {
        key: "baseUrl",
        label: "API address",
        type: "url",
        placeholder: "https://api.openai.com/v1",
        help: "Leave this as it is unless you know you need a custom address.",
      },
    ],
    setupSteps: [
      "Create an OpenAI API key in your OpenAI account.",
      "If possible, set a spending limit for safety.",
      "Paste the API key here and keep the suggested model unless you have a reason to change it.",
    ],
    notes: [
      "This website does not store the key on its own server.",
      "The key stays in your browser during this session, but OpenAI still advises care with website-based keys.",
      "OpenAI charges by tokens. This page can show a rough estimate before you start and actual token counts after finished steps when OpenAI returns them.",
    ],
  },
  google: {
    id: "google",
    label: "Google Translate",
    tagline: "Simple browser-based option",
    description:
      "This option sends the text straight from your browser to Google Cloud Translation. It is one of the easiest options for a website because Google lets you limit the key to your own domain.",
    status: "ready",
    browserOnlySupport: "direct",
    statusLabel: "Available",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "AIza...",
        required: true,
        help: "Create it in Google Cloud. You can limit it to your website address.",
      },
    ],
    setupSteps: [
      "Create a Google Cloud project.",
      "Turn on the Cloud Translation API.",
      "Create an API key and, if you want, limit it to your website address.",
      "Paste the key here.",
    ],
    notes: [
      "Only the text being translated is sent to Google, not the full EPUB file.",
      "If you plan to publish this website, domain restrictions on the key are strongly recommended.",
      "Google bills by characters, so this page can estimate the size of the job before you start.",
    ],
  },
  deepl: {
    id: "deepl",
    label: "DeepL",
    tagline: "Best for DeepL users",
    description:
      "DeepL does not allow normal direct website requests, so this site sends DeepL requests through its own Cloudflare connection first and then on to DeepL. From the user's point of view, you just paste the key and use the site normally.",
    status: "caution",
    browserOnlySupport: "warn",
    statusLabel: "Available",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "dpl-auth-key",
        required: true,
        help: "This key is sent through this website's DeepL connection and then to DeepL.",
      },
      {
        key: "serverUrl",
        label: "DeepL account type",
        type: "url",
        placeholder: "https://api-free.deepl.com",
        help: "Leave blank for DeepL Free. Use https://api.deepl.com only if you have DeepL Pro.",
      },
    ],
    setupSteps: [
      "Create a DeepL API key in your DeepL account.",
      "Paste the key here.",
      "If you use the normal DeepL Free API, leave the second field empty.",
      "If you use DeepL Pro, enter https://api.deepl.com in the second field.",
    ],
    notes: [
      "Your EPUB file still stays on your device while you read and prepare it.",
      "For DeepL only, the key and the text to translate pass through this website's Cloudflare connection before they reach DeepL.",
      "DeepL bills by characters, so this page can give a close estimate before you start and show billed characters during translation.",
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
