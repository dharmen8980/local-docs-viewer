// Client for the opt-in editing API (/api/edit/*). Every request is a relative
// same-origin URL, carries the per-launch X-Edit-Token and a JSON body (or
// multipart for uploads), so the server's CSRF checks always pass for us and
// never for another page.

import { ApiError, rawUrl, type AppConfig } from "@/lib/api";

export const EDIT_MAX_BYTES = 2 * 1024 * 1024;

export interface SaveResult {
  path: string;
  sha256: string;
  size: number;
  mtime: number;
  history_id: string | null;
}

export interface CurrentInfo {
  sha256: string;
  size: number;
  mtime: number;
}

export interface HistoryVersion {
  id: string;
  path: string;
  saved_at: number | string;
  size: number;
  sha256: string;
  reason: string;
}

export interface TrashItem {
  id: string;
  original_path: string;
  deleted_at: number | string;
  kind: "file" | "dir";
  size: number;
  file_count: number;
}

export interface AuditEntry {
  ts: number | string;
  op: string;
  path: string;
  to?: string;
  size?: number;
  sha256?: string;
  history_id?: string;
  trash_id?: string;
}

// ---------- token ----------

let token = "";
let refresher: (() => Promise<string | null>) | null = null;

/** Set the edit token (from /api/config) and a way to re-read it after a server restart. */
export function configureEditClient(t: string, refresh: () => Promise<string | null>) {
  token = t;
  refresher = refresh;
}

function detailMessage(status: number, body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  if (status === 0) return "Cannot reach the viewer server.";
  return fallback;
}

interface RequestOpts {
  json?: unknown;
  form?: FormData;
  text?: boolean;
  signal?: AbortSignal;
}

