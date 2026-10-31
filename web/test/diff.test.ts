import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockMarks,
  collapseContext,
  diffLineRows,
  diffMarkdownBlocks,
  diffWordsInLine,
  intraLineHighlights,
  onlyWhitespaceChanged,
  sectionCount,
  splitMarkdownBlocks,
  summarizeChange,
  diffVersions,
  type LineDiff,
  type MarkdownBlockDiff,
} from "../src/lib/diff.ts";

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) =>
  Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

function must<T extends LineDiff | MarkdownBlockDiff>(d: T | null): T {
  assert.ok(d, "diff gave up");
  return d;
}

test("identical texts and newline normalisation give no changes", () => {
  const d = must(diffLineRows("a\nb\n", "a\nb\n"));
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.hunks.length, 0);
  const n = must(diffLineRows("a\r\nb", "a\nb\n", { normalize: true }));
  assert.equal(n.added + n.removed, 0);
  assert.equal(n.hunks.length, 0);
  const cr = must(diffLineRows("a\rb\n", "a\nb\n", { normalize: true }));
  assert.equal(cr.hunks.length, 0);
});

test("exact mode (default): only CRLF is folded, a final newline counts", () => {
  assert.equal(must(diffLineRows("a\r\nb\r\n", "a\nb\n")).hunks.length, 0);
  const nl = must(diffLineRows("a\nb", "a\nb\n"));
  assert.equal(nl.hunks.length, 1);
  assert.equal(nl.added, 1);
  assert.equal(nl.removed, 1);
  assert.equal(must(diffLineRows("a\rb\n", "a\nb\n")).hunks.length, 1);
});

