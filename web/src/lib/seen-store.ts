// History for "Changed since you last looked", kept by the viewer server in its data dir
// (`/api/seen*`, server/viewer/seen.py), namespaced by the root folder's full path, so every
// browser and tab on that server shares it. Writes carry the per-launch X-Root-Token and a JSON
// body (same gate as /api/roots). Every request names the root it is for; the server refuses
// a mismatch (409) after a folder switch. Every method swallows its errors (console.debug) and
// resolves a harmless value; the feature just degrades.
//
// No `@/` or relative value imports: the unit tests run this file directly under node.

export interface SeenRecord {
  root: string;
  path: string;
  mtime: number;
  size: number;
  /** when it was viewed (server clock), ms since the epoch */
  viewedAt: number;
}

export interface Snapshot {
  path: string;
  mtime: number;
  size: number;
  viewedAt: number;
  text: string;
}

export interface ViewedVersion {
  path: string;
  mtime: number;
  size: number;
  /** string: snapshot it; null: no text available (drop a stale snapshot); undefined: leave the snapshot alone */
  text?: string | null;
  /**
   * SHA-256 hex of `text` (UTF-8), computed ahead of time (sha256Hex): a keepalive commit too
   * big for the cap sends this instead of the text, and the server keeps the file's text only
   * if it still hashes to it.
   */
  textSha256?: string;
}

/** A `seen` event on the live-update stream: another tab or browser recorded these paths. */
export interface SeenEvent {
  paths: string[];
  /** the writer's `clientId` (a tab skips its own events) */
  client?: string | null;
  /** the whole history of the folder was cleared (`paths` is empty) */
  cleared?: boolean;
}

export interface ChangeStore {
  readonly root: string;
  /** sent with every write and echoed in the SSE `seen` event */
  readonly clientId: string;
  loadSeen(): Promise<Map<string, SeenRecord>>;
  /** fresh copies of some records (after a `seen` event) */
  getSeen(paths: string[]): Promise<SeenRecord[]>;
  /**
   * The saved copy, null when there is none. A failed request also gives null, unless
   * `throwOnError` (callers that cache the answer must tell "no copy" from "request failed").
   */
  getSnapshot(path: string, opts?: { throwOnError?: boolean }): Promise<Snapshot | null>;
  /** `keepalive`: the page is going away (small bodies only, see KEEPALIVE_MAX) */
  commit(v: ViewedVersion, opts?: { keepalive?: boolean }): Promise<SeenRecord>;
  /** seen records only; snapshots are kept */
  markSeen(entries: { path: string; mtime: number; size: number }[]): Promise<SeenRecord[]>;
  /** exact path and everything below `${from}/` */
  rename(from: string, to: string): Promise<void>;
  /** forget every record and snapshot of the folder; false if the server did not do it */
  clear(): Promise<boolean>;
}

export interface StoreOptions {
  /** the current root token (from /api/config) */
  token: () => string;
  /** re-read the token after a 403 (the server may have restarted); null if unavailable */
  refreshToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
}

/** Browsers cap keepalive request bodies at 64 KiB (all in-flight ones together). */
export const KEEPALIVE_MAX = 60 * 1024;

const BASE = "/api/seen";

const utf8Length = (s: string) => (s.length * 3 <= KEEPALIVE_MAX ? s.length * 3 : new TextEncoder().encode(s).length);

/**
 * Whether a commit carrying `text` might not fit a keepalive body, so its digest is worth
 * computing ahead of time (JSON escaping takes at most 6 bytes per UTF-16 unit). `extra` is the
 * length of the other strings in the body (root and file path, at most 3 UTF-8 bytes per unit).
 */
export function needsDigest(text: string | null | undefined, extra = 0): text is string {
  return typeof text === "string" && text.length * 6 + extra * 3 + 1024 > KEEPALIVE_MAX;
}

/** SHA-256 hex of the UTF-8 encoding of `text`; null where crypto.subtle is missing (not a secure context). */
export async function sha256Hex(text: string): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function newClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // not a secure context
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/**
 * null when the server does not keep the history (an older server, the data dir overlaps the
 * folder, the database cannot be opened) or cannot be reached: the feature turns off.
 * The first loadSeen() returns the records fetched here.
 */
