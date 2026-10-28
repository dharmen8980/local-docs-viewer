// Bridge HTTP checks under plain Node (no Electron window is created: every request here is
// refused before a dialog or a render would start). Run: npm test (after npm run build).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startBridge, parsePdfRequest } = require("../dist/bridge");
const { setViewerOrigin } = require("../dist/security");

function req(port, { method = "POST", path = "/pick", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const VIEWER = "http://127.0.0.1:45678";
const pdfBody = (url) => JSON.stringify({ url, paper: "a4", orientation: "portrait", header_template: "",
  footer_template: "", margins_mm: { top: 18, bottom: 16, left: 16, right: 16 },
  ready_timeout_ms: 45000, nav_timeout_ms: 20000 });

test("bridge refuses bad requests", async () => {
  setViewerOrigin(VIEWER);
  let picks = 0;
  let release;
  const b = await startBridge(() => { picks++; return new Promise((r) => (release = r)); });
  const port = Number(new URL(b.url).port);
  const auth = { authorization: `Bearer ${b.token}`, "content-type": "application/json" };
  try {
    assert.equal(b.token.length, 64);
    assert.equal((await req(port, { body: "{}" })).status, 401);
    assert.equal((await req(port, { headers: { ...auth, authorization: `Bearer ${"0".repeat(64)}` }, body: "{}" })).status, 401);
    assert.equal((await req(port, { headers: { ...auth, authorization: `Bearer ${b.token}x` }, body: "{}" })).status, 401);
    assert.equal((await req(port, { headers: { ...auth, host: `localhost:${port}` }, body: "{}" })).status, 403);
    assert.equal((await req(port, { headers: { ...auth, host: "evil.example" }, body: "{}" })).status, 403);
    assert.equal((await req(port, { method: "GET", headers: auth })).status, 405);
    assert.equal((await req(port, { method: "PUT", headers: auth, body: "{}" })).status, 405);
    assert.equal((await req(port, { headers: { ...auth, origin: VIEWER }, body: "{}" })).status, 403);
    assert.equal((await req(port, { headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await req(port, { path: "/nope", headers: auth, body: "{}" })).status, 404);
    assert.equal((await req(port, { headers: auth, body: "not json" })).status, 400);
    assert.equal((await req(port, { headers: auth, body: "[1]" })).status, 400);
    assert.equal((await req(port, { headers: auth, body: JSON.stringify({ x: "a".repeat(1024 * 1024) }) })).status, 413);
    for (const url of [
      "http://127.0.0.1:45679/print?p=a.md", // other port
      "http://localhost:45678/print?p=a.md",
      "https://127.0.0.1:45678/print?p=a.md",
      `${VIEWER}/api/raw?p=a.md`, // not /print
      `${VIEWER}/print/../api/raw`, // normalises to /api/raw
      "http://u:p@127.0.0.1:45678/print",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const r = await req(port, { path: "/pdf", headers: auth, body: pdfBody(url) });
      assert.equal(r.status, 400, url);
    }
    assert.equal((await req(port, { path: "/pdf", headers: auth, body: pdfBody(`${VIEWER}/print?p=a.md`).replace('"a4"', '"a3"') })).status, 400);
    assert.equal(picks, 0);
    // one dialog at a time
    const first = req(port, { headers: auth, body: JSON.stringify({ prompt: "Choose" }) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await req(port, { headers: auth, body: "{}" })).status, 409);
    release("/tmp/x");
    assert.deepEqual(await first, { status: 200, body: { path: "/tmp/x" } });
    assert.equal(picks, 1);
  } finally {
    b.close();
  }
});

test("parsePdfRequest accepts the viewer's print page", () => {
  const r = parsePdfRequest(JSON.parse(pdfBody(`${VIEWER}/print?p=a%20b.md&paper=a4`)), VIEWER);
  assert.equal(r.url, `${VIEWER}/print?p=a%20b.md&paper=a4`);
  assert.equal(r.margins_mm.top, 18);
});
