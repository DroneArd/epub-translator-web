import type {
  CompletedSegmentsByPath,
  EngineId,
  ProviderConfigRecord,
  TranslationIssue,
  TranslationProgress,
  TranslationSettings,
  TranslationUsageTotals,
} from "../types";

const DB_NAME = "epub-translator-web";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const SESSION_KEY = "translation-session";
const PREFERENCES_KEY = "epub-translator-web:preferences";

export interface PersistencePreferences {
  rememberSession: boolean;
  rememberApiKeys: boolean;
}

export interface PricingConfigRecord {
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
}

export interface PersistedTranslationSession {
  version: 1;
  savedAt: string;
  bookFileName: string | null;
  bookData: ArrayBuffer | null;
  selectedEngine: EngineId;
  providerConfig: ProviderConfigRecord;
  pricingConfig: PricingConfigRecord;
  settings: TranslationSettings;
  translatedByPath: Record<string, string[]>;
  completedByPath: CompletedSegmentsByPath;
  issues: TranslationIssue[];
  progress: TranslationProgress;
  usageTotals: TranslationUsageTotals;
  sourceCharacterCount: number;
  statusMessage: string;
  previewPath: string;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Could not open browser storage."));
    };
  });
}

function runRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Browser storage request failed."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => Promise<T>,
) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    return await callback(store);
  } finally {
    database.close();
  }
}

export async function loadPersistedSession() {
  return withStore("readonly", async (store) => {
    const value = await runRequest(store.get(SESSION_KEY));
    return (value ?? null) as PersistedTranslationSession | null;
  });
}

export async function savePersistedSession(session: PersistedTranslationSession) {
  return withStore("readwrite", async (store) => {
    await runRequest(store.put(session, SESSION_KEY));
  });
}

export async function clearPersistedSession() {
  return withStore("readwrite", async (store) => {
    await runRequest(store.delete(SESSION_KEY));
  });
}

export function loadPersistencePreferences(): PersistencePreferences {
  if (typeof window === "undefined") {
    return {
      rememberSession: true,
      rememberApiKeys: false,
    };
  }

  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) {
      return {
        rememberSession: true,
        rememberApiKeys: false,
      };
    }

    const parsed = JSON.parse(raw) as Partial<PersistencePreferences>;
    return {
      rememberSession: parsed.rememberSession ?? true,
      rememberApiKeys: parsed.rememberApiKeys ?? false,
    };
  } catch {
    return {
      rememberSession: true,
      rememberApiKeys: false,
    };
  }
}

export function savePersistencePreferences(preferences: PersistencePreferences) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}
