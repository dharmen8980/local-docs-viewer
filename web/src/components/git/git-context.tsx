"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type FileInfo, type GitFileResponse, type GitStatusFile, type GitStatusResponse } from "@/lib/api";
import { CONTENT_MAX, TEXT_KINDS } from "@/lib/change-rules";
import { diffVersions, normalizeText } from "@/lib/diff";
import type { FileChangeState } from "@/components/changes/changes-context";

/** What the open file shows instead of its plain view: the diff against the last commit, or blame. */
export type GitViewMode = "compare" | "blame";

export interface GitState {
  /** null until the first status arrived (or when it failed) */
  status: GitStatusResponse | null;
  /** the status entries by path */
  byPath: ReadonlyMap<string, GitStatusFile>;
  /** the last status request failed (shown in the feed) */
  error: string | null;
  refresh(): void;
  /** the open file's git view; only applies while `path` is the open file */
  view: { path: string; mode: GitViewMode } | null;
  setView(v: { path: string; mode: GitViewMode } | null): void;
}

/** Null when git is off for this folder (not a repo, git missing, --git off). */
export const GitContext = createContext<GitState | null>(null);
export const useGit = () => useContext(GitContext);

/** Status refresh after a live change (debounced: a burst of writes asks once). */
const CHANGE_DEBOUNCE_MS = 700;
/** Commits, checkouts and stages do not touch the tree (.git is ignored): poll while visible. */
const POLL_MS = 30_000;
const EMPTY: ReadonlyMap<string, GitStatusFile> = new Map();

/** The root-level git state; `enabled` comes from /api/config (git_enabled). */
export function useGitState(enabled: boolean, treeVersion: number | undefined): GitState | null {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<GitState["view"]>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const first = useRef(true);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    const delay = first.current ? 0 : CHANGE_DEBOUNCE_MS;
    first.current = false;
    const timer = setTimeout(() => {
      api
        .gitStatus(ctrl.signal)
        .then((s) => {
          setStatus(s);
          setError(null);
        })
        .catch((e) => {
          if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
          setError(e instanceof ApiError ? e.message : String(e));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [enabled, treeVersion, tick]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => document.visibilityState === "visible" && refresh();
    const poll = setInterval(onFocus, POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, refresh]);

  const byPath = useMemo(() => (status ? new Map(status.files.map((f) => [f.path, f])) : EMPTY), [status]);
  return useMemo(
    () => (enabled ? { status, byPath, error, refresh, view, setView } : null),
    [enabled, status, byPath, error, refresh, view],
  );
}

/** The open file against the last commit: a FileChangeState for the banner, the diff and the markdown marks. */
export interface GitCompareState extends FileChangeState {
  loading: boolean;
  error: string | null;
  /** the file is the same as in the last commit */
  same: boolean;
  /** not in the last commit (new or untracked): every line is new */
  isNew: boolean;
  /** deleted since the last commit */
  isDeleted: boolean;
  /** the last commit's version is binary or too large: nothing to compare */
  noText: boolean;
  head: GitFileResponse | null;
}

/**
 * Loads the last commit's version and the current text while `active`. `file` is null for a
 * file deleted since the last commit (its current text is empty). `version` refetches.
 */
export function useGitCompare(path: string, file: FileInfo | null, active: boolean, version: string, close: () => void): GitCompareState | null {
  const [data, setData] = useState<{ key: string; head: GitFileResponse; text: string | null } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const textual = file ? TEXT_KINDS.has(file.kind) && file.size <= CONTENT_MAX : true;
  const tooLarge = Boolean(file && TEXT_KINDS.has(file.kind) && file.size > CONTENT_MAX);
  const key = `${path}\u0000${version}`;

  useEffect(() => {
    if (!active || !path) return;
    const ctrl = new AbortController();
    const current = file && textual ? api.content(path, ctrl.signal).then((r) => r.text) : Promise.resolve(file ? null : "");
    Promise.all([api.gitFile(path, ctrl.signal), current])
      .then(([head, text]) => {
        setData({ key, head, text });
        setFailed(null);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
        setFailed({ key, message: e instanceof ApiError ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [active, path, file, textual, key]);

  // While a newer version loads, keep showing the last one of this path.
  const shown = data && data.key.split("\u0000")[0] === path ? data : null;
  const head = shown?.head ?? null;
  const blob = head?.head ?? null;
  const isNew = Boolean(head && !blob);
  const isDeleted = Boolean(head && !head.exists);
  const noText = Boolean(blob && blob.text === null);
  const baseText = head ? (blob ? blob.text : "") : null;
  const currentText = shown?.text ?? null;
  const same = baseText !== null && currentText !== null && normalizeText(baseText) === normalizeText(currentText);
  const isMarkdown = file?.kind === "markdown";
  const both = !same && baseText !== null && currentText !== null;
  const diffs = useMemo(
    () => (both ? diffVersions(baseText as string, currentText as string, isMarkdown) : null),
    [both, baseText, currentText, isMarkdown],
  );

  return useMemo<GitCompareState | null>(() => {
    if (!active) return null;
    return {
      changed: Boolean(head),
      baseViewedAt: null,
      baseText,
      baseIsOlder: false,
      currentText,
      sizeDelta: (file?.size ?? 0) - (blob?.size ?? 0),
      tooLarge: tooLarge || Boolean(blob?.tooLarge),
      lineDiff: diffs?.lineDiff ?? null,
      markdownDiff: diffs?.markdownDiff ?? null,
      // A deleted file has nothing else to show.
      showDiff: showDiff || isDeleted,
      setShowDiff,
      markSeen: close,
      loading: !shown && !failed,
      error: failed && failed.key === key ? failed.message : null,
      same,
      isNew,
      isDeleted,
      noText,
      head,
    };
  }, [active, head, baseText, currentText, file, blob, tooLarge, diffs, showDiff, isDeleted, close, shown, failed, key, same, isNew, noText]);
}
