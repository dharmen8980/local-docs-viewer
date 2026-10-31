"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChangeTracker } from "@/hooks/use-change-tracker";
import { api, ApiError, type FileInfo } from "@/lib/api";
import { CONTENT_MAX, isChangedSince, TEXT_KINDS } from "@/lib/change-rules";
import { basename } from "@/lib/paths";
import { diffVersions, normalizeText, type LineDiff, type MarkdownBlockDiff } from "@/lib/diff";

/** The root-level tracker; null when the feature is off (no history on the server, no root). */
export const ChangesContext = createContext<ChangeTracker | null>(null);
export const useChanges = () => useContext(ChangesContext);

export interface FileChangeState {
  /** the open file changed since the version the base was taken from */
  changed: boolean;
  /** viewedAt of the base, ms */
  baseViewedAt: number | null;
  /** base text, or null when no copy was saved (never text-like, >2 MB, evicted) */
  baseText: string | null;
  /** the base copy is older than the last "seen" (Mark all as seen happened in between) */
  baseIsOlder: boolean;
  currentText: string | null;
  /** current.size - base.size */
  sizeDelta: number;
  /** text-like but over the fetch limit (CONTENT_MAX): not compared */
  tooLarge: boolean;
  /** only when changed and both texts are known; null also when the diff gave up */
  lineDiff: LineDiff | null;
  /** markdown only */
  markdownDiff: MarkdownBlockDiff | null;
  showDiff: boolean;
  setShowDiff(on: boolean): void;
  markSeen(): void;
}

/** The open file's change state, for the viewers (markdown highlights). */
export const FileChangeContext = createContext<FileChangeState | null>(null);
export const useFileChange = () => useContext(FileChangeContext);

/** The version the changes are shown against. */
interface Base {
  mtime: number;
  size: number;
  viewedAt: number;
  text: string | null;
  /** mtime of the version `text` is a copy of */
  textMtime?: number;
  older: boolean;
}

/** A displayed version: text is null when it is not fetched (non-text, too large, error). */
interface Current {
  key: string;
  mtime: number;
  size: number;
  text: string | null;
}

/** Live refetches of a file that keeps changing are spaced at least this far apart. */
const REFETCH_GAP_MS = 2000;
/** Retry delay after a network failure (server restarting, stream reconnecting). */
const RETRY_MS = 3000;

/**
 * Per open file (FileView is remounted per path, so all of this is one file
 * session). The base is taken once and never re-taken while the file stays
 * open: live changes keep being shown against the version last viewed. Only
 * "Mark as seen" and the user's own saves replace it. Leaving the file
 * persists the latest displayed version (see ChangeTracker.flushPending).
 */
