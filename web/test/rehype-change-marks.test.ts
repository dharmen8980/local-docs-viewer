import { test } from "node:test";
import assert from "node:assert/strict";
import type { Element, Root } from "hast";
import { rehypeChangeMarks } from "../src/lib/rehype-change-marks.ts";

/** A top-level element spanning source lines start..end. */
const el = (tagName: string, start: number, end: number): Element => ({
  type: "element",
  tagName,
  properties: {},
  children: [],
  position: { start: { line: start, column: 1 }, end: { line: end, column: 1 } },
});

const nl = { type: "text" as const, value: "\n" };

function run(marks: Parameters<typeof rehypeChangeMarks>[0]): Root {
  const tree: Root = { type: "root", children: [el("h1", 1, 1), nl, el("p", 3, 4), nl, el("hr", 6, 6), nl, el("pre", 8, 10)] };
  rehypeChangeMarks(marks)()(tree);
  return tree;
}

const summary = (tree: Root) =>
  tree.children
    .filter((n): n is Element => n.type === "element")
    .map((n) => {
      const cls = n.properties.className;
      if (Array.isArray(cls) && cls.length) return `${cls[0]}(${n.properties.dataRemovedLabel})`;
      return n.properties.dataChange ? `${n.tagName}:${n.properties.dataChange}` : n.tagName;
    });

test("no marks: tree untouched", () => {
  assert.deepEqual(summary(run(null)), ["h1", "p", "hr", "pre"]);
});

test("ranges map onto overlapping top-level blocks; modified wins", () => {
  const t = run({
    ranges: [
      { start: 3, end: 3, kind: "added" },
      { start: 4, end: 4, kind: "modified" },
      { start: 9, end: 9, kind: "added" },
    ],
    removed: [],
  });
  assert.deepEqual(summary(t), ["h1", "p:modified", "hr", "pre:added"]);
});

test("removals get their own marker before the next block (not on the hr), and at the end", () => {
  const t = run({ ranges: [], removed: [{ beforeLine: 6, count: 1 }, { beforeLine: null, count: 2 }] });
  assert.deepEqual(summary(t), [
    "h1",
    "p",
    "md-removed(1 block removed)",
    "hr",
    "pre",
    "md-removed-end(2 blocks removed at the end)",
  ]);
  const hr = t.children.find((n): n is Element => n.type === "element" && n.tagName === "hr");
  assert.equal(hr?.properties.dataRemovedLabel, undefined);
  // whitespace text nodes are kept
  assert.equal(t.children.filter((n) => n.type === "text").length, 3);
});
