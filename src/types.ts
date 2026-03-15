import type JSZip from "jszip";

export type EngineId = "openai" | "google" | "deepl";
export type OutputMode = "translated" | "parallel";
export type DocumentKind = "section" | "nav" | "ncx" | "support";

export interface EngineField {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  required?: boolean;
  help?: string;
}

export interface EngineDefinition {
  id: EngineId;
  label: string;
  tagline: string;
  description: string;
  status: "ready" | "caution" | "blocked";
  browserOnlySupport: "direct" | "warn" | "blocked";
  statusLabel: string;
  fields: EngineField[];
  setupSteps: string[];
  notes: string[];
}

export interface ManifestItem {
  id: string;
  href: string;
  fullPath: string;
  mediaType: string;
  properties: string[];
}

export interface TranslatableDocument {
  path: string;
  mediaType: string;
  kind: DocumentKind;
  title: string;
  originalText: string;
  sourceTexts: string[];
  segmentCount: number;
  hasBody: boolean;
  order: number;
}

export interface SectionSummary {
  path: string;
  title: string;
  order: number;
}

export interface EpubBook {
  fileName: string;
  title: string;
  rootFilePath: string;
  opfDir: string;
  zip: JSZip;
  fileOrder: string[];
  manifest: Record<string, ManifestItem>;
  documents: Record<string, TranslatableDocument>;
  sections: SectionSummary[];
}

export interface TranslationIssue {
  id: string;
  engine: EngineId;
  scope: string;
  message: string;
  recoverable: boolean;
  batchIndex?: number;
  segmentStart?: number;
}

export interface TranslationProgress {
  status: "idle" | "loading" | "ready" | "translating" | "done" | "error";
  totalSegments: number;
  translatedSegments: number;
  totalBatches: number;
  completedBatches: number;
  activeBatches: number;
}

export interface TranslationSettings {
  sourceLanguage: string;
  targetLanguage: string;
  outputMode: OutputMode;
  batchSize: number;
  concurrency: number;
}

export interface ProviderConfigRecord {
  openai: Record<string, string>;
  google: Record<string, string>;
  deepl: Record<string, string>;
}

export interface ProviderRequest {
  texts: string[];
  sourceLanguage: string;
  targetLanguage: string;
  config: Record<string, string>;
  signal: AbortSignal;
}
