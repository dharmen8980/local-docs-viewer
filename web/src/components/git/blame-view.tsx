"use client";

import { useEffect, useMemo, useState } from "react";
import { GitCommitHorizontalIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewerError } from "@/components/viewers/common";
import { api, ApiError, errorMessage, type GitBlameCommit, type GitBlameLine } from "@/lib/api";
import { ageOf, blameGroups, mergeBlame } from "@/lib/git";
import { cn } from "@/lib/utils";

/** Lines asked for per request (the server allows up to 5000). */
const CHUNK = 2000;

interface Loaded {
  lines: GitBlameLine[];
  commits: Record<string, GitBlameCommit>;
  total: number;
  tracked: boolean;
}

/** Who last changed each line (git blame), in chunks: the first CHUNK lines, then "Load more". */
export function BlameView({ path, version, onClose }: { path: string; version: string; onClose: () => void }) {
  const [state, setState] = useState<{ key: string; data: Loaded } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${path}\u0000${version}`;

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .gitBlame(path, 1, CHUNK, ctrl.signal)
      .then((r) => {
        setState({ key, data: { lines: r.lines, commits: r.commits, total: r.total, tracked: r.tracked } });
        setError(null);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && (e as Error)?.name !== "AbortError") setError(e);
      });
    return () => ctrl.abort();
  }, [path, key]);

  const data = state?.data ?? null;
  const loadMore = () => {
    if (!data || loadingMore) return;
    const start = (data.lines.at(-1)?.line ?? 0) + 1;
    setLoadingMore(true);
    api
      .gitBlame(path, start, CHUNK)
      .then((r) =>
        setState((s) => {
          if (!s || s.key !== key) return s;
          // Nothing came back (the file shrank or stopped being tracked since the first chunk):
          // stop at what is shown rather than asking for the same range again.
          if (!r.tracked || r.lines.length === 0) return { key, data: { ...s.data, total: s.data.lines.at(-1)?.line ?? 0 } };
          return {
            key,
            data: { ...s.data, lines: mergeBlame(s.data.lines, r.lines), commits: { ...s.data.commits, ...r.commits }, total: r.total },
          };
        }),
      )
      .catch((e) => setError(e))
      .finally(() => setLoadingMore(false));
  };

  const groups = useMemo(() => (data ? blameGroups(data.lines) : []), [data]);

  const header = (
    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <GitCommitHorizontalIcon className="size-3.5" aria-hidden />
      <span className="font-medium text-foreground">Blame</span>
      <span>who last changed each line</span>
      <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose} title="Back to the plain view">
        <XIcon /> Close
      </Button>
    </div>
  );

  if (error && !data) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <div className="px-4 py-4 md:px-8">
        {header}
        <ViewerError
          title={status === 413 ? "Too large to blame" : status === 400 ? "Not a text file" : "Could not load the blame"}
          message={errorMessage(error)}
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-2 px-4 py-4 md:px-8">
        {header}
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (!data.tracked) {
    return (
      <div className="px-4 py-4 md:px-8">
        {header}
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          This file is not in any commit yet, so there is nothing to blame.
        </p>
      </div>
    );
  }
  const shown = data.lines.at(-1)?.line ?? 0;
  return (
    <div className="px-4 py-4 md:px-8">
      {header}
      <div className="overflow-x-auto rounded-md border font-mono text-xs">
        <table className="w-full border-collapse">
          <tbody>
            {groups.map((g) => {
              const c = data.commits[g.commit];
              const tip = c
                ? c.uncommitted
                  ? "Not committed yet"
                  : `${c.short} · ${c.author} · ${new Date(c.authorTime * 1000).toLocaleString()}\n${c.summary}`
                : g.commit;
              return g.lines.map((l, i) => (
                <tr key={l.line} className={cn(i === 0 && "border-t first:border-t-0", c?.uncommitted && "bg-amber-500/5")}>
                  <td
                    className="w-56 max-w-56 border-r px-2 align-top whitespace-nowrap text-muted-foreground select-none"
                    title={tip}
                  >
                    {i === 0 && c ? (
                      <span className="flex items-baseline gap-2">
                        <span className={cn(c.uncommitted ? "text-amber-700 dark:text-amber-400" : "text-sky-700 dark:text-sky-400")}>
                          {c.uncommitted ? "uncommitted" : c.short.slice(0, 7)}
                        </span>
                        {c.uncommitted ? null : (
                          <>
                            <span className="min-w-0 truncate font-sans">{c.author}</span>
                            <span className="ml-auto shrink-0 font-sans">{ageOf(c.authorTime)}</span>
                          </>
                        )}
                      </span>
                    ) : null}
                  </td>
                  <td className="w-12 px-2 text-right align-top text-muted-foreground/70 select-none">{l.line}</td>
                  <td className="px-2 whitespace-pre">{l.text || " "}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      {shown < data.total ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            Lines 1-{shown.toLocaleString()} of {data.total.toLocaleString()}
          </span>
          <Button size="xs" variant="outline" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading..." : `Load ${Math.min(CHUNK, data.total - shown).toLocaleString()} more`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
