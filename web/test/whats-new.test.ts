import { test } from "node:test";
import assert from "node:assert/strict";
import { changedItems, createSummaryLoader, loadFeedSummary, summaryKey } from "../src/lib/whats-new.ts";

const file = (path: string, mtime: number, size = 10, kind = "markdown") => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind,
  mtime,
  size,
});

/** A promise resolved from outside. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const noYield = () => Promise.resolve();

test("changedItems: only changed files, newest first, then by path", () => {
  const files = [file("a.md", 5), file("docs/b.md", 9), file("c.md", 9), file("d.md", 7), file("z.md", 100)];
  const changed = new Set(["a.md", "docs/b.md", "c.md", "d.md", "gone.md"]);
  const items = changedItems(files, changed, new Map());
  assert.deepEqual(
    items.map((i) => i.path),
    ["c.md", "docs/b.md", "d.md", "a.md"],
  );
  assert.equal(items[1].dir, "docs");
  assert.equal(items[1].name, "b.md");
  assert.equal(items[0].dir, "");
  assert.deepEqual(changedItems(files, new Set(), new Map()), []);
});

test("summaryKey: changes with the version and with the base", () => {
  const k = summaryKey("a.md", { mtime: 1, size: 2 }, { mtime: 0.5, size: 1 });
  assert.equal(k, summaryKey("a.md", { mtime: 1, size: 2 }, { mtime: 0.5, size: 1 }));
  assert.notEqual(k, summaryKey("a.md", { mtime: 1.5, size: 2 }, { mtime: 0.5, size: 1 }));
  assert.notEqual(k, summaryKey("a.md", { mtime: 1, size: 3 }, { mtime: 0.5, size: 1 }));
  assert.notEqual(k, summaryKey("a.md", { mtime: 1, size: 2 }, { mtime: 0.7, size: 1 }));
  assert.notEqual(k, summaryKey("b.md", { mtime: 1, size: 2 }, { mtime: 0.5, size: 1 }));
  const seen = new Map([["a.md", { mtime: 0.5, size: 1 }]]);
  assert.equal(changedItems([file("a.md", 1, 2)], new Set(["a.md"]), seen)[0].key, k);
});

test("loader: bounded concurrency, results cached, listeners told", async () => {
  const loader = createSummaryLoader<string>({ concurrency: 2, yieldFn: noYield });
  const jobs = new Map<string, ReturnType<typeof deferred<string>>>();
  let runs = 0;
  const job = (key: string) => ({
    key,
    run: () => {
      runs++;
      const d = deferred<string>();
      jobs.set(key, d);
      return d.promise;
    },
  });
  let told = 0;
  loader.subscribe(() => told++);
  loader.want(["a", "b", "c", "d"].map(job));
  await tick();
  assert.deepEqual(loader.pending(), { running: 2, queued: 2 });
  assert.deepEqual([...jobs.keys()], ["a", "b"]);
  jobs.get("a")!.resolve("A");
  await tick();
  assert.equal(loader.get("a"), "A");
  assert.equal(told, 1);
  assert.deepEqual([...jobs.keys()], ["a", "b", "c"]);
  for (const k of ["b", "c"]) jobs.get(k)!.resolve(k.toUpperCase());
  await tick();
  jobs.get("d")!.resolve("D");
  await tick();
  assert.deepEqual(loader.pending(), { running: 0, queued: 0 });
  assert.equal(runs, 4);
  // Cached keys are not run again.
  loader.want(["a", "b", "c", "d"].map(job));
  await tick();
  assert.equal(runs, 4);
  assert.equal(loader.get("d"), "D");
});

test("loader: want() replaces the queue (rows scrolled away are dropped), running jobs finish", async () => {
  const loader = createSummaryLoader<number>({ concurrency: 1, yieldFn: noYield });
  const started: string[] = [];
  const gate = deferred<number>();
  const job = (key: string) => ({
    key,
    run: () => {
      started.push(key);
      return key === "a" ? gate.promise : Promise.resolve(key.length);
    },
  });
  loader.want(["a", "b", "c"].map(job));
  await tick();
  loader.want(["x", "a"].map(job)); // "a" is running: not queued twice
  assert.deepEqual(loader.pending(), { running: 1, queued: 1 });
  gate.resolve(1);
  await tick();
  await tick();
  assert.deepEqual(started, ["a", "x"]);
  assert.equal(loader.get("a"), 1);
  assert.equal(loader.get("b"), undefined);
});

test("loader: a failed job is not cached and runs again when wanted", async () => {
  const loader = createSummaryLoader<string>({ yieldFn: noYield, retryMs: 50 });
  let n = 0;
  const job = { key: "k", run: () => (++n === 1 ? Promise.reject(new Error("offline")) : Promise.resolve("ok")) };
  loader.want([job]);
  await tick();
  assert.equal(loader.get("k"), undefined);
  assert.deepEqual(loader.pending(), { running: 0, queued: 0 });
  loader.want([job]);
  await tick();
  assert.equal(loader.get("k"), "ok");
  assert.equal(n, 2);
});

test("loader: least recently used results are dropped beyond maxEntries", async () => {
  const loader = createSummaryLoader<string>({ maxEntries: 2, yieldFn: noYield });
  const job = (key: string) => ({ key, run: () => Promise.resolve(key) });
  loader.want([job("a"), job("b")]);
  await tick();
  assert.equal(loader.get("a"), "a"); // a is now the most recent
  loader.want([job("c")]);
  await tick();
  assert.equal(loader.get("b"), undefined);
  assert.equal(loader.get("a"), "a");
  assert.equal(loader.get("c"), "c");
});

test("loader: duplicate keys in one want() run once", async () => {
  const loader = createSummaryLoader<string>({ yieldFn: noYield });
  let runs = 0;
  const job = { key: "k", run: () => (runs++, Promise.resolve("v")) };
  loader.want([job, job, job]);
  await tick();
  assert.equal(runs, 1);
});

test("loader: a failed job is retried after retryMs without another want()", async () => {
  const loader = createSummaryLoader<string>({ yieldFn: noYield, retryMs: 5 });
  let n = 0;
  let told = 0;
  loader.subscribe(() => told++);
  loader.want([{ key: "k", run: () => (++n === 1 ? Promise.reject(new Error("offline")) : Promise.resolve("ok")) }]);
  await tick();
  assert.equal(loader.get("k"), undefined);
  assert.equal(told, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loader.get("k"), "ok");
  assert.equal(n, 2);
  assert.equal(told, 1);
});

test("loader: no retry once the key is no longer wanted", async () => {
  const loader = createSummaryLoader<string>({ yieldFn: noYield, retryMs: 5 });
  let n = 0;
  loader.want([{ key: "k", run: () => (n++, Promise.reject(new Error("offline"))) }]);
  await tick();
  loader.want([]); // scrolled away / row gone
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(n, 1);
  assert.deepEqual(loader.pending(), { running: 0, queued: 0 });
});

test("loadFeedSummary: fetches the copy, then the current text only when there is a copy", async () => {
  const calls: string[] = [];
  const inputs = (copy: string | null, over: Partial<Parameters<typeof loadFeedSummary<string>>[0]> = {}) => ({
    textKind: true,
    tooLarge: false,
    baseText: async () => (calls.push("base"), copy),
    currentText: async () => (calls.push("current"), "new"),
    summarize: (b: string | null, c: string | null) => `${b}|${c}`,
    ...over,
  });
  assert.equal(await loadFeedSummary(inputs("old")), "old|new");
  assert.deepEqual(calls.splice(0), ["base", "current"]);
  assert.equal(await loadFeedSummary(inputs(null)), "null|null");
  assert.deepEqual(calls.splice(0), ["base"]);
  assert.equal(await loadFeedSummary(inputs("old", { tooLarge: true })), "null|null");
  assert.equal(await loadFeedSummary(inputs("old", { textKind: false })), "null|null");
  assert.deepEqual(calls, []);
});

test("loadFeedSummary + loader: a failed snapshot fetch is not cached as 'no copy', and is retried", async () => {
  const loader = createSummaryLoader<string>({ yieldFn: noYield, retryMs: 5 });
  let snapshotCalls = 0;
  let summarized = 0;
  const run = () =>
    loadFeedSummary({
      textKind: true,
      tooLarge: false,
      baseText: async () => {
        if (++snapshotCalls === 1) throw new Error("503");
        return "old";
      },
      currentText: async () => "new",
      summarize: (b, c) => (summarized++, b === null ? "no copy" : `${b}->${c}`),
    });
  loader.want([{ key: "k", run }]);
  await tick();
  assert.equal(loader.get("k"), undefined);
  assert.equal(summarized, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loader.get("k"), "old->new");
  assert.equal(snapshotCalls, 2);
});
