import { test } from "node:test";
import assert from "node:assert/strict";
import { changedDirsOf, isChangedSince, remapPath } from "../src/lib/change-rules.ts";

test("isChangedSince", () => {
  const cur = { mtime: 1000, size: 10 };
  assert.equal(isChangedSince(cur, undefined), false);
  assert.equal(isChangedSince(cur, { mtime: 1000, size: 10 }), false);
  assert.equal(isChangedSince(cur, { mtime: 1000.0005, size: 10 }), false);
  assert.equal(isChangedSince(cur, { mtime: 1001, size: 10 }), true);
  assert.equal(isChangedSince(cur, { mtime: 999, size: 10 }), true);
  assert.equal(isChangedSince(cur, { mtime: 1000, size: 11 }), true);
});

test("remapPath", () => {
  assert.equal(remapPath("a/b", "a/b", "x/y"), "x/y");
  assert.equal(remapPath("a/b/c.md", "a/b", "x"), "x/c.md");
  assert.equal(remapPath("a/bc", "a/b", "x"), null);
  assert.equal(remapPath("z.md", "a/b", "x"), null);
});

test("changedDirsOf", () => {
  assert.deepEqual(changedDirsOf(["a/b/c.md", "x.md"]), new Map([["a/b", 1], ["a", 1]]));
  assert.deepEqual(
    changedDirsOf(["a/b/c.md", "a/d.md", "a/b/e/f.md"]),
    new Map([["a/b", 2], ["a", 3], ["a/b/e", 1]]),
  );
  assert.deepEqual(changedDirsOf([]), new Map());
});
