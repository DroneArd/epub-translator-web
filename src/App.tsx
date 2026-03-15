import { startTransition, useEffect, useRef, useState } from "react";
import {
  buildDownloadBlob,
  buildPreviewDocument,
  createDownloadName,
  loadEpub,
} from "./lib/epub";
import {
  DEFAULT_PROVIDER_CONFIG,
  ENGINE_CATALOG,
  ENGINE_ORDER,
} from "./lib/engineCatalog";
import { isEngineRunnable, translateBatch } from "./lib/providers";
import type {
  EngineId,
  EpubBook,
  ProviderConfigRecord,
  TranslationIssue,
  TranslationProgress,
  TranslationSettings,
  TranslationUsageTotals,
} from "./types";

const INITIAL_PROGRESS: TranslationProgress = {
  status: "idle",
  totalSegments: 0,
  translatedSegments: 0,
  totalBatches: 0,
  completedBatches: 0,
  activeBatches: 0,
};

const INITIAL_SETTINGS: TranslationSettings = {
  sourceLanguage: "",
  targetLanguage: "en",
  outputMode: "translated",
  batchSize: 18,
  concurrency: 4,
};

const INITIAL_USAGE_TOTALS: TranslationUsageTotals = {
  engine: null,
  sourceCharacters: 0,
  billedCharacters: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  successfulBatches: 0,
};

type PricingConfigRecord = {
  openai: {
    inputPerMillionTokens: string;
    outputPerMillionTokens: string;
  };
  google: {
    perMillionCharacters: string;
  };
  deepl: {
    perMillionCharacters: string;
  };
};

const INITIAL_PRICING: PricingConfigRecord = {
  openai: {
    inputPerMillionTokens: "",
    outputPerMillionTokens: "",
  },
  google: {
    perMillionCharacters: "",
  },
  deepl: {
    perMillionCharacters: "",
  },
};

function cloneDefaultPricing(): PricingConfigRecord {
  return JSON.parse(JSON.stringify(INITIAL_PRICING)) as PricingConfigRecord;
}

function cloneDefaultConfig(): ProviderConfigRecord {
  return JSON.parse(JSON.stringify(DEFAULT_PROVIDER_CONFIG)) as ProviderConfigRecord;
}

function sumSegments(book: EpubBook | null) {
  if (!book) {
    return 0;
  }

  return Object.values(book.documents).reduce(
    (total, documentRecord) => total + documentRecord.segmentCount,
    0,
  );
}

function countCodePoints(value: string) {
  return Array.from(value).length;
}

function countBookCharacters(book: EpubBook) {
  return Object.values(book.documents).reduce(
    (total, documentRecord) =>
      total +
      documentRecord.sourceTexts.reduce(
        (segmentTotal, text) => segmentTotal + countCodePoints(text),
        0,
      ),
    0,
  );
}

function buildBaselineTranslations(book: EpubBook) {
  const baseline: Record<string, string[]> = {};

  for (const documentRecord of Object.values(book.documents)) {
    baseline[documentRecord.path] = [...documentRecord.sourceTexts];
  }

  return baseline;
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function estimateOpenAiTokens(sourceCharacters: number) {
  if (!sourceCharacters) {
    return 0;
  }

  return Math.ceil(sourceCharacters / 4);
}

function parseRate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function calculateCharacterCost(rate: string, characters: number) {
  const parsedRate = parseRate(rate);
  if (parsedRate === null) {
    return null;
  }

  return (characters / 1_000_000) * parsedRate;
}

function calculateOpenAiCost(
  pricing: PricingConfigRecord["openai"],
  inputTokens: number,
  outputTokens: number,
) {
  const inputRate = parseRate(pricing.inputPerMillionTokens);
  const outputRate = parseRate(pricing.outputPerMillionTokens);

  if (inputRate === null || outputRate === null) {
    return null;
  }

  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatMoney(value: number) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 6 : 2,
  }).format(value);
}

