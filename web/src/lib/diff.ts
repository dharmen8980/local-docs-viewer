// Diff engine: unified line diffs (jsdiff) and top-level markdown block diffs.
// Pure and framework-free so it can be unit tested with `node --test` and
// reused by any "compare" view. Keep it free of `@/` and relative imports.

import { diffArrays, diffLines, diffWordsWithSpace } from "diff";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

// ---------- line diff ----------

/** Default time budget of one diff (ms); the diff gives up (null) beyond it. */
export const DIFF_TIMEOUT_MS = 1000;

export type LineRowType = "add" | "del" | "ctx" | "skip";

export interface LineRow {
  type: LineRowType;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** skip rows: number of collapsed unchanged lines */
  count?: number;
  /** skip rows: index of the first collapsed row in the full (uncollapsed) rows */
  start?: number;
}

/** A maximal run of add/del rows; 1-based line numbers, *Lines may be 0. */
export interface LineHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface LineDiff {
  rows: LineRow[];
  hunks: LineHunk[];
  added: number;
  removed: number;
}

/** CRLF/CR -> LF and a guaranteed trailing "\n" (a missing final newline is not reported as a change). */
export function normalizeText(s: string): string {
  const t = s.replace(/\r\n?/g, "\n");
  return t === "" || t.endsWith("\n") ? t : `${t}\n`;
}

export interface LineDiffOptions {
  timeoutMs?: number;
  maxEditLength?: number;
  /**
   * true: also fold lone CRs and ignore a missing final newline (normalizeText),
   * for "what changed" summaries. Default false: exact apart from CRLF -> LF, so a
   * save review still shows an added or removed trailing newline.
   */
  normalize?: boolean;
}

/** Full (uncollapsed) unified line diff. null = gave up (timeout / maxEditLength). */
export function diffLineRows(oldText: string, newText: string, opts: LineDiffOptions = {}): LineDiff | null {
  const prep = opts.normalize ? normalizeText : (s: string) => s.replace(/\r\n/g, "\n");
  const parts = diffLines(prep(oldText), prep(newText), {
    timeout: opts.timeoutMs ?? DIFF_TIMEOUT_MS,
    maxEditLength: opts.maxEditLength,
  });
  if (!parts) return null;
  const rows: LineRow[] = [];
  let o = 1;
  let n = 1;
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (!p.value) continue;
    const lines = p.value.endsWith("\n") ? p.value.slice(0, -1).split("\n") : p.value.split("\n");
    for (const text of lines) {
      if (p.added) {
        rows.push({ type: "add", text, newNo: n++ });
        added++;
      } else if (p.removed) {
        rows.push({ type: "del", text, oldNo: o++ });
        removed++;
      } else rows.push({ type: "ctx", text, oldNo: o++, newNo: n++ });
    }
  }
  // Hunks: maximal runs of changed rows. `o`/`n` track the next line numbers.
  const hunks: LineHunk[] = [];
  let cur: LineHunk | null = null;
  o = 1;
  n = 1;
  for (const r of rows) {
    if (r.type === "ctx") {
      cur = null;
      o++;
      n++;
      continue;
    }
    if (!cur) {
      cur = { oldStart: o, oldLines: 0, newStart: n, newLines: 0 };
      hunks.push(cur);
    }
    if (r.type === "del") {
      cur.oldLines++;
      o++;
    } else {
      cur.newLines++;
      n++;
    }
  }
  return { rows, hunks, added, removed };
}

/** true when the changed lines only differ in whitespace (incl. blank lines added or removed). */
export function onlyWhitespaceChanged(d: LineDiff): boolean {
  // Per run of changes, so a moved line is not mistaken for a whitespace change.
  let del = "";
  let add = "";
  for (const r of d.rows) {
    if (r.type === "del") del += r.text.replace(/\s+/g, "");
    else if (r.type === "add") add += r.text.replace(/\s+/g, "");
    else if (r.type === "ctx") {
      if (del !== add) return false;
      del = add = "";
    }
  }
  return del === add;
}

/** Collapse runs of unchanged lines, keeping `context` lines around changes. */
export function collapseContext(rows: LineRow[], context = 3): LineRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type !== "add" && r.type !== "del") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const out: LineRow[] = [];
  let skipped = 0;
  let start = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: "skip", text: "", count: skipped, start });
      skipped = 0;
      out.push(r);
    } else {
      if (!skipped) start = r.type === "skip" ? (r.start ?? i) : i;
      skipped += r.type === "skip" ? (r.count ?? 0) : 1;
    }
  });
  if (skipped) out.push({ type: "skip", text: "", count: skipped, start });
  return out;
}

// ---------- word diff inside changed lines ----------

/** A piece of one line; `changed` = not in the other version. */
export interface WordSegment {
  text: string;
  changed: boolean;
}

/** Lines longer than this are not word-diffed (cost, and little use). */
const WORD_DIFF_MAX_CHARS = 4000;

/**
 * Word-level diff of an edited line (jsdiff diffWordsWithSpace). null when the
 * lines are too long or mostly different: highlighting nearly everything helps
 * nobody, the line colour says it already.
 */
