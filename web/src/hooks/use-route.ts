"use client";

import { useSyncExternalStore } from "react";
import { viewerHref } from "@/lib/paths";

// URL state: "/?p=<path>&hl=<query>#<hash>". We drive window.history directly
// (Next's app router patches pushState/replaceState and stays in sync), which
// also lets us track the hash, something useSearchParams does not do.

export interface Route {
  path: string;
  hash: string;
  hl: string;
  /** text of the chosen search-match line, used to pick which occurrence to scroll to */
  hll: string;
}

const EMPTY: Route = { path: "", hash: "", hl: "", hll: "" };
const listeners = new Set<() => void>();
let cacheKey = "";
let cacheValue: Route = EMPTY;

function decodeHash(h: string): string {
  const raw = h.startsWith("#") ? h.slice(1) : h;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function snapshot(): Route {
  const key = window.location.search + window.location.hash;
  if (key !== cacheKey) {
    const sp = new URLSearchParams(window.location.search);
    cacheKey = key;
    cacheValue = {
      path: sp.get("p") ?? "",
      hl: sp.get("hl") ?? "",
      hll: sp.get("hll") ?? "",
      hash: decodeHash(window.location.hash),
    };
  }
  return cacheValue;
}

function emit() {
  for (const l of listeners) l();
}

// ---------- navigation guard (unsaved edits) ----------

/**
 * Called before a navigation that changes the open path. Return true to let it
 * happen now; return false to block it and call `proceed` later (e.g. after a
 * "Save / Discard / Cancel" prompt).
 */
export type NavigationGuard = (proceed: () => void) => boolean;
let guard: NavigationGuard | null = null;
let skipPopGuard = false;
let lastHref = "";

export function setNavigationGuard(g: NavigationGuard | null): () => void {
  guard = g;
  return () => {
    if (guard === g) guard = null;
  };
}

function currentHref(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

function onPopState() {
  const prevPath = cacheValue.path;
  const prevHref = lastHref;
  const next = new URLSearchParams(window.location.search).get("p") ?? "";
  if (guard && !skipPopGuard && next !== prevPath && prevHref) {
    let blocked = false;
    const allowed = guard(() => {
      if (!blocked) return;
      // Go to where the user was heading (the entry before the one we put back).
      skipPopGuard = true;
      window.history.go(-1);
    });
    if (!allowed) {
      // Put the current page back while the user decides.
      blocked = true;
      window.history.pushState(null, "", prevHref);
      return;
    }
  }
  skipPopGuard = false;
  lastHref = currentHref();
  emit();
}

function onHashChange() {
  lastHref = currentHref();
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) {
    lastHref = currentHref();
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    }
  };
}

export interface NavigateOptions {
  hash?: string;
  hl?: string;
  hll?: string;
  replace?: boolean;
  /** skip the unsaved-changes guard (used when following a rename of the open file) */
  force?: boolean;
}

export function navigate(path: string, opts: NavigateOptions = {}) {
  if (guard && !opts.force && path !== snapshot().path) {
    const g = guard;
    if (!g(() => navigate(path, { ...opts, force: true }))) return;
  }
  const extra: Record<string, string> = {};
  if (opts.hl) extra.hl = opts.hl;
  if (opts.hl && opts.hll) extra.hll = opts.hll;
  const href = viewerHref(path, opts.hash, extra);
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (href === current) {
    emit();
    return;
  }
  if (opts.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  lastHref = href;
  emit();
}

/** Change only the hash of the current URL (push by default). */
export function setHash(hash: string, replace = false) {
  const { path, hl, hll } = snapshot();
  navigate(path, { hash, hl: hl || undefined, hll: hll || undefined, replace });
}

export function useRoute(): Route & {
  navigate: typeof navigate;
  setHash: typeof setHash;
} {
  const route = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  // navigate/setHash are module-level functions, so they are already stable.
  return { ...route, navigate, setHash };
}
