import * as http from 'http';
import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startBridgeServer(chatPanel: ChatPanel): http.Server {
  const port = vscode.workspace
    .getConfiguration('weaver')
    .get<number>('bridgePort', 8765);

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = req.url ?? '/';

    // GET /context — return active editor info
    if (req.method === 'GET' && url === '/context') {
      const editor = chatPanel.activeEditor;
      if (!editor) {
        json(res, 200, { available: false });
        return;
      }
      json(res, 200, {
        available: true,
        fileName: editor.document.fileName.split(/[\\/]/).pop() ?? '',
        filePath: editor.document.fileName,
        languageId: editor.document.languageId,
        content: editor.document.getText(),
      });
      return;
    }

    // POST /apply — apply code to the active editor
    if (req.method === 'POST' && url === '/apply') {
      let body: { code?: string; language?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { ok: false, error: 'Invalid JSON' });
        return;
      }

      const code = typeof body.code === 'string' ? body.code : '';
      const language = typeof body.language === 'string' ? body.language : '';

      if (!code.trim()) {
        json(res, 400, { ok: false, error: 'code is required' });
        return;
      }

      if (!chatPanel.activeEditor) {
        json(res, 200, { ok: false, error: 'No active editor — open a file in VS Code first' });
        return;
      }

      try {
        await chatPanel.applyCode(code, language);
        json(res, 200, { ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 200, { ok: false, error: msg });
      }
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Weaver] Bridge server listening on http://127.0.0.1:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      vscode.window.showWarningMessage(
        `Weaver: Bridge server port ${port} is already in use. ` +
        `Change "weaver.bridgePort" in settings to use a different port.`
      );
    } else {
      console.error('[Weaver] Bridge server error:', err);
    }
  });

  return server;
}