test("a changed middle line", () => {
  const d = must(diffLineRows("a\nb\nc", "a\nB\nc"));
  const changed = d.rows.filter((r) => r.type !== "ctx");
  assert.deepEqual(changed, [
    { type: "del", text: "b", oldNo: 2 },
    { type: "add", text: "B", newNo: 2 },
  ]);
  assert.deepEqual(d.hunks, [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
});

test("pure insertions at the end and at the start", () => {
  const end = must(diffLineRows("a\nb\n", "a\nb\nc\n"));
  assert.deepEqual(end.rows.at(-1), { type: "add", text: "c", newNo: 3 });
  assert.deepEqual(end.hunks, [{ oldStart: 3, oldLines: 0, newStart: 3, newLines: 1 }]);
  const start = must(diffLineRows("a\nb\n", "z\na\nb\n"));
  assert.deepEqual(start.rows[0], { type: "add", text: "z", newNo: 1 });
  assert.deepEqual(start.rows[1], { type: "ctx", text: "a", oldNo: 1, newNo: 2 });
  assert.deepEqual(start.hunks, [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 }]);
});

test("collapseContext keeps context around changes", () => {
  const a = lines(20);
  const b = lines(20, (i) => (i === 10 ? "changed" : `line ${i}`));
  const d = must(diffLineRows(a, b));
  const c = collapseContext(d.rows, 3);
  assert.deepEqual(
    c.map((r) => (r.type === "skip" ? `skip(${r.count})` : r.type)),
    ["skip(6)", "ctx", "ctx", "ctx", "del", "add", "ctx", "ctx", "ctx", "skip(7)"],
  );
  // skip rows point at their first line in the full rows (expanding a gap)
  assert.deepEqual(
    c.filter((r) => r.type === "skip").map((r) => [r.start, r.count]),
    [
      [0, 6],
      [14, 7],
    ],
  );
  const z = collapseContext(d.rows, 0);
  assert.deepEqual(
    z.map((r) => (r.type === "skip" ? `skip(${r.count})` : r.type)),
    ["skip(9)", "del", "add", "skip(10)"],
  );
});

test("maxEditLength gives up", () => {
  const a = lines(30);
  const b = lines(30, (i) => (i === 3 || i === 15 || i === 27 ? `x${i}` : `line ${i}`));
  assert.equal(diffLineRows(a, b, { maxEditLength: 1 }), null);
});

const DOC = [
  "# Title", // 1
  "", // 2
  "Some paragraph.", // 3
  "", // 4
  "```js", // 5
  "const a = 1;", // 6
  "", // 7
  "const b = 2;", // 8
  "```", // 9
  "", // 10
  "| a | b |", // 11
  "| - | - |", // 12
  "| 1 | 2 |", // 13
  "", // 14
  "- one", // 15
  "- two", // 16
  "", // 17
  "<div>raw</div>", // 18
  "", // 19
  "[ref]: https://example.com", // 20
  "",
].join("\n");

test("splitMarkdownBlocks", () => {
  const blocks = splitMarkdownBlocks(DOC);
  assert.deepEqual(
    blocks.map((b) => [b.type, b.startLine, b.endLine]),
    [
      ["heading", 1, 1],
      ["paragraph", 3, 3],
      ["code", 5, 9],
      ["table", 11, 13],
      ["list", 15, 16],
      ["html", 18, 18],
    ],
  );
  assert.deepEqual(
    blocks.map((b) => b.index),
    [0, 1, 2, 3, 4, 5],
  );
});

const blocks = (a: string, b: string) => must(diffMarkdownBlocks(a, b));
const md = (...blocks: string[]) => blocks.join("\n\n") + "\n";

test("diffMarkdownBlocks: modified, added, removed", () => {
  const base = md("# T", "one", "two", "three");

  const mod = blocks(base, md("# T", "one", "TWO", "three"));
  assert.deepEqual(
    mod.changes.map((c) => c.kind),
    ["modified"],
  );
  assert.equal(mod.changes[0].newBlock?.startLine, 5);
  assert.equal(mod.changes[0].newBlock?.endLine, 5);
  assert.equal(sectionCount(mod), 1);

  const add = blocks(base, md("# T", "one", "new", "two", "three"));
  assert.deepEqual(
    add.changes.map((c) => c.kind),
    ["added"],
  );
  assert.equal(add.changes[0].newBlock?.text, "new");

  const del = blocks(base, md("# T", "one", "three"));
  assert.deepEqual(
    del.changes.map((c) => [c.kind, c.before]),
    [["removed", 2]],
  );
  assert.equal(del.newBlocks[2].text, "three");

  const last = blocks(base, md("# T", "one", "two"));
  assert.equal(last.changes.length, 1);
  assert.equal(last.changes[0].before, last.newBlocks.length);

  const ws = blocks(base, "# T  \n\none\t\n\ntwo\n\nthree   \n");
  assert.equal(ws.changes.length, 0);
  assert.equal(sectionCount(ws), 0);

  const fresh = blocks("", base);
  assert.deepEqual(
    fresh.changes.map((c) => c.kind),
    ["added", "added", "added", "added"],
  );
  assert.equal(sectionCount(fresh), 4);
  assert.deepEqual(fresh.counts, { added: 4, modified: 0, removed: 0 });
});

test("blockMarks", () => {
  const d = blocks(md("# T", "one", "two", "three", "four"), md("# T", "ONE", "two", "added", "three"));
  const m = blockMarks(d);
  assert.deepEqual(m.ranges, [
    { start: 3, end: 3, kind: "modified" },
    { start: 7, end: 7, kind: "added" },
  ]);
  assert.deepEqual(m.removed, [{ beforeLine: null, count: 1 }]);

  const mid = blockMarks(blocks(md("a", "b", "c"), md("a", "c")));
  assert.deepEqual(mid.removed, [{ beforeLine: 3, count: 1 }]);
});

test("diffMarkdownBlocks gives up (null) on budget or size", () => {
  const a = md(...Array.from({ length: 40 }, (_, i) => `para ${i}`));
  const b = md(...Array.from({ length: 40 }, (_, i) => `para ${i} changed`));
  assert.equal(diffMarkdownBlocks(a, b, { maxEditLength: 2 }), null);
  assert.equal(diffMarkdownBlocks(a, b, { maxChars: 10 }), null);
  assert.ok(diffMarkdownBlocks(a, b));
});

test("word diff inside an edited line", () => {
  const w = diffWordsInLine("This page covers the setup.", "This page explains the setup.");
  assert.ok(w);
  assert.deepEqual(
    w.old.filter((s) => s.changed).map((s) => s.text),
    ["covers"],
  );
  assert.deepEqual(
    w.new.filter((s) => s.changed).map((s) => s.text),
    ["explains"],
  );
  assert.equal(w.new.map((s) => s.text).join(""), "This page explains the setup.");
  // Mostly different lines: no word highlights.
  assert.equal(diffWordsInLine("alpha beta gamma", "one two three"), null);

  const d = must(diffLineRows("a\nThis page covers the setup.\nb\n", "a\nThis page explains the setup.\nb\n"));
  const hl = intraLineHighlights(d.rows);
  assert.deepEqual([...hl.keys()], [1, 2]);
});

test("onlyWhitespaceChanged", () => {
  assert.equal(onlyWhitespaceChanged(must(diffLineRows("a\nb  \n", "a\nb\n"))), true);
  assert.equal(onlyWhitespaceChanged(must(diffLineRows("a\nb\n", "a\n\nb\n"))), true);
  assert.equal(onlyWhitespaceChanged(must(diffLineRows("a\nb\n", "a\nc\n"))), false);
  // a moved line is a real change
  assert.equal(onlyWhitespaceChanged(must(diffLineRows("x\na\nb\nc\n", "a\nb\nc\nx\n"))), false);
});

// ---------- summarizeChange (the banner's and the What's new feed's detail) ----------

const summarize = (oldText: string, newText: string, markdown = true, sizeDelta = 0) => {
  const { lineDiff, markdownDiff } = diffVersions(oldText, newText, markdown);
  return summarizeChange({ markdown, textKind: true, baseText: oldText, currentText: newText, lineDiff, markdownDiff, sizeDelta });
};

test("summarizeChange: markdown blocks added / edited / removed", () => {
  const s = summarize("# T\n\nkeep\n\nold para\n\ngone\n", "# T\n\nkeep\n\nnew para\n\nadded one\n");
  assert.equal(s.type, "blocks");
  if (s.type !== "blocks") return;
  assert.equal(s.added + s.modified + s.removed, s.total);
  assert.ok(s.modified >= 1);
});

test("summarizeChange: other text gives line counts", () => {
  const s = summarize("a\nb\nc\n", "a\nB\nc\nd\n", false);
  assert.deepEqual(s, { type: "lines", changes: 2, added: 2, removed: 1 });
});

test("summarizeChange: whitespace only, same text, too many, size only", () => {
  assert.deepEqual(summarize("a b\n", "a  b\n", false), { type: "whitespace" });
  assert.deepEqual(summarize("a\r\nb", "a\nb\n", false), { type: "same" });
  // Both texts known, the diff gave up.
  assert.deepEqual(
    summarizeChange({ markdown: false, textKind: true, baseText: "a\n", currentText: "b\n", lineDiff: null, markdownDiff: null, sizeDelta: 0 }),
    { type: "too-many" },
  );
  assert.deepEqual(
    summarizeChange({ markdown: false, textKind: true, baseText: null, currentText: "b\n", lineDiff: null, markdownDiff: null, sizeDelta: 2048 }),
    { type: "size", delta: 2048, noCopy: true, tooLarge: false },
  );
  assert.deepEqual(
    summarizeChange({ markdown: false, textKind: false, baseText: null, currentText: null, lineDiff: null, markdownDiff: null, sizeDelta: -3 }),
    { type: "size", delta: -3, noCopy: false, tooLarge: false },
  );
});

test("summarizeChange: a saved copy but no current text is not 'no copy'", () => {
  const base = { markdown: false, textKind: true, lineDiff: null, markdownDiff: null, sizeDelta: 5 };
  // Over the fetch limit: too large to compare, whether or not a copy was saved.
  assert.deepEqual(summarizeChange({ ...base, baseText: "a\n", currentText: null, tooLarge: true }), {
    type: "size",
    delta: 5,
    noCopy: false,
    tooLarge: true,
  });
  assert.deepEqual(summarizeChange({ ...base, baseText: null, currentText: null, tooLarge: true }), {
    type: "size",
    delta: 5,
    noCopy: false,
    tooLarge: true,
  });
  // The current text could not be read (deleted meanwhile): just the size.
  assert.deepEqual(summarizeChange({ ...base, baseText: "a\n", currentText: null }), {
    type: "size",
    delta: 5,
    noCopy: false,
    tooLarge: false,
  });
});

test("diffVersions: a smaller budget is passed to both diffs", () => {
  const a = Array.from({ length: 4000 }, (_, i) => `line ${i} ${i % 7}`).join("\n");
  const b = Array.from({ length: 4000 }, (_, i) => `line ${(i * 7919) % 4000} x`).join("\n");
  const t = Date.now();
  const r = diffVersions(a, b, true, { timeoutMs: 1 });
  assert.ok(Date.now() - t < 500);
  assert.equal(r.lineDiff, null);
  assert.equal(r.markdownDiff, null);
});

test("summarizeChange: markdown where only definitions changed falls back to lines", () => {
  const s = summarize("Text [x].\n\n[x]: https://a.example\n", "Text [x].\n\n[x]: https://b.example\n");
  assert.equal(s.type, "lines");
});
