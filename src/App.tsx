import { startTransition, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  buildDownloadBlob,
  buildPreviewDocument,
  createDownloadName,
  loadEpubFromArrayBuffer,
} from "./lib/epub";
import {
  DEFAULT_PROVIDER_CONFIG,
  ENGINE_CATALOG,
  ENGINE_ORDER,
} from "./lib/engineCatalog";
import {
  clearPersistedSession,
  loadPersistedSession,
  loadPersistencePreferences,
  savePersistedSession,
  savePersistencePreferences,
} from "./lib/clientPersistence";
import type {
  PersistencePreferences,
  PersistedTranslationSession,
  PricingConfigRecord,
} from "./lib/clientPersistence";
import { isEngineRunnable, translateBatch } from "./lib/providers";
import type {
  CompletedSegmentsByPath,
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

function sanitizeProviderConfigForPersistence(
  providerConfig: ProviderConfigRecord,
  rememberApiKeys: boolean,
) {
  if (rememberApiKeys) {
    return JSON.parse(JSON.stringify(providerConfig)) as ProviderConfigRecord;
  }

  return {
    openai: {
      ...providerConfig.openai,
      apiKey: "",
    },
    google: {
      ...providerConfig.google,
      apiKey: "",
    },
    deepl: {
      ...providerConfig.deepl,
      apiKey: "",
    },
  } satisfies ProviderConfigRecord;
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

function buildCompletionMap(book: EpubBook) {
  const completion: CompletedSegmentsByPath = {};

  for (const documentRecord of Object.values(book.documents)) {
    completion[documentRecord.path] = new Array(documentRecord.sourceTexts.length).fill(false);
  }

  return completion;
}

function countCompletedSegments(completedByPath: CompletedSegmentsByPath) {
  return Object.values(completedByPath).reduce(
    (total, flags) => total + flags.filter(Boolean).length,
    0,
  );
}

function cloneTranslations(translatedByPath: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(translatedByPath).map(([path, texts]) => [path, [...texts]]),
  ) as Record<string, string[]>;
}

function cloneCompletionMap(completedByPath: CompletedSegmentsByPath) {
  return Object.fromEntries(
    Object.entries(completedByPath).map(([path, flags]) => [path, [...flags]]),
  ) as CompletedSegmentsByPath;
}

function mergeSavedTranslations(
  book: EpubBook,
  translatedByPath: Record<string, string[]> | undefined,
  completedByPath: CompletedSegmentsByPath | undefined,
) {
  const mergedTranslations = buildBaselineTranslations(book);
  const mergedCompletion = buildCompletionMap(book);

  for (const documentRecord of Object.values(book.documents)) {
    const savedTexts = translatedByPath?.[documentRecord.path];
    const savedFlags = completedByPath?.[documentRecord.path];

    for (let index = 0; index < documentRecord.sourceTexts.length; index += 1) {
      if (typeof savedTexts?.[index] === "string") {
        mergedTranslations[documentRecord.path][index] = savedTexts[index];
      }

      mergedCompletion[documentRecord.path][index] =
        typeof savedFlags?.[index] === "boolean"
          ? savedFlags[index]
          : mergedTranslations[documentRecord.path][index] !== documentRecord.sourceTexts[index];
    }
  }

  return {
    translatedByPath: mergedTranslations,
    completedByPath: mergedCompletion,
  };
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
  const [bookBinary, setBookBinary] = useState<ArrayBuffer | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<EngineId>("google");
  const [providerConfig, setProviderConfig] = useState<ProviderConfigRecord>(
    cloneDefaultConfig,
  );
  const [pricingConfig, setPricingConfig] = useState<PricingConfigRecord>(
    cloneDefaultPricing,
  );
  const [settings, setSettings] = useState<TranslationSettings>(INITIAL_SETTINGS);
  const [translatedByPath, setTranslatedByPath] = useState<Record<string, string[]>>({});
  const [completedByPath, setCompletedByPath] = useState<CompletedSegmentsByPath>({});
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
  const [isUploadDragActive, setIsUploadDragActive] = useState(false);
  const [persistencePreferences, setPersistencePreferences] =
    useState<PersistencePreferences>(loadPersistencePreferences);
  const [restoringSession, setRestoringSession] = useState(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const persistenceReadyRef = useRef(false);
  const uploadDragDepthRef = useRef(0);

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
    savePersistencePreferences(persistencePreferences);
  }, [persistencePreferences]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        if (!persistencePreferences.rememberSession) {
          await clearPersistedSession().catch(() => undefined);
          return;
        }

        const savedSession = await loadPersistedSession();
        if (cancelled || !savedSession) {
          return;
        }

        setSelectedEngine(savedSession.selectedEngine);
        setPricingConfig(savedSession.pricingConfig);
        setSettings(savedSession.settings);
        setIssues(savedSession.issues);
        setUsageTotals(savedSession.usageTotals);
        setSourceCharacterCount(savedSession.sourceCharacterCount);
        setPreviewPath(savedSession.previewPath);

        const restoredConfig = persistencePreferences.rememberApiKeys
          ? savedSession.providerConfig
          : sanitizeProviderConfigForPersistence(savedSession.providerConfig, false);
        setProviderConfig(restoredConfig);

        if (savedSession.bookData && savedSession.bookFileName) {
          const restoredBook = await loadEpubFromArrayBuffer(
            savedSession.bookData,
            savedSession.bookFileName,
          );

          if (cancelled) {
            return;
          }

          const mergedState = mergeSavedTranslations(
            restoredBook,
            savedSession.translatedByPath,
            savedSession.completedByPath,
          );
          const translatedSegments = countCompletedSegments(mergedState.completedByPath);
          const totalSegments = sumSegments(restoredBook);
          const hadActiveWork =
            savedSession.progress.status === "loading" ||
            savedSession.progress.status === "translating";

          setBook(restoredBook);
          setBookBinary(savedSession.bookData);
          setTranslatedByPath(mergedState.translatedByPath);
          setCompletedByPath(mergedState.completedByPath);
          setProgress({
            status:
              translatedSegments && translatedSegments >= totalSegments ? "done" : "ready",
            totalSegments,
            translatedSegments,
            totalBatches: savedSession.progress.totalBatches,
            completedBatches: savedSession.progress.completedBatches,
            activeBatches: 0,
          });
          setStatusMessage(
            hadActiveWork
              ? "Your saved book and partial translation were restored. Translation was paused by the reload, so press Start translation to continue."
              : "Your saved book and settings were restored on this device.",
          );
          return;
        }

        setStatusMessage(savedSession.statusMessage || "Your saved settings were restored.");
      } catch (error) {
        if (cancelled) {
          return;
        }

        setIssues([
          createIssue(
            selectedEngine,
            "Saved data",
            formatErrorMessage(error),
            true,
          ),
        ]);
        setStatusMessage("We could not restore the saved session on this device.");
        await clearPersistedSession().catch(() => undefined);
      } finally {
        if (!cancelled) {
          persistenceReadyRef.current = true;
          setRestoringSession(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, [persistencePreferences.rememberSession]);

  useEffect(() => {
    if (!persistenceReadyRef.current || restoringSession) {
      return;
    }

    if (!persistencePreferences.rememberSession) {
      void clearPersistedSession();
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const session: PersistedTranslationSession = {
        version: 1,
        savedAt: new Date().toISOString(),
        bookFileName: book?.fileName ?? null,
        bookData: bookBinary,
        selectedEngine,
        providerConfig: sanitizeProviderConfigForPersistence(
          providerConfig,
          persistencePreferences.rememberApiKeys,
        ),
        pricingConfig,
        settings,
        translatedByPath,
        completedByPath,
        issues,
        progress,
        usageTotals,
        sourceCharacterCount,
        statusMessage,
        previewPath,
      };

      void savePersistedSession(session).catch(() => undefined);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    book,
    bookBinary,
    completedByPath,
    issues,
    previewPath,
    pricingConfig,
    progress,
    providerConfig,
    restoringSession,
    selectedEngine,
    settings,
    sourceCharacterCount,
    statusMessage,
    translatedByPath,
    usageTotals,
    persistencePreferences,
  ]);

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
    setIsUploadDragActive(false);
    uploadDragDepthRef.current = 0;
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
    setBookBinary(null);
    setPreviewPath("");
    setPreviewHtml("");
    setCompletedByPath({});

    try {
      const bookData = await file.arrayBuffer();
      const loadedBook = await loadEpubFromArrayBuffer(bookData, file.name);
      const baselineTranslations = buildBaselineTranslations(loadedBook);
      const baselineCompletion = buildCompletionMap(loadedBook);
      const segmentCount = sumSegments(loadedBook);
      const characterCount = countBookCharacters(loadedBook);
      setBook(loadedBook);
      setBookBinary(bookData);
      setTranslatedByPath(baselineTranslations);
      setCompletedByPath(baselineCompletion);
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

  function updatePersistencePreference<Key extends keyof PersistencePreferences>(
    key: Key,
    value: PersistencePreferences[Key],
  ) {
    setPersistencePreferences((current) => ({
      ...current,
      ...(key === "rememberSession" && !value ? { rememberApiKeys: false } : {}),
      [key]: value,
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

  function handleUploadDragEnter(event: DragEvent<HTMLLabelElement>) {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    uploadDragDepthRef.current += 1;
    setIsUploadDragActive(true);
  }

  function handleUploadDragOver(event: DragEvent<HTMLLabelElement>) {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsUploadDragActive(true);
  }

  function handleUploadDragLeave(event: DragEvent<HTMLLabelElement>) {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);

    if (uploadDragDepthRef.current === 0) {
      setIsUploadDragActive(false);
    }
  }

  function handleUploadDrop(event: DragEvent<HTMLLabelElement>) {
    if (!event.dataTransfer.files.length) {
      return;
    }

    event.preventDefault();
    uploadDragDepthRef.current = 0;
    setIsUploadDragActive(false);

    const file = Array.from(event.dataTransfer.files).find((entry) =>
      entry.name.toLowerCase().endsWith(".epub"),
    );

    if (file) {
      void handleFileSelection(file);
      return;
    }

    setIssues([
      createIssue(
        selectedEngine,
        "EPUB import",
        "Please drop an EPUB file with the .epub ending.",
        false,
      ),
    ]);
    setStatusMessage("That file does not look like an EPUB.");
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
      const pendingIndices = documentRecord.sourceTexts
        .map((_, index) => index)
        .filter((index) => !completedByPath[documentRecord.path]?.[index]);
      const batches = [];

      for (
        let batchStart = 0;
        batchStart < pendingIndices.length;
        batchStart += settings.batchSize
      ) {
        const segmentIndices = pendingIndices.slice(
          batchStart,
          batchStart + settings.batchSize,
        );
        batches.push({
          docPath: documentRecord.path,
          title: documentRecord.title,
          segmentStart: segmentIndices[0] ?? 0,
          segmentIndices,
          texts: segmentIndices.map((index) => documentRecord.sourceTexts[index]),
        });
      }
      return batches;
    });

    if (!tasks.length) {
      setIssues([]);
      setStatusMessage(
        "Everything in this book is already translated in the current session. You can keep reading or download the EPUB now.",
      );
      setProgress((current) => ({
        ...current,
        status: "done",
        translatedSegments: totalSegments,
      }));
      return;
    }

    const workingTranslations = cloneTranslations(
      Object.keys(translatedByPath).length ? translatedByPath : buildBaselineTranslations(book),
    );
    const workingCompletion = cloneCompletionMap(
      Object.keys(completedByPath).length ? completedByPath : buildCompletionMap(book),
    );
    const collectedIssues: TranslationIssue[] = [];
    const workerCount = Math.max(1, Math.min(settings.concurrency, tasks.length));
    const sourceLanguage = settings.sourceLanguage.trim();
    const targetLanguage = settings.targetLanguage.trim();
    let nextTaskIndex = 0;
    let completedBatches = 0;
    let activeBatches = 0;
    let translatedSegments = countCompletedSegments(workingCompletion);
    const workingUsage: TranslationUsageTotals =
      usageTotals.engine === selectedEngine
        ? { ...usageTotals }
        : {
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
    setCompletedByPath(workingCompletion);
    setIssues([]);
    setStatusMessage("Translation has started. The preview will update as each part finishes.");
    setProgress({
      status: "translating",
      totalSegments,
      translatedSegments,
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

          translatedTexts.forEach((text, index) => {
            const segmentIndex = task.segmentIndices[index];
            if (typeof segmentIndex !== "number") {
              return;
            }

            workingTranslations[task.docPath][segmentIndex] = text;
            if (!workingCompletion[task.docPath][segmentIndex]) {
              workingCompletion[task.docPath][segmentIndex] = true;
              translatedSegments += 1;
            }
          });
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
            setCompletedByPath({ ...workingCompletion });
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
        setCompletedByPath({ ...workingCompletion });
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

  async function handleClearSavedData() {
    abortControllerRef.current?.abort();
    await clearPersistedSession().catch(() => undefined);
    setBook(null);
    setBookBinary(null);
    setTranslatedByPath({});
    setCompletedByPath({});
    setIssues([]);
    setProgress(INITIAL_PROGRESS);
    setUsageTotals(INITIAL_USAGE_TOTALS);
    setSourceCharacterCount(0);
    setPreviewPath("");
    setPreviewHtml("");
    setStatusMessage("Saved data was removed from this browser.");
    setSelectedEngine("google");
    setSettings(INITIAL_SETTINGS);
    setPricingConfig(cloneDefaultPricing());
    setProviderConfig(cloneDefaultConfig());
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
              <li>You can keep the current book and progress in this browser between reloads, and API key saving is optional.</li>
            </ul>
          </div>
        </header>

      <main className="workspace">
        <section className="control-stack control-stack--wide">
          <article className="card control-card control-card--full">
            <div className="card-head">
              <div>
                <p className="card-label">1. EPUB</p>
                <h2>Choose your book</h2>
              </div>
              <span className={`status-pill status-pill--${progress.status}`}>
                {progress.status}
              </span>
            </div>
            <label
              className={`upload-drop ${isUploadDragActive ? "upload-drop--active" : ""}`}
              onDragEnter={handleUploadDragEnter}
              onDragOver={handleUploadDragOver}
              onDragLeave={handleUploadDragLeave}
              onDrop={handleUploadDrop}
            >
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
              <span className="upload-title">
                {isUploadDragActive ? "Drop your EPUB here" : "Choose an EPUB file"}
              </span>
              <span className="upload-copy">
                Drag an EPUB from your computer into this box, or click to browse. The preview opens automatically after the file is read.
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
            <div className="toggle-stack">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={persistencePreferences.rememberSession}
                  onChange={(event) =>
                    updatePersistencePreference("rememberSession", event.target.checked)
                  }
                />
                <span>
                  <strong>Keep this book and progress on this device</strong>
                  <small>After a reload, the book preview and finished translation steps come back here.</small>
                </span>
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => void handleClearSavedData()}
              >
                Remove saved browser data
              </button>
            </div>
          </article>

          {book ? (
            <article className="card preview-card control-card--full">
              <div className="preview-head">
                <div>
                  <p className="card-label">Preview</p>
                  <h2>{currentDocument?.title ?? "Loading preview"}</h2>
                  <p className="preview-subtitle">
                    {`Part ${Math.max(currentSectionIndex + 1, 1)} of ${book.sections.length}`}
                  </p>
                </div>
                <div className="preview-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => moveSection(-1)}
                    disabled={currentSectionIndex <= 0}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => moveSection(1)}
                    disabled={currentSectionIndex >= book.sections.length - 1}
                  >
                    Next
                  </button>
                </div>
              </div>
              <div className="preview-layout">
                <aside className="chapter-list">
                  {book.sections.map((section) => (
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
                  ))}
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
                      <h3>Preparing the preview</h3>
                      <p>
                        Your book is loaded. The preview will appear here in a moment.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ) : null}

          <article className="card control-card control-card--service">
            <div className="card-head">
              <div>
                <p className="card-label">2. Service</p>
                <h2>Choose a translation service and enter your key</h2>
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
            <div className="engine-layout">
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
                <div className="toggle-stack">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={persistencePreferences.rememberApiKeys}
                      onChange={(event) =>
                        updatePersistencePreference("rememberApiKeys", event.target.checked)
                      }
                      disabled={!persistencePreferences.rememberSession}
                    />
                    <span>
                      <strong>Remember my API key on this device</strong>
                      <small>
                        Keep this turned off if you are on a shared computer. The key is only saved inside this browser.
                      </small>
                    </span>
                  </label>
                </div>
              </div>
              <div className="guide-block guide-block--inline">
                <p className="card-label">Setup Help</p>
                <h3>How to get your {ENGINE_CATALOG[selectedEngine].label} key</h3>
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
            </div>
          </article>

          <article className="card control-card control-card--translation">
            <div className="card-head">
              <div>
                <p className="card-label">3. Options</p>
                <h2>Choose language, layout, and speed</h2>
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

          <article className="card control-card control-card--full">
            <div className="card-head">
              <div>
                <p className="card-label">4. Status</p>
                <h2>Start the translation and follow progress</h2>
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
                  {restoringSession
                    ? "Restoring saved session..."
                    : `${progress.completedBatches}/${progress.totalBatches} steps done · ${progress.translatedSegments}/${progress.totalSegments} text parts translated`}
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
        </section>
      </main>
    </div>
  );
}

export default App;
