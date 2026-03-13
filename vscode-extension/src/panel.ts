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
      const methodLower = r.method.toLowerCase();
      const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
      const methodClass = httpMethods.includes(methodLower) ? methodLower : 'module';
      const paramsHtml = r.parameters ? this._renderParams(r.parameters) : '';
      const examplesLabel = httpMethods.includes(methodLower) ? 'Request Body' : 'Example';
      const bodyHtml = r.requestBody
        ? `<div class="section"><span class="section-label">${examplesLabel}</span><pre class="code-block">${esc(r.requestBody)}</pre></div>`
        : '';
      const responseHtml = r.responseExample
        ? `<div class="section"><span class="section-label">Response</span><pre class="code-block">${esc(r.responseExample)}</pre></div>`
        : '';

      return `
        <div class="card">
          <div class="card-header">
            <span class="method-badge ${methodClass}">${esc(r.method)}</span>
            <span class="endpoint">${esc(r.endpoint)}</span>
          </div>
          <div class="card-title">${esc(r.title)}</div>
          ${paramsHtml}
          ${bodyHtml}
          ${responseHtml}
          <div class="card-meta">${esc(r.apiGroup)} &middot; ${esc(r.source ?? '')}</div>
        </div>`;
    }).join('');

    return this._page(`
      <p class="query-line">Query: <em>${esc(query)}</em></p>
      ${cards}
    `);
  }

  private _renderParams(paramsText: string): string {
    const lines = paramsText.split('\n').filter(l => l.trim().startsWith('-'));
    if (!lines.length) { return ''; }
    const rows = lines.map(line => {
      const match = line.match(/^-\s+(\w+)\s+\(([^)]+)\)(.*)$/);
      if (!match) { return `<tr><td colspan="3">${esc(line.replace(/^-\s*/, ''))}</td></tr>`; }
      const [, name, meta, rest] = match;
      const desc = rest.replace(/^\s*[—-]\s*/, '').trim();
      return `<tr><td class="param-name">${esc(name)}</td><td class="param-meta">${esc(meta)}</td><td>${esc(desc.slice(0, 100))}</td></tr>`;
    }).join('');
    return `<div class="section"><span class="section-label">Parameters</span><table class="params-table">${rows}</table></div>`;
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
    .card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .card-title { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .card-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 5px; border-top: 1px solid var(--vscode-panel-border); padding-top: 3px; }
    .method-badge { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; }
    .method-badge.get    { background: #1a7f37; color: #fff; }
    .method-badge.post   { background: #0969da; color: #fff; }
    .method-badge.put    { background: #9a6700; color: #fff; }
    .method-badge.patch  { background: #8250df; color: #fff; }
    .method-badge.delete { background: #cf222e; color: #fff; }
    .method-badge.head   { background: #57606a; color: #fff; }
    .method-badge.module { background: #0d7377; color: #fff; }
    .endpoint { font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 600; color: var(--vscode-textLink-foreground); word-break: break-all; }
    .section { margin: 4px 0; }
    .section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 2px; }
    .params-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .params-table td { padding: 2px 4px 2px 0; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    .param-name { font-family: var(--vscode-editor-font-family); font-weight: 600; white-space: nowrap; }
    .param-meta { color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: 10px; }
    .code-block { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 4px 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto; margin: 2px 0; }
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

