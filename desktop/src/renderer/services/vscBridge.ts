export interface VscContext {
  available: boolean;
  fileName?: string;
  filePath?: string;
  languageId?: string;
  content?: string;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

async function getBridgeBase(): Promise<string> {
  const cfg = await window.electronAPI.getConfig();
  return `http://127.0.0.1:${cfg.bridgePort}`;
}

export async function getVscContext(): Promise<VscContext> {
  try {
    const base = await getBridgeBase();
    const res = await fetch(`${base}/context`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { available: false };
    return (await res.json()) as VscContext;
  } catch {
    return { available: false };
  }
}

export async function applyInVscode(code: string, language: string): Promise<ApplyResult> {
  try {
    const base = await getBridgeBase();
    const res = await fetch(`${base}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language }),
      signal: AbortSignal.timeout(5000),
    });
    return (await res.json()) as ApplyResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}
