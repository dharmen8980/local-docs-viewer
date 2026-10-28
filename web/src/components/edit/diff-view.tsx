"use client";

import { useMemo } from "react";
import { diffLines } from "diff";
import { cn } from "@/lib/utils";

interface Row {
  type: "add" | "del" | "ctx" | "skip";
  text: string;
  oldNo?: number;
  newNo?: number;
  count?: number;
}

const CONTEXT = 3;

function buildRows(oldText: string, newText: string): Row[] | null {
  const parts = diffLines(oldText.replace(/\r\n/g, "\n"), newText.replace(/\r\n/g, "\n"), { timeout: 1500 });
  if (!parts) return null;
  const all: Row[] = [];
  let o = 1;
  let n = 1;
  for (const p of parts) {
    const lines = p.value.endsWith("\n") ? p.value.slice(0, -1).split("\n") : p.value.split("\n");
    for (const text of lines) {
      if (p.added) all.push({ type: "add", text, newNo: n++ });
      else if (p.removed) all.push({ type: "del", text, oldNo: o++ });
      else all.push({ type: "ctx", text, oldNo: o++, newNo: n++ });
    }
  }
  // Collapse long runs of unchanged lines.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((r, i) => {
    if (r.type === "ctx") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(all.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const out: Row[] = [];
  let skipped = 0;
  all.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: "skip", text: "", count: skipped });
      skipped = 0;
      out.push(r);
    } else skipped++;
  });
  if (skipped) out.push({ type: "skip", text: "", count: skipped });
  return out;
}

/** Simple unified line diff: `oldText` (left/"-") against `newText` (right/"+"). */
export function DiffView({
  oldText,
  newText,
  oldLabel,
  newLabel,
  className,
}: {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
  className?: string;
}) {
  const rows = useMemo(() => buildRows(oldText, newText), [oldText, newText]);
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const r of rows ?? []) {
      if (r.type === "add") add++;
      else if (r.type === "del") del++;
    }
    return { add, del };
  }, [rows]);

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
      <div className="max-h-[50vh] overflow-auto font-mono">
        {!rows ? (
          <div className="p-3 text-muted-foreground">The versions are too different to compare quickly.</div>
        ) : stats.add + stats.del === 0 ? (
          <div className="p-3 text-muted-foreground">No differences.</div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {rows.map((r, i) =>
                r.type === "skip" ? (
                  <tr key={i} className="bg-muted/40 text-muted-foreground">
                    <td colSpan={3} className="px-2 py-0.5 text-center italic">
                      {r.count} unchanged line{r.count === 1 ? "" : "s"}
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={i}
                    className={cn(
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
                      {r.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