export function diffWordsInLine(oldLine: string, newLine: string): { old: WordSegment[]; new: WordSegment[] } | null {
  if (oldLine.length > WORD_DIFF_MAX_CHARS || newLine.length > WORD_DIFF_MAX_CHARS) return null;
  const parts = diffWordsWithSpace(oldLine, newLine, { timeout: 50 });
  if (!parts) return null;
  const out = { old: [] as WordSegment[], new: [] as WordSegment[] };
  let same = 0;
  for (const p of parts) {
    if (!p.added) out.old.push({ text: p.value, changed: Boolean(p.removed) });
    if (!p.removed) out.new.push({ text: p.value, changed: Boolean(p.added) });
    if (!p.added && !p.removed) same += p.value.length;
  }
  if (same < 0.3 * Math.max(oldLine.length, newLine.length)) return null;
  return out;
}

/**
 * Word highlights for runs of removed lines followed by added lines: the k-th
 * removed line is paired with the k-th added one. Keyed by row index in `rows`.
 */
export function intraLineHighlights(rows: readonly LineRow[], maxPairs = 1000, budgetMs = 250): Map<number, WordSegment[]> {
  const out = new Map<number, WordSegment[]>();
  const until = Date.now() + budgetMs;
  let pairs = 0;
  for (let i = 0; i < rows.length && pairs < maxPairs && Date.now() < until; ) {
    if (rows[i].type !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < rows.length && rows[i].type === "del") i++;
    const addStart = i;
    while (i < rows.length && rows[i].type === "add") i++;
    const n = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < n && pairs < maxPairs; k++, pairs++) {
      const w = diffWordsInLine(rows[delStart + k].text, rows[addStart + k].text);
      if (!w) continue;
      out.set(delStart + k, w.old);
      out.set(addStart + k, w.new);
    }
  }
  return out;
}

// ---------- markdown block diff ----------

export interface MdBlock {
  index: number;
  /** mdast node type: heading, paragraph, code, table, list, html, blockquote, thematicBreak, ... */
  type: string;
  /** 1-based, inclusive */
  startLine: number;
  endLine: number;
  /** source slice, trailing whitespace stripped per line (the comparison key) */
  text: string;
}

export type BlockChangeKind = "added" | "modified" | "removed";

export interface BlockChange {
  kind: BlockChangeKind;
  /** modified, removed */
  oldBlock?: MdBlock;
  /** added, modified */
  newBlock?: MdBlock;
  /** removed only: index in newBlocks of the block it sits before (newBlocks.length = at the end) */
  before?: number;
}

export interface MarkdownBlockDiff {
  oldBlocks: MdBlock[];
  newBlocks: MdBlock[];
  changes: BlockChange[];
  counts: { added: number; modified: number; removed: number };
}

/** Blocks that render elsewhere (footnotes) or nowhere (link definitions). */
const SKIP_BLOCKS = new Set(["definition", "footnoteDefinition"]);

/** Top-level blocks via mdast-util-from-markdown + GFM (the same parser react-markdown uses). */
export function splitMarkdownBlocks(text: string): MdBlock[] {
  const src = normalizeText(text);
  const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const out: MdBlock[] = [];
  for (const node of tree.children) {
    const pos = node.position;
    if (SKIP_BLOCKS.has(node.type) || !pos || pos.start.offset == null || pos.end.offset == null) continue;
    const slice = src
      .slice(pos.start.offset, pos.end.offset)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n");
    out.push({ index: out.length, type: node.type, startLine: pos.start.line, endLine: pos.end.line, text: slice });
  }
  return out;
}

/** Above this combined length the block diff is skipped (parsing alone gets slow). */
export const BLOCK_DIFF_MAX_CHARS = 2 * 1024 * 1024;

/** null = gave up: texts too large, or the diff ran out of time / edit length. */
export function diffMarkdownBlocks(
  oldText: string,
  newText: string,
  opts: { timeoutMs?: number; maxEditLength?: number; maxChars?: number } = {},
): MarkdownBlockDiff | null {
  if (oldText.length + newText.length > (opts.maxChars ?? BLOCK_DIFF_MAX_CHARS)) return null;
  const oldBlocks = splitMarkdownBlocks(oldText);
  const newBlocks = splitMarkdownBlocks(newText);
  const parts = diffArrays(
    oldBlocks.map((b) => b.text),
    newBlocks.map((b) => b.text),
    { timeout: opts.timeoutMs ?? DIFF_TIMEOUT_MS, maxEditLength: opts.maxEditLength },
  );
  if (!parts) return null;
  const changes: BlockChange[] = [];
  let oi = 0;
  let ni = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      oi += p.count ?? p.value.length;
      ni += p.count ?? p.value.length;
      continue;
    }
    // A removed run next to an added run (either order) is a replace group.
    const next = parts[i + 1];
    let r = 0;
    let a = 0;
    if (next && (next.added || next.removed) && next.added !== p.added) {
      r = p.removed ? p.value.length : next.value.length;
      a = p.added ? p.value.length : next.value.length;
      i++;
    } else if (p.removed) r = p.value.length;
    else a = p.value.length;
    const pairs = Math.min(r, a);
    for (let k = 0; k < pairs; k++) {
      changes.push({ kind: "modified", oldBlock: oldBlocks[oi + k], newBlock: newBlocks[ni + k] });
    }
    for (let k = pairs; k < a; k++) changes.push({ kind: "added", newBlock: newBlocks[ni + k] });
    for (let k = pairs; k < r; k++) changes.push({ kind: "removed", oldBlock: oldBlocks[oi + k], before: ni + a });
    oi += r;
    ni += a;
  }
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const c of changes) counts[c.kind]++;
  return { oldBlocks, newBlocks, changes, counts };
}

