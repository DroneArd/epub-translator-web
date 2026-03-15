import JSZip from "jszip";
import type {
  DocumentKind,
  EpubBook,
  ManifestItem,
  OutputMode,
  SectionSummary,
  TranslatableDocument,
} from "../types";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

const PREVIEW_STYLE = `
  :root {
    color-scheme: light;
    font-family: "Avenir Next", "Trebuchet MS", sans-serif;
    line-height: 1.6;
  }

  body {
    margin: 0;
    background: linear-gradient(180deg, #fffdf7 0%, #f6efe0 100%);
    color: #1b1812;
    padding: 2rem 1.5rem 3rem;
  }

  body, p, li, blockquote, figcaption, td, th {
    font-size: 1.02rem;
  }

  h1, h2, h3, h4, h5, h6 {
    font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    line-height: 1.2;
    margin-top: 1.75em;
  }

  img, svg {
    max-width: 100%;
    height: auto;
  }

  table {
    max-width: 100%;
  }

  .parallel-layout {
    display: grid !important;
    width: 95% !important;
    max-width: none !important;
    margin: 0 auto !important;
    gap: 1.25rem !important;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
    align-items: stretch !important;
    justify-items: stretch !important;
  }

  .parallel-panel {
    display: block !important;
    width: auto !important;
    min-width: 0 !important;
    max-width: none !important;
    margin: 0 !important;
    box-sizing: border-box !important;
    justify-self: stretch !important;
    align-self: stretch !important;
    background: rgba(255, 252, 244, 0.92) !important;
    border: 1px solid rgba(91, 76, 42, 0.18) !important;
    border-radius: 18px !important;
    padding: 1.25rem !important;
    box-shadow: 0 18px 40px rgba(73, 56, 26, 0.08) !important;
  }

  .parallel-panel h1:first-child,
  .parallel-panel h2:first-child,
  .parallel-panel h3:first-child,
  .parallel-panel p:first-child {
    margin-top: 0;
  }
`;

const EXPORT_PARALLEL_STYLE = `
  .parallel-layout {
    display: table !important;
    width: 95% !important;
    max-width: none !important;
    margin: 0 auto !important;
    table-layout: fixed !important;
    border-spacing: 0 !important;
  }

  .parallel-panel {
    display: table-cell !important;
    width: 50% !important;
    max-width: none !important;
    vertical-align: top !important;
    padding-right: 0.8em !important;
    box-sizing: border-box !important;
  }

  .parallel-panel--translated {
    padding-right: 0 !important;
    padding-left: 0.8em !important;
  }
`;

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function dirname(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basename(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function basenameWithoutExtension(path: string) {
  return basename(path).replace(/\.[^.]+$/, "");
}

function resolvePath(baseDir: string, target: string) {
  if (!target) {
    return normalizePath(baseDir);
  }

  const parts = normalizePath(`${baseDir}/${target}`).split("/");
  const resolved: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      resolved.pop();
      continue;
    }

    resolved.push(part);
  }

  return resolved.join("/");
}

function elementsByLocalName(root: Document | Element, localName: string) {
  const withNamespace = Array.from(root.getElementsByTagNameNS("*", localName));
  if (withNamespace.length) {
    return withNamespace;
  }

  return Array.from(root.getElementsByTagName(localName));
}

function firstElementByLocalName(root: Document | Element, localName: string) {
  return elementsByLocalName(root, localName)[0] ?? null;
}

function parseXml(input: string, contentType: DOMParserSupportedType) {
  const doc = new DOMParser().parseFromString(input, contentType);
  const parserError = firstElementByLocalName(doc, "parsererror");

  if (parserError) {
    throw new Error(parserError.textContent?.trim() || "Failed to parse XML.");
  }

  return doc;
}

function parseDocument(input: string, path: string) {
  const lowerPath = path.toLowerCase();

  if (lowerPath.endsWith(".ncx") || lowerPath.endsWith(".opf") || lowerPath.endsWith(".xml")) {
    return parseXml(input, "application/xml");
  }

  return parseXml(input, "application/xhtml+xml");
}

function isTranslatableText(value: string | null) {
  if (!value) {
    return false;
  }

  if (!value.trim()) {
    return false;
  }

  return /[\p{L}]/u.test(value);
}

function hasSkippedAncestor(node: Node) {
  let current = node.parentNode;

  while (current) {
    if (
      current.nodeType === Node.ELEMENT_NODE &&
      ["script", "style", "title", "meta"].includes(
        (current as Element).localName.toLowerCase(),
      )
    ) {
      return true;
    }

    current = current.parentNode;
  }

  return false;
}

