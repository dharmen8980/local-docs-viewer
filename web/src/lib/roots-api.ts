// Client for the folder switcher (/api/roots*); its token also guards /api/seen*. Relative same-origin URLs only.
// Mutations carry the per-launch X-Root-Token and a JSON body. A browser can
// never name an arbitrary path: switch only accepts folders already in the
// server's recent list; new folders only come in via the native dialog.

import { ApiError, api } from "@/lib/api";

export interface RootsInfo {
  current: string | null;
  recent: string[];
  picker_available: boolean;
  switch_enabled: boolean;
}

export type PickResult = { cancelled: true } | { cancelled: false; current: string };

let token = "";

/** Set the roots token (from /api/config). It belongs to the server launch, not to a root. */
export function configureRootsClient(t: string | undefined) {
  if (t) token = t;
}

/** The current roots token (also guards the changes history, /api/seen*). */
export function rootToken(): string {
  return token;
}

/** Re-read the token from /api/config (the server may have restarted); null if there is none. */
export async function refreshRootToken(): Promise<string | null> {
  const fresh = await api.config().then((c) => c.root_token ?? null, () => null);
  if (fresh) token = fresh;
  return fresh;
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

function send(method: string, url: string, json?: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (method !== "GET") {
    headers["X-Root-Token"] = token;
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json ?? {});
  }
  return fetch(url, { method, headers, body, signal, cache: "no-store", credentials: "same-origin", redirect: "error" });
}

async function request<T>(method: string, url: string, json?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await send(method, url, json, signal);
    if (res.status === 403 && method !== "GET") {
      // The server may have restarted with a new token: re-read it once and retry.
      const before = token;
      const fresh = await refreshRootToken();
      if (fresh && fresh !== before) res = await send(method, url, json, signal);
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
  return (await res.json()) as T;
}

export const rootsApi = {
  get: (signal?: AbortSignal) => request<RootsInfo>("GET", "/api/roots", undefined, signal),
  /** Opens the native folder dialog on this machine; resolves when the user chooses or cancels. */
  pick: () => request<PickResult>("POST", "/api/roots/pick", {}),
  switch: (path: string) => request<{ current?: string }>("POST", "/api/roots/switch", { path }),
  forget: (path: string) => request<unknown>("POST", "/api/roots/forget", { path }),
};

export const getRoots = rootsApi.get;
export const pickRoot = rootsApi.pick;
export const switchRoot = rootsApi.switch;
export const forgetRoot = rootsApi.forget;