export function useFileChanges(file: FileInfo | null): FileChangeState | null {
  const tracker = useChanges();
  /** undefined: not determined yet; "adopt": take the next resolved version as the base */
  const [base, setBase] = useState<Base | "adopt" | undefined>(undefined);
  const [fetched, setFetched] = useState<Current | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  /** bumped to retry a fetch that failed on the network */
  const [retry, setRetry] = useState(0);
  const lastFetchAt = useRef(0);

  const path = file?.path ?? "";
  const mtime = file?.mtime ?? 0;
  const size = file?.size ?? 0;
  const ready = Boolean(tracker?.ready);
  const textual = Boolean(file && TEXT_KINDS.has(file.kind) && file.size <= CONTENT_MAX);
  const tooLarge = Boolean(file && TEXT_KINDS.has(file.kind) && file.size > CONTENT_MAX);
  const key = file ? `${path}:${mtime}:${size}` : "";
  const baseObj = typeof base === "object" ? base : null;

  // 1. The base: the last viewed version (seen record + saved copy, if any).
  useEffect(() => {
    if (!tracker?.ready || !path || base !== undefined) return;
    const seen = tracker.seen.get(path);
    if (!seen) {
      // Never viewed: the first displayed version becomes the baseline, no banner.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBase((b) => (b === undefined ? "adopt" : b));
      return;
    }
    let cancelled = false;
    void tracker.getSnapshot(path).then((snap) => {
      if (cancelled) return;
      const b: Base = {
        mtime: seen.mtime,
        size: seen.size,
        viewedAt: seen.viewedAt,
        text: snap?.text ?? null,
        textMtime: snap?.mtime,
        older: snap ? Math.abs(snap.mtime - seen.mtime) > 0.001 : false,
      };
      // An own save may have switched to "adopt" meanwhile: keep that.
      setBase((cur) => (cur === undefined ? b : cur));
    });
    return () => {
      cancelled = true;
    };
  }, [tracker, path, base]);

  // The history was cleared: the version on screen becomes the baseline again, as on a first view.
  const clearCount = tracker?.clearCount ?? 0;
  const clearSeen = useRef(clearCount);
  useEffect(() => {
    if (clearSeen.current === clearCount) return;
    clearSeen.current = clearCount;
    setBase("adopt");
    setShowDiff(false);
  }, [clearCount]);

  // The user's own save (editor): absorb it as the new baseline, before paint so no banner flashes.
  useLayoutEffect(() => {
    if (!tracker || !path) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tracker.consumeOwnWrite(path, mtime)) setBase("adopt");
  }, [tracker, path, mtime]);

  // 2. The displayed version. The base's copy is reused when it is the same version.
  const reuse =
    baseObj?.text != null && baseObj.textMtime !== undefined && Math.abs(baseObj.textMtime - mtime) <= 0.001 && baseObj.size === size
      ? baseObj.text
      : null;
  const immediate = useMemo<Current | null>(() => {
    if (!key) return null;
    if (!textual) return { key, mtime, size, text: null };
    if (reuse !== null) return { key, mtime, size, text: reuse };
    return null;
  }, [key, mtime, size, textual, reuse]);
  const needFetch = ready && base !== undefined && textual && !immediate && fetched?.key !== key;

  useEffect(() => {
    if (!needFetch) return;
    const ctrl = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      lastFetchAt.current = Date.now();
      api
        .content(path, ctrl.signal)
        .then((r) => !ctrl.signal.aborted && setFetched({ key, mtime, size, text: r.text }))
        .catch((e) => {
          if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
          // 413 (too large) and other failures: no text, the banner works from size/mtime.
          if (!(e instanceof ApiError) || e.status !== 0) setFetched({ key, mtime, size, text: null });
          // Network failure: try again shortly (the deps alone would never re-run this).
          else retryTimer = setTimeout(() => setRetry((n) => n + 1), RETRY_MS);
        });
    };
    // Throttled: a newer key cancels a waiting call (trailing edge).
    const wait = lastFetchAt.current + REFETCH_GAP_MS - Date.now();
    const timer = wait > 0 && fetched ? setTimeout(run, wait) : null;
    if (!timer) run();
    return () => {
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      ctrl.abort();
    };
  }, [needFetch, path, key, mtime, size, fetched, retry]);

  // While a newer version loads, keep showing the last resolved one.
  const current: Current | null = immediate ?? fetched;

  // 3. Hand the displayed version to the tracker (persisted on leave); adopt it if asked.
  useEffect(() => {
    if (!tracker || !current || base === undefined) return;
    // text null drops a stale copy (non-text kinds, too large, unreadable).
    const v = { path, mtime: current.mtime, size: current.size, text: current.text };
    tracker.setPending(v);
    if (base === "adopt") {
      tracker.commit(v);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBase({ mtime: current.mtime, size: current.size, viewedAt: Date.now(), text: current.text, textMtime: current.mtime, older: false });
    }
  }, [tracker, current, base, path]);

  // 4. Changed? Identical content under a new mtime (regenerated) does not count.
  const baseText = baseObj?.text ?? null;
  const currentText = current?.text ?? null;
  const sameText = useMemo(
    () => baseText !== null && currentText !== null && normalizeText(baseText) === normalizeText(currentText),
    [baseText, currentText],
  );
  const differs = Boolean(baseObj && current && isChangedSince(current, baseObj));
  const changed = differs && !sameText;

  // Rewritten with the same text: it is seen right away, so the sidebar dot goes too
  // and the next regeneration is compared with this version.
  useEffect(() => {
    if (!tracker || !current || !differs || !sameText) return;
    const v = { path, mtime: current.mtime, size: current.size, text: current.text };
    tracker.commit(v);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBase((b) => (typeof b === "object" ? { ...b, mtime: v.mtime, size: v.size, textMtime: v.mtime, text: v.text } : b));
  }, [tracker, current, differs, sameText, path]);

  // 5. Diffs (pure, so StrictMode double memo calls are harmless), time-boxed (diffVersions).
  const both = changed && baseText !== null && currentText !== null;
  const isMarkdown = file?.kind === "markdown";
  const diffs = useMemo(
    () => (both ? diffVersions(baseText as string, currentText as string, isMarkdown) : null),
    [both, baseText, currentText, isMarkdown],
  );
  const lineDiff = diffs?.lineDiff ?? null;
  const markdownDiff = diffs?.markdownDiff ?? null;

  // Marked as seen from the sidebar (What's new, Mark all as seen): when that is the version on
  // screen, it becomes the base and the banner goes. Records written by other tabs or on tab hide
  // do not count: the banner stays until the user leaves the file.
  const marked = tracker?.marked;
  const markedSeq = useRef(marked?.seq ?? 0);
  useEffect(() => {
    if (!marked || markedSeq.current === marked.seq) return;
    markedSeq.current = marked.seq;
    const rec = tracker?.seen.get(path);
    if (!changed || !marked.paths.has(path) || !rec || !current || isChangedSince(current, rec)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBase({ mtime: current.mtime, size: current.size, viewedAt: rec.viewedAt, text: current.text, textMtime: current.mtime, older: false });
    setShowDiff(false);
  }, [marked, tracker, changed, path, current]);

  // 6. Mark as seen: the displayed version becomes the base right away (undoable: the old copy is overwritten).
  const markSeen = useCallback(() => {
    if (!tracker || !current) return;
    const prev = baseObj;
    tracker.commit({ path, mtime: current.mtime, size: current.size, text: current.text });
    setBase({ mtime: current.mtime, size: current.size, viewedAt: Date.now(), text: current.text, textMtime: current.mtime, older: false });
    setShowDiff(false);
    if (!prev) return;
    toast("Marked as seen", {
      description: basename(path),
      action: {
        label: "Undo",
        onClick: () => {
          tracker.commit({ path, mtime: prev.mtime, size: prev.size, text: prev.text });
          setBase(prev);
        },
      },
    });
  }, [tracker, current, path, baseObj]);

  return useMemo<FileChangeState | null>(() => {
    if (!tracker || !file) return null;
    return {
      changed,
      baseViewedAt: baseObj?.viewedAt ?? null,
      baseText,
      baseIsOlder: baseObj?.older ?? false,
      currentText,
      sizeDelta: current && baseObj ? current.size - baseObj.size : 0,
      tooLarge,
      lineDiff,
      markdownDiff,
      showDiff,
      setShowDiff,
      markSeen,
    };
  }, [tracker, file, changed, baseObj, baseText, currentText, current, tooLarge, lineDiff, markdownDiff, showDiff, markSeen]);
}
