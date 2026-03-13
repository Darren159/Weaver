import * as vscode from 'vscode';
import { extractContext } from './contextExtractor';
import { completeStream } from './searchClient';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  // Incremented when document content changes — invalidates any in-flight stream.
  private docGeneration = 0;
  // Incremented on every provider call — used only for debouncing keystrokes.
  private callGeneration = 0;
  // docGeneration when the active stream started (-1 = no stream).
  private inflightDocGen = -1;
  private abortCurrentRequest: (() => void) | undefined;
  private lastDocVersion = -1;
  // Tokens accumulated so far from the active stream.
  private streamedCompletion = '';
  // The prefix that triggered the active stream.
  private streamingPrefix: string | undefined;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    const docVersion = document.version;

    // Document content changed — abort any active stream and reset state.
    if (docVersion !== this.lastDocVersion) {
      this.abortCurrentRequest?.();
      this.abortCurrentRequest = undefined;
      this.lastDocVersion = docVersion;
      this.docGeneration++;
      this.inflightDocGen = -1;
      this.streamingPrefix = undefined;
      this.streamedCompletion = '';
    }

    const docGen = this.docGeneration;

    const prefix = document.getText(new vscode.Range(
      new vscode.Position(Math.max(0, position.line - 20), 0),
      position
    ));

    // Stream already in progress for this prefix — return whatever tokens have
    // arrived so far. VS Code will call us again on the next inlineSuggest.trigger
    // fired from onToken, showing progressively longer ghost text each time.
    if (this.streamingPrefix === prefix) {
      if (!this.streamedCompletion) { return []; }
      return [new vscode.InlineCompletionItem(
        this.streamedCompletion,
        new vscode.Range(position, position)
      )];
    }

    // A stream is already running for this doc version but at a different prefix
    // (shouldn't normally happen, but guard anyway).
    if (this.inflightDocGen === docGen) { return []; }

    // Debounce: wait for the user to pause before sending the request.
    const callGen = ++this.callGeneration;
    const debounceMs = vscode.workspace
      .getConfiguration('pkmLinker')
      .get<number>('debounceMs', 500);
    await new Promise<void>(resolve => setTimeout(resolve, debounceMs));

    if (callGen !== this.callGeneration) { return []; }
    if (docGen !== this.docGeneration)   { return []; }
    if (token.isCancellationRequested)   { return []; }
    if (this.inflightDocGen === docGen)  { return []; }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) { return []; }

    const ctx = extractContext(editor);
    if (!ctx) { return []; }

    const suffix = document.getText(new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + 5), 0)
    ));

    const backendUrl = vscode.workspace
      .getConfiguration('pkmLinker')
      .get<string>('backendUrl', 'http://localhost:3000');

    // Mark the stream as started BEFORE the async callbacks fire.
    this.inflightDocGen   = docGen;
    this.streamingPrefix  = prefix;
    this.streamedCompletion = '';

    console.log('[inline] starting stream, query:', ctx.query);

    completeStream(
      backendUrl, prefix, suffix, ctx.language, ctx.query,
      // onToken — append and re-trigger so VS Code picks up the longer text.
      (tok) => {
        if (docGen !== this.docGeneration) { return; }
        this.streamedCompletion += tok;
        vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      },
      // onDone — guard against stale callbacks from an already-aborted stream
      // firing after a new stream has started and corrupting its state.
      () => {
        if (docGen !== this.docGeneration) { return; }
        this.inflightDocGen = -1;
        console.log('[inline] stream done, total length:', this.streamedCompletion.length);
      },
      // onError
      (err) => {
        if (docGen !== this.docGeneration) { return; } // stale callback — new stream already owns state
        this.inflightDocGen  = -1;
        this.streamingPrefix = undefined;
        // "aborted" is the Node.js error when req.destroy() is called mid-response.
        // "Request cancelled" is our own destroy() call. Both are expected on abort.
        if (err.message !== 'Request cancelled' && err.message !== 'aborted') {
          console.error('[inline] stream error:', err.message);
        }
      },
      // onCancel — wired to document-change abort only (not the VS Code token,
      // which gets cancelled on every re-trigger we fire ourselves).
      (abort) => { this.abortCurrentRequest = abort; }
    );

    // Return empty for now. The first onToken fires inlineSuggest.trigger, which
    // calls us again — that call hits the streamingPrefix branch above and returns
    // the first chunk of ghost text. Subsequent tokens keep extending it.
    return [];
  }
}
