import { ENGINE_CATALOG } from "./engineCatalog";
import type {
  EngineId,
  ProviderBatchResult,
  ProviderBatchUsage,
  ProviderRequest,
} from "../types";

function decodeHtmlEntities(value: string) {
  const doc = new DOMParser().parseFromString(value, "text/html");
  return doc.documentElement.textContent ?? value;
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  return fallback;
}

function countCodePoints(value: string) {
  return Array.from(value).length;
}

function countSourceCharacters(texts: string[]) {
  return texts.reduce((total, text) => total + countCodePoints(text), 0);
}

function createBatchUsage(
  sourceCharacters: number,
  overrides: Partial<Omit<ProviderBatchUsage, "sourceCharacters">> = {},
): ProviderBatchUsage {
  return {
    sourceCharacters,
    billedCharacters: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    ...overrides,
  };
}

function extractOpenAiText(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenAI returned an empty response body.");
  }

  const directOutput =
    "output_text" in payload && typeof payload.output_text === "string"
      ? payload.output_text
      : "";

  if (directOutput) {
    return directOutput;
  }

  const candidates: string[] = [];

  if ("output" in payload && Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!item || typeof item !== "object" || !("content" in item)) {
        continue;
      }

      const { content } = item;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }

        if ("text" in part && typeof part.text === "string") {
          candidates.push(part.text);
        }
      }
    }
  }

  const longest = candidates.sort((left, right) => right.length - left.length)[0];
  if (!longest) {
    throw new Error("OpenAI returned a response, but no text output was found.");
  }

  return longest;
}

function extractOpenAiUsage(payload: unknown, sourceCharacters: number) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("usage" in payload) ||
    !payload.usage ||
    typeof payload.usage !== "object"
  ) {
    return createBatchUsage(sourceCharacters);
  }

  const usage = payload.usage;
  const inputTokens =
    "input_tokens" in usage && typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : null;
  const outputTokens =
    "output_tokens" in usage && typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : null;
  const totalTokens =
    "total_tokens" in usage && typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : inputTokens !== null || outputTokens !== null
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : null;

  return createBatchUsage(sourceCharacters, {
    inputTokens,
    outputTokens,
    totalTokens,
  });
}

async function translateWithOpenAi({
  texts,
  sourceLanguage,
  targetLanguage,
  config,
  signal,
}: ProviderRequest): Promise<ProviderBatchResult> {
  const apiKey = config.apiKey?.trim();
  const model = config.model?.trim();
  const baseUrl = config.baseUrl?.trim() || "https://api.openai.com/v1";
  const sourceCharacters = countSourceCharacters(texts);

  if (!apiKey || !model) {
    throw new Error("OpenAI requires both an API key and a model.");
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You translate EPUB text fragments.",
                "Return JSON only.",
                "Keep the array length and order exactly the same.",
                "Do not add commentary, numbering, or explanations.",
                "Preserve whitespace and punctuation when reasonable.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                sourceLanguage: sourceLanguage || "auto",
                targetLanguage,
                texts,
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "translation_batch",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              translations: {
                type: "array",
                minItems: texts.length,
                maxItems: texts.length,
                items: {
                  type: "string",
                },
              },
            },
            required: ["translations"],
          },
        },
      },
    }),
  });

  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(
      extractErrorMessage(
        payload,
        `OpenAI request failed with HTTP ${response.status}.`,
      ),
    );
  }

  const rawText = extractOpenAiText(payload);
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `OpenAI returned non-JSON output: ${error.message}`
        : "OpenAI returned non-JSON output.",
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("translations" in parsed) ||
    !Array.isArray(parsed.translations) ||
    parsed.translations.some((item) => typeof item !== "string")
  ) {
    throw new Error("OpenAI returned a JSON object without a valid translations array.");
  }

  if (parsed.translations.length !== texts.length) {
    throw new Error(
      `OpenAI returned ${parsed.translations.length} translations for ${texts.length} inputs.`,
    );
  }

  return {
    translations: parsed.translations,
    usage: extractOpenAiUsage(payload, sourceCharacters),
  };
}

