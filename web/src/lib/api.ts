// Typed client for the local FastAPI backend. Every request is a relative
// same-origin `/api/...` URL; nothing in here ever talks to another host.

export type FileKind =
  | "markdown"
  | "mermaid"
  | "image"
  | "pdf"
  | "json"
  | "csv"
  | "xlsx"
  | "code"
  | "text"
  | "binary";

export interface AppConfig {
  /** basename of the root; null when no folder is selected */
  root_name: string | null;
  /** full canonical path of the root; null when no folder is selected */
  root_path?: string | null;
  /** true when the server runs without a root: only /api/config and /api/roots* work */
  no_root?: boolean;
  /** the folder can be switched from the UI (false with --lock-root) */
  root_switch_enabled?: boolean;
  /** Per-launch token for mutating /api/roots/* and /api/seen/* (same-site requests only). */
  root_token?: string;
  /** the server keeps the "changed since you last looked" history for this folder (/api/seen*) */
  seen_enabled?: boolean;
  /** the folder is inside a git work tree and git is usable: /api/git/* (read-only) */
  git_enabled?: boolean;
  repo_prefix: string;
  search_max_bytes: number;
  version: string | number;
  /** Tier 3 (opt-in editing). Absent on older/read-only servers: treat as false. */
  edit_enabled?: boolean;
  /** Per-launch token for /api/edit/*, only present when editing is enabled. */
  edit_token?: string;
  deny_patterns?: string[];
  ignore_patterns?: string[];
  upload_ext?: string[];
  upload_max_bytes?: number;
}

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: FileKind;
  ext: string;
}

export interface TreeResponse {
  files: FileEntry[];
  dirs: string[];
  version: number;
}

export interface FileInfo extends FileEntry {
  mime: string;
}

export interface ContentResponse {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
}

export interface TextSegment {
  start: number;
  end: number;
  start_line: number;
  text: string;
}

export interface TextGap {
  start: number;
  end: number;
}

export interface TextResponse {
  path: string;
  size: number;
  segments: TextSegment[];
  gaps: TextGap[];
}

export interface CsvResponse {
  header: string[];
  rows: string[][];
  total_rows: number;
  truncated: boolean;
}

export interface XlsxSheet {
  name: string;
  rows: string[][];
  total_rows: number;
  truncated: boolean;
}

export interface XlsxResponse {
  sheets: XlsxSheet[];
}

export interface NameHit {
  path: string;
  name: string;
  kind: FileKind;
}

export interface ContentMatch {
  line: number;
  offset: number;
  text: string;
  ranges: [number, number][];
}

export interface ContentHit {
  path: string;
  kind: FileKind;
  score: number;
  matches: ContentMatch[];
  match_count: number;
}

export interface SearchResponse {
  indexing: boolean;
  names: NameHit[];
  content: ContentHit[];
}

export interface ChangeEvent {
  version: number;
  added: string[];
  modified: string[];
  deleted: string[];
  renames: { from: string; to: string }[];
  dirs_changed: boolean;
}

/** M modified, A added (staged, not in HEAD), D deleted, R renamed, ?? untracked, U conflict. */
export type GitStatusCode = "M" | "A" | "D" | "R" | "??" | "U";

export interface GitStatusFile {
  path: string;
  status: GitStatusCode;
  /** renames: the path in the last commit (only when it is visible in this folder) */
  origPath: string | null;
  /** lines against the last commit; null when binary or not counted (too large, too many files) */
  added: number | null;
  removed: number | null;
  binary: boolean;
  kind: FileKind | null;
  /** null for deleted files */
  mtime: number | null;
  size: number | null;
}

export interface GitStatusResponse {
  /** abbreviated HEAD commit; null before the first commit */
  head: string | null;
  branch: string | null;
  /** the root inside the work tree, "" or "sub/dir/" */
  prefix: string;
  /** newest change first; deleted files last */
  files: GitStatusFile[];
  /** more changed files than the server lists */
  truncated: boolean;
}

