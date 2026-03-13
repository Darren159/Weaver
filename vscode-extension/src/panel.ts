import * as vscode from 'vscode';
import { SearchResult } from './searchClient';

// ApiDocsView is a WebviewViewProvider — it registers as a sidebar view
// in the primary sidebar (left). VS Code shows it in the activity bar.
export class ApiDocsView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pkmLinker.docsView';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: false,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._idleHtml();
  }

  showResults(results: SearchResult[], query: string): void {
    if (!this._view) { return; }
    this._view.webview.html = this._resultsHtml(results, query);
    this._view.show(true); // reveal without stealing focus
  }

  showLoading(query: string): void {
    if (!this._view) { return; }
    this._view.webview.html = this._statusHtml(`Searching for <em>${esc(query)}</em>&hellip;`);
  }

  showError(msg: string): void {
    if (!this._view) { return; }
    this._view.webview.html = this._statusHtml(`<span class="err">${esc(msg)}</span>`);
  }

  // ── Private HTML builders ─────────────────────────────────────────────────

  private _resultsHtml(results: SearchResult[], query: string): string {
    if (!results.length) {
      return this._page(`
        <p class="query-line">Query: <em>${esc(query)}</em></p>
        <p class="muted center">No matching docs found</p>
      `);
    }

    const cards = results.map(r => {
      const snippet = r.content ? `<div class="card-snippet">${esc(r.content.slice(0, 220))}</div>` : '';
      const tagsHtml = r.tags?.length
        ? r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
        : '';
      return `
        <div class="card">
          <div class="card-header">
            <span class="doc-type-badge type-${esc(r.docType ?? '')}">${esc(r.docType ?? '')}</span>
            <span class="card-title">${esc(r.title || '—')}</span>
          </div>
          ${snippet}
          <div class="card-meta">${tagsHtml}${tagsHtml && r.source ? ' &middot; ' : ''}${esc(r.source ?? '')}</div>
        </div>`;
    }).join('');

    return this._page(`
      <p class="query-line">Query: <em>${esc(query)}</em></p>
      ${cards}
    `);
  }

  private _idleHtml(): string {
    return this._page('<p class="muted center">Start typing to surface related docs</p>');
  }

  private _statusHtml(innerHtml: string): string {
    return this._page(`<p class="muted center">${innerHtml}</p>`);
  }

  private _page(content: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 10px 12px;
      margin: 0;
      line-height: 1.5;
    }
    em { font-style: normal; background: var(--vscode-editor-findMatchHighlightBackground); border-radius: 2px; padding: 0 1px; }
    .err { color: var(--vscode-errorForeground); }
    .muted { color: var(--vscode-descriptionForeground); }
    .center { text-align: center; padding-top: 24px; }
    .query-line { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
    .card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    .card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .card-title { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); flex: 1; word-break: break-word; }
    .card-snippet { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.45; margin-bottom: 5px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .card-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 5px; border-top: 1px solid var(--vscode-panel-border); padding-top: 3px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .doc-type-badge { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; white-space: nowrap; flex-shrink: 0; }
    .type-drive-pdf    { background: #0969da; color: #fff; }
    .type-drive-doc    { background: #0d7377; color: #fff; }
    .type-github-markdown { background: #1a7f37; color: #fff; }
    .type-upload-pdf   { background: #8250df; color: #fff; }
    .type-upload-doc   { background: #9a6700; color: #fff; }
    .tag { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 4px; border-radius: 3px; }
  </style>
</head>
<body>${content}</body>
</html>`;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