function collectTranslatableTextNodes(root: Node) {
  const ownerDocument =
    root.nodeType === Node.DOCUMENT_NODE
      ? (root as Document)
      : root.ownerDocument ?? document;
  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    if (hasSkippedAncestor(textNode)) {
      continue;
    }
    if (isTranslatableText(textNode.nodeValue)) {
      textNodes.push(textNode);
    }
  }

  return textNodes;
}

function collectSourceTexts(root: Node) {
  return collectTranslatableTextNodes(root).map((node) => node.nodeValue ?? "");
}

function createElement(doc: Document, tagName: string) {
  const namespace = doc.documentElement.namespaceURI || XHTML_NS;
  return doc.createElementNS(namespace, tagName);
}

function clearChildren(element: Element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function moveChildren(from: Element, to: Element) {
  while (from.firstChild) {
    to.appendChild(from.firstChild);
  }
}

function ensureHead(doc: Document) {
  let head = firstElementByLocalName(doc, "head");
  if (head) {
    return head;
  }

  head = createElement(doc, "head");
  const html = firstElementByLocalName(doc, "html");
  if (!html) {
    throw new Error("Document does not contain an html element.");
  }

  html.insertBefore(head, html.firstChild);
  return head;
}

function replaceTexts(root: Node, replacements: string[]) {
  const nodes = collectTranslatableTextNodes(root);

  nodes.forEach((node, index) => {
    node.nodeValue = replacements[index] ?? node.nodeValue ?? "";
  });
}

function deriveTitle(doc: Document, fallbackPath: string, order: number) {
  const title = firstElementByLocalName(doc, "title")?.textContent?.trim();
  if (title) {
    return title;
  }

  const headings = ["h1", "h2", "h3", "h4"];
  for (const headingName of headings) {
    const heading = firstElementByLocalName(doc, headingName)?.textContent?.trim();
    if (heading) {
      return heading;
    }
  }

  return basenameWithoutExtension(fallbackPath) || `Section ${order + 1}`;
}

function isTranslatableManifestItem(item: ManifestItem) {
  const lowerMediaType = item.mediaType.toLowerCase();
  const lowerPath = item.fullPath.toLowerCase();

  return (
    lowerMediaType.includes("xhtml") ||
    lowerMediaType.includes("html") ||
    lowerMediaType.includes("xml") ||
    lowerPath.endsWith(".xhtml") ||
    lowerPath.endsWith(".html") ||
    lowerPath.endsWith(".htm") ||
    lowerPath.endsWith(".ncx")
  );
}

function inspectDocument(
  sourceText: string,
  path: string,
  mediaType: string,
  kind: DocumentKind,
  order: number,
) {
  const doc = parseDocument(sourceText, path);
  const body = firstElementByLocalName(doc, "body");
  const root = body ?? doc.documentElement;
  const sourceTexts = collectSourceTexts(root);

  return {
    path,
    mediaType,
    kind,
    title: deriveTitle(doc, path, order),
    originalText: sourceText,
    sourceTexts,
    segmentCount: sourceTexts.length,
    hasBody: Boolean(body),
    order,
  } satisfies TranslatableDocument;
}

function injectStyle(doc: Document, css: string, marker: string) {
  const head = ensureHead(doc);
  const existing = head.querySelector(`style[data-epub-translator="${marker}"]`);
  if (existing) {
    existing.remove();
  }

  const style = createElement(doc, "style");
  style.setAttribute("type", "text/css");
  style.setAttribute("data-epub-translator", marker);
  style.textContent = css;
  head.appendChild(style);
}

function transformDocument(
  documentRecord: TranslatableDocument,
  translatedTexts: string[] | undefined,
  mode: OutputMode,
  preview: boolean,
) {
  const doc = parseDocument(documentRecord.originalText, documentRecord.path);
  const body = firstElementByLocalName(doc, "body");
  const effectiveTexts = documentRecord.sourceTexts.map(
    (source, index) => translatedTexts?.[index] ?? source,
  );

  if (!body || mode === "translated" || documentRecord.kind !== "section") {
    replaceTexts(body ?? doc.documentElement, effectiveTexts);

    if (preview) {
      injectStyle(doc, PREVIEW_STYLE, "preview");
    }

    return doc;
  }

  const originalBody = body.cloneNode(true) as Element;
  const translatedBody = body.cloneNode(true) as Element;

  replaceTexts(translatedBody, effectiveTexts);
  clearChildren(body);

  const wrapper = createElement(doc, "div");
  wrapper.setAttribute("class", "parallel-layout");

  const originalColumn = createElement(doc, "div");
  originalColumn.setAttribute("class", "parallel-panel parallel-panel--original");
  moveChildren(originalBody, originalColumn);

  const translatedColumn = createElement(doc, "div");
  translatedColumn.setAttribute(
    "class",
    "parallel-panel parallel-panel--translated",
  );
  moveChildren(translatedBody, translatedColumn);

  wrapper.appendChild(originalColumn);
  wrapper.appendChild(translatedColumn);
  body.appendChild(wrapper);

  injectStyle(
    doc,
    preview ? `${EXPORT_PARALLEL_STYLE}\n${PREVIEW_STYLE}` : EXPORT_PARALLEL_STYLE,
    preview ? "preview" : "parallel",
  );

  return doc;
}

function stripStylesheetLinks(doc: Document) {
  for (const link of elementsByLocalName(doc, "link")) {
    if (link.getAttribute("rel")?.toLowerCase() === "stylesheet") {
      link.remove();
    }
  }
}

function extractOriginalPrefixParts(sourceText: string) {
  let remaining = sourceText;
  let xmlDeclaration = "";
  let doctype = "";

  const xmlMatch = remaining.match(/^\s*(<\?xml[\s\S]*?\?>\s*)/i);
  if (xmlMatch) {
    xmlDeclaration = xmlMatch[1];
    remaining = remaining.slice(xmlMatch[0].length);
  }

  const doctypeMatch = remaining.match(/^\s*(<!DOCTYPE[\s\S]*?>\s*)/i);
  if (doctypeMatch) {
    doctype = doctypeMatch[1];
  }

  return {
    xmlDeclaration,
    doctype,
  };
}

function detectSerializedPreamble(serialized: string) {
  const trimmed = serialized.trimStart();
  const xmlMatch = trimmed.match(/^<\?xml[\s\S]*?\?>\s*/i);
  const afterXml = xmlMatch ? trimmed.slice(xmlMatch[0].length) : trimmed;

  return {
    hasXmlDeclaration: Boolean(xmlMatch),
    hasDoctype: /^<!DOCTYPE/i.test(afterXml),
  };
}

function serializeDocument(
  doc: Document,
  sourceText: string,
  preview: boolean,
  hasHtmlRoot: boolean,
) {
  const serialized = new XMLSerializer().serializeToString(doc);
  const { xmlDeclaration, doctype } = extractOriginalPrefixParts(sourceText);
  const { hasXmlDeclaration, hasDoctype } = detectSerializedPreamble(serialized);

  if (preview) {
    if (hasHtmlRoot && !hasXmlDeclaration && !hasDoctype) {
      return `<!DOCTYPE html>\n${serialized}`;
    }

    return serialized;
  }

  let prefix = "";

  if (!hasXmlDeclaration && xmlDeclaration) {
    prefix += xmlDeclaration;
  }

  if (!hasDoctype && doctype) {
    prefix += doctype;
  }

  return `${prefix}${serialized}`;
}

async function loadEpubArchive(input: ArrayBuffer, fileName: string) {
  const zip = await JSZip.loadAsync(input);
  const fileOrder: string[] = [];

  zip.forEach((path) => {
    fileOrder.push(path);
  });

  const containerEntry = zip.file("META-INF/container.xml");
  if (!containerEntry) {
    throw new Error("The EPUB is missing META-INF/container.xml.");
  }

  const containerDoc = parseXml(await containerEntry.async("text"), "application/xml");
  const rootFilePath =
    firstElementByLocalName(containerDoc, "rootfile")?.getAttribute("full-path")?.trim() ??
    "";

  if (!rootFilePath) {
    throw new Error("Could not find the OPF package path in container.xml.");
  }

  const opfEntry = zip.file(rootFilePath);
  if (!opfEntry) {
    throw new Error(`The OPF package file is missing: ${rootFilePath}`);
  }

  const opfDoc = parseXml(await opfEntry.async("text"), "application/xml");
  const opfDir = dirname(rootFilePath);
  const manifestById = new Map<string, ManifestItem>();
  const manifestByPath: Record<string, ManifestItem> = {};

  for (const item of elementsByLocalName(opfDoc, "item")) {
    const id = item.getAttribute("id")?.trim() ?? "";
    const href = item.getAttribute("href")?.trim() ?? "";
    const mediaType = item.getAttribute("media-type")?.trim() ?? "";
    const properties = (item.getAttribute("properties") ?? "")
      .split(/\s+/)
      .filter(Boolean);

    if (!id || !href) {
      continue;
    }

    const manifestItem = {
      id,
      href,
      fullPath: resolvePath(opfDir, href),
      mediaType,
      properties,
    };

    manifestById.set(id, manifestItem);
    manifestByPath[manifestItem.fullPath] = manifestItem;
  }

  const spineItemRefs = elementsByLocalName(opfDoc, "itemref");
  const spineIds = spineItemRefs
    .map((itemRef) => itemRef.getAttribute("idref")?.trim() ?? "")
    .filter(Boolean);
  const spinePaths = spineIds
    .map((id) => manifestById.get(id)?.fullPath)
    .filter((value): value is string => Boolean(value));
  const spinePathSet = new Set(spinePaths);
  const tocId = firstElementByLocalName(opfDoc, "spine")?.getAttribute("toc")?.trim() ?? "";

  const documents: Record<string, TranslatableDocument> = {};
  const sections: SectionSummary[] = [];
  let sectionOrder = 0;
  let supportOrder = spinePaths.length;

  for (const item of manifestById.values()) {
    if (!isTranslatableManifestItem(item)) {
      continue;
    }

    const entry = zip.file(item.fullPath);
    if (!entry) {
      continue;
    }

    const kind: DocumentKind = spinePathSet.has(item.fullPath)
      ? "section"
      : item.properties.includes("nav")
        ? "nav"
        : item.id === tocId || item.fullPath.toLowerCase().endsWith(".ncx")
          ? "ncx"
          : "support";
    const order = kind === "section" ? spinePaths.indexOf(item.fullPath) : supportOrder++;
    const inspected = inspectDocument(
      await entry.async("text"),
      item.fullPath,
      item.mediaType,
      kind,
      order,
    );

    documents[item.fullPath] = inspected;

    if (kind === "section") {
      sections.push({
        path: item.fullPath,
        title: inspected.title,
        order: sectionOrder++,
      });
    }
  }

  sections.sort((left, right) => left.order - right.order);
  const packageTitle =
    firstElementByLocalName(opfDoc, "title")?.textContent?.trim() ||
    basenameWithoutExtension(fileName) ||
    "Untitled EPUB";

  return {
    fileName,
    title: packageTitle,
    rootFilePath,
    opfDir,
    zip,
    fileOrder,
    manifest: manifestByPath,
    documents,
    sections,
  } satisfies EpubBook;
}

export async function loadEpub(file: File) {
  return loadEpubArchive(await file.arrayBuffer(), file.name);
}

export async function loadEpubFromArrayBuffer(
  input: ArrayBuffer,
  fileName: string,
) {
  return loadEpubArchive(input, fileName);
}

export function buildPreviewDocument(
  documentRecord: TranslatableDocument,
  translatedTexts: string[] | undefined,
  mode: OutputMode,
) {
  const doc = transformDocument(documentRecord, translatedTexts, mode, true);
  stripStylesheetLinks(doc);
  return serializeDocument(doc, documentRecord.originalText, true, documentRecord.hasBody);
}

export function buildTranslatedDocument(
  documentRecord: TranslatableDocument,
  translatedTexts: string[] | undefined,
  mode: OutputMode,
) {
  const doc = transformDocument(documentRecord, translatedTexts, mode, false);
  return serializeDocument(doc, documentRecord.originalText, false, documentRecord.hasBody);
}

export async function buildDownloadBlob(
  book: EpubBook,
  translatedByPath: Record<string, string[]>,
  mode: OutputMode,
) {
  const outputZip = new JSZip();
  const orderedPaths = book.fileOrder.includes("mimetype")
    ? ["mimetype", ...book.fileOrder.filter((path) => path !== "mimetype")]
    : [...book.fileOrder];

  for (const path of orderedPaths) {
    const sourceFile = book.zip.file(path);
    if (!sourceFile) {
      continue;
    }

    const translatedDocument = book.documents[path];
    const options = {
      binary: !translatedDocument,
      compression: "STORE",
      createFolders: false,
      date: sourceFile.date,
      dir: sourceFile.dir,
      comment: sourceFile.comment,
      unixPermissions: sourceFile.unixPermissions,
      dosPermissions: sourceFile.dosPermissions,
    } as const;

    if (translatedDocument) {
      outputZip.file(
        path,
        buildTranslatedDocument(
          translatedDocument,
          translatedByPath[path],
          mode,
        ),
        {
          ...options,
          binary: false,
        },
      );
      continue;
    }

    outputZip.file(path, await sourceFile.async("uint8array"), options);
  }

  return outputZip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "STORE",
  });
}

export function createDownloadName(fileName: string, targetLanguage: string, mode: OutputMode) {
  const normalizedName = basenameWithoutExtension(fileName) || "translated-book";
  const languageToken = targetLanguage.trim() || "translated";
  const modeToken = mode === "parallel" ? "parallel" : "translated";
  return `${normalizedName}.${languageToken}.${modeToken}.epub`;
}
