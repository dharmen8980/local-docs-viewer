"use client";

import { useMemo, useState } from "react";
import { collapseContext, diffLineRows, intraLineHighlights, type LineDiff, type LineRow, type WordSegment } from "@/lib/diff";
import { cn } from "@/lib/utils";

const CONTEXT = 3;
const EMPTY: ReadonlySet<number> = new Set();

/** A row on screen, with its index in the full (uncollapsed) rows. */
interface Shown {
  row: LineRow;
  /** index in the full rows; for skip rows the first collapsed one */
  idx: number;
  /** first row of a run of changes (prev/next change navigation) */
  hunk?: boolean;
}

/**
 * Unified line diff: `oldText` (left/"-") against `newText` (right/"+").
 * Pass `diff` when it is computed already (it is then used as is). Unchanged
 * runs are collapsed and can be expanded; edited lines get word highlights.
 */
export function DiffView({
  oldText,
  newText,
  diff: given,
  oldLabel,
  newLabel,
  className,
  bodyClassName = "max-h-[50vh]",
  maxRows = Infinity,
}: {
  oldText: string;
  newText: string;
  /** precomputed diff of the two texts (undefined: computed here; null: it gave up) */
  diff?: LineDiff | null;
  oldLabel: string;
  newLabel: string;
  className?: string;
  /** classes of the scrolling body; replaces the default height cap */
  bodyClassName?: string;
  /** rows rendered at most (very large diffs) */
  maxRows?: number;
}) {
  const own = useMemo(
    () => (given === undefined ? diffLineRows(oldText, newText) : null),
    [given, oldText, newText],
  );
  const d = given === undefined ? own : given;
  const collapsed = useMemo(() => (d ? collapseContext(d.rows, CONTEXT) : null), [d]);
  const words = useMemo(() => (d ? intraLineHighlights(d.rows) : new Map<number, WordSegment[]>()), [d]);
  /** expanded gaps, by the full-row index of their first line (reset when the diff changes) */
  const [expanded, setExpanded] = useState<{ of: LineDiff | null; gaps: ReadonlySet<number> }>({ of: null, gaps: new Set() });
  const open = expanded.of === d ? expanded.gaps : EMPTY;

  const rows = useMemo<Shown[] | null>(() => {
    if (!d || !collapsed) return null;
    const out: Shown[] = [];
    let idx = 0;
    for (const r of collapsed) {
      if (r.type === "skip") {
        const start = r.start ?? idx;
        const count = r.count ?? 0;
        if (open.has(start)) for (let k = start; k < start + count; k++) out.push({ row: d.rows[k], idx: k });
        else out.push({ row: r, idx: start });
        idx = start + count;
      } else out.push({ row: r, idx: idx++ });
    }
    for (let i = 0; i < out.length; i++) {
      const t = out[i].row.type;
      const prev = i > 0 ? out[i - 1].row.type : "ctx";
      if ((t === "add" || t === "del") && prev !== "add" && prev !== "del") out[i].hunk = true;
    }
    return out;
  }, [d, collapsed, open]);

  const stats = { add: d?.added ?? 0, del: d?.removed ?? 0 };
  const shown = rows && rows.length > maxRows ? rows.slice(0, maxRows) : rows;
  const hidden = rows && shown ? rows.length - shown.length : 0;

  return (
    <div className={cn("overflow-hidden rounded-md border text-xs", className)}>
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/50 px-2 py-1 text-muted-foreground">
        <span>
          <span className="font-mono text-red-600 dark:text-red-400">-</span> {oldLabel}
        </span>
        <span>
          <span className="font-mono text-emerald-600 dark:text-emerald-400">+</span> {newLabel}
        </span>
        {rows ? (
          <span className="ml-auto">
            <span className="text-emerald-600 dark:text-emerald-400">+{stats.add}</span>{" "}
            <span className="text-red-600 dark:text-red-400">-{stats.del}</span>
          </span>
        ) : null}
      </div>
      <div className={cn("overflow-auto font-mono", bodyClassName)}>
        {!rows ? (
          <div className="p-3 text-muted-foreground">The versions are too different to compare quickly.</div>
        ) : stats.add + stats.del === 0 ? (
          <div className="p-3 text-muted-foreground">No differences.</div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {(shown ?? []).map(({ row: r, idx, hunk }) =>
                r.type === "skip" ? (
                  <tr key={`s${idx}`} className="bg-muted/40 text-muted-foreground">
                    <td colSpan={3} className="p-0">
                      <button
                        type="button"
                        className="w-full cursor-pointer px-2 py-0.5 text-center italic hover:bg-muted hover:text-foreground"
                        aria-label={`Show ${r.count} unchanged line${r.count === 1 ? "" : "s"}`}
                        title="Show these lines"
                        onClick={() => setExpanded({ of: d, gaps: new Set(open).add(idx) })}
                      >
                        {r.count} unchanged line{r.count === 1 ? "" : "s"}
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={idx}
                    data-diff-hunk={hunk ? "" : undefined}
                    className={cn(
                      "scroll-mt-24",
                      r.type === "add" && "bg-emerald-500/10",
                      r.type === "del" && "bg-red-500/10",
                    )}
                  >
                    <td className="w-10 select-none px-1 text-right align-top text-muted-foreground/70">{r.oldNo ?? ""}</td>
                    <td className="w-10 select-none px-1 text-right align-top text-muted-foreground/70">{r.newNo ?? ""}</td>
                    <td className="whitespace-pre-wrap break-all px-2 align-top">
                      <span
                        className={cn(
                          "select-none pr-1",
                          r.type === "add" && "text-emerald-600 dark:text-emerald-400",
                          r.type === "del" && "text-red-600 dark:text-red-400",
                          r.type === "ctx" && "text-transparent",
                        )}
                      >
                        {r.type === "add" ? "+" : r.type === "del" ? "-" : " "}
                      </span>
                      <LineText text={r.text} segments={words.get(idx)} type={r.type} />
                    </td>
                  </tr>
                ),
              )}
              {hidden > 0 ? (
                <tr className="bg-muted/40 text-muted-foreground">
                  <td colSpan={3} className="px-2 py-1 text-center italic">
                    {hidden.toLocaleString()} more line{hidden === 1 ? "" : "s"} not shown
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** One line, with the words that differ from its counterpart emphasised. */
function LineText({ text, segments, type }: { text: string; segments?: WordSegment[]; type: LineRow["type"] }) {
  if (!segments) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) =>
        s.changed ? (
          <mark
            key={i}
            className={cn(
              "rounded-sm text-inherit",
              type === "add" ? "bg-emerald-500/30 dark:bg-emerald-400/30" : "bg-red-500/25 dark:bg-red-400/30",
            )}
          >
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
