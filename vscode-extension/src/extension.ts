import * as vscode from 'vscode';
import { ApiDocsView } from './panel';
import { ApplyService } from './applyService';
import { extractContext } from './contextExtractor';
import { search } from './searchClient';
import { InlineCompletionProvider } from './inlineCompletionProvider';
import { startBridgeServer } from './bridgeServer';

export function activate(context: vscode.ExtensionContext): void {
  // ── Sidebar docs view (left, primary sidebar) ───────────────────────────
  const docsView = new ApiDocsView(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ApiDocsView.viewType, docsView)
  );

  // ── Apply service (tracks active editor, handles code apply from desktop) ─
  const applyService = new ApplyService(context);

  // ── Desktop panel bridge server ──────────────────────────────────────────
  const bridgeServer = startBridgeServer(applyService);
  context.subscriptions.push({ dispose: () => bridgeServer.close() });

  // ── Inline completion provider ───────────────────────────────────────────
  const inlineProvider = new InlineCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      inlineProvider
    )
  );

  // ── Auto-search on cursor move → update sidebar docs view ───────────────
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let searchSeq = 0;
  let lastSearchKey = '';

  const triggerSearch = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    clearTimeout(debounceTimer);

    const debounceMs = vscode.workspace
      .getConfiguration('weaver')
      .get<number>('debounceMs', 500);

    debounceTimer = setTimeout(async () => {
      const ctx = extractContext(editor);
      if (!ctx) { return; }

      const key = `${editor.document.uri.toString()}::${editor.selection.active.line}::${ctx.query}`;
      if (key === lastSearchKey) { return; }
      lastSearchKey = key;

      const currentSeq = ++searchSeq;

      const backendUrl = vscode.workspace
        .getConfiguration('weaver')
        .get<string>('backendUrl', 'http://localhost:8000');

      docsView.showLoading(ctx.query);

      try {
        const response = await search(backendUrl, ctx.query);
        if (currentSeq !== searchSeq) { return; }
        docsView.showResults(response.results, ctx.query);
      } catch (err: unknown) {
        if (currentSeq !== searchSeq) { return; }
        const msg = err instanceof Error ? err.message : String(err);
        docsView.showError(`Backend unreachable — ${msg}`);
      }
    }, debounceMs);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(triggerSearch),
    vscode.window.onDidChangeActiveTextEditor(triggerSearch)
  );
}

export function deactivate(): void {}