async function translateWithGoogle({
  texts,
  sourceLanguage,
  targetLanguage,
  config,
  signal,
}: ProviderRequest): Promise<ProviderBatchResult> {
  const apiKey = config.apiKey?.trim();
  const sourceCharacters = countSourceCharacters(texts);

  if (!apiKey) {
    throw new Error("Google Translate requires an API key.");
  }

  const response = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(
      apiKey,
    )}`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: texts,
        target: targetLanguage,
        ...(sourceLanguage ? { source: sourceLanguage } : {}),
        format: "text",
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(
      extractErrorMessage(
        payload,
        `Google request failed with HTTP ${response.status}.`,
      ),
    );
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !payload.data ||
    typeof payload.data !== "object" ||
    !("translations" in payload.data) ||
    !Array.isArray(payload.data.translations)
  ) {
    throw new Error("Google returned an unexpected response shape.");
  }

  const translations = payload.data.translations.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("translatedText" in entry) ||
      typeof entry.translatedText !== "string"
    ) {
      throw new Error("Google returned an invalid translation entry.");
    }

    return decodeHtmlEntities(entry.translatedText);
  });

  if (translations.length !== texts.length) {
    throw new Error(
      `Google returned ${translations.length} translations for ${texts.length} inputs.`,
    );
  }

  return {
    translations,
    usage: createBatchUsage(sourceCharacters, {
      billedCharacters: sourceCharacters,
    }),
  };
}

async function translateWithDeepLBridge({
  texts,
  sourceLanguage,
  targetLanguage,
  config,
  signal,
}: ProviderRequest): Promise<ProviderBatchResult> {
  const proxyUrl = config.proxyUrl?.trim() || "/api/deepl";
  const sourceCharacters = countSourceCharacters(texts);

  let response: Response;

  try {
    response = await fetch(proxyUrl, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        texts,
        sourceLanguage: sourceLanguage || null,
        targetLanguage,
        apiKey: config.apiKey?.trim() || undefined,
        serverUrl: config.serverUrl?.trim() || undefined,
      }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    throw new Error(
      `Could not reach the DeepL proxy route at ${proxyUrl}. Deploy the site on Cloudflare Pages so /api/deepl is available, or point proxyUrl at a compatible endpoint.`,
    );
  }

  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(
      extractErrorMessage(
        payload,
        `DeepL proxy request failed with HTTP ${response.status}.`,
      ),
    );
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("translations" in payload) ||
    !Array.isArray(payload.translations)
  ) {
    throw new Error("DeepL proxy returned an unexpected response shape.");
  }

  const translations = payload.translations.map((entry) => {
    if (!entry || typeof entry !== "object" || !("text" in entry) || typeof entry.text !== "string") {
      throw new Error("DeepL proxy returned an invalid translation entry.");
    }

    return entry.text;
  });

  if (translations.length !== texts.length) {
    throw new Error(
      `DeepL proxy returned ${translations.length} translations for ${texts.length} inputs.`,
    );
  }

  const billedCharacters =
    "usage" in payload &&
    payload.usage &&
    typeof payload.usage === "object" &&
    "billedCharacters" in payload.usage &&
    typeof payload.usage.billedCharacters === "number"
      ? payload.usage.billedCharacters
      : sourceCharacters;

  return {
    translations,
    usage: createBatchUsage(sourceCharacters, {
      billedCharacters,
    }),
  };
}

export function getEngineSupportMessage(engine: EngineId) {
  return ENGINE_CATALOG[engine].description;
}

export function isEngineRunnable(engine: EngineId) {
  return ENGINE_CATALOG[engine].browserOnlySupport !== "blocked";
}

export async function translateBatch(
  engine: EngineId,
  request: ProviderRequest,
): Promise<ProviderBatchResult> {
  switch (engine) {
    case "openai":
      return translateWithOpenAi(request);
    case "google":
      return translateWithGoogle(request);
    case "deepl":
      return translateWithDeepLBridge(request);
    default:
      throw new Error(`Unsupported engine: ${String(engine)}`);
  }
}
