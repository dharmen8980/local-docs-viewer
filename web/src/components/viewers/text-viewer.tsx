"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Loader2Icon, WrapTextIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRoute } from "@/hooks/use-route";
import { api, errorMessage, formatBytes, type TextResponse, type TextSegment } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { parseLineHash } from "./code-viewer";

const CHUNK = 256 * 1024;
const MAX_CHUNK = 1024 * 1024; // server caps length at 1 MB

interface Seg extends TextSegment {
  lines: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toSeg(s: TextSegment): Seg {
  const body = s.text.endsWith("\n") ? s.text.slice(0, -1) : s.text;
  return { ...s, lines: s.text.length === 0 ? [] : body.split("\n") };
}

/** Merge segments by byte offset. Segment boundaries are always line boundaries. */
function mergeSegments(existing: Seg[], incoming: TextSegment[]): Seg[] {
  const all = [...existing, ...incoming.map(toSeg)].sort((a, b) => a.start - b.start);
  const out: Seg[] = [];
  for (const cur of all) {
    const last = out[out.length - 1];
    if (!last || cur.start > last.end) {
      out.push(cur);
      continue;
    }
    if (cur.end <= last.end) continue; // fully contained
    const tailBytes = enc.encode(cur.text).subarray(last.end - cur.start);
    out[out.length - 1] = toSeg({
      start: last.start,
      end: cur.end,
      start_line: last.start_line,
      text: last.text + dec.decode(tailBytes),
    });
  }
  return out;
}

function computeGaps(segs: Seg[], size: number): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  let pos = 0;
  for (const s of segs) {
    if (s.start > pos) gaps.push({ start: pos, end: s.start });
    pos = Math.max(pos, s.end);
  }
  if (pos < size) gaps.push({ start: pos, end: size });
  return gaps;
}

