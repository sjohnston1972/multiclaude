// Typed helpers for talking to the local server's REST API.

export interface SessionInfo {
  id: string;
  title: string;
  branch: string | null;
  isRepo: boolean;
  cwd: string;
  pid: number;
  createdAt: number;
  lastOutputAt: number;
  lastBellAt: number;
  attached: boolean;
}

export interface AppSettings {
  fontSize: number;
  scrollback: number;
}

export interface AppState {
  layout: unknown | null;
  settings: AppSettings;
  recentFolders: string[];
}

export async function api<T>(
  url: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      // The API is always live server state (folder listings, sessions, …) —
      // never serve it from the browser cache, or you'd see stale folders.
      cache: "no-store",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the multiclaude server — is it running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `Server error (${res.status} ${res.statusText})`
    );
  }
  return data as T;
}
