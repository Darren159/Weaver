import * as vscode from 'vscode';
import * as http  from 'http';
import * as https from 'https';
import { URL }    from 'url';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PendingDiff {
  docUri: vscode.Uri;
  original: string;
}

// Provides "Keep" and "Undo" CodeLens items above the changed region
class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private _change = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._change.event;
  private _state: { doc: vscode.TextDocument; line: number } | undefined;

  show(doc: vscode.TextDocument, line: number): void {
    this._state = { doc, line };
    this._change.fire();
  }

  hide(): void {
    this._state = undefined;
    this._change.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this._state || this._state.doc !== document) { return []; }
    const pos = new vscode.Position(this._state.line, 0);
    const r   = new vscode.Range(pos, pos);
    return [
      new vscode.CodeLens(r, { title: '$(check) Keep', command: 'pkmLinker.keepChange', tooltip: 'Accept this change' }),
      new vscode.CodeLens(r, { title: '$(discard) Undo', command: 'pkmLinker.undoChange', tooltip: 'Revert this change' }),
    ];
  }
}

export class ChatPanel {
  private static _instance: ChatPanel | undefined;
  private _panel: vscode.WebviewPanel | undefined;
  private _messages: ChatMessage[] = [];
  private _inflight = false;
  private _lastEditor: vscode.TextEditor | undefined;
  private _pendingDiff: PendingDiff | undefined;
  private _diffLens = new DiffCodeLensProvider();
  // Single persistent decoration type — cleared by setting empty ranges, never disposed
  private readonly _diffDecType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });

  private constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {
    // Keep _lastEditor pointing at the most recent real text editor.
    this._lastEditor = vscode.window.activeTextEditor;
    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) { this._lastEditor = editor; }
      }),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this._diffLens),
      vscode.commands.registerCommand('pkmLinker.keepChange', () => this._clearDiff(false)),
      vscode.commands.registerCommand('pkmLinker.undoChange', () => this._clearDiff(true)),
    );
  }

  static getInstance(extensionUri: vscode.Uri, context: vscode.ExtensionContext): ChatPanel {
    if (!ChatPanel._instance) {
      ChatPanel._instance = new ChatPanel(extensionUri, context);
    }
    return ChatPanel._instance;
  }

  open(): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Two, false);
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'pkmLinker.chat',
      'PKM Chat',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true,
      },
    );

    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => { this._panel = undefined; });

    // Re-render existing history when panel is re-created
    if (this._messages.length > 0) {
      this._panel.webview.postMessage({ type: 'history', messages: this._messages });
    }

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'send') {
        await this._handleUserMessage(msg.text);
      }
      if (msg.type === 'apply') {
        await this._applyCode(msg.code, msg.language);
      }
      if (msg.type === 'clear') {
        this._messages = [];
      }
    });
  }

  private async _handleUserMessage(text: string): Promise<void> {
    if (this._inflight || !text.trim()) { return; }
    this._inflight = true;

    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    this._messages.push(userMsg);
    this._panel?.webview.postMessage({ type: 'userMsg', content: userMsg.content });
    this._panel?.webview.postMessage({ type: 'streamStart' });

    const backendUrl = vscode.workspace
      .getConfiguration('pkmLinker')
      .get<string>('backendUrl', 'http://localhost:8000');

    // _lastEditor is maintained by onDidChangeActiveTextEditor in the constructor
    const fileContext  = this._lastEditor?.document.getText() ?? '';
    const fileName     = this._lastEditor?.document.fileName.split(/[\\/]/).pop() ?? '';

    let assistantText = '';

    try {
      await streamChat(
        backendUrl,
        this._messages,
        fileContext,
        fileName,
        (token) => {
          assistantText += token;
          this._panel?.webview.postMessage({ type: 'token', token });
        },
        () => {
          this._messages.push({ role: 'assistant', content: assistantText });
          this._panel?.webview.postMessage({ type: 'streamDone' });
          this._inflight = false;
          // Auto-apply any code block that matches the active file's language
          this._autoApplyFromResponse(assistantText).catch(() => {});
        },
        (err) => {
          this._panel?.webview.postMessage({ type: 'error', message: err.message });
          this._inflight = false;
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._panel?.webview.postMessage({ type: 'error', message: msg });
      this._inflight = false;
    }
  }

  /** Detect the top-level function/class name a code block defines. */
  private _detectTopLevelName(code: string): string | null {
    const patterns = [
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/m,
      /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/m,
      /^def\s+(\w+)/m,
    ];
    for (const p of patterns) {
      const m = code.match(p);
      if (m) { return m[1]; }
    }
    return null;
  }

  /**
   * Replace the existing definition of `name` inside `source` with `newCode`.
   * Uses brace-counting for JS/TS; indentation-based for Python def.
   * Returns the new full-file string, or null if the definition wasn't found.
   */
  private _replaceDefinition(source: string, name: string, newCode: string): string | null {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`^(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${esc}\\b`, 'm'),
      new RegExp(`^(export\\s+)?(abstract\\s+)?class\\s+${esc}\\b`, 'm'),
      new RegExp(`^(export\\s+)?(const|let|var)\\s+${esc}\\s*=`, 'm'),
      new RegExp(`^def\\s+${esc}\\b`, 'm'),
    ];

    let startIndex = -1;
    let isPython = false;
    for (const p of patterns) {
      const m = source.match(p);
      if (m?.index !== undefined) {
        startIndex = m.index;
        isPython = /^def\s/.test(p.source.replace(/\^/g, ''));
        break;
      }
    }
    if (startIndex === -1) { return null; }

    let endIndex: number;

    if (isPython) {
      // Indentation-based: collect lines until indent drops back to <= def's indent
      const lines = source.split('\n');
      let charPos = 0;
      let defLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (charPos === startIndex || (charPos <= startIndex && startIndex < charPos + lines[i].length + 1)) {
          defLine = i;
          break;
        }
        charPos += lines[i].length + 1;
      }
      if (defLine === -1) { return null; }
      const defIndent = lines[defLine].match(/^(\s*)/)?.[1].length ?? 0;
      let endLine = defLine + 1;
      while (endLine < lines.length) {
        const l = lines[endLine];
        if (l.trim() !== '' && (l.match(/^(\s*)/)?.[1].length ?? 0) <= defIndent) { break; }
        endLine++;
      }
      endIndex = lines.slice(0, endLine).join('\n').length + (endLine < lines.length ? 1 : 0);
    } else {
      // Brace counting
      let depth = 0;
      let foundOpen = false;
      endIndex = startIndex;
      for (let i = startIndex; i < source.length; i++) {
        const c = source[i];
        if (c === '{') { depth++; foundOpen = true; }
        else if (c === '}') {
          depth--;
          if (foundOpen && depth === 0) { endIndex = i + 1; break; }
        }
      }
      if (!foundOpen) { return null; }
      // Consume trailing newline
      while (endIndex < source.length && (source[endIndex] === '\n' || source[endIndex] === '\r')) { endIndex++; }
    }

    return source.slice(0, startIndex) + newCode.trimEnd() + '\n' + source.slice(endIndex);
  }

  /** Auto-apply the most relevant code block from a completed assistant response. */
  private async _autoApplyFromResponse(text: string): Promise<void> {
    const editor = this._lastEditor;
    if (!editor) { return; }

    const langId  = editor.document.languageId;
    const fileExt = editor.document.fileName.split('.').pop() ?? '';

    const regex = /```(\w*)\n?([\s\S]*?)```/g;
    const blocks: Array<{ lang: string; code: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const lang = m[1] || '';
      const code = m[2].trimEnd();
      if (code.split('\n').length >= 3) { blocks.push({ lang, code }); }
    }
    if (!blocks.length) { return; }

    // Language alias map so e.g. "py" matches "python", "js" matches "javascript"
    const aliases: Record<string, string> = {
      py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', rb: 'ruby', sh: 'shellscript', bash: 'shellscript',
    };
    const normalize = (l: string) => aliases[l.toLowerCase()] ?? l.toLowerCase();
    const fileLang = normalize(langId);

    const matching = blocks.filter(b =>
      !b.lang || normalize(b.lang) === fileLang || normalize(b.lang) === fileExt,
    );
    // Fall back to the largest block if nothing matched by language
    const best = matching[0] ?? blocks.reduce((a, b) => b.code.length > a.code.length ? b : a);

    await this._applyCode(best.code, best.lang);
  }

  private async _applyCode(code: string, language: string): Promise<void> {
    const editor = this._lastEditor ?? vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('PKM Chat: No active editor to apply changes to.');
      return;
    }

    const doc          = editor.document;
    const original     = doc.getText();
    const sameLanguage = !language || doc.languageId === language ||
      doc.fileName.endsWith(`.${language}`);

    this._clearDiff(false); // clear any prior pending diff

    const edit = new vscode.WorkspaceEdit();
    let firstLine: number;
    let lastLine: number;

    if (sameLanguage) {
      // Try to replace a named definition that already exists in the file
      const topName = this._detectTopLevelName(code);
      if (topName) {
        const replaced = this._replaceDefinition(original, topName, code);
        if (replaced) {
          // Find first changed line
          const origLines = original.split('\n');
          const newLines  = replaced.split('\n');
          firstLine = 0;
          while (firstLine < origLines.length && origLines[firstLine] === newLines[firstLine]) { firstLine++; }
          lastLine = firstLine + code.split('\n').length;
          edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), replaced);
          await vscode.workspace.applyEdit(edit);
          this._showDiff(editor, original, firstLine, lastLine);
          return;
        }
      }
    }

    // Append at end of file — never blindly replace the whole file.
    // Strip leading lines that already exist verbatim in the file (e.g. duplicate imports).
    const existingLines = new Set(original.split('\n').map(l => l.trim()).filter(l => l));
    const codeLines = code.split('\n');
    let stripUntil = 0;
    for (let i = 0; i < codeLines.length; i++) {
      const t = codeLines[i].trim();
      if (t && existingLines.has(t)) { stripUntil = i + 1; } else { break; }
    }
    const dedupedCode = codeLines.slice(stripUntil).join('\n').trimStart();
    if (!dedupedCode.trim()) { return; } // nothing new to add

    const sep = original.trimEnd().endsWith('\n') ? '\n' : '\n\n';
    const appended = original.trimEnd() + sep + dedupedCode.trimEnd() + '\n';
    firstLine = original.split('\n').length;
    lastLine  = firstLine + dedupedCode.split('\n').length + 1;
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), appended);
    await vscode.workspace.applyEdit(edit);
    this._showDiff(editor, original, firstLine, lastLine);
  }

  private _showDiff(
    editor: vscode.TextEditor,
    original: string,
    firstLine: number,
    lastLine: number,
  ): void {
    const ranges: vscode.Range[] = [];
    const lineCount = editor.document.lineCount;
    for (let i = firstLine; i < Math.min(lastLine, lineCount); i++) {
      ranges.push(editor.document.lineAt(i).range);
    }
    editor.setDecorations(this._diffDecType, ranges);
    editor.revealRange(
      new vscode.Range(firstLine, 0, Math.min(firstLine + 5, lineCount - 1), 0),
      vscode.TextEditorRevealType.InCenter,
    );

    this._pendingDiff = { docUri: editor.document.uri, original };
    this._diffLens.show(editor.document, firstLine);

    const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? 'file';
    vscode.window.setStatusBarMessage(`$(sparkle) Applied to ${fileName} — Keep or Ctrl+Z to undo`, 8000);
  }

  private _clearDiff(restore: boolean): void {
    if (!this._pendingDiff) { return; }
    const { docUri, original } = this._pendingDiff;
    this._pendingDiff = undefined;
    this._diffLens.hide();
    // Clear decorations from every visible editor showing this document
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this._diffDecType, []);
    }
    if (restore) {
      const targetDoc = vscode.workspace.textDocuments.find(
        d => d.uri.toString() === docUri.toString(),
      );
      if (targetDoc) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(docUri, new vscode.Range(0, 0, targetDoc.lineCount, 0), original);
        vscode.workspace.applyEdit(edit);
      }
    }
  }

  // ── Webview HTML ──────────────────────────────────────────────────────────

  private _buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    /* ── Message list ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .msg { display: flex; flex-direction: column; gap: 2px; max-width: 100%; }

    .msg-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
    }
    .msg.user  .msg-label { color: var(--vscode-textLink-foreground); }

    .msg-body {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px 10px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user .msg-body {
      background: var(--vscode-inputOption-activeBackground,
                       var(--vscode-editorWidget-background));
    }

    /* ── Code blocks inside assistant messages ── */
    .code-fence {
      position: relative;
      margin: 6px 0;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .code-fence-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 8px;
      background: var(--vscode-panel-border);
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .code-fence pre {
      margin: 0;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre;
    }
    .apply-btn {
      font-size: 10px;
      padding: 2px 8px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
    }
    .apply-btn:hover { background: var(--vscode-button-hoverBackground); }

    /* Streaming cursor */
    .cursor { display: inline-block; width: 7px; height: 13px; background: var(--vscode-foreground); vertical-align: text-bottom; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

    /* ── Input bar ── */
    #input-bar {
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    #input {
      flex: 1;
      resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 6px 8px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      line-height: 1.4;
      min-height: 36px;
      max-height: 120px;
      outline: none;
    }
    #input:focus { border-color: var(--vscode-focusBorder); }
    #send-btn {
      align-self: flex-end;
      padding: 6px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    #send-btn:hover { background: var(--vscode-button-hoverBackground); }
    #send-btn:disabled { opacity: 0.5; cursor: default; }

    #clear-btn {
      align-self: flex-end;
      padding: 6px 8px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    #clear-btn:hover { background: var(--vscode-toolbar-hoverBackground); }

    .err-msg { color: var(--vscode-errorForeground); font-size: 11px; padding: 4px 8px; }
  </style>
</head>
<body>
  <div id="messages">
    <div style="color:var(--vscode-descriptionForeground);font-size:12px;text-align:center;padding-top:20px;">
      Ask anything about your code. Code blocks are applied automatically — <strong>Ctrl+Z</strong> to undo.
    </div>
  </div>
  <div id="input-bar">
    <textarea id="input" rows="1" placeholder="Ask about your code…"></textarea>
    <button id="clear-btn" title="Clear chat">Clear</button>
    <button id="send-btn">Send</button>
  </div>

  <script>
    const vscode   = acquireVsCodeApi();
    const msgList  = document.getElementById('messages');
    const inputEl  = document.getElementById('input');
    const sendBtn  = document.getElementById('send-btn');
    const clearBtn = document.getElementById('clear-btn');

    let streamingDiv = null;
    let streamingText = '';

    // ── Auto-resize textarea
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    // ── Send on Enter (Shift+Enter for newline)
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    sendBtn.addEventListener('click', doSend);
    clearBtn.addEventListener('click', () => {
      msgList.innerHTML = '';
      streamingDiv = null;
      streamingText = '';
      vscode.postMessage({ type: 'clear' });
    });

    function doSend() {
      const text = inputEl.value.trim();
      if (!text || sendBtn.disabled) { return; }
      vscode.postMessage({ type: 'send', text });
      inputEl.value = '';
      inputEl.style.height = 'auto';
    }

    // ── Receive messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'history') {
        msgList.innerHTML = '';
        for (const m of msg.messages) {
          appendMessage(m.role, m.content);
        }
        return;
      }

      if (msg.type === 'userMsg') {
        appendMessage('user', msg.content);
        return;
      }

      if (msg.type === 'streamStart') {
        sendBtn.disabled = true;
        streamingText = '';
        streamingDiv = appendMessage('assistant', '');
        return;
      }

      if (msg.type === 'token') {
        streamingText += msg.token;
        if (streamingDiv) {
          updateStreamingMsg(streamingDiv, streamingText);
        }
        return;
      }

      if (msg.type === 'streamDone') {
        sendBtn.disabled = false;
        if (streamingDiv) {
          // Final render — replace raw text with formatted version
          const body = streamingDiv.querySelector('.msg-body');
          if (body) { body.innerHTML = renderMarkdown(streamingText); }
          streamingDiv = null;
          streamingText = '';
        }
        return;
      }

      if (msg.type === 'error') {
        sendBtn.disabled = false;
        const el = document.createElement('div');
        el.className = 'err-msg';
        el.textContent = 'Error: ' + msg.message;
        msgList.appendChild(el);
        msgList.scrollTop = msgList.scrollHeight;
      }
    });

    // ── Append a message bubble; returns the element
    function appendMessage(role, content) {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg ' + role;

      const label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = role === 'user' ? 'You' : 'PKM Assistant';

      const body = document.createElement('div');
      body.className = 'msg-body';
      if (content) {
        body.innerHTML = role === 'assistant' ? renderMarkdown(content) : esc(content);
      } else if (role === 'assistant') {
        body.innerHTML = '<span class="cursor"></span>';
      }

      wrapper.appendChild(label);
      wrapper.appendChild(body);
      msgList.appendChild(wrapper);
      msgList.scrollTop = msgList.scrollHeight;
      return wrapper;
    }

    // ── Update a streaming bubble with raw text + blinking cursor
    function updateStreamingMsg(wrapper, text) {
      const body = wrapper.querySelector('.msg-body');
      if (!body) { return; }
      // Show plain text while streaming (fast path — no parsing)
      body.textContent = text;
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      body.appendChild(cursor);
      msgList.scrollTop = msgList.scrollHeight;
    }

    // ── Minimal markdown renderer (bold, inline code, fenced code blocks)
    // Note: backticks written as \\x60 to avoid ending the TS template literal.
    function renderMarkdown(text) {
      const FENCE = '\\x60\\x60\\x60';
      const parts = text.split(new RegExp('(' + FENCE + '[\\s\\S]*?' + FENCE + ')', 'g'));
      return parts.map((part, i) => {
        if (i % 2 === 1) {
          // Code block
          const re = new RegExp('^' + FENCE + '(\\\\w*)\\\\n?([\\\\s\\\\S]*?)' + FENCE + '$');
          const match = part.match(re);
          if (match) {
            const lang = match[1] || '';
            const code = match[2];
            const escapedCode = esc(code);
            const escapedLang = esc(lang);
            const dataCode = encodeURIComponent(code);
            const dataLang = encodeURIComponent(lang);
            return '<div class="code-fence">'
              + '<div class="code-fence-header">'
              + '<span>' + (escapedLang || 'code') + '</span>'
              + '<button class="apply-btn" onclick="applyCode(decodeURIComponent(\\'' + dataCode + '\\'),decodeURIComponent(\\'' + dataLang + '\\'))">Reapply</button>'
              + '</div>'
              + '<pre>' + escapedCode + '</pre>'
              + '</div>';
          }
        }
        // Inline formatting
        return esc(part)
          .replace(/\*\*(.*?)\*\*/g,  '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g,      '<em>$1</em>')
          .replace(/\\x60([^\\x60]+)\\x60/g, '<code style="font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:0 3px;border-radius:2px">$1</code>')
          .replace(/\\n/g, '<br>');
      }).join('');
    }

    function applyCode(code, lang) {
      vscode.postMessage({ type: 'apply', code: code, language: lang });
    }

    function esc(s) {
      return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>`;
  }
}

// ── Streaming HTTP helper ────────────────────────────────────────────────────

function streamChat(
  backendUrl: string,
  messages: ChatMessage[],
  fileContext: string,
  fileName: string,
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (e: Error) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(`${backendUrl}/api/chat`);
    const payload = JSON.stringify({ messages, fileContext, fileName });
    const lib     = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        if (res.statusCode !== 200) {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => { onError(new Error(`HTTP ${res.statusCode}: ${data}`)); resolve(); });
          return;
        }

        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) { continue; }
            const data = line.slice(6).trim();
            if (data === '[DONE]') { onDone(); resolve(); return; }
            try {
              const evt = JSON.parse(data);
              if (evt.token) { onToken(evt.token); }
            } catch { /* ignore */ }
          }
        });
        res.on('end', () => { onDone(); resolve(); });
      },
    );

    req.on('error', (err) => { onError(err); reject(err); });
    req.setTimeout(60_000, () => { req.destroy(); onError(new Error('Chat request timed out')); });
    req.write(payload);
    req.end();
  });
}
