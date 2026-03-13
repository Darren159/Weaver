// Code.ts — Server-side Apps Script for PKM Linker Google Workspace Add-on
//
// All functions in this file run on Google's servers (not in the browser).
// They are called from sidebar.html via google.script.run.functionName().
//
// Provides:
//   onOpen            — adds "PKM Linker" menu to Google Docs
//   showSidebar       — opens the HTML sidebar panel
//   getCursorContext  — reads text around the cursor (prefix + suffix)
//   insertAtCursor    — inserts text at the current cursor position
//   getBackendUrl     — reads stored backend URL from user properties
//   setBackendUrl     — persists backend URL to user properties
//   indexFolder       — indexes all Google Docs in the same Drive folder

// ── Types ─────────────────────────────────────────────────────────────────────

interface CursorContext {
  prefix: string;
  suffix: string;
  documentTitle: string;
}

interface IngestDoc {
  title: string;
  content: string;
  endpoint: string;
  method: string;
  parameters: string;
  request_body: string;
  response_example: string;
  api_group: string;
  tags: string[];
  source: string;
}

// ── Triggers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onOpen(): void {
  DocumentApp.getUi()
    .createMenu('PKM Linker')
    .addItem('Open sidebar', 'showSidebar')
    .addToUi();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function showSidebar(): void {
  const html = HtmlService.createHtmlOutputFromFile('src/sidebar')
    .setTitle('PKM Linker')
    .setWidth(320);
  DocumentApp.getUi().showSidebar(html);
}

// ── Cursor context ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getCursorContext(): CursorContext {
  const doc   = DocumentApp.getActiveDocument();
  const body  = doc.getBody();
  const title = doc.getName();
  const cursor = doc.getCursor();

  const bodyText = body.getText();

  if (!cursor) {
    return {
      prefix: bodyText.slice(-2000),
      suffix: '',
      documentTitle: title,
    };
  }

  // getSurroundingText() returns the Text element of the paragraph containing
  // the cursor. getSurroundingTextOffset() is the character offset inside it.
  const surroundingText   = cursor.getSurroundingText().getText();
  const offsetInParagraph = cursor.getSurroundingTextOffset();

  // Find where this paragraph starts in the full body text, then compute
  // the absolute cursor position.
  const paraStart = bodyText.indexOf(surroundingText);
  const cursorPos = paraStart !== -1
    ? paraStart + offsetInParagraph
    : offsetInParagraph;

  return {
    prefix:        bodyText.slice(Math.max(0, cursorPos - 2000), cursorPos),
    suffix:        bodyText.slice(cursorPos, cursorPos + 500),
    documentTitle: title,
  };
}

// ── Text insertion ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function insertAtCursor(text: string): void {
  const doc    = DocumentApp.getActiveDocument();
  const cursor = doc.getCursor();
  if (!cursor) { return; }
  cursor.insertText(text);
}

// ── Backend URL persistence ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getBackendUrl(): string {
  return PropertiesService.getUserProperties()
    .getProperty('backendUrl') ?? 'http://localhost:3000';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setBackendUrl(url: string): void {
  PropertiesService.getUserProperties().setProperty('backendUrl', url);
}

// ── Drive folder indexing ─────────────────────────────────────────────────────
// Exports all Google Docs in the same folder as the current document,
// chunks them into ~1500-char pieces, and POSTs to /api/ingest.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function indexFolder(): string {
  const doc       = DocumentApp.getActiveDocument();
  const docId     = doc.getId();
  const backendUrl = getBackendUrl();

  const file    = DriveApp.getFileById(docId);
  const parents = file.getParents();
  if (!parents.hasNext()) { return 'Could not find parent folder.'; }
  const folder = parents.next();

  const files = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  const batch: IngestDoc[] = [];
  let totalChunks = 0;
  let totalFiles  = 0;

  while (files.hasNext()) {
    const f = files.next();
    try {
      const content = DocumentApp.openById(f.getId()).getBody().getText();
      batch.push(...chunkText(content, f.getName()));
      totalFiles++;

      if (batch.length >= 20) {
        postIngest(backendUrl, batch.splice(0, 20));
        totalChunks += 20;
      }
    } catch {
      // Skip files that cannot be opened (permissions, etc.)
    }
  }

  if (batch.length > 0) {
    postIngest(backendUrl, batch);
    totalChunks += batch.length;
  }

  return `Indexed ${totalChunks} chunks from ${totalFiles} documents.`;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function chunkText(text: string, fileName: string): IngestDoc[] {
  const MAX_CHARS = 1500;
  const paragraphs = text.split(/\n{2,}/);
  const chunks: IngestDoc[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (buffer && buffer.length + para.length > MAX_CHARS) {
      if (buffer.trim().length > 60) {
        chunks.push(makeChunk(buffer.trim(), fileName));
      }
      buffer = para;
    } else {
      buffer += (buffer ? '\n\n' : '') + para;
    }
  }
  if (buffer.trim().length > 60) {
    chunks.push(makeChunk(buffer.trim(), fileName));
  }
  return chunks;
}

function makeChunk(content: string, fileName: string): IngestDoc {
  const title = content.split('\n')[0].slice(0, 120) || fileName;
  return {
    title,
    content,
    endpoint:         '',
    method:           'google-drive',
    parameters:       '',
    request_body:     '',
    response_example: '',
    api_group:        fileName,
    tags:             ['google-drive', fileName],
    source:           `drive/${fileName}`,
  };
}

function postIngest(backendUrl: string, docs: IngestDoc[]): void {
  UrlFetchApp.fetch(`${backendUrl}/api/ingest`, {
    method:  'post',
    contentType: 'application/json',
    payload: JSON.stringify({ documents: docs }),
    muteHttpExceptions: true,
  });
}
