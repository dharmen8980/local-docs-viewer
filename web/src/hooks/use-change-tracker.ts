"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeResponse } from "@/lib/api";
import { isChangedSince, remapPath } from "@/lib/change-rules";
import { refreshRootToken, rootToken } from "@/lib/roots-api";
import {
  needsDigest,
  openChangeStore,
  sha256Hex,
  type ChangeStore,
  type SeenEvent,
  type SeenRecord,
  type Snapshot,
  type ViewedVersion,
} from "@/lib/seen-store";

export interface ChangeTracker {
  /** the store opened (the server keeps the history for this folder) */
  enabled: boolean;
  /** the seen map is loaded (no badges before that, so nothing flashes) */
  ready: boolean;
  seen: ReadonlyMap<string, SeenRecord>;
  /** tree files with a seen record whose mtime/size differ */
  changed: ReadonlySet<string>;
  /** bumped when the whole history was cleared (here or in another tab): open files start over */
  clearCount: number;
  /** see ChangeStore.getSnapshot; with `throwOnError` and no store yet it rejects too */
  getSnapshot(path: string, opts?: { throwOnError?: boolean }): Promise<Snapshot | null>;
  /** persist now (Mark as seen / own write); updates `seen` */
  commit(v: ViewedVersion): void;
  /** the version on screen; persisted when the user leaves it */
  setPending(v: ViewedVersion | null): void;
  /** persist + clear the pending version unless it is `keepPath` (route changes) */
  flushPending(keepPath: string): void;
  /** seen := current tree mtime/size for every changed file (snapshots kept) */
  markAllSeen(): void;
  /**
   * The same for some of the changed files (others are ignored). Returns their previous
   * records, for an undo with restoreSeen.
   */
  markSeen(paths: Iterable<string>): SeenRecord[];
  /** put back records returned by markSeen (Undo) */
  restoreSeen(records: SeenRecord[]): void;
  /** bumped by markSeen / markAllSeen with the paths marked (the open file drops its banner) */
  marked: { seq: number; paths: ReadonlySet<string> };
  /** forget the folder's whole history (every record and snapshot); false if it failed */
  clearHistory(): Promise<boolean>;
  /** remaps seen state, the pending version and the store (file or folder) */
  rename(from: string, to: string): void;
  /**
   * The editor saved `v`: it is seen at once, and it replaces a pending version of
   * the same file (the viewer is unmounted while editing, so that one is stale).
   */
  ownSave(v: ViewedVersion): void;
  /** the editor saved (or may have saved) `path`: absorb its next newer version */
  expectOwnWrite(path: string, sinceMtime: number): void;
  /** true (once) when `mtime` is the user's own save of `path` */
  consumeOwnWrite(path: string, mtime: number): boolean;
  /** a `seen` event from the live-update stream (another tab or browser wrote these records) */
  onSeenEvent(ev: SeenEvent): void;
  /** reload the records (the live-update stream reconnected: events may have been missed) */
  resync(): void;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
/** An expected own save that never shows up (Done without saving) stops counting after this. */
const OWN_WRITE_TTL_MS = 30_000;
/** On resync, local records this recent survive even if the server does not have them yet (a write in flight). */
const IN_FLIGHT_MS = 10_000;

/**
 * Root-level state of "Changed since you last looked". The history is kept by the
 * server in its data dir (lib/seen-store.ts, /api/seen*), namespaced by the root's
 * full path, and shared by every tab and browser on that server (SSE `seen` events).
 * `rootPath` is null when the feature is off (no folder, or the server does not keep it).
 */
export function useChangeTracker(rootPath: string | null | undefined, tree: TreeResponse | null): ChangeTracker {
  const root = rootPath ?? null;
  const storeRef = useRef<ChangeStore | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [seen, setSeen] = useState<ReadonlyMap<string, SeenRecord>>(() => new Map());
  const [clearCount, setClearCount] = useState(0);
  const [marked, setMarked] = useState<{ seq: number; paths: ReadonlySet<string> }>(() => ({ seq: 0, paths: EMPTY_SET }));
  const seenRef = useRef(seen);
  useEffect(() => {
    seenRef.current = seen;
  }, [seen]);
  const pendingRef = useRef<ViewedVersion | null>(null);
  /** the last digest computed, reused while the same text stays on screen */
  const digestRef = useRef<{ text: string; hex: string } | null>(null);
  const ownWrites = useRef(new Map<string, { since: number; at: number }>());

  useEffect(() => {
    let cancelled = false;
    storeRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(false);
    setReady(false);
    setSeen(new Map());
    if (!root) return; // no folder, or the server does not keep the history: feature off
    void openChangeStore(root, { token: rootToken, refreshToken: refreshRootToken }).then(async (store) => {
      if (cancelled || !store) return;
      const m = await store.loadSeen();
      if (cancelled) return;
      storeRef.current = store;
      setSeen(m);
      setEnabled(true);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const applySeen = useCallback((recs: SeenRecord[]) => {
    if (!recs.length) return;
    setSeen((prev) => {
      const next = new Map(prev);
      for (const r of recs) next.set(r.path, r);
      return next;
    });
  }, []);

  const dropAll = useCallback(() => {
    setSeen(new Map());
    setClearCount((n) => n + 1);
  }, []);

  // Other tabs and browsers on this server: refresh the records they wrote.
  const onSeenEvent = useCallback(
    (ev: SeenEvent) => {
      const store = storeRef.current;
      if (!store || ev.client === store.clientId) return;
      if (ev.cleared) return dropAll();
      if (!Array.isArray(ev.paths) || !ev.paths.length) return;
      void store.getSeen(ev.paths).then((recs) => {
        if (storeRef.current === store) applySeen(recs);
      });
    },
    [applySeen, dropAll],
  );

  const resync = useCallback(() => {
    const store = storeRef.current;
    if (!store) return;
    const started = Date.now();
    void store.loadSeen().then((m) => {
      if (storeRef.current !== store) return;
      // An empty history that had older records here: another tab cleared it while our
      // stream was down. Same as the `cleared` event, so the open file gets a new baseline too.
      if (!m.size && [...seenRef.current.values()].some((r) => r.viewedAt < started - IN_FLIGHT_MS)) return dropAll();
      setSeen((prev) => {
        const next = new Map(m);
        for (const [path, rec] of prev) {
          const srv = next.get(path);
          if (srv ? rec.viewedAt > srv.viewedAt : rec.viewedAt >= started - IN_FLIGHT_MS) next.set(path, rec);
        }
        return next;
      });
    });
  }, [dropAll]);

  const commit = useCallback(
    (v: ViewedVersion) => {
      const store = storeRef.current;
      if (!store) return;
      // Optimistic: badges update at once, the write follows.
      applySeen([{ root: store.root, path: v.path, mtime: v.mtime, size: v.size, viewedAt: Date.now() }]);
      void store.commit(v);
    },
    [applySeen],
  );

  /**
   * Makes `v` the pending version. A text too big for a keepalive body gets its digest now,
   * because the unload handlers cannot wait for crypto.subtle (see ViewedVersion.textSha256).
   */
  const holdPending = useCallback((v: ViewedVersion | null) => {
    const text = v?.text;
    if (!v || !needsDigest(text, v.path.length + (storeRef.current?.root.length ?? 4096))) {
      pendingRef.current = v;
      return;
    }
    const known = digestRef.current;
    if (known && known.text === text) {
      pendingRef.current = { ...v, textSha256: known.hex };
      return;
    }
    pendingRef.current = v;
    void sha256Hex(text).then((hex) => {
      if (!hex) return;
      digestRef.current = { text, hex };
      const p = pendingRef.current;
      if (p && p.text === text) pendingRef.current = { ...p, textSha256: hex };
    });
  }, []);

  const setPending = useCallback(
    (v: ViewedVersion | null) => {
      const p = pendingRef.current;
      // Another file took over the screen before the route effect ran: that is a leave.
      if (p && v && p.path !== v.path) commit(p);
      holdPending(v);
    },
    [commit, holdPending],
  );

  const flushPending = useCallback(
    (keepPath: string) => {
      const p = pendingRef.current;
      if (!p || p.path === keepPath) return;
      pendingRef.current = null;
      commit(p);
    },
    [commit],
  );

  // Tab hidden or closed: persist what is on screen, but keep it pending so the
  // banner and highlights stay until the user actually leaves the file.
  useEffect(() => {
    if (!enabled) return;
    const persist = () => {
      const p = pendingRef.current;
      const store = storeRef.current;
      if (p && store) void store.commit(p, { keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") persist();
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  const changed = useMemo<ReadonlySet<string>>(() => {
    if (!ready || !tree || !seen.size) return EMPTY_SET;
    const out = new Set<string>();
    for (const f of tree.files) if (isChangedSince(f, seen.get(f.path))) out.add(f.path);
    return out;
  }, [ready, tree, seen]);

  const latest = useRef({ tree, changed });
  useEffect(() => {
    latest.current = { tree, changed };
  });

  const markSeen = useCallback(
    (paths: Iterable<string>) => {
      const store = storeRef.current;
      const { tree: t, changed: c } = latest.current;
      if (!store || !t || !c.size) return [];
      const want = new Set(paths);
      const entries = t.files
        .filter((f) => c.has(f.path) && want.has(f.path))
        .map((f) => ({ path: f.path, mtime: f.mtime, size: f.size }));
      if (!entries.length) return [];
      const prev = entries.flatMap((e) => seenRef.current.get(e.path) ?? []);
      const now = Date.now();
      applySeen(entries.map((e) => ({ root: store.root, ...e, viewedAt: now })));
      setMarked((m) => ({ seq: m.seq + 1, paths: new Set(entries.map((e) => e.path)) }));
      void store.markSeen(entries);
      return prev;
    },
    [applySeen],
  );

  const markAllSeen = useCallback(() => void markSeen(latest.current.changed), [markSeen]);

  const restoreSeen = useCallback(
    (records: SeenRecord[]) => {
      const store = storeRef.current;
      if (!store || !records.length) return;
      const entries = records.map((r) => ({ path: r.path, mtime: r.mtime, size: r.size }));
      applySeen(entries.map((e) => ({ root: store.root, ...e, viewedAt: Date.now() })));
      void store.markSeen(entries);
    },
    [applySeen],
  );

  const clearHistory = useCallback(async () => {
    const store = storeRef.current;
    if (!store || !(await store.clear())) return false;
    // Only once the server has answered, so the open file's fresh record lands after the clear.
    if (storeRef.current === store) dropAll();
    return true;
  }, [dropAll]);

  const rename = useCallback((from: string, to: string) => {
    if (!from || from === to) return;
    const p = pendingRef.current;
    const np = p ? remapPath(p.path, from, to) : null;
    if (p && np !== null) pendingRef.current = { ...p, path: np };
    for (const [path, w] of [...ownWrites.current]) {
      const m = remapPath(path, from, to);
      if (m === null) continue;
      ownWrites.current.delete(path);
      ownWrites.current.set(m, w);
    }
    setSeen((prev) => {
      let next: Map<string, SeenRecord> | null = null;
      for (const [path, rec] of prev) {
        const m = remapPath(path, from, to);
        if (m === null) continue;
        next ??= new Map(prev);
        next.delete(path);
        next.set(m, { ...rec, path: m });
      }
      return next ?? prev;
    });
    void storeRef.current?.rename(from, to);
  }, []);

  const ownSave = useCallback(
    (v: ViewedVersion) => {
      if (pendingRef.current?.path === v.path) holdPending(v);
      commit(v);
    },
    [commit, holdPending],
  );

  const getSnapshot = useCallback(
    (path: string, opts?: { throwOnError?: boolean }) => {
      const store = storeRef.current;
      if (store) return store.getSnapshot(path, opts);
      return opts?.throwOnError ? Promise.reject(new Error("changes: no store")) : Promise.resolve(null);
    },
    [],
  );

  const expectOwnWrite = useCallback((path: string, sinceMtime: number) => {
    ownWrites.current.set(path, { since: sinceMtime, at: Date.now() });
  }, []);

  const consumeOwnWrite = useCallback((path: string, mtime: number) => {
    const w = ownWrites.current.get(path);
    if (!w) return false;
    if (Date.now() - w.at > OWN_WRITE_TTL_MS) {
      ownWrites.current.delete(path);
      return false;
    }
    if (mtime <= w.since + 0.001) return false;
    ownWrites.current.delete(path);
    return true;
  }, []);

  return useMemo<ChangeTracker>(
    () => ({
      enabled,
      ready,
      seen,
      changed,
      clearCount,
      getSnapshot,
      commit,
      setPending,
      flushPending,
      markAllSeen,
      markSeen,
      restoreSeen,
      marked,
      clearHistory,
      rename,
      ownSave,
      expectOwnWrite,
      consumeOwnWrite,
      onSeenEvent,
      resync,
    }),
    [
      enabled,
      ready,
      seen,
      changed,
      clearCount,
      getSnapshot,
      commit,
      setPending,
      flushPending,
      markAllSeen,
      markSeen,
      restoreSeen,
      marked,
      clearHistory,
      rename,
      ownSave,
      expectOwnWrite,
      consumeOwnWrite,
      onSeenEvent,
      resync,
    ],
  );
}
