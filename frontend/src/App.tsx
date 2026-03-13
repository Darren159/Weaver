import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DriveFile,
  IngestResponse,
  UploadResponse,
  AgentRecord,
  startGoogleAuth,
  checkAuthStatus,
  revokeAuth,
  previewFiles,
  ingestDrive,
  ingestGithub,
  uploadFile,
  getActiveModel,
  setActiveModel,
  listAgents,
} from "./services/api";

import "./styles.css";

type Page = "ingest" | "agents";
type Source = "upload" | "drive" | "github";

const STORAGE_KEY = "weaver_drive_user_id";

// ── Agents page ────────────────────────────────────────────────────────────────

function AgentsView() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const data = await listAgents();
      setAgents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="agents-layout">
      {/* Left: agent list */}
      <section className="panel fade-in agents-sidebar">
        <div className="agents-list-header">
          <h2>Agents</h2>
          <button type="button" onClick={load} disabled={isLoading} className="refresh-btn">
            {isLoading ? "…" : "Refresh"}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {!isLoading && agents.length === 0 && !error && (
          <p className="placeholder">No agents found in Elastic.</p>
        )}

        <ul className="agent-list">
          {agents.map((agent) => (
            <li
              key={agent.id}
              className={`agent-list-item${agent.id === selectedId ? " selected" : ""}`}
              onClick={() => setSelectedId(agent.id === selectedId ? null : agent.id)}
            >
              <span className="agent-list-name">{agent.config.name}</span>
              {agent.config.description && (
                <span className="agent-list-desc">{agent.config.description}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Right: detail panel */}
      <section className="panel fade-in agents-detail">
        {selected ? (
          <>
            <h2 className="detail-name">{selected.config.name}</h2>
            {selected.config.description && (
              <p className="agent-description">{selected.config.description}</p>
            )}

            <div className="detail-section">
              <div className="detail-label">System instructions</div>
              <pre className="detail-instructions">{selected.config.system_instructions}</pre>
            </div>

            {selected.config.tools.length > 0 && (
              <div className="detail-section">
                <div className="detail-label">Tools</div>
                <div className="agent-tools">
                  {selected.config.tools.map((t) => (
                    <span
                      key={t.name}
                      className={`tool-badge${t.enabled ? "" : " tool-badge--disabled"}`}
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="detail-section">
              <div className="detail-label">Agent ID</div>
              <code className="agent-id">{selected.id}</code>
            </div>
          </>
        ) : (
          <p className="placeholder">Select an agent to view its details.</p>
        )}
      </section>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────

function App() {
  const [page, setPage] = useState<Page>("ingest");
  const [source, setSource] = useState<Source>("upload");

  // Shared
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  // File upload state
  const [uploadFile_, setUploadFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);

  // Drive auth state
  const [driveUserId, setDriveUserId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? ""
  );
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive form state
  const [folderLink, setFolderLink] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [maxFiles, setMaxFiles] = useState("");
  const [previewResult, setPreviewResult] = useState<DriveFile[] | null>(null);
  const [driveResult, setDriveResult] = useState<IngestResponse | null>(null);

  // GitHub state
  const [githubUrl, setGithubUrl] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubResult, setGithubResult] = useState<IngestResponse | null>(null);

  const parsedMaxFiles = useMemo(() => {
    if (!maxFiles.trim()) return undefined;
    const value = Number(maxFiles);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }, [maxFiles]);

  // Model state
  const [activeModel, setActiveModelId] = useState<string>("us.anthropic.claude-sonnet-4-6");
  const [isUpdatingModel, setIsUpdatingModel] = useState(false);

  const AVAILABLE_MODELS = [
    { id: "us.anthropic.claude-sonnet-4-6",             name: "Claude Sonnet 4.6" },
    { id: "us.anthropic.claude-opus-4-6-v1",            name: "Claude Opus 4.6" },
    { id: "us.anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" },
    { id: "us.anthropic.claude-opus-4-20250514-v1:0",   name: "Claude Opus 4" },
    { id: "us.amazon.nova-pro-v1:0",                    name: "Amazon Nova Pro" },
    { id: "us.amazon.nova-premier-v1:0",                name: "Amazon Nova Premier" },
    { id: "us.anthropic.claude-3-haiku-20240307-v1:0",  name: "Claude 3 Haiku" },
  ];

  useEffect(() => {
    getActiveModel().then(setActiveModelId).catch(console.error);
  }, []);

  const handleModelChange = async (modelId: string) => {
    setIsUpdatingModel(true);
    try {
      const newModel = await setActiveModel(modelId);
      setActiveModelId(newModel);
      setStatus(`Active model set to ${newModel}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update model.");
    } finally {
      setIsUpdatingModel(false);
    }
  };

  // Verify stored user_id on mount and when it changes
  useEffect(() => {
    if (!driveUserId) {
      setIsAuthenticated(false);
      return;
    }
    checkAuthStatus(driveUserId).then(setIsAuthenticated);
  }, [driveUserId]);

  // Persist user_id to localStorage whenever it changes
  useEffect(() => {
    if (driveUserId) {
      localStorage.setItem(STORAGE_KEY, driveUserId);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [driveUserId]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const resetResults = () => {
    setUploadResult(null);
    setPreviewResult(null);
    setDriveResult(null);
    setGithubResult(null);
  };

  const handleSourceChange = (next: Source) => {
    setSource(next);
    setError("");
    setStatus("");
    resetResults();
  };

  // ── Google OAuth ───────────────────────────────────────────────────────────

  const handleConnectDrive = async () => {
    setError("");
    setIsAuthenticating(true);
    try {
      const { auth_url, user_id } = await startGoogleAuth();
      setDriveUserId(user_id);

      const popup = window.open(auth_url, "google-auth", "width=520,height=640");

      pollRef.current = setInterval(async () => {
        const authenticated = await checkAuthStatus(user_id);
        if (authenticated) {
          stopPolling();
          setIsAuthenticated(true);
          setIsAuthenticating(false);
          if (popup && !popup.closed) popup.close();
        } else if (popup?.closed) {
          // User closed popup without completing auth
          stopPolling();
          setIsAuthenticating(false);
        }
      }, 1500);
    } catch (err) {
      setIsAuthenticating(false);
      setError(err instanceof Error ? err.message : "Failed to start Google auth.");
    }
  };

  const handleDisconnectDrive = async () => {
    stopPolling();
    if (driveUserId) await revokeAuth(driveUserId);
    setDriveUserId("");
    setIsAuthenticated(false);
    resetResults();
    setStatus("");
  };

  // ── File upload handler ────────────────────────────────────────────────────

  const handleUpload = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStatus("");

    if (!uploadFile_) {
      setError("Select a file before uploading.");
      return;
    }

    setIsLoading(true);
    resetResults();
    try {
      const result = await uploadFile({ file: uploadFile_ });
      setUploadResult(result);
      setStatus(`Upload complete: ${result.chunks_created} chunk(s) created, ${result.chunks_indexed} indexed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setIsLoading(false);
    }
  };

  // ── Drive handlers ─────────────────────────────────────────────────────────

  const validateDrive = () => {
    if (!isAuthenticated) {
      setError("Connect Google Drive first.");
      return false;
    }
    if (!folderLink.trim()) {
      setError("Google Drive folder link is required.");
      return false;
    }
    return true;
  };

  const handlePreview = async () => {
    setError("");
    setStatus("");
    if (!validateDrive()) return;

    setIsLoading(true);
    resetResults();
    try {
      const files = await previewFiles({
        userId: driveUserId,
        folderLink,
        recursive,
        maxFiles: parsedMaxFiles,
      });
      setPreviewResult(files);
      setStatus(`Previewed ${files.length} file(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDriveIngest = async () => {
    setError("");
    setStatus("");
    if (!validateDrive()) return;

    setIsLoading(true);
    resetResults();
    try {
      const result = await ingestDrive({ userId: driveUserId, folderLink, recursive });
      setDriveResult(result);
      setStatus(`Ingest complete: ${result.indexed} chunk(s) indexed from ${result.files_processed} file(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Drive ingest failed.");
    } finally {
      setIsLoading(false);
    }
  };

  // ── GitHub handler ─────────────────────────────────────────────────────────

  const handleGithubIngest = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStatus("");

    if (!githubUrl.trim()) {
      setError("GitHub URL is required.");
      return;
    }

    setIsLoading(true);
    resetResults();
    try {
      const result = await ingestGithub({ url: githubUrl, token: githubToken });
      setGithubResult(result);
      setStatus(`Ingest complete: ${result.indexed} chunk(s) indexed from ${result.files_processed} file(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub ingest failed.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="topbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Elastic Document Console</h1>
        <div className="model-selector" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label htmlFor="model-select" style={{ fontSize: '13px', color: 'var(--text-muted, #666)' }}>Model:</label>
          <select
            id="model-select"
            value={activeModel}
            onChange={(e) => handleModelChange(e.target.value)}
            disabled={isUpdatingModel}
            style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border, #ccc)' }}
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <nav className="page-tabs" aria-label="Page navigation">
          <button
            type="button"
            className={`tab-btn${page === "ingest" ? " active" : ""}`}
            onClick={() => setPage("ingest")}
          >
            Ingest
          </button>
          <button
            type="button"
            className={`tab-btn${page === "agents" ? " active" : ""}`}
            onClick={() => setPage("agents")}
          >
            Agents
          </button>
        </nav>
      </header>

      {page === "agents" ? (
        <main className="workspace">
          <AgentsView />
        </main>
      ) : (
      <main className="workspace">
        <section className="source-select-wrap" aria-label="Source selector">
          <label className="source-select-label" htmlFor="source-select">
            Ingest source
          </label>
          <select
            id="source-select"
            className="source-select"
            value={source}
            onChange={(e) => handleSourceChange(e.target.value as Source)}
          >
            <option value="upload">File Upload (PDF / Word)</option>
            <option value="drive">Google Drive</option>
            <option value="github">GitHub</option>
          </select>
        </section>

        {source === "upload" && (
          <section className="panel fade-in" key="upload-mode">
            <h2>File Upload</h2>
            <form className="form-grid" onSubmit={handleUpload}>
              <label className="file-upload-label">
                Document (PDF or Word)
                <input
                  aria-label="upload-file"
                  type="file"
                  accept="application/pdf,.pdf,application/msword,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
                  className="file-input-hidden"
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                />
                <span className="file-upload-bar">
                  <span className="file-upload-name">{uploadFile_?.name ?? "No file selected"}</span>
                  <span className="file-upload-action">
                    {uploadFile_ ? "Replace file" : "Choose file"}
                  </span>
                </span>
              </label>

              <div className="actions">
                <button type="submit" className="primary" disabled={isLoading}>
                  {isLoading ? "Uploading..." : "Upload & Ingest"}
                </button>
              </div>
            </form>
          </section>
        )}

        {source === "drive" && (
          <section className="panel fade-in" key="drive-mode">
            <h2>Google Drive</h2>

            <div className="auth-bar">
              {isAuthenticated ? (
                <>
                  <span className="auth-status connected">Connected</span>
                  <button
                    type="button"
                    className="auth-disconnect"
                    onClick={handleDisconnectDrive}
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="primary auth-connect"
                  onClick={handleConnectDrive}
                  disabled={isAuthenticating}
                >
                  {isAuthenticating ? "Waiting for Google..." : "Connect Google Drive"}
                </button>
              )}
            </div>

            {isAuthenticated && (
              <form className="form-grid">
                <label>
                  Drive folder link
                  <input
                    aria-label="folder-link"
                    type="text"
                    value={folderLink}
                    onChange={(e) => setFolderLink(e.target.value)}
                    placeholder="https://drive.google.com/drive/folders/..."
                  />
                </label>

                <label>
                  Max files (optional)
                  <input
                    aria-label="max-files"
                    type="number"
                    value={maxFiles}
                    onChange={(e) => setMaxFiles(e.target.value)}
                    placeholder="50"
                    inputMode="numeric"
                  />
                </label>

                <div className="checkbox-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={recursive}
                      onChange={(e) => setRecursive(e.target.checked)}
                    />
                    recursive
                  </label>
                </div>

                <div className="actions">
                  <button onClick={handlePreview} disabled={isLoading} type="button">
                    {isLoading ? "Loading..." : "Preview Files"}
                  </button>
                  <button onClick={handleDriveIngest} disabled={isLoading} type="button" className="primary">
                    {isLoading ? "Loading..." : "Ingest Files"}
                  </button>
                </div>
              </form>
            )}
          </section>
        )}

        {source === "github" && (
          <section className="panel fade-in" key="github-mode">
            <h2>GitHub Ingest</h2>
            <form className="form-grid" onSubmit={handleGithubIngest}>
              <label>
                GitHub URL
                <input
                  aria-label="github-url"
                  type="text"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/tree/main/docs"
                />
              </label>

              <label>
                Personal access token (optional, for private repos)
                <input
                  aria-label="github-token"
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_..."
                />
              </label>

              <div className="actions">
                <button type="submit" className="primary" disabled={isLoading}>
                  {isLoading ? "Ingesting..." : "Ingest Repo"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="output fade-in" aria-live="polite">
          <h3>Activity</h3>
          {error ? <p className="error">{error}</p> : null}
          {status ? <p className="status">{status}</p> : null}

          {previewResult ? (
            <div>
              <h4>Preview Files ({previewResult.length})</h4>
              <ul className="results-list">
                {previewResult.map((file) => (
                  <li key={file.id}>
                    <strong>{file.name}</strong>
                    <span>{file.mime_type}</span>
                    <span>{file.size ?? "n/a"} bytes</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {driveResult ? (
            <div>
              <h4>Drive Ingest Summary</h4>
              <p>
                Indexed {driveResult.indexed} chunk(s) from {driveResult.files_processed} file(s)
                {driveResult.skipped > 0 ? ` (${driveResult.skipped} skipped)` : ""}.
              </p>
              {driveResult.errors.length ? (
                <ul className="error-list">
                  {driveResult.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {githubResult ? (
            <div>
              <h4>GitHub Ingest Summary</h4>
              <p>
                Indexed {githubResult.indexed} chunk(s) from {githubResult.files_processed} file(s)
                {githubResult.skipped > 0 ? ` (${githubResult.skipped} skipped)` : ""}.
              </p>
              {githubResult.errors.length ? (
                <ul className="error-list">
                  {githubResult.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {uploadResult ? (
            <div>
              <h4>Upload Summary</h4>
              <p>File: {uploadResult.file_name}</p>
              <p>Chunks created: {uploadResult.chunks_created}</p>
              <p>Chunks indexed: {uploadResult.chunks_indexed}</p>
              {uploadResult.errors.length ? (
                <ul className="error-list">
                  {uploadResult.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {!error && !status && !previewResult && !driveResult && !githubResult && !uploadResult ? (
            <p className="placeholder">No activity yet. Run an ingest to populate this panel.</p>
          ) : null}
        </section>
      </main>
      )}
    </div>
  );
}

export default App;