async function send(method: string, url: string, opts: RequestOpts): Promise<Response> {
  const headers: Record<string, string> = { "X-Edit-Token": token };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form; // the browser sets multipart/form-data with the boundary
  } else if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = "{}";
  }
  return fetch(url, {
    method,
    headers,
    body,
    signal: opts.signal,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
}

async function request<T>(method: string, url: string, opts: RequestOpts = {}): Promise<T> {
  let res: Response;
  try {
    res = await send(method, url, opts);
    if (res.status === 403 && refresher) {
      // The server may have restarted with a new token: re-read it once and retry.
      const before = token;
      const fresh = await refresher().catch(() => null);
      if (fresh && fresh !== before) {
        token = fresh;
        res = await send(method, url, opts);
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the viewer server.", null);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detailMessage(res.status, body, `${res.status} ${res.statusText}`), body);
  }
  if (opts.text) return (await res.text()) as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return {} as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  return `?${sp.toString()}`;
}

export const editApi = {
  saveFile: (body: { path: string; content: string; base_sha256: string | null; create?: boolean }) =>
    request<SaveResult>("PUT", "/api/edit/file", { json: body }),
  mkdir: (path: string) => request<{ path?: string }>("POST", "/api/edit/mkdir", { json: { path } }),
  move: (from: string, to: string, opts: { overwrite?: boolean; create_parents?: boolean } = {}) =>
    request<{ from: string; to: string }>("POST", "/api/edit/move", {
      json: { from, to, overwrite: opts.overwrite ?? false, ...(opts.create_parents ? { create_parents: true } : {}) },
    }),
  copy: (from: string, to: string) => request<{ from?: string; to?: string; path?: string }>("POST", "/api/edit/copy", { json: { from, to } }),
  remove: (path: string) => request<{ trash_id: string }>("POST", "/api/edit/delete", { json: { path } }),
  trash: (signal?: AbortSignal) => request<{ items: TrashItem[] }>("GET", "/api/edit/trash", { signal }),
  restoreTrash: (id: string, to?: string) =>
    request<{ path?: string; to?: string }>("POST", "/api/edit/trash/restore", { json: to ? { id, to } : { id } }),
  purgeTrash: (arg: { id: string } | { all: true }) => request<unknown>("POST", "/api/edit/trash/purge", { json: arg }),
  history: (path: string, signal?: AbortSignal) =>
    request<{ versions: HistoryVersion[] }>("GET", `/api/edit/history${qs({ path })}`, { signal }),
  historyContent: (id: string, path: string, signal?: AbortSignal) =>
    request<string>("GET", `/api/edit/history/content${qs({ id, path })}`, { text: true, signal }),
  restoreHistory: (path: string, id: string) =>
    request<Partial<SaveResult> & { unchanged?: boolean }>("POST", "/api/edit/history/restore", { json: { path, id } }),
  upload: (dir: string, files: File[], overwrite = false) => {
    const form = new FormData();
    form.append("dir", dir);
    if (overwrite) form.append("overwrite", "true");
    for (const f of files) form.append("files", f, f.name);
    return request<{ paths: string[] }>("POST", "/api/edit/upload", { form });
  },
  audit: (limit = 50, signal?: AbortSignal) =>
    request<{ items?: AuditEntry[]; entries?: AuditEntry[] } | AuditEntry[]>("GET", `/api/edit/audit${qs({ limit })}`, {
      signal,
    }).then((r) => (Array.isArray(r) ? r : (r.items ?? r.entries ?? []))),
};

// ---------- loading a file for editing ----------

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser context has no WebCrypto (needs http://127.0.0.1).");
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface EditableText {
  text: string;
  sha256: string;
  size: number;
  /** every line break in the file is CRLF */
  crlf: boolean;
}

/** Fetch the exact bytes of a file, hash them and decode as UTF-8 (fails on invalid UTF-8). */
export async function loadEditable(path: string, signal?: AbortSignal): Promise<EditableText> {
  let res: Response;
  try {
    res = await fetch(rawUrl(path), { cache: "no-store", credentials: "same-origin", signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the viewer server.", null);
  }
  if (!res.ok) {
    throw new ApiError(res.status, res.status === 404 ? "File not found (404)." : `${res.status} ${res.statusText}`, null);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > EDIT_MAX_BYTES) throw new Error("This file is larger than 2 MB and cannot be edited here.");
  const sha256 = await sha256Hex(buf);
  let text: string;
  try {
    // ignoreBOM keeps a leading BOM in the string so saving writes it back.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new Error("This file is not valid UTF-8 text, so it cannot be edited here.");
  }
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = lf > 0 && (text.match(/\r\n/g) ?? []).length === lf;
  return { text, sha256, size: buf.byteLength, crlf };
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

// ---------- name validation (mirrors the server; the server stays authoritative) ----------

export const DEFAULT_DENY = [".env", ".env*", "*token*", "*secret*", "*credential*", "*.pem", "*.key"];
export const DEFAULT_IGNORE = ["__pycache__", "*.pyc", ".DS_Store", "node_modules", ".venv", ".git", ".ldv-tmp-*"];

/** NFKC + case folding, like the server's name folding (approximation of str.casefold). */
export function foldName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ſ/g, "s").normalize("NFKC");
}

const reCache = new Map<string, RegExp>();

/** Python fnmatch.translate equivalent (full match). */
export function fnmatchRegex(pattern: string): RegExp {
  const hit = reCache.get(pattern);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "!") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) re += "\\[";
      else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (stuff.startsWith("!")) stuff = `^${stuff.slice(1)}`;
        else if (stuff.startsWith("^")) stuff = `\\${stuff}`;
        re += `[${stuff}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  const out = new RegExp(`^(?:${re})$`, "s");
  reCache.set(pattern, out);
  return out;
}

export function matchesAny(name: string, patterns: string[]): string | null {
  const n = foldName(name);
  for (const p of patterns) if (fnmatchRegex(foldName(p)).test(n)) return p;
  return null;
}

export interface NameRules {
  deny: string[];
  ignore: string[];
}

export function nameRules(config: AppConfig | null): NameRules {
  return {
    deny: config?.deny_patterns ?? DEFAULT_DENY,
    ignore: [...(config?.ignore_patterns ?? DEFAULT_IGNORE), ".ldv-tmp-*"],
  };
}

/** Problem with a single path component, or null when it looks acceptable. */
export function validateName(name: string, rules: NameRules): string | null {
  if (!name) return "Enter a name.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (/[/\\]/.test(name)) return "Names cannot contain / or \\.";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "Names cannot contain control characters.";
  if (utf8Length(name) > 255) return "That name is too long (max 255 bytes).";
  if (/[ .]$/.test(name)) return "Names cannot end with a space or a dot.";
  if (/^\s/.test(name)) return "Names cannot start with whitespace.";
  const denied = matchesAny(name, rules.deny);
  if (denied) return `Matches the deny list (${denied}); the viewer would refuse it.`;
  const ignored = matchesAny(name, rules.ignore);
  if (ignored) return `Matches the ignore list (${ignored}); it would be hidden.`;
  return null;
}

/** Validate every component of a root-relative path. */
export function validatePath(path: string, rules: NameRules): string | null {
  if (!path) return "Enter a path.";
  if (path.startsWith("/")) return "Use a path relative to the root (no leading /).";
  for (const part of path.split("/")) {
    const err = validateName(part, rules);
    if (err) return part ? `"${part}": ${err}` : "Paths cannot contain empty segments (//).";
  }
  return null;
}

export function uploadProblem(file: File, config: AppConfig | null): string | null {
  const exts = config?.upload_ext;
  const max = config?.upload_max_bytes;
  const name = file.name;
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : "";
  if (exts && exts.length && !exts.map((e) => e.toLowerCase().replace(/^\./, "")).includes(ext)) {
    return `${name}: .${ext || "(none)"} files are not allowed (allowed: ${exts.join(", ")})`;
  }
  if (typeof max === "number" && max > 0 && file.size > max) {
    return `${name}: larger than the ${Math.round(max / 1024 / 1024)} MB upload limit`;
  }
  return null;
}

/** Epoch milliseconds from seconds, milliseconds or an ISO string (NaN if unknown). */
export function whenMs(v: number | string | undefined | null): number {
  if (v === undefined || v === null || v === "") return NaN;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(v);
}

export function formatWhen(v: number | string | undefined | null): string {
  if (v === undefined || v === null || v === "") return "";
  const ms = whenMs(v);
  if (!Number.isFinite(ms)) return String(v);
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
