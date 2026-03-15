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
  const [settings, setSettings] = useState<TranslationSettings>(INITIAL_SETTINGS);
  const [translatedByPath, setTranslatedByPath] = useState<Record<string, string[]>>({});
  const [issues, setIssues] = useState<TranslationIssue[]>([]);
  const [progress, setProgress] = useState<TranslationProgress>(INITIAL_PROGRESS);
  const [statusMessage, setStatusMessage] = useState(
    "Load an EPUB to parse it locally and open the live preview.",
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
    setStatusMessage("Parsing EPUB locally. Nothing leaves the browser during this step.");
    setIssues([]);
    setBook(null);
    setPreviewPath("");
    setPreviewHtml("");

    try {
      const loadedBook = await loadEpub(file);
      const baselineTranslations = buildBaselineTranslations(loadedBook);
      const segmentCount = sumSegments(loadedBook);
      setBook(loadedBook);
      setTranslatedByPath(baselineTranslations);
      setProgress({
        ...INITIAL_PROGRESS,
        status: "ready",
        totalSegments: segmentCount,
      });
      setStatusMessage(
        `Ready. Parsed ${loadedBook.sections.length} readable sections and ${segmentCount} translatable text fragments locally.`,
      );

      startTransition(() => {
        setPreviewPath(loadedBook.sections[0]?.path ?? Object.keys(loadedBook.documents)[0] ?? "");
      });
    } catch (error) {
      setProgress({
        ...INITIAL_PROGRESS,
        status: "error",
      });
      setStatusMessage("This EPUB could not be parsed.");
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
        createIssue(selectedEngine, "Translation", "Load an EPUB before translating.", false),
      ]);
      return;
    }

    if (!settings.targetLanguage.trim()) {
      setIssues([
        createIssue(
          selectedEngine,
          "Target language",
          "Choose a target language code such as en, de, fr, or ja.",
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
      setStatusMessage("This provider cannot run in a browser-only deployment.");
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
          `Missing required field${missingFields.length > 1 ? "s" : ""}: ${missingFields
            .map((field) => field.label)
            .join(", ")}.`,
          false,
        ),
      ]);
      setStatusMessage("Fill in the required engine fields before starting translation.");
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
          "No translatable text nodes were found in this EPUB.",
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
    setStatusMessage("Translation started. Preview updates as each batch completes.");
    setProgress({
      status: "translating",
      totalSegments,
      translatedSegments: 0,
      totalBatches: tasks.length,
      completedBatches: 0,
      activeBatches: 0,
    });

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
          const translatedTexts = await translateBatch(selectedEngine, {
            texts: task.texts,
            sourceLanguage,
            targetLanguage,
            config: providerConfig[selectedEngine],
            signal: controller.signal,
          });

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

          startTransition(() => {
            setTranslatedByPath({ ...workingTranslations });
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
          "Translation cancelled. Completed batches remain in the preview and export.",
        );
        return;
      }

      startTransition(() => {
        setTranslatedByPath({ ...workingTranslations });
        setIssues([...collectedIssues]);
      });

      syncProgress("done");
      setStatusMessage(
        collectedIssues.length
          ? `Finished with ${collectedIssues.length} batch error(s). Failed batches stayed in the source language.`
          : "Translation finished. You can keep reading, switch modes, or download the EPUB.",
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
      setStatusMessage("Download started. The EPUB was generated entirely in the browser.");
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
      setStatusMessage("The EPUB could not be generated.");
    } finally {
      setDownloadBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-backdrop" />
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Browser-only EPUB Translation</p>
          <h1>Translate EPUBs without uploading the book to your own server.</h1>
          <p className="hero-summary">
            This repo rebuilds the original Python script as a static TypeScript site:
            EPUB parsing, preview, batching, and export all happen locally in the tab.
            Only extracted text batches are sent to the translation engine you choose.
          </p>
          <div className="hero-badges">
            <span>Local EPUB parsing</span>
            <span>Concurrent translation batches</span>
            <span>Single or parallel text export</span>
          </div>
        </div>
        <div className="hero-note card">
          <p className="card-label">Privacy boundary</p>
          <ul className="privacy-list">
            <li>The uploaded `.epub` stays in browser memory.</li>
            <li>Your static host never receives the file or the API key.</li>
            <li>Only the selected engine receives the text fragments you translate.</li>
          </ul>
        </div>
      </header>

      <main className="workspace">
        <section className="control-stack">
          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">1. EPUB</p>
                <h2>Load a book</h2>
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
              <span className="upload-title">Choose an EPUB</span>
              <span className="upload-copy">
                The parser reads `container.xml`, the OPF spine, and the XHTML files locally.
              </span>
            </label>
            <div className="book-meta">
              <strong>{book?.title ?? "No book loaded yet"}</strong>
              <span>
                {book
                  ? `${book.sections.length} previewable sections · ${totalSegments} translatable fragments`
                  : "The preview opens as soon as a file is parsed."}
              </span>
            </div>
          </article>

          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">2. Engine</p>
                <h2>Choose a translation provider</h2>
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
                <h2>Languages, batching, and layout</h2>
              </div>
            </div>
            <div className="field-grid field-grid--compact">
              <label className="field">
                <span>Source language</span>
                <input
                  type="text"
                  placeholder="auto"
                  value={settings.sourceLanguage}
                  onChange={(event) => updateSetting("sourceLanguage", event.target.value)}
                />
                <small>Optional. Leave blank when the provider should detect it.</small>
              </label>
              <label className="field">
                <span>Target language</span>
                <input
                  type="text"
                  placeholder="en"
                  value={settings.targetLanguage}
                  onChange={(event) => updateSetting("targetLanguage", event.target.value)}
                />
                <small>Use short language codes like `en`, `de`, `fr`, `es`, or `ja`.</small>
              </label>
              <label className="field">
                <span>Batch size</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={settings.batchSize}
                  onChange={(event) =>
                    updateSetting("batchSize", Number(event.target.value) || 1)
                  }
                />
                <small>Texts per request. Larger batches are faster until the provider times out.</small>
              </label>
              <label className="field">
                <span>Concurrency</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.concurrency}
                  onChange={(event) =>
                    updateSetting("concurrency", Number(event.target.value) || 1)
                  }
                />
                <small>Concurrent requests. Increase carefully to avoid rate limits.</small>
              </label>
            </div>

            <div className="mode-toggle">
              <button
                type="button"
                className={
                  settings.outputMode === "translated" ? "mode-chip mode-chip--active" : "mode-chip"
                }
                onClick={() => updateSetting("outputMode", "translated")}
              >
                Save translated text only
              </button>
              <button
                type="button"
                className={
                  settings.outputMode === "parallel" ? "mode-chip mode-chip--active" : "mode-chip"
                }
                onClick={() => updateSetting("outputMode", "parallel")}
              >
                Save original + translation in columns
              </button>
            </div>
            <p className="helper-copy">
              Dry run behavior: before translation finishes, the preview uses the original text as
              both input and output. In parallel mode, you will see the same text in both columns
              until a translated batch arrives.
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
                Cancel
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleDownload()}
                disabled={!book || downloadBusy}
              >
                {downloadBusy ? "Building EPUB..." : "Download EPUB"}
              </button>
            </div>
          </article>

          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">4. Status</p>
                <h2>Progress and errors</h2>
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
                  {progress.completedBatches}/{progress.totalBatches} batches ·{" "}
                  {progress.translatedSegments}/{progress.totalSegments} translated fragments
                </span>
              </div>
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
                  No provider or export errors yet. Failed batches will stay in the source language
                  and appear here.
                </p>
              )}
            </div>
          </article>

          <article className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-label">5. Setup guide</p>
                <h2>How to get the required keys</h2>
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
                <p className="card-label">Reader preview</p>
                <h2>{currentDocument?.title ?? "Waiting for an EPUB"}</h2>
                <p className="preview-subtitle">
                  {book
                    ? `Section ${Math.max(currentSectionIndex + 1, 1)} of ${book.sections.length}`
                    : "Upload a book to open the reader preview."}
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
                  <p className="empty-copy">The chapter list appears after the EPUB is parsed.</p>
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
                    <h3>Client-side preview</h3>
                    <p>
                      The app will parse the EPUB locally, open the first section, and keep the
                      preview in sync with your output mode and completed translation batches.
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
