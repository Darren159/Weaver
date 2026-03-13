import * as vscode from 'vscode';

export interface EditorContext {
  query: string;
  language: string;
  filePath: string;
  currentLine: string;
}

// extractContext builds a search query optimized for API doc lookup.
// Focuses on extracting module.method patterns from the current line.
export function extractContext(editor: vscode.TextEditor): EditorContext | null {
  const doc    = editor.document;
  const cursor = editor.selection.active;

  const currentLine = doc.lineAt(cursor.line).text.trim();

  // Skip blanks, comment-only lines
  if (!currentLine) return null;
  if (/^(\/\/|\/\*|\*|#|--|<!--)/.test(currentLine)) return null;

  const imports = extractImports(doc);
  const query = buildQuery(currentLine, imports);

  if (query.trim().length < 3) return null;

  return {
    query,
    language: doc.languageId,
    filePath: doc.uri.fsPath,
    currentLine,
  };
}

function extractImports(doc: vscode.TextDocument): string[] {
  const imports: string[] = [];
  const limit = Math.min(40, doc.lineCount);
  for (let i = 0; i < limit; i++) {
    const line = doc.lineAt(i).text.trim();
    if (/^(import\s|const\s.*require\()/.test(line)) imports.push(line);
  }
  return imports;
}

function buildQuery(currentLine: string, imports: string[]): string {
  const parts: string[] = [];

  // 1. Extract method calls like fs.readFile, path.join, http.createServer
  //    Also matches chained calls: readline.createInterface
  const methodCalls = currentLine.match(/\b([a-zA-Z_$]\w*\.[a-zA-Z_$]\w*)/g);
  if (methodCalls) {
    // Deduplicate and take the most relevant ones
    const unique = [...new Set(methodCalls)];
    parts.push(...unique.slice(0, 3));
  }

  // 2. If no method call found, try to extract standalone identifiers
  //    that might be module names (e.g., when typing `fs.` or just `readFile`)
  if (!methodCalls) {
    const cleaned = currentLine
      .replace(/[{}()[\];,=<>!&|+\-*/?.:'"`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract identifiers > 2 chars, skip common keywords
    const keywords = new Set(['const', 'let', 'var', 'function', 'return', 'await', 'async', 'new', 'this', 'import', 'from', 'require', 'export', 'default', 'class', 'extends', 'true', 'false', 'null', 'undefined', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'throw', 'typeof', 'instanceof']);
    const tokens = cleaned.split(/\s+/)
      .filter(t => t.length > 2 && !keywords.has(t) && /^[a-zA-Z_$]/.test(t))
      .slice(0, 4);

    if (tokens.length > 0) parts.push(...tokens);
  }

  // 3. Add module names from imports for context
  //    e.g., import * as fs from 'fs' → "fs"
  const moduleNames = imports
    .map(imp => {
      // Match: from 'node:fs' or from 'fs' or require('fs')
      const mod = imp.match(/from\s+['"](?:node:)?([^'"\/]+)['"]/)?.[1]
        ?? imp.match(/require\(['"](?:node:)?([^'"\/]+)['"]\)/)?.[1];
      return mod;
    })
    .filter((n): n is string => !!n && n.length > 1);

  // Only add import context if we didn't already find method calls with those modules
  const querySoFar = parts.join(' ');
  for (const mod of moduleNames.slice(0, 2)) {
    if (!querySoFar.includes(mod)) {
      parts.push(mod);
    }
  }

  return parts.join(' ').trim();
}