const SegmentView = memo(function SegmentView({
  seg,
  target,
  onLineClick,
}: {
  seg: Seg;
  target: number | null;
  onLineClick: (n: number) => void;
}) {
  return (
    <div className="py-1">
      {seg.lines.map((line, i) => {
        const n = seg.start_line + i;
        return (
          <div
            key={n}
            id={`L${n}`}
            className={cn(
              "text-line flex hover:bg-muted/50",
              n === target && "bg-yellow-200/60 dark:bg-yellow-500/25",
            )}
          >
            <span
              className="text-line-no sticky left-0 min-w-[var(--gutter)] shrink-0 cursor-pointer select-none bg-background pr-3 pl-2 text-right text-muted-foreground/70 hover:text-foreground"
              onClick={() => onLineClick(n)}
            >
              {n}
            </span>
            <span className="text-line-body pr-4">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
});

export function TextViewer({ file, reloadKey }: ViewerProps) {
  const { hash, setHash } = useRoute();
  const target = parseLineHash(hash);
  const [state, setState] = useState<{ path: string; size: number; segs: Seg[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const requestedLines = useRef(new Set<number>());

  const applyResponse = useCallback((r: TextResponse, replace: boolean) => {
    setState((prev) => {
      const base = !replace && prev && prev.path === r.path ? prev.segs : [];
      return { path: r.path, size: r.size, segs: mergeSegments(base, r.segments) };
    });
  }, []);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Initial load. When the file changes on disk (reloadKey), reload in place:
  // fetch head+tail again and re-request every byte range the reader had
  // loaded, so "Load 256 KB" chunks and #L jumps survive (e.g. a growing log).
  // Only if the file shrank do we start over.
  useEffect(() => {
    const ctrl = new AbortController();
    const prev = stateRef.current && stateRef.current.path === file.path ? stateRef.current : null;
    (async () => {
      const r = await api.textInitial(file.path, ctrl.signal);
      if (!prev || r.size < prev.size) {
        requestedLines.current.clear();
        setError(null);
        applyResponse(r, true);
        return;
      }
      const have = mergeSegments([], r.segments);
      const covered = (pos: number) => have.find((sg) => sg.start <= pos && pos < sg.end);
      const extra: TextSegment[] = [];
      let budget = 16 * MAX_CHUNK; // never re-fetch more than this in one reload
      for (const seg of prev.segs) {
        let pos = seg.start;
        while (pos < seg.end && budget > 0) {
          const c = covered(pos);
          if (c) {
            pos = c.end;
            continue;
          }
          // start one byte early so the server's snap-forward lands exactly on `pos`
          const from = Math.max(0, pos - 1);
          const length = Math.min(MAX_CHUNK, seg.end - from);
          const rr = await api.textRange(file.path, from, length, ctrl.signal);
          const got = rr.segments[0];
          if (!got || got.end <= pos) break;
          extra.push(got);
          budget -= got.end - got.start;
          pos = got.end;
        }
      }
      setError(null);
      applyResponse({ ...r, segments: [...r.segments, ...extra] }, true);
    })().catch((e) => {
      if ((e as Error).name !== "AbortError") setError(e);
    });
    return () => ctrl.abort();
  }, [file.path, reloadKey, applyResponse]);

  const current = state && state.path === file.path ? state : null;
  const gaps = useMemo(() => (current ? computeGaps(current.segs, current.size) : []), [current]);

  const targetLoaded = useMemo(() => {
    if (!current || target === null) return true;
    return current.segs.some((s) => target >= s.start_line && target < s.start_line + s.lines.length);
  }, [current, target]);

  // '#L<n>' pointing into an unloaded region: fetch the chunk around that line.
  useEffect(() => {
    if (!current || target === null || targetLoaded || gaps.length === 0) return;
    if (requestedLines.current.has(target)) return;
    requestedLines.current.add(target);
    const ctrl = new AbortController();
    api
      .textLine(file.path, target, ctrl.signal)
      .then((r) => applyResponse(r, false))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") toast.error(`Could not load line ${target}: ${errorMessage(e)}`);
      });
    return () => ctrl.abort();
  }, [current, target, targetLoaded, gaps.length, file.path, applyResponse]);

  // Scroll to the target line once it is rendered (once per target, so live
  // reloads keep the reader's scroll position).
  const scrolledTo = useRef("");
  useEffect(() => {
    if (target === null || !targetLoaded) return;
    const key = `${file.path}#${target}`;
    if (scrolledTo.current === key) return;
    const el = document.getElementById(`L${target}`);
    if (!el) return;
    scrolledTo.current = key;
    el.scrollIntoView({ block: "center" });
  }, [target, targetLoaded, current?.segs, file.path]);

  const loadRange = async (key: string, start: number, end: number) => {
    setBusy(key);
    try {
      const length = Math.min(MAX_CHUNK, Math.max(1, end - start));
      const r = await api.textRange(file.path, start, length);
      applyResponse(r, false);
    } catch (e) {
      toast.error(`Could not load more text: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onLineClick = useCallback((n: number) => setHash(`L${n}`, true), [setHash]);

  if (!current) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return <ViewerLoading />;
  }

  const loadedBytes = current.segs.reduce((n, s) => n + (s.end - s.start), 0);
  const lastSeg = current.segs[current.segs.length - 1];
  const maxLine = lastSeg ? lastSeg.start_line + lastSeg.lines.length : 1;
  const gutter = `calc(${String(maxLine).length}ch + 1.25rem)`;
  const items: React.ReactNode[] = [];
  const order = [
    ...current.segs.map((s) => ({ type: "seg" as const, start: s.start, seg: s })),
    ...gaps.map((g) => ({ type: "gap" as const, start: g.start, gap: g })),
  ].sort((a, b) => a.start - b.start);

  for (const it of order) {
    if (it.type === "seg") {
      items.push(<SegmentView key={`s${it.seg.start}`} seg={it.seg} target={target} onLineClick={onLineClick} />);
    } else {
      const g = it.gap;
      const gapSize = g.end - g.start;
      const k = `g${g.start}`;
      // Requests start one byte early so the server's "snap forward past the
      // next newline" lands exactly on the gap start.
      const fromStart = Math.max(0, g.start - 1);
      items.push(
        <div
          key={k}
          className="no-print sticky left-0 my-2 flex flex-wrap items-center gap-2 border-y border-dashed bg-muted/40 px-3 py-2 font-sans text-xs text-muted-foreground"
        >
          <span>
            {formatBytes(gapSize)} not loaded
            {target !== null && !targetLoaded ? " (loading target line...)" : ""}
          </span>
          {g.start > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => loadRange(`${k}-down`, fromStart, Math.min(g.end, g.start + CHUNK))}
            >
              {busy === `${k}-down` ? <Loader2Icon className="animate-spin" /> : <ArrowDownIcon />}
              Load 256 KB below
            </Button>
          ) : null}
          {g.end < current.size ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                loadRange(`${k}-up`, Math.max(fromStart, g.end - CHUNK - 1), g.end)
              }
            >
              {busy === `${k}-up` ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
              Load 256 KB above
            </Button>
          ) : null}
          {gapSize <= MAX_CHUNK - 2 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => loadRange(`${k}-all`, fromStart, g.end + 1)}
            >
              Load all {formatBytes(gapSize)}
            </Button>
          ) : null}
        </div>,
      );
    }
  }

  return (
    <div className="flex flex-col">
      <div className="no-print sticky top-[var(--header-h,3.5rem)] z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
        <span>
          {gaps.length === 0
            ? `Whole file loaded (${formatBytes(current.size)})`
            : `Showing ${formatBytes(loadedBytes)} of ${formatBytes(current.size)}`}
        </span>
        {gaps.length > 0 ? <Badge variant="secondary">large file</Badge> : null}
        <div className="ml-auto">
          <Button
            size="sm"
            variant={wrap ? "secondary" : "ghost"}
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
          >
            <WrapTextIcon /> Wrap
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "overflow-x-auto font-mono text-[13px] leading-[1.55]",
          wrap ? "[&_.text-line-body]:whitespace-pre-wrap [&_.text-line-body]:break-all" : "[&_.text-line-body]:whitespace-pre",
        )}
      >
        <div
          className={cn(!wrap && "w-max min-w-full")}
          style={{ ["--gutter" as string]: gutter }}
        >
          {items}
        </div>
      </div>
    </div>
  );
}
