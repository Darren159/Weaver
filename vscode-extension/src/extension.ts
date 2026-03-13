import * as vscode from 'vscode';
import { ApiDocsView } from './panel';
import { ChatPanel }   from './chatPanel';
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

  // ── Chat panel (right, opens on command) ────────────────────────────────
  const chatPanel = ChatPanel.getInstance(context.extensionUri, context);
  context.subscriptions.push(
    vscode.commands.registerCommand('weaver.openChat', () => chatPanel.open())
  );

  // ── Desktop panel bridge server ──────────────────────────────────────────
  const bridgeServer = startBridgeServer(chatPanel);
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

      const backendUrl = vscode.workspace
        .getConfiguration('weaver')
        .get<string>('backendUrl', 'http://localhost:8000');

      docsView.showLoading(ctx.query);

      try {
        const response = await search(backendUrl, ctx.query);
        docsView.showResults(response.results, ctx.query);
      } catch (err: unknown) {
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