export interface GitHeadBlob {
  oid: string;
  size: number;
  /** null when binary or too large */
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export interface GitFileResponse {
  path: string;
  /** null: no uncommitted change */
  status: GitStatusCode | null;
  origPath: string | null;
  /** the version in the last commit; null when the file is not in it */
  head: GitHeadBlob | null;
  headCommit: string | null;
  exists: boolean;
}

export interface GitBlameCommit {
  short: string;
  author: string;
  /** unix seconds */
  authorTime: number;
  summary: string;
  /** the line is not committed yet */
  uncommitted: boolean;
}

export interface GitBlameLine {
  line: number;
  commit: string;
  text: string;
}

export interface GitBlameResponse {
  path: string;
  start: number;
  /** lines in the file */
  total: number;
  /** false: the file is not in any commit yet */
  tracked: boolean;
  lines: GitBlameLine[];
  commits: Record<string, GitBlameCommit>;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store", credentials: "same-origin" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the viewer server. Is `uv run viewer` running?", null);
  }
  if (!res.ok) {
    let body: unknown = null;
    let message = `${res.status} ${res.statusText}`;
    try {
      body = await res.json();
      const detail = (body as { detail?: unknown })?.detail;
      if (typeof detail === "string") message = `${res.status}: ${detail}`;
    } catch {
      /* not JSON */
    }
    if (res.status === 403) message = `Access refused (403)${message.includes(":") ? message.slice(message.indexOf(":")) : ""}`;
    if (res.status === 404) message = "File not found (404). It may have been deleted or moved.";
    throw new ApiError(res.status, message, body);
  }
  return (await res.json()) as T;
}

export const rawUrl = (path: string) => `/api/raw${qs({ path })}`;

export interface PdfOptions {
  paper: "a4" | "letter";
  orientation: "auto" | "portrait" | "landscape";
  toc: boolean;
}

export const pdfUrl = (path: string, o: PdfOptions) =>
  `/api/pdf${qs({ path, paper: o.paper, orientation: o.orientation, toc: o.toc ? 1 : 0 })}`;

export const api = {
  config: (signal?: AbortSignal) => getJson<AppConfig>("/api/config", signal),
  tree: (signal?: AbortSignal) => getJson<TreeResponse>("/api/tree", signal),
  file: (path: string, signal?: AbortSignal) => getJson<FileInfo>(`/api/file${qs({ path })}`, signal),
  content: (path: string, signal?: AbortSignal) =>
    getJson<ContentResponse>(`/api/content${qs({ path })}`, signal),
  textInitial: (path: string, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path })}`, signal),
  textRange: (path: string, start: number, length: number, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path, start, length })}`, signal),
  textLine: (path: string, line: number, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path, line })}`, signal),
  csv: (path: string, signal?: AbortSignal) => getJson<CsvResponse>(`/api/csv${qs({ path })}`, signal),
  xlsx: (path: string, signal?: AbortSignal) => getJson<XlsxResponse>(`/api/xlsx${qs({ path })}`, signal),
  gitStatus: (signal?: AbortSignal) => getJson<GitStatusResponse>("/api/git/status", signal),
  gitFile: (path: string, signal?: AbortSignal) => getJson<GitFileResponse>(`/api/git/file${qs({ path })}`, signal),
  gitBlame: (path: string, start: number, count: number, signal?: AbortSignal) =>
    getJson<GitBlameResponse>(`/api/git/blame${qs({ path, start, count })}`, signal),
  search: (
    params: { q: string; folder?: string; types?: string[]; limit?: number },
    signal?: AbortSignal,
  ) =>
    getJson<SearchResponse>(
      `/api/search${qs({
        q: params.q,
        folder: params.folder || undefined,
        types: params.types && params.types.length ? params.types.join(",") : undefined,
        limit: params.limit,
      })}`,
      signal,
    ),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTime(mtime: number): string {
  const d = new Date(mtime * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(mtime: number): string {
  const diff = Date.now() / 1000 - mtime;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(mtime * 1000).toLocaleDateString();
}
