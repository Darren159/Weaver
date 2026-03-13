import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  DriveFile,
  IngestResponse,
  UploadResponse,
  startGoogleAuth,
  checkAuthStatus,
  revokeAuth,
  previewFiles,
  ingestDrive,
  ingestGithub,
  uploadFile,
} from "./services/api";

import "./styles.css";

type Source = "upload" | "drive" | "github";

const STORAGE_KEY = "weaver_drive_user_id";

function App() {
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
      <header className="topbar">
        <h1>Elastic Document Console</h1>
      </header>

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
    </div>
  );
}

export default App;
