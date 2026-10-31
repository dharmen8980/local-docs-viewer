// Pure parts of the git views: the Uncommitted feed rows, their one-line details, and blame
// grouping. No `@/` or relative value imports: unit tested with node --test.

export type GitCode = "M" | "A" | "D" | "R" | "??" | "U";

/** The fields of a /api/git/status entry used here. */
export interface GitEntry {
  path: string;
  status: GitCode;
  origPath: string | null;
  added: number | null;
  removed: number | null;
  binary: boolean;
  kind: string | null;
  mtime: number | null;
  size: number | null;
}

/** A row of the Uncommitted feed (same shape as the What's new rows, plus the git fields). */
export interface GitFeedItem {
  path: string;
  name: string;
  dir: string;
  kind: string;
  /** 0 for deleted files (no time on disk) */
  mtime: number;
  size: number;
  key: string;
  status: GitCode;
  entry: GitEntry;
}

/** The status letters as shown on a badge, and in words. */
export const GIT_STATUS_WORDS: Record<GitCode, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  "??": "untracked",
  U: "conflict",
};

/** Status entries as feed rows: newest change first, deleted files after the rest, then by path. */
export function uncommittedItems(entries: readonly GitEntry[]): GitFeedItem[] {
  const out = entries.map((e) => {
    const i = e.path.lastIndexOf("/");
    return {
      path: e.path,
      name: e.path.slice(i + 1),
      dir: i < 0 ? "" : e.path.slice(0, i),
      kind: e.kind ?? "text",
      mtime: e.mtime ?? 0,
      size: e.size ?? 0,
      key: `${e.path}\u0000${e.status}:${e.mtime ?? "-"}:${e.size ?? "-"}:${e.added ?? "-"}:${e.removed ?? "-"}`,
      status: e.status,
      entry: e,
    };
  });
  return out.sort(
    (a, b) =>
      Number(a.status === "D") - Number(b.status === "D") ||
      b.mtime - a.mtime ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** What the entry changed against the last commit, in a few words. */
export function gitDetail(e: GitEntry): string {
  const counts = e.added !== null && e.removed !== null;
  const lines = counts ? `+${e.added} −${e.removed} lines` : null;
  switch (e.status) {
    case "??":
      return e.binary ? "new file, not committed (binary)" : counts ? `new file, ${plural(e.added ?? 0, "line")}` : "new file, not committed";
    case "A":
      return e.binary ? "added (binary)" : counts ? `added, ${plural(e.added ?? 0, "line")}` : "added";
    case "D":
      return counts ? `deleted, ${plural(e.removed ?? 0, "line")}` : "deleted";
    case "R": {
      const from = e.origPath ? `renamed from ${e.origPath}` : "renamed";
      return lines && (e.added || e.removed) ? `${from}, ${lines}` : from;
    }
    case "U":
      return "merge conflict";
    default:
      if (e.binary) return "binary file changed";
      return lines ?? "changed";
  }
}

/** The blame of a run of consecutive lines from the same commit. */
export interface BlameGroup<L extends { line: number; commit: string }> {
  commit: string;
  start: number;
  lines: L[];
}

/** Consecutive lines of the same commit, in order (a gap in line numbers starts a new group). */
export function blameGroups<L extends { line: number; commit: string }>(lines: readonly L[]): BlameGroup<L>[] {
  const out: BlameGroup<L>[] = [];
  let cur: BlameGroup<L> | null = null;
  let prev = -1;
  for (const l of [...lines].sort((a, b) => a.line - b.line)) {
    if (!cur || cur.commit !== l.commit || l.line !== prev + 1) {
      cur = { commit: l.commit, start: l.line, lines: [] };
      out.push(cur);
    }
    cur.lines.push(l);
    prev = l.line;
  }
  return out;
}

/** Merges a newly loaded chunk into the lines loaded so far (by line number, newest wins). */
export function mergeBlame<L extends { line: number }>(have: readonly L[], chunk: readonly L[]): L[] {
  const byLine = new Map<number, L>();
  for (const l of have) byLine.set(l.line, l);
  for (const l of chunk) byLine.set(l.line, l);
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** "3 days ago" style age of a unix time (seconds), against `now` (ms). */
export function ageOf(seconds: number, now = Date.now()): string {
  const d = Math.max(0, now / 1000 - seconds);
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (d < 60) return "just now";
  if (d < 3600) return unit(Math.floor(d / 60), "minute");
  if (d < 86400) return unit(Math.floor(d / 3600), "hour");
  if (d < 86400 * 30) return unit(Math.floor(d / 86400), "day");
  if (d < 86400 * 365) return unit(Math.floor(d / (86400 * 30)), "month");
  return unit(Math.floor(d / (86400 * 365)), "year");
}
