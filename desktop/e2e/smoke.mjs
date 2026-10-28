// End-to-end smoke test of the desktop app against the real Python server (no folder dialog):
// a temp docs folder is pre-seeded as last_root in an isolated profile (LDV_USER_DATA_DIR).
//
//   node e2e/smoke.mjs              dev tree (npm run build first): Playwright _electron drives the
//                                   window - tree shows the seeded files, open a markdown file,
//                                   PDF export + FTS5 search via fetch from the page, quit
//   node e2e/smoke.mjs --packaged [exe]
//                                   the packaged app (default: release/<platform>/...). Its fuses
//                                   forbid --inspect / remote debugging, so it is launched as-is and
//                                   checked from outside: the window's own requests in the server
//                                   log, the same API checks over HTTP, then SIGTERM -> clean quit
// Both assert that the Python child exited. Exit code 0 = pass.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function until(what, fn, ms = 30_000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// -- fixture: docs folder + isolated profile with state.json -------------------------------------
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ldv-smoke-")));
const docs = path.join(tmp, "docs");
const userData = path.join(tmp, "profile");
const dataDir = path.join(userData, "data");
fs.mkdirSync(path.join(docs, "notes"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const WORD = "zanzibarquux"; // unique: FTS5 content hit
fs.writeFileSync(path.join(docs, "guide.md"),
  `# Smoke Guide\n\nThe ${WORD} paragraph.\n\n## Section two\n\n${"Some text. ".repeat(200)}\n\n` +
  "```mermaid\ngraph TD; A-->B; B-->C;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
fs.writeFileSync(path.join(docs, "notes", "other.md"), "# Other\n\nhello\n");
fs.writeFileSync(path.join(docs, "notes", "flow.mmd"), "graph LR; X-->Y;\n");
fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ last_root: docs, recent: [docs] }));