export async function openChangeStore(root: string, opts: StoreOptions): Promise<ChangeStore | null> {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const clientId = newClientId();
  let token = opts.token;

  const bodyOf = (json: unknown) => JSON.stringify({ root, client: clientId, ...(json as object) });
  // UTF-8 bytes
  const fitsKeepalive = (body: string) => body.length <= KEEPALIVE_MAX && utf8Length(body) <= KEEPALIVE_MAX;

  const send = (method: "GET" | "POST", url: string, json?: unknown, keepalive = false) => {
    const init: RequestInit = { method, cache: "no-store", credentials: "same-origin", redirect: "error" };
    if (method === "POST") {
      const body = bodyOf(json);
      init.headers = { "Content-Type": "application/json", "X-Root-Token": token() };
      init.body = body;
      // a bigger body goes as a normal request (it may not finish if the page unloads)
      if (keepalive && fitsKeepalive(body)) init.keepalive = true;
    }
    return doFetch(url, init);
  };

  const call = async <T>(method: "GET" | "POST", url: string, json?: unknown, keepalive = false): Promise<T> => {
    let res = await send(method, url, json, keepalive);
    if (res.status === 403 && method === "POST" && opts.refreshToken) {
      const before = token();
      const fresh = await opts.refreshToken().catch(() => null);
      if (fresh && fresh !== before) {
        token = () => fresh;
        res = await send(method, url, json, keepalive);
      }
    }
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as T;
  };

  const q = (params: Record<string, string>) => new URLSearchParams({ root, ...params }).toString();

  const loadAll = async () => {
    const r = await call<{ records: SeenRecord[] }>("GET", `${BASE}?${q({})}`);
    return new Map(r.records.map((x) => [x.path, x]));
  };

  let first: Map<string, SeenRecord> | null;
  try {
    first = await loadAll();
  } catch (e) {
    console.debug("changes: history unavailable", e);
    return null;
  }

  const fallback = (v: { path: string; mtime: number; size: number }): SeenRecord => ({
    root,
    path: v.path,
    mtime: v.mtime,
    size: v.size,
    viewedAt: Date.now(),
  });

  return {
    root,
    clientId,
    async loadSeen() {
      if (first) {
        const m = first;
        first = null;
        return m;
      }
      try {
        return await loadAll();
      } catch (e) {
        console.debug("changes: loadSeen failed", e);
        return new Map();
      }
    },
    async getSeen(paths) {
      if (!paths.length) return [];
      try {
        return (await call<{ records: SeenRecord[] }>("POST", `${BASE}/get`, { paths })).records;
      } catch (e) {
        console.debug("changes: getSeen failed", e);
        return [];
      }
    },
    async getSnapshot(path, o) {
      try {
        return (await call<{ snapshot: Snapshot | null }>("GET", `${BASE}/snapshot?${q({ path })}`)).snapshot;
      } catch (e) {
        if (o?.throwOnError) throw e;
        console.debug("changes: getSnapshot failed", e);
        return null;
      }
    },
    async commit(v, o) {
      try {
        let body: Record<string, unknown> = { path: v.path, mtime: v.mtime, size: v.size };
        if (v.text !== undefined) body.text = v.text; // absent: leave the snapshot alone
        // Page going away with a body over the keepalive cap: send the digest of the text instead.
        if (o?.keepalive && typeof v.text === "string" && v.textSha256 && !fitsKeepalive(bodyOf(body))) {
          body = { path: v.path, mtime: v.mtime, size: v.size, textSha256: v.textSha256 };
        }
        return (await call<{ record: SeenRecord }>("POST", `${BASE}/commit`, body, o?.keepalive)).record;
      } catch (e) {
        console.debug("changes: commit failed", e);
        return fallback(v);
      }
    },
    async markSeen(entries) {
      if (!entries.length) return [];
      try {
        return (await call<{ records: SeenRecord[] }>("POST", `${BASE}/mark`, { entries })).records;
      } catch (e) {
        console.debug("changes: markSeen failed", e);
        return entries.map(fallback);
      }
    },
    async rename(from, to) {
      if (!from || from === to) return;
      try {
        await call("POST", `${BASE}/rename`, { from, to });
      } catch (e) {
        console.debug("changes: rename failed", e);
      }
    },
    async clear() {
      try {
        await call("POST", `${BASE}/clear`, {});
        return true;
      } catch (e) {
        console.debug("changes: clear failed", e);
        return false;
      }
    },
  };
}