/** added + modified + removed */
export function sectionCount(d: MarkdownBlockDiff): number {
  return d.counts.added + d.counts.modified + d.counts.removed;
}

/** What the renderer needs: line ranges in the NEW text, plus removal anchors. */
export interface ChangeMarks {
  /** sorted by start */
  ranges: { start: number; end: number; kind: "added" | "modified" }[];
  /** beforeLine null = after the last block */
  removed: { beforeLine: number | null; count: number }[];
}

export function blockMarks(d: MarkdownBlockDiff): ChangeMarks {
  const ranges: ChangeMarks["ranges"] = [];
  const removedBy = new Map<number, number>();
  for (const c of d.changes) {
    if (c.kind === "removed") removedBy.set(c.before ?? d.newBlocks.length, (removedBy.get(c.before ?? d.newBlocks.length) ?? 0) + 1);
    else if (c.newBlock) ranges.push({ start: c.newBlock.startLine, end: c.newBlock.endLine, kind: c.kind });
  }
  ranges.sort((a, b) => a.start - b.start);
  const removed = [...removedBy]
    .sort((a, b) => a[0] - b[0])
    .map(([before, count]) => ({ beforeLine: before < d.newBlocks.length ? d.newBlocks[before].startLine : null, count }));
  return { ranges, removed };
}

// ---------- "what changed" summary ----------

/**
 * Both diffs of a changed file, as the banner and the What's new feed compute them.
 * `timeoutMs` is the budget of each of the two diffs (the feed uses a smaller one).
 */
export function diffVersions(
  oldText: string,
  newText: string,
  markdown: boolean,
  opts: { timeoutMs?: number } = {},
): { lineDiff: LineDiff | null; markdownDiff: MarkdownBlockDiff | null } {
  const timeoutMs = opts.timeoutMs ?? DIFF_TIMEOUT_MS;
  const lineDiff = diffLineRows(oldText, newText, { timeoutMs, normalize: true });
  // The block diff is skipped when the line diff already gave up.
  const markdownDiff = lineDiff && markdown ? diffMarkdownBlocks(oldText, newText, { timeoutMs }) : null;
  return { lineDiff, markdownDiff };
}

/** What changed, most specific first (the banner's and the feed's detail text). */
export type ChangeSummary =
  | { type: "blocks"; total: number; added: number; modified: number; removed: number }
  | { type: "lines"; changes: number; added: number; removed: number }
  | { type: "whitespace" }
  /** same text under a new mtime (touched, regenerated) */
  | { type: "same" }
  /** both texts known but the diff gave up */
  | { type: "too-many" }
  /**
   * no text to compare. For text-like kinds: `tooLarge` when the current file is over the
   * fetch limit, else `noCopy` when no earlier copy was saved.
   */
  | { type: "size"; delta: number; noCopy: boolean; tooLarge: boolean };

export interface ChangeSummaryInput {
  markdown: boolean;
  /** the kind's text is fetched and snapshotted (change-rules TEXT_KINDS) */
  textKind: boolean;
  baseText: string | null;
  currentText: string | null;
  lineDiff: LineDiff | null;
  markdownDiff: MarkdownBlockDiff | null;
  /** current size - base size */
  sizeDelta: number;
  /** the current file is over the fetch limit (CONTENT_MAX), so its text was not read */
  tooLarge?: boolean;
}

export function summarizeChange(s: ChangeSummaryInput): ChangeSummary {
  const { markdownDiff, lineDiff, baseText, currentText } = s;
  if (s.markdown && markdownDiff && sectionCount(markdownDiff) > 0) {
    return { type: "blocks", total: sectionCount(markdownDiff), ...markdownDiff.counts };
  }
  if (lineDiff) {
    // diffVersions normalizes: no hunks means the same text.
    if (!lineDiff.hunks.length) return { type: "same" };
    if (onlyWhitespaceChanged(lineDiff)) return { type: "whitespace" };
    return { type: "lines", changes: lineDiff.hunks.length, added: lineDiff.added, removed: lineDiff.removed };
  }
  if (baseText !== null && currentText !== null) {
    return normalizeText(baseText) === normalizeText(currentText) ? { type: "same" } : { type: "too-many" };
  }
  const tooLarge = s.textKind && Boolean(s.tooLarge);
  return { type: "size", delta: s.sizeDelta, noCopy: s.textKind && !tooLarge && baseText === null, tooLarge };
}
