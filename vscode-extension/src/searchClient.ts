import * as http  from 'http';
import * as https from 'https';
import { URL }    from 'url';

export interface SearchResult {
  id: string;
  title: string;
  endpoint: string;
  method: string;
  parameters: string;
  requestBody: string;
  responseExample: string;
  apiGroup: string;
  score: number;
  source?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: { value: number; relation: string } | number;
}

// post sends a POST request and returns parsed JSON.
function post<T>(url: string, body: unknown, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const payload = JSON.stringify(body);
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
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

export function search(
  backendUrl: string,
  query: string,
): Promise<SearchResponse> {
  return post<SearchResponse>(`${backendUrl}/api/search`, { query, size: 5 });
}

// completeStream fires a POST to /api/complete and calls onToken for each
// streamed token as it arrives. The stream lifecycle is managed entirely via
// callbacks so the caller (the inline provider) can fire-and-forget it.
export function completeStream(
  backendUrl: string,
  prefix: string,
  suffix: string,
  language: string,
  query: string,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onCancel?: (abort: () => void) => void,
): void {
  const parsed  = new URL(`${backendUrl}/api/complete`);
  const payload = JSON.stringify({ prefix, suffix, language, query });
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
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => onError(new Error(`HTTP ${res.statusCode}: ${data}`)));
        return;
      }

      // Process the SSE stream line-by-line as chunks arrive.
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep any incomplete trailing line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            onDone();
            return;
          }
          try {
            const evt = JSON.parse(data) as { token?: string };
            if (evt.token) onToken(evt.token);
          } catch { /* ignore malformed SSE lines */ }
        }
      });

      res.on('end',  () => onDone());
      res.on('error', onError);
    }
  );

  onCancel?.(() => req.destroy(new Error('Request cancelled')));
  req.on('error', onError);
  req.setTimeout(30_000, () => {
    req.destroy();
    onError(new Error('Request timed out'));
  });

  req.write(payload);
  req.end();
}
