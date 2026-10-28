// The Python viewer server as a child process. Dev: `uv run --project <repo> viewer`; packaged: the
// PyInstaller onedir binary in resources/server. It gets --desktop, the bridge URL/token in its
// env and stdin as a pipe that stays open: closing it (or our death) tells it to exit. It reports
// `LDV_READY http://127.0.0.1:P/` on stdout once it accepts connections. Output goes to userData/logs.

import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app } from "electron";

const READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const TERM_GRACE_MS = 2_000;
const LOG_MAX = 5 * 1024 * 1024;
const READY_RE = /^LDV_READY (http:\/\/127\.0\.0\.1:(\d+)\/)\s*$/;

export const REPO_DIR = path.resolve(__dirname, "..", ".."); // desktop/dist -> repo (dev only)
export const logsDir = () => path.join(app.getPath("userData"), "logs");
export const logFile = () => path.join(logsDir(), "server.log");
export const dataDir = () => path.join(app.getPath("userData"), "data");

/** Free a loopback port: `preferred` if it can be bound, else an OS-assigned one. */
export async function freePort(preferred: number | null): Promise<number> {
  const tryPort = (p: number) => new Promise<number | null>((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(null));
    s.listen({ port: p, host: "127.0.0.1", exclusive: true }, () => {
      const got = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(got));
    });
  });
  if (preferred) {
    const p = await tryPort(preferred);
    if (p) return p;
  }
  const p = await tryPort(0);
  if (!p) throw new Error("no free port on 127.0.0.1");
  return p;
}

function command(): { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, "server", "viewer-server", "viewer-server");
    return { cmd: exe, args: [], cwd: path.dirname(exe), env: {} };
  }
  // GUI launches get a minimal PATH: add the usual uv install locations.
  const home = app.getPath("home");
  const extra = [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const PATH = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...extra].join(path.delimiter);
  return { cmd: "uv", args: ["run", "--project", REPO_DIR, "viewer"], cwd: REPO_DIR, env: { PATH } };
}

const uiDir = () => app.isPackaged ? path.join(process.resourcesPath, "web", "out") : path.join(REPO_DIR, "web", "out");

/** Append-only log fd, shared with the child: its stderr is the file itself (not a pipe), so the
 * server can still log - and shut down cleanly - after we die; stdout is teed here by us. */
function openLog(): { fd: number; write(d: string | Buffer): void; close(): void } {
  fs.mkdirSync(logsDir(), { recursive: true });
  try {
    if (fs.statSync(logFile()).size > LOG_MAX) fs.renameSync(logFile(), `${logFile()}.1`);
  } catch {
    /* no log yet */
  }
  const fd = fs.openSync(logFile(), "a", 0o600);
  let open = true;
  return {
    fd,
    write: (d) => {
      try {
        if (open) typeof d === "string" ? fs.writeSync(fd, d) : fs.writeSync(fd, d);
      } catch {
        /* disk full etc.: drop */
      }
    },
    close: () => {
      if (open) fs.closeSync(fd);
      open = false;
    },
  };
}

export interface ServerOptions {
  port: number;
  allowEdit: boolean;
  bridgeUrl: string;
  bridgeToken: string;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void; // unexpected exit only
}

export class ServerProcess {
  private child: ChildProcess | null = null;
  private stopping = false;
  private exited: Promise<void> = Promise.resolve();

  /** Spawn and resolve with the viewer URL once LDV_READY arrives (reject on timeout / early exit). */
  start(o: ServerOptions): Promise<string> {
    const { cmd, args, cwd, env } = command();
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const argv = [...args, "--desktop", "--port", String(o.port), "--ui-dir", uiDir(), "--data-dir", dataDir()];
    if (o.allowEdit) argv.push("--allow-edit");
    const log = openLog();
    log.write(`\n--- ${new Date().toISOString()} starting: ${cmd} ${argv.join(" ")}\n`);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, DOCS_VIEWER_DESKTOP: "1",
      DOCS_VIEWER_BRIDGE_URL: o.bridgeUrl, DOCS_VIEWER_BRIDGE_TOKEN: o.bridgeToken, PYTHONUNBUFFERED: "1" };
    for (const k of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "DOCS_VIEWER_ROOT", "DOCS_VIEWER_PORT",
      "DOCS_VIEWER_DATA_DIR", "DOCS_VIEWER_ALLOW_EDIT", "DOCS_VIEWER_LOCK_ROOT"]) delete childEnv[k];
    this.stopping = false;
    const child = spawn(cmd, argv, { cwd, env: childEnv, stdio: ["pipe", "pipe", log.fd], detached: false });
    this.child = child;
    child.stdin!.on("error", () => undefined); // EPIPE once the child is gone
    this.exited = new Promise((r) => child.once("exit", () => r()));

    return new Promise<string>((resolve, reject) => {
      let ready = false, buf = "";
      const fail = (msg: string) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail(`the viewer server did not start within ${READY_TIMEOUT_MS / 1000}s`), READY_TIMEOUT_MS);
      child.stdout!.on("data", (d: Buffer) => {
        log.write(d);
        if (ready) return;
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const m = READY_RE.exec(line);
          if (m && Number(m[2]) === o.port) {
            ready = true;
            clearTimeout(timer);
            resolve(m[1]);
            return;
          }
        }
        if (buf.length > 64 * 1024) buf = buf.slice(-1024);
      });
      child.once("close", () => log.close()); // after exit and once stdout is drained
      child.once("error", (e) => {
        log.write(`--- spawn failed: ${e.message}\n`);
        log.close();
        fail(`could not start the viewer server: ${e.message}`);
      });
      child.once("exit", (code, signal) => {
        log.write(`--- exited (code ${code}, signal ${signal})\n`);
        if (this.child === child) this.child = null;
        if (!ready) fail(`the viewer server exited during startup (code ${code ?? signal})`);
        else if (!this.stopping) o.onExit(code, signal);
      });
    });
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Close stdin, wait up to 5 s, then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const waitExit = (ms: number) => Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    child.stdin?.end();
    if (await waitExit(STOP_GRACE_MS)) return;
    child.kill("SIGTERM");
    if (await waitExit(TERM_GRACE_MS)) return;
    child.kill("SIGKILL");
    await waitExit(TERM_GRACE_MS);
  }
}
