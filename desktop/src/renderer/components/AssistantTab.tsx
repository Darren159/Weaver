import { FormEvent, useEffect, useRef, useState } from 'react';
import { ChatMessage, GdocsContext, SearchIndex, SearchResult, getGdocsContext, insertInGdocs, searchDocs, streamChat } from '../services/api';
import { VscContext, applyInVscode, getVscContext } from '../services/vscBridge';
import { CodeBlock } from './CodeBlock';

// ── Simple markdown → React renderer ─────────────────────────────────────────

interface MsgPart {
  type: 'text' | 'code';
  content: string;
  language?: string;
}

function parseMarkdown(text: string): MsgPart[] {
  const parts: MsgPart[] = [];
  const fenceRe = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) });
    parts.push({ type: 'code', language: m[1] || '', content: m[2].trimEnd() });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });
  return parts;
}

function MessageContent({
  text,
  streaming,
  onApply,
  applyLabel,
}: {
  text: string;
  streaming: boolean;
  onApply?: (code: string, language: string) => Promise<void>;
  applyLabel?: string;
}) {
  const parts = parseMarkdown(text);
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'code' ? (
          <CodeBlock key={i} code={p.content} language={p.language ?? ''} onApply={onApply} applyLabel={applyLabel} />
        ) : (
          <span key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {p.content}
            {streaming && i === parts.length - 1 ? <span className="cursor-blink">▌</span> : null}
          </span>
        ),
      )}
    </>
  );
}

// ── VS Code panel ─────────────────────────────────────────────────────────────

