import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { KEEPALIVE_MAX, needsDigest, openChangeStore, sha256Hex } from "../src/lib/seen-store.ts";

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

/** A fake /api/seen server: `handler` answers each request; every call is recorded. */
function fake(handler: (c: Call, n: number) => { status?: number; json?: unknown } | Promise<never>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
    calls.push(c);
    const r = await handler(c, calls.length);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const ROOT = "/Users/me/notes";
const rec = (path: string, mtime = 1) => ({ root: ROOT, path, mtime, size: 2, viewedAt: 5 });
const quiet = () => {
  const orig = console.debug;
  console.debug = () => undefined;
  return () => {
    console.debug = orig;
  };
};

test("open loads once, then every request names the root", async () => {
  const { f, calls } = fake((c) => {
    if (c.url.startsWith("/api/seen?")) return { json: { records: [rec("a.md")] } };
    if (c.url === "/api/seen/commit") return { json: { record: rec("a.md", 2) } };
    if (c.url.startsWith("/api/seen/snapshot")) return { json: { snapshot: null } };
    return { json: { records: [] } };
  });
  const store = await openChangeStore(ROOT, { token: () => "tok", fetch: f });
  assert.ok(store);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/seen?root=${encodeURIComponent(ROOT)}`);
  assert.deepEqual([...(await store.loadSeen()).keys()], ["a.md"]);
  assert.equal(calls.length, 1, "the first loadSeen uses the records fetched on open");
  await store.loadSeen();
  assert.equal(calls.length, 2);

  await store.commit({ path: "a.md", mtime: 2, size: 2, text: "hi" });
  const c = calls.at(-1)!;
  assert.equal(c.init.method, "POST");
  assert.deepEqual(c.init.headers, { "Content-Type": "application/json", "X-Root-Token": "tok" });
  assert.deepEqual(c.body, { root: ROOT, client: store.clientId, path: "a.md", mtime: 2, size: 2, text: "hi" });
  assert.equal(c.init.keepalive, undefined);

  await store.commit({ path: "a.md", mtime: 2, size: 2 });
  assert.equal("text" in calls.at(-1)!.body!, false, "undefined text is not sent (leave the snapshot alone)");
  await store.commit({ path: "a.md", mtime: 2, size: 2, text: null });
  assert.equal(calls.at(-1)!.body!.text, null);

  await store.getSnapshot("docs/x y.md");
  assert.equal(calls.at(-1)!.url, `/api/seen/snapshot?root=${encodeURIComponent(ROOT)}&path=docs%2Fx+y.md`);
  await store.rename("docs", "notes");
  assert.deepEqual(calls.at(-1)!.body, { root: ROOT, client: store.clientId, from: "docs", to: "notes" });
  const n = calls.length;
  assert.deepEqual(await store.getSeen([]), []);
  assert.deepEqual(await store.markSeen([]), []);
  await store.rename("x", "x");
  assert.equal(calls.length, n, "no-op calls do not hit the server");
});

test("keepalive only for small bodies", async () => {
  const { f, calls } = fake((c) => (c.init.method === "GET" ? { json: { records: [] } } : { json: { record: rec("a.md") } }));
  const store = (await openChangeStore(ROOT, { token: () => "t", fetch: f }))!;
  await store.commit({ path: "a.md", mtime: 1, size: 1, text: "small" }, { keepalive: true });
  assert.equal(calls.at(-1)!.init.keepalive, true);
  await store.commit({ path: "a.md", mtime: 1, size: 1, text: "x".repeat(KEEPALIVE_MAX) }, { keepalive: true });
  assert.equal(calls.at(-1)!.init.keepalive, undefined);
  await store.commit({ path: "a.md", mtime: 1, size: 1, text: "é".repeat(KEEPALIVE_MAX / 2) }, { keepalive: true });
  assert.equal(calls.at(-1)!.init.keepalive, undefined, "counted in UTF-8 bytes");
});

test("sha256Hex hashes the UTF-8 text; needsDigest only for texts that may not fit", async () => {
  for (const t of ["", "abc", "é \u{1f600}\r\n\uFFFD", "x".repeat(100_000)]) {
    assert.equal(await sha256Hex(t), createHash("sha256").update(t, "utf8").digest("hex"));
  }
  assert.equal(needsDigest(null), false);
  assert.equal(needsDigest(undefined), false);
  assert.equal(needsDigest("small"), false);
  assert.equal(needsDigest("x".repeat(KEEPALIVE_MAX / 6)), true);
  assert.equal(needsDigest("x".repeat(9000)), false);
  assert.equal(needsDigest("x".repeat(9000), 8192), true); // long root and path
});

test("keepalive over the cap sends the digest instead of the text", async () => {
  const { f, calls } = fake((c) => (c.init.method === "GET" ? { json: { records: [] } } : { json: { record: rec("a.md") } }));
  const store = (await openChangeStore(ROOT, { token: () => "t", fetch: f }))!;
  const big = "é".repeat(KEEPALIVE_MAX);
  const hex = (await sha256Hex(big))!;
  await store.commit({ path: "a.md", mtime: 1, size: 2, text: big, textSha256: hex }, { keepalive: true });
  const c = calls.at(-1)!;
  assert.equal(c.init.keepalive, true);
  assert.deepEqual(c.body, { root: ROOT, client: store.clientId, path: "a.md", mtime: 1, size: 2, textSha256: hex });
  assert.ok(new TextEncoder().encode(c.init.body as string).length <= KEEPALIVE_MAX);
  // small bodies and normal commits still carry the text; no digest known: a normal request
  await store.commit({ path: "a.md", mtime: 1, size: 2, text: "hi", textSha256: hex }, { keepalive: true });
  assert.equal(calls.at(-1)!.body!.text, "hi");
  assert.equal("textSha256" in calls.at(-1)!.body!, false);
  await store.commit({ path: "a.md", mtime: 1, size: 2, text: big, textSha256: hex });
  assert.equal(calls.at(-1)!.body!.text, big);
  assert.equal(calls.at(-1)!.init.keepalive, undefined);
  await store.commit({ path: "a.md", mtime: 1, size: 2, text: big }, { keepalive: true });
  assert.equal(calls.at(-1)!.body!.text, big);
  assert.equal(calls.at(-1)!.init.keepalive, undefined);
});

test("clear posts the root and reports failure", async () => {
  const restore = quiet();
  try {
    const { f, calls } = fake((c, n) => (c.init.method === "GET" ? { json: { records: [] } } : n === 2 ? { json: { cleared: 3 } } : { status: 500 }));
    const store = (await openChangeStore(ROOT, { token: () => "t", fetch: f }))!;
    assert.equal(await store.clear(), true);
    assert.equal(calls.at(-1)!.url, "/api/seen/clear");
    assert.equal(calls.at(-1)!.init.method, "POST");
    assert.deepEqual(calls.at(-1)!.body, { root: ROOT, client: store.clientId });
    assert.equal(await store.clear(), false);
  } finally {
    restore();
  }
});

test("open fails -> null (feature off)", async () => {
  const restore = quiet();
  try {
    for (const handler of [() => ({ status: 403 }), () => ({ status: 503 }), () => Promise.reject(new TypeError("down"))]) {
      const { f } = fake(handler as never);
      assert.equal(await openChangeStore(ROOT, { token: () => "t", fetch: f }), null);
    }
  } finally {
    restore();
  }
});

test("errors resolve harmless values", async () => {
  const restore = quiet();
  try {
    const { f } = fake((_c, n) => (n === 1 ? { json: { records: [] } } : { status: 500 }));
    const store = (await openChangeStore(ROOT, { token: () => "t", fetch: f }))!;
    assert.deepEqual(await store.loadSeen(), new Map());
    assert.deepEqual(await store.loadSeen(), new Map());
    assert.deepEqual(await store.getSeen(["a.md"]), []);
    assert.equal(await store.getSnapshot("a.md"), null);
    await assert.rejects(store.getSnapshot("a.md", { throwOnError: true }));
    const r = await store.commit({ path: "a.md", mtime: 3, size: 4, text: "x" });
    assert.equal(r.path, "a.md");
    assert.equal(r.mtime, 3);
    assert.equal(r.root, ROOT);
    const m = await store.markSeen([{ path: "b.md", mtime: 1, size: 1 }]);
    assert.deepEqual(
      m.map((x) => x.path),
      ["b.md"],
    );
    await store.rename("a", "b"); // resolves
  } finally {
    restore();
  }
});

test("a 403 re-reads the token once and retries", async () => {
  const { f, calls } = fake((c) => {
    if (c.init.method === "GET") return { json: { records: [] } };
    const tok = (c.init.headers as Record<string, string>)["X-Root-Token"];
    return tok === "new" ? { json: { records: [rec("a.md")] } } : { status: 403 };
  });
  let refreshes = 0;
  const store = (await openChangeStore(ROOT, {
    token: () => "old",
    refreshToken: async () => {
      refreshes++;
      return "new";
    },
    fetch: f,
  }))!;
  assert.deepEqual(
    (await store.markSeen([{ path: "a.md", mtime: 1, size: 2 }])).map((r) => r.path),
    ["a.md"],
  );
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 3);
  await store.markSeen([{ path: "a.md", mtime: 1, size: 2 }]);
  assert.equal(refreshes, 1, "the fresh token is kept");
});
