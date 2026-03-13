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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

function authorizationHeader(userId: string): string {
  const value = userId.trim();
  if (!value) {
    throw new Error("user_id is required.");
  }
  return `Bearer ${value}`;
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string };
    if (body.detail) {
      return body.detail;
    }
  } catch {
    // Ignore JSON parsing errors and fall through.
  }
  return `Request failed with status ${response.status}`;
}

export async function startGoogleAuth(): Promise<{ auth_url: string; user_id: string }> {
  const response = await fetch(`${API_BASE_URL}/auth/google/init`);
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return (await response.json()) as { auth_url: string; user_id: string };
}

export async function checkAuthStatus(userId: string): Promise<boolean> {
  const response = await fetch(
    `${API_BASE_URL}/auth/google/status?user_id=${encodeURIComponent(userId)}`
  );
  if (!response.ok) return false;
  const body = (await response.json()) as { authenticated: boolean };
  return body.authenticated;
}

export async function revokeAuth(userId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/auth/google?user_id=${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export async function previewFiles(params: {
  userId: string;
  folderLink: string;
  recursive: boolean;
  maxFiles?: number;
}): Promise<DriveFile[]> {
  const query = new URLSearchParams({
    folder_link: params.folderLink,
    recursive: String(params.recursive),
  });
  if (params.maxFiles !== undefined) {
    query.set("max_files", String(params.maxFiles));
  }

  const response = await fetch(`${API_BASE_URL}/folders/list?${query.toString()}`, {
    headers: {
      Authorization: authorizationHeader(params.userId),
    },
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return (await response.json()) as DriveFile[];
}

export async function ingestDrive(params: {
  userId: string;
  folderLink: string;
  recursive: boolean;
}): Promise<IngestResponse> {
  const response = await fetch(`${API_BASE_URL}/ingest/drive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorizationHeader(params.userId),
    },
    body: JSON.stringify({
      folder_link: params.folderLink,
      recursive: params.recursive,
    }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return (await response.json()) as IngestResponse;
}

export async function ingestGithub(params: {
  url: string;
  token?: string;
}): Promise<IngestResponse> {
  const body: Record<string, unknown> = { url: params.url };
  if (params.token?.trim()) {
    body.token = params.token.trim();
  }

  const response = await fetch(`${API_BASE_URL}/ingest/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return (await response.json()) as IngestResponse;
}

export async function uploadFile(params: {
  file: File;
}): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", params.file);

  const response = await fetch(`${API_BASE_URL}/ingest/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return (await response.json()) as UploadResponse;
}

export async function getActiveModel(): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/model`);
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  const data = await response.json();
  return data.model_id;
}

export async function setActiveModel(model_id: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_id }),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  const data = await response.json();
  return data.model_id;
}

export { API_BASE_URL };