function VSCodePanel() {
  const searchIndex: SearchIndex = 'github-docs';
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [chatError, setChatError] = useState('');
  const [vscCtx, setVscCtx] = useState<VscContext>({ available: false });
  const [includeContext, setIncludeContext] = useState(true);
  const chatAbortRef = useRef<AbortController | null>(null);
  const accRef = useRef('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Poll VS Code context every 3s
  useEffect(() => {
    const refresh = () => getVscContext().then(setVscCtx);
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError('');
    setSearchResults(null);
    try {
      const results = await searchDocs(searchQuery, 5, searchIndex);
      setSearchResults(results);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleApply = async (code: string, language: string): Promise<void> => {
    const result = await applyInVscode(code, language);
    if (!result.ok) throw new Error(result.error ?? 'Apply failed');
  };

  const handleChat = async (e: FormEvent) => {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text || isChatStreaming) return;

    const fileContext = includeContext && vscCtx.available ? (vscCtx.content ?? '') : '';
    const fileName = includeContext && vscCtx.available ? (vscCtx.fileName ?? '') : '';

    const userMsg: ChatMessage = { role: 'user', content: text };
    const newHistory = [...messages, userMsg];
    setMessages([...newHistory, { role: 'assistant', content: '' }]);
    setChatInput('');
    setChatError('');
    setIsChatStreaming(true);
    accRef.current = '';

    chatAbortRef.current = new AbortController();
    try {
      await streamChat(
        newHistory,
        fileContext,
        fileName,
        (token) => {
          accRef.current += token;
          const accumulated = accRef.current;
          setMessages([...newHistory, { role: 'assistant', content: accumulated }]);
        },
        searchIndex,
        chatAbortRef.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setChatError(err instanceof Error ? err.message : 'Chat failed.');
        setMessages(newHistory);
      }
    } finally {
      setIsChatStreaming(false);
      chatAbortRef.current = null;
    }
  };

  return (
    <div className="assistant-layout">
      {/* VS Code status bar */}
      <div className={`vsc-status ${vscCtx.available ? 'connected' : 'disconnected'}`}>
        {vscCtx.available ? (
          <>
            <span className="vsc-dot" />
            <span>VS Code: <strong>{vscCtx.fileName}</strong></span>
            <label className="ctx-toggle">
              <input
                type="checkbox"
                checked={includeContext}
                onChange={(e) => setIncludeContext(e.target.checked)}
              />
              Include file context
            </label>
          </>
        ) : (
          <>
            <span className="vsc-dot off" />
            <span>VS Code not connected — open VS Code with Weaver extension</span>
          </>
        )}
      </div>

      {/* Search */}
      <section className="panel fade-in">
        <h2>Search</h2>
        <form className="form-grid" onSubmit={handleSearch}>
          <label>
            Query
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="e.g. how to authenticate with Google Drive"
            />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={isSearching}>
              {isSearching ? 'Searching…' : 'Search'}
            </button>
          </div>
        </form>
        {searchError ? <p className="error">{searchError}</p> : null}
        {searchResults !== null ? (
          searchResults.length === 0 ? (
            <p className="placeholder" style={{ marginTop: 10 }}>No results found.</p>
          ) : (
            <ul className="results-list" style={{ marginTop: 12 }}>
              {searchResults.map((r) => (
                <li key={r.id}>
                  <strong>{r.title || '—'}</strong>
                  <span className="result-meta">{r.docType} · {r.source}</span>
                  <span className="result-snippet">{r.content.slice(0, 180)}…</span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      {/* Chat */}
      <section className="panel fade-in">
        <div className="chat-header">
          <h2>Chat</h2>
          {messages.length > 0 && (
            <button
              type="button"
              className="auth-disconnect"
              onClick={() => { chatAbortRef.current?.abort(); setMessages([]); setChatError(''); }}
            >
              Clear
            </button>
          )}
        </div>

        {messages.length > 0 ? (
          <div className="chat-history">
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                <span className="chat-role">{m.role === 'user' ? 'You' : 'Weaver'}</span>
                <div className="chat-content">
                  {m.role === 'assistant' ? (
                    <MessageContent
                      text={m.content}
                      streaming={isChatStreaming && i === messages.length - 1}
                      onApply={vscCtx.available ? handleApply : undefined}
                    />
                  ) : (
                    <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        ) : (
          <p className="placeholder" style={{ margin: '12px 0' }}>
            Ask anything about your code or indexed documents.
          </p>
        )}

        {chatError ? <p className="error">{chatError}</p> : null}

        <form className="chat-input-row" onSubmit={handleChat}>
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Ask a question…"
            disabled={isChatStreaming}
          />
          {isChatStreaming ? (
            <button type="button" onClick={() => chatAbortRef.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={!chatInput.trim()}>Send</button>
          )}
        </form>
      </section>
    </div>
  );
}

// ── Google Docs panel ─────────────────────────────────────────────────────────

function GoogleDocsPanel() {
  const chatIndex: SearchIndex = 'drive-docs';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [chatError, setChatError] = useState('');
  const [gdocsCtx, setGdocsCtx] = useState<GdocsContext>({ available: false });
  const [includeContext, setIncludeContext] = useState(true);
  const chatAbortRef = useRef<AbortController | null>(null);
  const accRef = useRef('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Poll Google Docs context every 3s via backend relay
  useEffect(() => {
    const refresh = () => getGdocsContext().then(setGdocsCtx);
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Connected = sidebar posted context within the last 15s
  const isConnected = gdocsCtx.available &&
    gdocsCtx.updatedAt !== undefined &&
    Date.now() / 1000 - gdocsCtx.updatedAt < 15;

  const handleInsert = async (text: string, _language: string): Promise<void> => {
    const result = await insertInGdocs(text);
    if (!result.ok) throw new Error(result.error ?? 'Insert failed');
  };

  const handleChat = async (e: FormEvent) => {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text || isChatStreaming) return;

    const fileContext = includeContext && isConnected ? (gdocsCtx.prefix ?? '') : '';
    const fileName    = includeContext && isConnected ? (gdocsCtx.docTitle ?? '') : '';

    const userMsg: ChatMessage = { role: 'user', content: text };
    const newHistory = [...messages, userMsg];
    setMessages([...newHistory, { role: 'assistant', content: '' }]);
    setChatInput('');
    setChatError('');
    setIsChatStreaming(true);
    accRef.current = '';

    chatAbortRef.current = new AbortController();
    try {
      await streamChat(
        newHistory,
        fileContext,
        fileName,
        (token) => {
          accRef.current += token;
          setMessages([...newHistory, { role: 'assistant', content: accRef.current }]);
        },
        chatIndex,
        chatAbortRef.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setChatError(err instanceof Error ? err.message : 'Chat failed.');
        setMessages(newHistory);
      }
    } finally {
      setIsChatStreaming(false);
      chatAbortRef.current = null;
    }
  };

  return (
    <div className="assistant-layout">
      {/* Google Docs status bar */}
      <div className={`vsc-status ${isConnected ? 'connected' : 'disconnected'}`}>
        {isConnected ? (
          <>
            <span className="vsc-dot" />
            <span>Google Docs: <strong>{gdocsCtx.docTitle}</strong></span>
            <label className="ctx-toggle">
              <input
                type="checkbox"
                checked={includeContext}
                onChange={(e) => setIncludeContext(e.target.checked)}
              />
              Include doc context
            </label>
          </>
        ) : (
          <>
            <span className="vsc-dot off" />
            <span>Not connected — open the Weaver sidebar in Google Docs</span>
          </>
        )}
      </div>

      {/* Chat */}
      <section className="panel fade-in">
        <div className="chat-header">
          <h2>Chat</h2>
          {messages.length > 0 && (
            <button
              type="button"
              className="auth-disconnect"
              onClick={() => { chatAbortRef.current?.abort(); setMessages([]); setChatError(''); }}
            >
              Clear
            </button>
          )}
        </div>

        {messages.length > 0 ? (
          <div className="chat-history">
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                <span className="chat-role">{m.role === 'user' ? 'You' : 'Weaver'}</span>
                <div className="chat-content">
                  {m.role === 'assistant' ? (
                    <MessageContent
                      text={m.content}
                      streaming={isChatStreaming && i === messages.length - 1}
                      onApply={isConnected ? handleInsert : undefined}
                      applyLabel="Insert in Doc"
                    />
                  ) : (
                    <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        ) : (
          <p className="placeholder" style={{ margin: '12px 0' }}>
            Ask anything about your document or knowledge base.
          </p>
        )}

        {chatError ? <p className="error">{chatError}</p> : null}

        <form className="chat-input-row" onSubmit={handleChat}>
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Ask a question…"
            disabled={isChatStreaming}
          />
          {isChatStreaming ? (
            <button type="button" onClick={() => chatAbortRef.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={!chatInput.trim()}>Send</button>
          )}
        </form>
      </section>
    </div>
  );
}

// ── Exported tab ──────────────────────────────────────────────────────────────

type AssistantApp = 'vscode' | 'googledocs';

export function AssistantTab() {
  const [app, setApp] = useState<AssistantApp>('vscode');

  return (
    <>
      <section className="source-select-wrap">
        <label className="source-select-label" htmlFor="app-select">I'm working in</label>
        <select
          id="app-select"
          className="source-select"
          value={app}
          onChange={(e) => setApp(e.target.value as AssistantApp)}
        >
          <option value="vscode">VS Code</option>
          <option value="googledocs">Google Docs</option>
        </select>
      </section>
      {app === 'vscode' ? <VSCodePanel /> : <GoogleDocsPanel />}
    </>
  );
}
