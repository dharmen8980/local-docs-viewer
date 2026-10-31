import { test } from "node:test";
import assert from "node:assert/strict";
import { ageOf, blameGroups, gitDetail, mergeBlame, uncommittedItems, type GitEntry } from "../src/lib/git.ts";

const entry = (path: string, status: GitEntry["status"], over: Partial<GitEntry> = {}): GitEntry => ({
  path,
  status,
  origPath: null,
  added: 1,
  removed: 0,
  binary: false,
  kind: "markdown",
  mtime: 10,
  size: 5,
  ...over,
});

test("uncommittedItems: newest first, deleted last, names and folders", () => {
  const items = uncommittedItems([
    entry("a.md", "M", { mtime: 5 }),
    entry("docs/gone.md", "D", { mtime: null, size: null }),
    entry("docs/b.md", "??", { mtime: 9 }),
    entry("c.md", "M", { mtime: 9 }),
  ]);
  assert.deepEqual(
    items.map((i) => i.path),
    ["c.md", "docs/b.md", "a.md", "docs/gone.md"],
  );
  assert.equal(items[1].name, "b.md");
  assert.equal(items[1].dir, "docs");
  assert.equal(items[3].mtime, 0);
  assert.equal(items[3].status, "D");
});

test("uncommittedItems: the key changes with the counts", () => {
  const [a] = uncommittedItems([entry("a.md", "M", { added: 1 })]);
  const [b] = uncommittedItems([entry("a.md", "M", { added: 2 })]);
  assert.notEqual(a.key, b.key);
});

test("gitDetail: per status", () => {
  assert.equal(gitDetail(entry("a", "M", { added: 3, removed: 1 })), "+3 −1 lines");
  assert.equal(gitDetail(entry("a", "M", { added: null, removed: null, binary: true })), "binary file changed");
  assert.equal(gitDetail(entry("a", "??", { added: 1 })), "new file, 1 line");
  assert.equal(gitDetail(entry("a", "??", { added: null, removed: null })), "new file, not committed");
  assert.equal(gitDetail(entry("a", "A", { added: 12 })), "added, 12 lines");
  assert.equal(gitDetail(entry("a", "D", { added: 0, removed: 4 })), "deleted, 4 lines");
  assert.equal(gitDetail(entry("a", "R", { origPath: "old.md", added: 0, removed: 0 })), "renamed from old.md");
  assert.equal(gitDetail(entry("a", "R", { origPath: "old.md", added: 2, removed: 1 })), "renamed from old.md, +2 −1 lines");
  assert.equal(gitDetail(entry("a", "U")), "merge conflict");
});

test("blameGroups: consecutive lines of one commit, gaps split", () => {
  const l = (line: number, commit: string) => ({ line, commit, text: "" });
  const g = blameGroups([l(1, "a"), l(2, "a"), l(3, "b"), l(4, "a"), l(6, "a")]);
  assert.deepEqual(
    g.map((x) => [x.commit, x.start, x.lines.length]),
    [
      ["a", 1, 2],
      ["b", 3, 1],
      ["a", 4, 1],
      ["a", 6, 1],
    ],
  );
  assert.deepEqual(blameGroups([]), []);
});

test("mergeBlame: chunks merge by line number", () => {
  const l = (line: number, t: string) => ({ line, commit: "c", text: t });
  const m = mergeBlame([l(1, "x"), l(2, "y")], [l(2, "Y"), l(3, "z")]);
  assert.deepEqual(
    m.map((x) => x.text),
    ["x", "Y", "z"],
  );
});

test("ageOf", () => {
  const now = 1_000_000_000_000;
  assert.equal(ageOf(now / 1000 - 10, now), "just now");
  assert.equal(ageOf(now / 1000 - 120, now), "2 minutes ago");
  assert.equal(ageOf(now / 1000 - 3600, now), "1 hour ago");
  assert.equal(ageOf(now / 1000 - 86400 * 3, now), "3 days ago");
  assert.equal(ageOf(now / 1000 - 86400 * 400, now), "1 year ago");
  assert.equal(ageOf(now / 1000 + 100, now), "just now");
});
