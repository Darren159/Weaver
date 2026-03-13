import * as http from 'http';
import * as vscode from 'vscode';
import { ApplyService } from './applyService';

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

function readBody(req: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;

    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('Request body timeout'));
    }, timeoutMs);

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => {
      clearTimeout(timeout);
      resolve(data);
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function isLoopback(remoteAddress?: string): boolean {
  if (!remoteAddress) { return false; }
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

export function startBridgeServer(applyService: ApplyService): http.Server {
  const cfg = vscode.workspace.getConfiguration('weaver');
  const port = cfg.get<number>('bridgePort', 8765);
  const maxBodyBytes = cfg.get<number>('bridgeMaxBodyBytes', 512_000);
  const requestTimeoutMs = cfg.get<number>('bridgeRequestTimeoutMs', 10_000);

  const server = http.createServer(async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      json(res, 403, { ok: false, error: 'Forbidden' });
      return;
    }

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

    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && url === '/health') {
      json(res, 200, { ok: true });
      return;
    }

    // GET /context — return active editor info
    if (req.method === 'GET' && url === '/context') {
      const editor = applyService.activeEditor;
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
        body = JSON.parse(await readBody(req, maxBodyBytes, requestTimeoutMs));
      } catch (err) {
        if (err instanceof Error && (err.message === 'Payload too large' || err.message === 'Request body timeout')) {
          const status = err.message === 'Payload too large' ? 413 : 408;
          json(res, status, { ok: false, error: err.message });
          return;
        }
        json(res, 400, { ok: false, error: 'Invalid JSON' });
        return;
      }

      const code = typeof body.code === 'string' ? body.code : '';
      const language = typeof body.language === 'string' ? body.language : '';

      if (!code.trim()) {
        json(res, 400, { ok: false, error: 'code is required' });
        return;
      }

      if (!applyService.activeEditor) {
        json(res, 409, { ok: false, error: 'No active editor — open a file in VS Code first' });
        return;
      }

      try {
        await applyService.applyCode(code, language);
        json(res, 200, { ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 500, { ok: false, error: msg });
      }
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Weaver] Bridge server listening on http://127.0.0.1:${port}`);
  });

  server.headersTimeout = Math.max(requestTimeoutMs + 1000, 5000);
  server.requestTimeout = requestTimeoutMs;

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

  server.on('clientError', (err) => {
    console.error('[Weaver] Bridge client error:', err.message);
  });

  return server;
}