const env = { ...process.env, LDV_USER_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;

/** Python child of this run (its argv carries our private data dir). */
function serverPids() {
  try {
    return execFileSync("pgrep", ["-f", `data-dir ${dataDir}`], { encoding: "utf8" })
      .split("\n").map(Number).filter((p) => p && p !== process.pid);
  } catch {
    return [];
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The page and the API checks share this: fetch from the page (dev) or from Node (packaged).
async function apiChecks(get) {
  const tree = await get("/api/tree", "json");
  const paths = JSON.stringify(tree);
  for (const p of ["guide.md", "notes/other.md", "notes/flow.mmd"]) assert.ok(paths.includes(p), `tree lacks ${p}`);
  log("tree has the seeded files");
  const hit = await until("FTS5 search hit", async () => {
    const r = await get(`/api/search?q=${WORD}`, "json");
    return r.content?.some((c) => c.path === "guide.md") && r;
  }, 20_000, 250);
  log(`search: ${hit.content.length} content hit(s) for "${WORD}" (FTS5)`);
  for (const [p, extra] of [["guide.md", "&toc=1"], ["notes/flow.mmd", "&orientation=auto"]]) {
    const started = Date.now();
    const r = await get(`/api/pdf?path=${encodeURIComponent(p)}${extra}`, "pdf");
    assert.equal(r.status, 200, `pdf ${p}: HTTP ${r.status} ${r.detail || ""}`);
    assert.equal(r.type, "application/pdf");
    assert.equal(r.magic, "%PDF-", `pdf ${p}: not a PDF`);
    assert.ok(r.size > 10_000, `pdf ${p}: only ${r.size} bytes`);
    log(`pdf ${p}: ${r.size} bytes, ${r.orientation}, ${Date.now() - started} ms`);
  }
  const missing = await get("/api/pdf?path=nope.md", "pdf");
  assert.equal(missing.status, 404);
}

async function assertServerGone(pids) {
  assert.ok(pids.length > 0, "no Python child found");
  await until("Python child exit", async () => pids.every((p) => !alive(p)), 10_000);
  log(`Python child ${pids.join(",")} exited`);
}

// -- dev: Playwright drives the real window ----------------------------------------------------------
async function dev() {
  const { _electron } = await import("playwright-core");
  const { default: electronPath } = await import("electron");
  const app = await _electron.launch({ executablePath: electronPath, args: [desktop], cwd: desktop,
    env: { ...env, LDV_E2E: "1" }, timeout: 60_000 });
  let pids = [];
  try {
    const win = await app.firstWindow({ timeout: 45_000 });
    await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    log(`window at ${win.url()} (startup ${Date.now() - t0} ms)`);
    pids = serverPids();
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    assert.deepEqual(prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    await win.locator('[data-path="guide.md"]').first().waitFor({ timeout: 20_000 });
    await win.getByText("notes", { exact: true }).first().waitFor();
    log("tree shows the seeded files");
    await win.locator('[data-path="guide.md"]').first().click();
    await win.getByRole("heading", { name: "Smoke Guide" }).first().waitFor({ timeout: 20_000 });
    await win.getByText(WORD, { exact: false }).first().waitFor();
    log("opened guide.md");
    assert.equal(await win.evaluate("typeof require"), "undefined");
    // File > Open Folder... reaches the server's bridge picker exactly once per click, also on a narrow
    // window (sidebar unmounted as a sheet). The dialog is stubbed: cancel.
    await app.evaluate(({ dialog }) => {
      globalThis.__picks = 0;
      dialog.showOpenDialog = async () => (globalThis.__picks++, { canceled: true, filePaths: [] });
    });
    for (const [w, want] of [[1200, 1], [600, 2]]) {
      await app.evaluate(({ BrowserWindow, Menu }, w) => {
        BrowserWindow.getAllWindows()[0].setSize(w, 700);
        const find = (m) => m.items.flatMap((i) => (i.label === "Open Folder…" ? [i] : i.submenu ? find(i.submenu) : []));
        setTimeout(() => find(Menu.getApplicationMenu())[0].click(), 300); // after the resize re-render
      }, w);
      await until(`menu pick at ${w}px`, async () => (await app.evaluate(() => globalThis.__picks)) >= want, 10_000);
      await sleep(500);
      assert.equal(await app.evaluate(() => globalThis.__picks), want, `menu pick at ${w}px opened >1 dialog`);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    log("File > Open Folder... picks once at 1200px and at 600px");
    // A print page whose renderer hangs: 504 within the ready timeout, the hidden window is gone,
    // and the queue still serves the real exports below.
    const hang = await app.evaluate(async ({ app: a, BrowserWindow }, [origin, mod]) => {
      const { renderPdf } = process.mainModule.require(mod); // the app's own instance (same queue)
      a.once("web-contents-created", (_e, wc) =>
        wc.once("did-finish-load", () => wc.executeJavaScript("for (;;) {}").catch(() => undefined)));
      const started = Date.now();
      const r = await renderPdf({ url: `${origin}/print?p=guide.md`, paper: "a4", orientation: "portrait",
        header_template: "", footer_template: "", margins_mm: { top: 18, bottom: 16, left: 16, right: 16 },
        ready_timeout_ms: 2000, nav_timeout_ms: 20000 });
      await new Promise((res) => setTimeout(res, 300));
      return { r, ms: Date.now() - started, windows: BrowserWindow.getAllWindows().length };
    }, [new URL(win.url()).origin, path.join(desktop, "dist", "pdf.js")]);
    assert.equal(hang.r.error?.status, 504, JSON.stringify(hang.r));
    assert.ok(hang.ms < 15_000, `hung render took ${hang.ms} ms`);
    assert.equal(hang.windows, 1, "hidden PDF window left behind");
    log(`hung print page: 504 in ${hang.ms} ms, window destroyed`);
    await apiChecks((url, as) => win.evaluate(async ([url, as]) => {
      const r = await fetch(url);
      if (as === "json") return r.json();
      const b = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, type: r.headers.get("content-type"), size: b.length,
        magic: String.fromCharCode(...b.slice(0, 5)), orientation: r.headers.get("x-pdf-orientation"),
        detail: r.status === 200 ? "" : new TextDecoder().decode(b).slice(0, 300) };
    }, [url, as]));
  } finally {
    await app.close().catch((e) => log(`close: ${e.message}`));
  }
  log("app quit");
  await assertServerGone(pids);
}

// -- packaged: launched as the user would, checked from outside ----------------------------------
function defaultExe() {
  const rel = path.join(desktop, "release");
  if (process.platform === "darwin") {
    const dir = process.arch === "arm64" ? "mac-arm64" : "mac";
    return path.join(rel, dir, "Local Docs Viewer.app", "Contents", "MacOS", "Local Docs Viewer");
  }
  return path.join(rel, "linux-unpacked", "local-docs-viewer");
}

async function packaged(exe) {
  assert.ok(fs.existsSync(exe), `${exe} missing (npm run dist first)`);
  const logFile = path.join(userData, "logs", "server.log");
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");
  const spawned = Date.now();
  const app = spawn(exe, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  app.stdout.on("data", (d) => (out += d));
  app.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => app.once("exit", (code, sig) => r({ code, sig })));
  try {
    const origin = await until("LDV_READY in the server log", async () => readLog().match(/^LDV_READY (http:\/\/127\.0\.0\.1:\d+)\/$/m)?.[1], 45_000);
    const ready = Date.now() - spawned;
    // the window's own page load: the UI fetches the tree once it runs
    await until("the window loading the UI", async () => /"GET \/api\/tree HTTP\/1\.1" 200/.test(readLog()), 30_000);
    const shown = Date.now() - spawned;
    log(`packaged app: server ready ${ready} ms, window loaded the tree ${shown} ms after launch (${origin})`);
    const pids = serverPids();
    assert.ok(pids.length > 0, "no Python child found");
    const exeName = execFileSync("ps", ["-o", "command=", "-p", String(pids[0])], { encoding: "utf8" });
    assert.ok(exeName.includes("viewer-server"), `child is not the frozen server: ${exeName}`);
    assert.ok(/desktop mode; bridge/.test(readLog()));
    await apiChecks(async (url, as) => {
      const r = await fetch(origin + url);
      if (as === "json") return r.json();
      const b = Buffer.from(await r.arrayBuffer());
      return { status: r.status, type: r.headers.get("content-type"), size: b.length,
        magic: b.subarray(0, 5).toString("latin1"), orientation: r.headers.get("x-pdf-orientation"),
        detail: r.status === 200 ? "" : b.toString("utf8", 0, 300) };
    });
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(st.last_root, docs);
    app.kill("SIGTERM"); // Electron: app.quit() -> will-quit -> stdin closed -> server exits
    const quitStart = Date.now();
    const { code, sig } = await Promise.race([exited, sleep(15_000).then(() => ({ code: "timeout" }))]);
    assert.notEqual(code, "timeout", "app did not quit within 15s");
    log(`app quit in ${Date.now() - quitStart} ms (code ${code}, signal ${sig})`);
    await assertServerGone(pids);
    return { ready, shown };
  } catch (e) {
    console.error(`--- app output\n${out.slice(-4000)}\n--- server log\n${readLog().slice(-4000)}`);
    throw e;
  } finally {
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
  }
}

const args = process.argv.slice(2);
try {
  if (args[0] === "--packaged") await packaged(path.resolve(args[1] || defaultExe()));
  else await dev();
  log("PASS");
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  console.error(`[smoke] FAIL (fixture kept in ${tmp})`);
  for (const p of serverPids()) process.kill(p, "SIGKILL");
  process.exit(1);
}
