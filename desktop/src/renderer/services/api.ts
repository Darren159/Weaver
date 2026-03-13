// Desktop-adapted api.ts — base URL comes from Electron IPC config instead of import.meta.env

export type DriveFile = {
  id: string;
  name: string;
  mime_type: string;
  size: number | null;
};

export type IngestResponse = {
  indexed: number;
  files_processed: number;
  skipped: number;
  errors: string[];
};

export type UploadResponse = {
  file_name: string;
  size_bytes: number;
  chunks_created: number;
  chunks_indexed: number;
  errors: string[];
};

export type SearchResult = {
  id: string;
  index: string;
  title: string;
  content: string;
  score: number;
  source: string;
  docType: string;
  tags: string[];
};

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type SearchIndex = 'drive-docs' | 'github-docs';

export type AgentRecord = {
  id: string;
  config: {
    name: string;
    description?: string;
    system_instructions: string;
  };
};

// ── Config cache ──────────────────────────────────────────────────────────────

let _backendUrl: string | null = null;

async function getBase(): Promise<string> {
  if (_backendUrl) return _backendUrl;
  const cfg = await window.electronAPI.getConfig();
  _backendUrl = cfg.backendUrl;
  return _backendUrl;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function authorizationHeader(userId: string): string {
  const value = userId.trim();
  if (!value) throw new Error('user_id is required.');
  return `Bearer ${value}`;
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string };
    if (body.detail) return body.detail;
  } catch { /* ignore */ }
  return `Request failed with status ${response.status}`;
}

async function consumeSSE(
  response: Response,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) { reader.cancel(); return; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as { token?: string };
          if (parsed.token) onToken(parsed.token);
        } catch { /* ignore */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function startGoogleAuth(): Promise<{ auth_url: string; user_id: string }> {
  const base = await getBase();
  const response = await fetch(`${base}/auth/google/init`);
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as { auth_url: string; user_id: string };
}

export async function checkAuthStatus(userId: string): Promise<boolean> {
  const base = await getBase();
  const response = await fetch(`${base}/auth/google/status?user_id=${encodeURIComponent(userId)}`);
  if (!response.ok) return false;
  const body = (await response.json()) as { authenticated: boolean };
  return body.authenticated;
}

export async function revokeAuth(userId: string): Promise<void> {
  const base = await getBase();
  await fetch(`${base}/auth/google?user_id=${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// ── Drive ─────────────────────────────────────────────────────────────────────

export async function previewFiles(params: {
  userId: string;
  folderLink: string;
  recursive: boolean;
  maxFiles?: number;
}): Promise<DriveFile[]> {
  const base = await getBase();
  const query = new URLSearchParams({ folder_link: params.folderLink, recursive: String(params.recursive) });
  if (params.maxFiles !== undefined) query.set('max_files', String(params.maxFiles));
  const response = await fetch(`${base}/folders/list?${query.toString()}`, {
    headers: { Authorization: authorizationHeader(params.userId) },
  });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as DriveFile[];
}

export async function ingestDrive(params: {
  userId: string;
  folderLink: string;
  recursive: boolean;
}): Promise<IngestResponse> {
  const base = await getBase();
  const response = await fetch(`${base}/ingest/drive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorizationHeader(params.userId) },
    body: JSON.stringify({ folder_link: params.folderLink, recursive: params.recursive }),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as IngestResponse;
}

// ── GitHub ────────────────────────────────────────────────────────────────────

export async function ingestGithub(params: { url: string; token?: string }): Promise<IngestResponse> {
  const base = await getBase();
  const body: Record<string, unknown> = { url: params.url };
  if (params.token?.trim()) body.token = params.token.trim();
  const response = await fetch(`${base}/ingest/github`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as IngestResponse;
}

// ── Upload ────────────────────────────────────────────────────────────────────

export async function uploadFile(params: { file: File }): Promise<UploadResponse> {
  const base = await getBase();
  const formData = new FormData();
  formData.append('file', params.file);
  const response = await fetch(`${base}/ingest/upload`, { method: 'POST', body: formData });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as UploadResponse;
}

// ── Assistant ─────────────────────────────────────────────────────────────────

export async function searchDocs(query: string, size = 5, index?: SearchIndex): Promise<SearchResult[]> {
  const base = await getBase();
  const response = await fetch(`${base}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, size, index }),
  });
  if (!response.ok) throw new Error(await parseError(response));
  const data = (await response.json()) as { results: SearchResult[] };
  return data.results;
}

export async function streamChat(
  messages: ChatMessage[],
  fileContext: string,
  fileName: string,
  onToken: (token: string) => void,
  index?: SearchIndex,
  signal?: AbortSignal,
  agentInstructions?: string,
): Promise<void> {
  const base = await getBase();
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, fileContext, fileName, index, agentInstructions }),
    signal,
  });
  if (!response.ok) throw new Error(await parseError(response));
  await consumeSSE(response, onToken, signal);
}

export async function streamComplete(
  params: { prefix: string; suffix?: string; language?: string; index?: SearchIndex },
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const base = await getBase();
  const response = await fetch(`${base}/api/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prefix: params.prefix,
      suffix: params.suffix ?? '',
      language: params.language ?? '',
      index: params.index,
      query: params.prefix.slice(-150).trim(),
    }),
    signal,
  });
  if (!response.ok) throw new Error(await parseError(response));
  await consumeSSE(response, onToken, signal);
}

// ── Google Docs bridge ────────────────────────────────────────────────────────

export type GdocsContext = {
  available: boolean;
  docTitle?: string;
  prefix?: string;
  suffix?: string;
  updatedAt?: number;
};

export async function getGdocsContext(): Promise<GdocsContext> {
  try {
    const base = await getBase();
    const response = await fetch(`${base}/api/gdocs/context`);
    if (!response.ok) return { available: false };
    return (await response.json()) as GdocsContext;
  } catch {
    return { available: false };
  }
}

export async function insertInGdocs(text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const base = await getBase();
    const response = await fetch(`${base}/api/gdocs/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) return { ok: false, error: await parseError(response) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Insert failed' };
  }
}

// ── Model selection ───────────────────────────────────────────────────────────

export const BEDROCK_MODELS: { id: string; label: string }[] = [
  { id: 'us.anthropic.claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
  { id: 'us.anthropic.claude-opus-4-6',           label: 'Claude Opus 4.6' },
  { id: 'us.anthropic.claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'us.anthropic.claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { id: 'us.anthropic.claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
];

export async function getActiveModel(): Promise<string> {
  try {
    const base = await getBase();
    const response = await fetch(`${base}/api/model`);
    if (!response.ok) return BEDROCK_MODELS[0].id;
    const data = (await response.json()) as { model_id: string };
    return data.model_id;
  } catch {
    return BEDROCK_MODELS[0].id;
  }
}

export async function setActiveModel(modelId: string): Promise<void> {
  const base = await getBase();
  await fetch(`${base}/api/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId }),
  });
}

// ── Agents ────────────────────────────────────────────────────────────────────

export async function listAgents(): Promise<AgentRecord[]> {
  try {
    const base = await getBase();
    const response = await fetch(`${base}/agents`);
    if (!response.ok) return [];
    return (await response.json()) as AgentRecord[];
  } catch {
    return [];
  }
}
