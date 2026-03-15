interface Env {
  DEEPL_AUTH_KEY?: string;
  DEEPL_SERVER_URL?: string;
}

interface Context {
  request: Request;
  env: Env;
}

const DEFAULT_SERVER_URL = "https://api-free.deepl.com";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeServerUrl(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : DEFAULT_SERVER_URL;
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  if (
    payload &&
    typeof payload === "object" &&
    "detail" in payload &&
    typeof payload.detail === "string"
  ) {
    return payload.detail;
  }

  return fallback;
}

export const onRequestGet = async ({ env }: Context) => {
  return json({
    ok: true,
    provider: "deepl",
    route: "/api/deepl",
    siteKeyConfigured: Boolean(env.DEEPL_AUTH_KEY),
    defaultServerUrl: normalizeServerUrl(env.DEEPL_SERVER_URL),
  });
};

export const onRequestPost = async ({ request, env }: Context) => {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const body = payload && typeof payload === "object" ? payload : {};
  const texts =
    "texts" in body && Array.isArray(body.texts)
      ? body.texts.filter((value): value is string => typeof value === "string")
      : [];
  const targetLanguage =
    "targetLanguage" in body && typeof body.targetLanguage === "string"
      ? body.targetLanguage.trim()
      : "";
  const sourceLanguage =
    "sourceLanguage" in body && typeof body.sourceLanguage === "string"
      ? body.sourceLanguage.trim()
      : "";
  const apiKey =
    ("apiKey" in body && typeof body.apiKey === "string" ? body.apiKey.trim() : "") ||
    env.DEEPL_AUTH_KEY?.trim() ||
    "";
  const serverUrl = normalizeServerUrl(
    ("serverUrl" in body && typeof body.serverUrl === "string"
      ? body.serverUrl
      : undefined) || env.DEEPL_SERVER_URL,
  );

  if (!texts.length) {
    return json({ error: "At least one text fragment is required." }, 400);
  }

  if (!targetLanguage) {
    return json({ error: "targetLanguage is required." }, 400);
  }

  if (!apiKey) {
    return json(
      {
        error:
          "No DeepL auth key was provided. Paste one into the site, or configure DEEPL_AUTH_KEY in Cloudflare for a private deployment.",
      },
      400,
    );
  }

  let deeplResponse: Response;

  try {
    deeplResponse = await fetch(`${serverUrl}/v2/translate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DeepL-Auth-Key ${apiKey}`,
      },
      body: JSON.stringify({
        text: texts,
        target_lang: targetLanguage,
        ...(sourceLanguage ? { source_lang: sourceLanguage } : {}),
        split_sentences: "nonewlines",
        preserve_formatting: true,
      }),
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? `Cloudflare could not reach DeepL: ${error.message}`
            : "Cloudflare could not reach DeepL.",
      },
      502,
    );
  }

  const deeplPayload = (await deeplResponse.json().catch(() => null)) as unknown;

  if (!deeplResponse.ok) {
    return json(
      {
        error: extractErrorMessage(
          deeplPayload,
          `DeepL returned HTTP ${deeplResponse.status}.`,
        ),
      },
      deeplResponse.status,
    );
  }

  if (
    !deeplPayload ||
    typeof deeplPayload !== "object" ||
    !("translations" in deeplPayload) ||
    !Array.isArray(deeplPayload.translations)
  ) {
    return json({ error: "DeepL returned an unexpected response shape." }, 502);
  }

  const translations = [];

  for (const entry of deeplPayload.translations) {
    if (!entry || typeof entry !== "object" || !("text" in entry) || typeof entry.text !== "string") {
      return json({ error: "DeepL returned an invalid translation entry." }, 502);
    }

    translations.push({
      text: entry.text,
      detectedSourceLanguage:
        "detected_source_language" in entry &&
        typeof entry.detected_source_language === "string"
          ? entry.detected_source_language
          : null,
      billedCharacters:
        "billed_characters" in entry && typeof entry.billed_characters === "number"
          ? entry.billed_characters
          : null,
    });
  }

  return json({ translations });
};
