// Pure rules for "Changed since you last looked" (no imports: unit tested with node --test).

/** File kinds whose text is fetched, snapshotted and diffed. */
export const TEXT_KINDS: ReadonlySet<string> = new Set(["markdown", "mermaid", "code", "text", "json", "csv"]);

/** Mirrors the server's readers.CONTENT_MAX: /api/content answers 413 above it. */
export const CONTENT_MAX = 2 * 1024 * 1024;

/**
 * true when a file seen before has another mtime or size now (|Δmtime| > 1 ms).
 * Never viewed (undefined) -> false. `!==` rather than `>`: a file restored from
 * an older backup counts as changed too.
 */
export function isChangedSince(
  cur: { mtime: number; size: number },
  seen: { mtime: number; size: number } | undefined,
): boolean {
  if (!seen) return false;
  return Math.abs(cur.mtime - seen.mtime) > 0.001 || cur.size !== seen.size;
}

/** p itself or below `from` -> moved path, else null. */
export function remapPath(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  return null;
}

/** All ancestor folders ("" excluded) of the given file paths -> how many of the files they contain. */
export function changedDirsOf(paths: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of paths) {
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
      const d = p.slice(0, i);
      out.set(d, (out.get(d) ?? 0) + 1);
    }
  }
  return out;
}