function createIssue(
  engine: EngineId,
  scope: string,
  message: string,
  recoverable = true,
  batchIndex?: number,
  segmentStart?: number,
) {
  return {
    id: crypto.randomUUID(),
    engine,
    scope,
    message,
    recoverable,
    batchIndex,
    segmentStart,
  } satisfies TranslationIssue;
}

function App() {
  const [book, setBook] = useState<EpubBook | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<EngineId>("google");
  const [providerConfig, setProviderConfig] = useState<ProviderConfigRecord>(
    cloneDefaultConfig,
  );
  const [pricingConfig, setPricingConfig] = useState<PricingConfigRecord>(
    cloneDefaultPricing,
  );
  const [settings, setSettings] = useState<TranslationSettings>(INITIAL_SETTINGS);
  const [translatedByPath, setTranslatedByPath] = useState<Record<string, string[]>>({});
  const [issues, setIssues] = useState<TranslationIssue[]>([]);
  const [progress, setProgress] = useState<TranslationProgress>(INITIAL_PROGRESS);
  const [usageTotals, setUsageTotals] = useState<TranslationUsageTotals>(
    INITIAL_USAGE_TOTALS,
  );
  const [sourceCharacterCount, setSourceCharacterCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState(
    "Choose an EPUB file to get started.",
  );
  const [previewPath, setPreviewPath] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [downloadBusy, setDownloadBusy] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const currentDocument = book && previewPath ? book.documents[previewPath] : undefined;
  const currentSectionIndex = book
    ? book.sections.findIndex((section) => section.path === previewPath)
    : -1;
  const totalSegments = sumSegments(book);
  const progressPercent = progress.totalBatches
    ? Math.round((progress.completedBatches / progress.totalBatches) * 100)
    : 0;
  const selectedPricing = pricingConfig[selectedEngine];
  const selectedUsageTotals =
    usageTotals.engine === selectedEngine ? usageTotals : null;
  const estimatedInputTokens =
    selectedEngine === "openai" ? estimateOpenAiTokens(sourceCharacterCount) : 0;
  const estimatedOutputTokens = selectedEngine === "openai" ? estimatedInputTokens : 0;
  const estimatedBilledCharacters =
    selectedEngine === "openai" ? 0 : sourceCharacterCount;
  const estimatedCost =
    selectedEngine === "openai"
      ? calculateOpenAiCost(
          pricingConfig.openai,
          estimatedInputTokens,
          estimatedOutputTokens,
        )
      : calculateCharacterCost(
          pricingConfig[selectedEngine].perMillionCharacters,
          estimatedBilledCharacters,
        );
  const actualCost =
    !selectedUsageTotals
      ? null
      : selectedEngine === "openai"
        ? calculateOpenAiCost(
            pricingConfig.openai,
            selectedUsageTotals.inputTokens,
            selectedUsageTotals.outputTokens,
          )
        : calculateCharacterCost(
            pricingConfig[selectedEngine].perMillionCharacters,
            selectedUsageTotals.billedCharacters,
          );

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!book) {
      setPreviewHtml("");
      return;
    }

    const resolvedPreviewPath =
      previewPath && book.documents[previewPath]
        ? previewPath
        : book.sections[0]?.path ?? Object.keys(book.documents)[0] ?? "";

    if (!resolvedPreviewPath) {
      setPreviewHtml("");
      return;
    }

    if (resolvedPreviewPath !== previewPath) {
      startTransition(() => {
        setPreviewPath(resolvedPreviewPath);
      });
      return;
    }

    const documentRecord = book.documents[resolvedPreviewPath];
    setPreviewHtml(
      buildPreviewDocument(
        documentRecord,
        translatedByPath[documentRecord.path],
        settings.outputMode,
      ),
    );
  }, [book, previewPath, settings.outputMode, translatedByPath]);

  async function handleFileSelection(file: File) {
    abortControllerRef.current?.abort();
    setProgress({
      ...INITIAL_PROGRESS,
      status: "loading",
    });
    setUsageTotals(INITIAL_USAGE_TOTALS);
    setSourceCharacterCount(0);
    setStatusMessage("Opening your book on this device...");
    setIssues([]);
    setBook(null);
    setPreviewPath("");
    setPreviewHtml("");

    try {
      const loadedBook = await loadEpub(file);
      const baselineTranslations = buildBaselineTranslations(loadedBook);
      const segmentCount = sumSegments(loadedBook);
      const characterCount = countBookCharacters(loadedBook);
      setBook(loadedBook);
      setTranslatedByPath(baselineTranslations);
      setSourceCharacterCount(characterCount);
      setProgress({
        ...INITIAL_PROGRESS,
        status: "ready",
        totalSegments: segmentCount,
      });
      setStatusMessage(
        `Your book is ready. We found ${loadedBook.sections.length} readable sections and ${segmentCount} pieces of text that can be translated.`,
      );

      startTransition(() => {
        setPreviewPath(loadedBook.sections[0]?.path ?? Object.keys(loadedBook.documents)[0] ?? "");
      });
    } catch (error) {
      setProgress({
        ...INITIAL_PROGRESS,
        status: "error",
      });
      setStatusMessage("We could not open this EPUB file.");
      setIssues([
        createIssue(
          selectedEngine,
          "EPUB import",
          formatErrorMessage(error),
          false,
        ),
      ]);
    }
  }

  function updateProviderConfig(engine: EngineId, field: string, value: string) {
    setProviderConfig((current) => ({
      ...current,
      [engine]: {
        ...current[engine],
        [field]: value,
      },
    }));
  }

  function updatePricingConfig(
    engine: EngineId,
    field: string,
    value: string,
  ) {
    setPricingConfig((current) => ({
      ...current,
      [engine]: {
        ...current[engine],
        [field]: value,
      },
    }));
  }

  function updateSetting<Key extends keyof TranslationSettings>(
    key: Key,
    value: TranslationSettings[Key],
  ) {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function moveSection(direction: -1 | 1) {
    if (!book || currentSectionIndex < 0) {
      return;
    }

    const nextSection = book.sections[currentSectionIndex + direction];
    if (!nextSection) {
      return;
    }

    startTransition(() => {
      setPreviewPath(nextSection.path);
    });
  }

  async function handleTranslate() {
    if (!book) {
      setIssues([
        createIssue(selectedEngine, "Translation", "Choose an EPUB file before starting.", false),
      ]);
      return;
    }

    if (!settings.targetLanguage.trim()) {
      setIssues([
        createIssue(
          selectedEngine,
          "Language",
          "Enter the language you want, for example en for English, de for German, or fr for French.",
          false,
        ),
      ]);
      return;
    }

    if (!isEngineRunnable(selectedEngine)) {
      setIssues([
        createIssue(
          selectedEngine,
          ENGINE_CATALOG[selectedEngine].label,
          ENGINE_CATALOG[selectedEngine].description,
          false,
        ),
      ]);
      setStatusMessage("This translation option is not available right now.");
      return;
    }

    const missingFields = ENGINE_CATALOG[selectedEngine].fields
      .filter((field) => field.required)
      .filter((field) => !providerConfig[selectedEngine][field.key]?.trim());

    if (missingFields.length) {
      setIssues([
        createIssue(
          selectedEngine,
          ENGINE_CATALOG[selectedEngine].label,
          `Please fill in ${missingFields.length > 1 ? "these fields" : "this field"}: ${missingFields
            .map((field) => field.label)
            .join(", ")}.`,
          false,
        ),
      ]);
      setStatusMessage("Please complete the missing information first.");
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const orderedDocuments = Object.values(book.documents).sort(
      (left, right) => left.order - right.order,
    );
    const tasks = orderedDocuments.flatMap((documentRecord) => {
      const batches = [];
      for (
        let segmentStart = 0;
        segmentStart < documentRecord.sourceTexts.length;
        segmentStart += settings.batchSize
      ) {
        batches.push({
          docPath: documentRecord.path,
          title: documentRecord.title,
          segmentStart,
          texts: documentRecord.sourceTexts.slice(
            segmentStart,
            segmentStart + settings.batchSize,
          ),
        });
      }
      return batches;
    });

    if (!tasks.length) {
      setIssues([
        createIssue(
          selectedEngine,
          "Translation",
          "We could not find any readable text to translate in this EPUB.",
          false,
        ),
      ]);
      return;
    }

    const workingTranslations = buildBaselineTranslations(book);
    const collectedIssues: TranslationIssue[] = [];
    const workerCount = Math.max(1, Math.min(settings.concurrency, tasks.length));
    const sourceLanguage = settings.sourceLanguage.trim();
    const targetLanguage = settings.targetLanguage.trim();
    let nextTaskIndex = 0;
    let completedBatches = 0;
    let activeBatches = 0;
    let translatedSegments = 0;
    const workingUsage: TranslationUsageTotals = {
      ...INITIAL_USAGE_TOTALS,
      engine: selectedEngine,
    };

    const syncProgress = (status: TranslationProgress["status"]) => {
      setProgress({
        status,
        totalSegments,
        translatedSegments,
        totalBatches: tasks.length,
        completedBatches,
        activeBatches,
      });
    };

    setTranslatedByPath(workingTranslations);
    setIssues([]);
    setStatusMessage("Translation has started. The preview will update as each part finishes.");
    setProgress({
      status: "translating",
      totalSegments,
      translatedSegments: 0,
      totalBatches: tasks.length,
      completedBatches: 0,
      activeBatches: 0,
    });
    setUsageTotals(workingUsage);

    const workers = Array.from({ length: workerCount }, async () => {
      while (!controller.signal.aborted) {
        const taskIndex = nextTaskIndex++;
        if (taskIndex >= tasks.length) {
          return;
        }

        const task = tasks[taskIndex];
        activeBatches += 1;
        syncProgress("translating");

        try {
          const result = await translateBatch(selectedEngine, {
            texts: task.texts,
            sourceLanguage,
            targetLanguage,
            config: providerConfig[selectedEngine],
            signal: controller.signal,
          });
          const translatedTexts = result.translations;

          if (translatedTexts.length !== task.texts.length) {
            throw new Error(
              `Expected ${task.texts.length} translated strings, but received ${translatedTexts.length}.`,
            );
          }

          workingTranslations[task.docPath].splice(
            task.segmentStart,
            translatedTexts.length,
            ...translatedTexts,
          );
          translatedSegments += translatedTexts.length;
          workingUsage.sourceCharacters += result.usage.sourceCharacters;
          workingUsage.billedCharacters += result.usage.billedCharacters ?? 0;
          workingUsage.inputTokens += result.usage.inputTokens ?? 0;
          workingUsage.outputTokens += result.usage.outputTokens ?? 0;
          workingUsage.totalTokens +=
            result.usage.totalTokens ??
            ((result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0));
          workingUsage.successfulBatches += 1;

          startTransition(() => {
            setTranslatedByPath({ ...workingTranslations });
            setUsageTotals({ ...workingUsage });
          });
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }

          const issue = createIssue(
            selectedEngine,
            task.title,
            formatErrorMessage(error),
            true,
            taskIndex + 1,
            task.segmentStart,
          );
          collectedIssues.push(issue);

          startTransition(() => {
            setIssues([...collectedIssues]);
          });
        } finally {
          activeBatches -= 1;
          completedBatches += 1;
          syncProgress("translating");
        }
      }
    });

    try {
      await Promise.all(workers);
      if (controller.signal.aborted) {
        syncProgress("ready");
        setStatusMessage(
          "Translation was stopped. Anything already translated is still shown in the preview and will stay in the download.",
        );
        return;
      }

      startTransition(() => {
        setTranslatedByPath({ ...workingTranslations });
        setIssues([...collectedIssues]);
        setUsageTotals({ ...workingUsage });
      });

      syncProgress("done");
      setStatusMessage(
        collectedIssues.length
          ? `Finished with ${collectedIssues.length} problem(s). Any part that failed was left in the original language.`
          : "Translation is finished. You can keep reading, change the layout, or download the new EPUB.",
      );
    } finally {
      abortControllerRef.current = null;
    }
  }

  function handleCancelTranslation() {
    abortControllerRef.current?.abort();
  }

  async function handleDownload() {
    if (!book) {
      return;
    }

    setDownloadBusy(true);

    try {
      const blob = await buildDownloadBlob(book, translatedByPath, settings.outputMode);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = createDownloadName(
        book.fileName,
        settings.targetLanguage,
        settings.outputMode,
      );
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setStatusMessage("Your download has started.");
    } catch (error) {
      setIssues((current) => [
        ...current,
        createIssue(
          selectedEngine,
          "EPUB export",
          formatErrorMessage(error),
          false,
        ),
      ]);
      setStatusMessage("We could not create the new EPUB file.");
    } finally {
      setDownloadBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-backdrop" />
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Translate Your EPUB</p>
          <h1>Upload a book, preview it, and download a translated copy.</h1>
          <p className="hero-summary">
            Open your EPUB, choose a translation service, enter your API key, and start the
            translation. You can read the book while it is being translated and then download a
            new EPUB when it is done.
          </p>
          <div className="hero-badges">
            <span>Preview before downloading</span>
            <span>Choose your translation service</span>
            <span>Download translated or side-by-side</span>
          </div>
        </div>
        <div className="hero-note card">
          <p className="card-label">Your Privacy</p>
          <ul className="privacy-list">
            <li>Your original EPUB stays on your device while the book is opened and prepared.</li>
            <li>This website does not upload the full book file to its own server.</li>
            <li>Only the text that needs translation is sent to the service you choose.</li>
            <li>If you use DeepL, those translation requests pass through this website before going to DeepL.</li>
          </ul>
        </div>
      </header>

      <main className="workspace">
        <section className="control-stack">
          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">1. EPUB</p>
                <h2>Choose your book</h2>
              </div>
              <span className={`status-pill status-pill--${progress.status}`}>
                {progress.status}
              </span>
            </div>
            <label className="upload-drop">
              <input
                type="file"
                accept=".epub,application/epub+zip"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleFileSelection(file);
                  }
                }}
              />
              <span className="upload-title">Choose an EPUB file</span>
              <span className="upload-copy">
                The preview opens automatically after the file is read.
              </span>
            </label>
            <div className="book-meta">
              <strong>{book?.title ?? "No book chosen yet"}</strong>
              <span>
                {book
                  ? `${book.sections.length} readable sections · ${totalSegments} text parts to translate`
                  : "Once your file is ready, you can start reading it here."}
              </span>
            </div>
          </article>

          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">2. Engine</p>
                <h2>Choose a translation service</h2>
              </div>
            </div>
            <div className="engine-grid">
              {ENGINE_ORDER.map((engineId) => {
                const engine = ENGINE_CATALOG[engineId];
                const selected = selectedEngine === engineId;

                return (
                  <button
                    key={engineId}
                    type="button"
                    className={`engine-card ${selected ? "engine-card--selected" : ""}`}
                    onClick={() => setSelectedEngine(engineId)}
                  >
                    <div className="engine-card__row">
                      <strong>{engine.label}</strong>
                      <span className={`engine-status engine-status--${engine.status}`}>
                        {engine.statusLabel}
                      </span>
                    </div>
                    <p>{engine.tagline}</p>
                  </button>
                );
              })}
            </div>
            <div className="engine-detail">
              <p>{ENGINE_CATALOG[selectedEngine].description}</p>
              <div className="field-grid">
                {ENGINE_CATALOG[selectedEngine].fields.map((field) => (
                  <label key={field.key} className="field">
                    <span>{field.label}</span>
                    <input
                      type={field.type}
                      placeholder={field.placeholder}
                      required={field.required}
                      value={providerConfig[selectedEngine][field.key] ?? ""}
                      onChange={(event) =>
                        updateProviderConfig(
                          selectedEngine,
                          field.key,
                          event.target.value,
                        )
                      }
                    />
                    {field.help ? <small>{field.help}</small> : null}
                  </label>
                ))}
              </div>
            </div>
          </article>

          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">3. Translation</p>
                <h2>Choose language and download style</h2>
              </div>
            </div>
            <div className="field-grid field-grid--compact">
              <label className="field">
                <span>Current language</span>
                <input
                  type="text"
                  placeholder="auto"
                  value={settings.sourceLanguage}
                  onChange={(event) => updateSetting("sourceLanguage", event.target.value)}
                />
                <small>Optional. Leave this empty if you want the service to detect the language.</small>
              </label>
              <label className="field">
                <span>Translate into</span>
                <input
                  type="text"
                  placeholder="en"
                  value={settings.targetLanguage}
                  onChange={(event) => updateSetting("targetLanguage", event.target.value)}
                />
                <small>Use short codes like `en` for English, `de` for German, or `fr` for French.</small>
              </label>
              <label className="field">
                <span>Texts per step</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={settings.batchSize}
                  onChange={(event) =>
                    updateSetting("batchSize", Number(event.target.value) || 1)
                  }
                />
                <small>Higher numbers can be faster, but very large numbers may fail more often.</small>
              </label>
              <label className="field">
                <span>Requests at the same time</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.concurrency}
                  onChange={(event) =>
                    updateSetting("concurrency", Number(event.target.value) || 1)
                  }
                />
                <small>Higher numbers can be faster, but some services may slow down or reject too many requests.</small>
              </label>
            </div>

            <div className="usage-panel">
              <div className="usage-head">
                <strong>Estimated usage before you start</strong>
                <span>{selectedEngine === "openai" ? "Rough guide" : "Close guide"}</span>
              </div>
              {book ? (
                <>
                  <div className="usage-grid">
                    <article className="usage-stat">
                      <span>Book text size</span>
                      <strong>{formatCount(sourceCharacterCount)} characters</strong>
                    </article>
                    {selectedEngine === "openai" ? (
                      <>
                        <article className="usage-stat">
                          <span>Approx. input tokens</span>
                          <strong>{formatCount(estimatedInputTokens)}</strong>
                        </article>
                        <article className="usage-stat">
                          <span>Approx. output tokens</span>
                          <strong>{formatCount(estimatedOutputTokens)}</strong>
                        </article>
                      </>
                    ) : (
                      <article className="usage-stat">
                        <span>Estimated billed characters</span>
                        <strong>{formatCount(estimatedBilledCharacters)}</strong>
                      </article>
                    )}
                    <article className="usage-stat">
                      <span>How this service charges</span>
                      <strong>{selectedEngine === "openai" ? "Tokens" : "Characters"}</strong>
                    </article>
                  </div>

                  <div className="field-grid field-grid--compact price-grid">
                    {selectedEngine === "openai" ? (
                      <>
                        <label className="field">
                          <span>Input price per 1M tokens</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="Optional"
                            value={pricingConfig.openai.inputPerMillionTokens}
                            onChange={(event) =>
                              updatePricingConfig(
                                "openai",
                                "inputPerMillionTokens",
                                event.target.value,
                              )
                            }
                          />
                          <small>Use your own currency. Example: 0.15 or 2.50.</small>
                        </label>
                        <label className="field">
                          <span>Output price per 1M tokens</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="Optional"
                            value={pricingConfig.openai.outputPerMillionTokens}
                            onChange={(event) =>
                              updatePricingConfig(
                                "openai",
                                "outputPerMillionTokens",
                                event.target.value,
                              )
                            }
                          />
                          <small>The estimate uses the same currency you enter above.</small>
                        </label>
                      </>
                    ) : (
                      <label className="field">
                        <span>Price per 1M characters</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="Optional"
                          value={pricingConfig[selectedEngine].perMillionCharacters}
                          onChange={(event) =>
                            updatePricingConfig(
                              selectedEngine,
                              "perMillionCharacters",
                              event.target.value,
                            )
                          }
                        />
                        <small>Use the price from your account. The estimate uses the same currency.</small>
                      </label>
                    )}
                  </div>

                  <p className="usage-summary">
                    {estimatedCost !== null
                      ? `Estimated cost for the whole book: ${formatMoney(estimatedCost)}`
                      : selectedEngine === "openai"
                        ? "Add your input and output token prices above if you want a money estimate."
                        : "Add your character price above if you want a money estimate."}
                  </p>
                  <p className="usage-note">
                    {selectedEngine === "openai"
                      ? "OpenAI estimates are based on about 4 characters per token, so the final numbers can be a bit lower or higher."
                      : "Character-based services are easier to predict because they usually bill from the source text length."}
                  </p>
                </>
              ) : (
                <p className="empty-copy">
                  Choose a book first and the usage estimate will appear here.
                </p>
              )}
            </div>

            <div className="mode-toggle">
              <button
                type="button"
                className={
                  settings.outputMode === "translated" ? "mode-chip mode-chip--active" : "mode-chip"
                }
                onClick={() => updateSetting("outputMode", "translated")}
              >
                Only translated text
              </button>
              <button
                type="button"
                className={
                  settings.outputMode === "parallel" ? "mode-chip mode-chip--active" : "mode-chip"
                }
                onClick={() => updateSetting("outputMode", "parallel")}
              >
                Original and translation side by side
              </button>
            </div>
            <p className="helper-copy">
              Before a section is translated, the preview still shows the original text. In the
              side-by-side view, both columns will look the same until the translated version is ready.
            </p>

            <div className="action-row">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleTranslate()}
                disabled={
                  !book ||
                  progress.status === "loading" ||
                  progress.status === "translating" ||
                  !settings.targetLanguage.trim() ||
                  !isEngineRunnable(selectedEngine)
                }
              >
                Start translation
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleCancelTranslation}
                disabled={progress.status !== "translating"}
              >
                Stop
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleDownload()}
                disabled={!book || downloadBusy}
              >
                {downloadBusy ? "Preparing download..." : "Download EPUB"}
              </button>
            </div>
          </article>

          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">4. Status</p>
                <h2>Progress and messages</h2>
              </div>
            </div>
            <div className="progress-panel">
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="progress-stats">
                <span>{statusMessage}</span>
                <span>
                  {progress.completedBatches}/{progress.totalBatches} steps done ·{" "}
                  {progress.translatedSegments}/{progress.totalSegments} text parts translated
                </span>
              </div>
            </div>
            <div className="usage-panel">
              <div className="usage-head">
                <strong>
                  {progress.status === "translating"
                    ? "Actual usage so far"
                    : "Actual usage from completed translation"}
                </strong>
                <span>
                  {selectedUsageTotals?.successfulBatches ?? 0} successful{" "}
                  {(selectedUsageTotals?.successfulBatches ?? 0) === 1 ? "step" : "steps"}
                </span>
              </div>
              {selectedUsageTotals?.successfulBatches ? (
                <>
                  <div className="usage-grid">
                    <article className="usage-stat">
                      <span>Characters sent</span>
                      <strong>{formatCount(selectedUsageTotals.sourceCharacters)}</strong>
                    </article>
                    {selectedEngine === "openai" ? (
                      <>
                        <article className="usage-stat">
                          <span>Input tokens</span>
                          <strong>{formatCount(selectedUsageTotals.inputTokens)}</strong>
                        </article>
                        <article className="usage-stat">
                          <span>Output tokens</span>
                          <strong>{formatCount(selectedUsageTotals.outputTokens)}</strong>
                        </article>
                      </>
                    ) : (
                      <article className="usage-stat">
                        <span>Billed characters</span>
                        <strong>{formatCount(selectedUsageTotals.billedCharacters)}</strong>
                      </article>
                    )}
                    <article className="usage-stat">
                      <span>Total text parts finished</span>
                      <strong>{formatCount(progress.translatedSegments)}</strong>
                    </article>
                  </div>
                  <p className="usage-summary">
                    {actualCost !== null
                      ? `${progress.status === "translating" ? "Cost so far" : "Actual cost"}: ${formatMoney(actualCost)}`
                      : selectedEngine === "openai"
                        ? "Add your current input and output token prices above if you want this turned into a money total."
                        : "Add your current character price above if you want this turned into a money total."}
                  </p>
                  {selectedEngine === "openai" &&
                  selectedUsageTotals.inputTokens === 0 &&
                  selectedUsageTotals.outputTokens === 0 ? (
                    <p className="usage-note">
                      OpenAI finished some steps, but no exact token counts came back, so only the estimate is available.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="empty-copy">
                  Start a translation and this area will show what the service actually used.
                </p>
              )}
            </div>
            <div className="issue-list">
              {issues.length ? (
                issues.map((issue) => (
                  <article key={issue.id} className="issue-card">
                    <div className="issue-head">
                      <strong>{issue.scope}</strong>
                      <span>{issue.engine}</span>
                    </div>
                    <p>{issue.message}</p>
                    {issue.batchIndex ? (
                      <small>
                        Batch {issue.batchIndex}
                        {typeof issue.segmentStart === "number"
                          ? ` · starts at fragment ${issue.segmentStart + 1}`
                          : ""}
                      </small>
                    ) : null}
                  </article>
                ))
              ) : (
                <p className="empty-copy">
                  Everything looks good so far. If anything goes wrong, the details will appear here.
                </p>
              )}
            </div>
          </article>

          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">5. Setup guide</p>
                <h2>How to get your API key</h2>
              </div>
            </div>
            <div className="guide-block">
              <h3>{ENGINE_CATALOG[selectedEngine].label}</h3>
              <ol className="guide-steps">
                {ENGINE_CATALOG[selectedEngine].setupSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div className="guide-notes">
                {ENGINE_CATALOG[selectedEngine].notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          </article>
        </section>

        <section className="preview-shell">
          <article className="card preview-card">
            <div className="preview-head">
              <div>
                <p className="card-label">Book Preview</p>
                <h2>{currentDocument?.title ?? "Waiting for your book"}</h2>
                <p className="preview-subtitle">
                  {book
                    ? `Part ${Math.max(currentSectionIndex + 1, 1)} of ${book.sections.length}`
                    : "Choose a book to open the preview."}
                </p>
              </div>
              <div className="preview-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => moveSection(-1)}
                  disabled={!book || currentSectionIndex <= 0}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => moveSection(1)}
                  disabled={!book || currentSectionIndex >= book.sections.length - 1}
                >
                  Next
                </button>
              </div>
            </div>
            <div className="preview-layout">
              <aside className="chapter-list">
                {book ? (
                  book.sections.map((section) => (
                    <button
                      key={section.path}
                      type="button"
                      className={
                        section.path === previewPath
                          ? "chapter-button chapter-button--active"
                          : "chapter-button"
                      }
                      onClick={() => {
                        startTransition(() => {
                          setPreviewPath(section.path);
                        });
                      }}
                    >
                      <span>{section.order + 1}</span>
                      <strong>{section.title}</strong>
                    </button>
                  ))
                ) : (
                  <p className="empty-copy">The list of sections will appear here after your book is opened.</p>
                )}
              </aside>
              <div className="reader-frame">
                {previewHtml ? (
                  <iframe
                    title="EPUB preview"
                    sandbox=""
                    srcDoc={previewHtml}
                  />
                ) : (
                  <div className="reader-empty">
                    <h3>Your preview will appear here</h3>
                    <p>
                      Once your EPUB is opened, you can start reading right away. As translation
                      finishes, this preview updates automatically.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}

export default App;
