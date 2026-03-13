import * as vscode from 'vscode';

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
      new vscode.CodeLens(r, { title: '$(check) Keep', command: 'weaver.keepChange', tooltip: 'Accept this change' }),
      new vscode.CodeLens(r, { title: '$(discard) Undo', command: 'weaver.undoChange', tooltip: 'Revert this change' }),
    ];
  }
}

export class ApplyService {
  private _lastEditor: vscode.TextEditor | undefined;
  private _pendingDiff: PendingDiff | undefined;
  private _diffLens = new DiffCodeLensProvider();
  private readonly _diffDecType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._lastEditor = vscode.window.activeTextEditor;
    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) { this._lastEditor = editor; }
      }),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this._diffLens),
      vscode.commands.registerCommand('weaver.keepChange', () => this._clearDiff(false)),
      vscode.commands.registerCommand('weaver.undoChange', () => this._clearDiff(true)),
    );
  }

  public get activeEditor(): vscode.TextEditor | undefined {
    return this._lastEditor;
  }

  public async applyCode(code: string, language: string): Promise<void> {
    const editor = this._lastEditor ?? vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Weaver: No active editor to apply changes to.');
      return;
    }

    const doc          = editor.document;
    const original     = doc.getText();
    const sameLanguage = !language || doc.languageId === language ||
      doc.fileName.endsWith(`.${language}`);

    this._clearDiff(false);

    const edit = new vscode.WorkspaceEdit();
    let firstLine: number;
    let lastLine: number;

    if (sameLanguage) {
      const topName = this._detectTopLevelName(code);
      if (topName) {
        const replaced = this._replaceDefinition(original, topName, code);
        if (replaced) {
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

    // Insert at cursor position (or replace selection if one exists).
    const existingLines = new Set(original.split('\n').map(l => l.trim()).filter(l => l));
    const codeLines = code.split('\n');
    let stripUntil = 0;
    for (let i = 0; i < codeLines.length; i++) {
      const t = codeLines[i].trim();
      if (t && existingLines.has(t)) { stripUntil = i + 1; } else { break; }
    }
    const dedupedCode = codeLines.slice(stripUntil).join('\n').trimStart();
    if (!dedupedCode.trim()) { return; }

    const cursor   = editor.selection;
    const insertAt = cursor.isEmpty
      ? new vscode.Range(cursor.active, cursor.active)
      : cursor;
    firstLine = insertAt.start.line;
    lastLine  = firstLine + dedupedCode.split('\n').length;
    edit.replace(doc.uri, insertAt, dedupedCode.trimEnd() + '\n');
    await vscode.workspace.applyEdit(edit);
    this._showDiff(editor, original, firstLine, lastLine);
  }

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
      while (endIndex < source.length && (source[endIndex] === '\n' || source[endIndex] === '\r')) { endIndex++; }
    }

    return source.slice(0, startIndex) + newCode.trimEnd() + '\n' + source.slice(endIndex);
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
}
