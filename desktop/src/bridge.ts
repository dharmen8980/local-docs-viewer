// Bridge: a tiny HTTP server on 127.0.0.1 (OS-assigned port) that the Python server (--desktop)
// calls for the things it cannot do itself: the native folder dialog (/pick) and PDF rendering in
// Electron's Chromium (/pdf). POST + JSON only, Authorization: Bearer <32-byte random token>
// (constant-time compare), exact Host 127.0.0.1:<port>, no browser Origin, body <= 1 MB.

import crypto from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";
import { PdfRequest, renderPdf } from "./pdf";
import { getViewerOrigin, sameOrigin } from "./security";

const BODY_MAX = 1024 * 1024;
const PAPERS = new Set(["a4", "letter"]);
const ORIENTATIONS = new Set(["portrait", "landscape", "auto"]);

export interface Bridge {
  url: string;
  token: string;
  close(): void;
}

export type PickFn = (prompt: string) => Promise<string | null>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body));
  if (status >= 400) res.shouldKeepAlive = false;
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > BODY_MAX) return reject(new HttpError(413, "request body too large"));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) {
        chunks.length = 0;
        reject(new HttpError(413, "request body too large")); // the rest is read and dropped
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const num = (v: unknown, lo: number, hi: number, name: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `bad ${name}`);
  return v;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new HttpError(400, `bad ${name}`);
  return v;
};

/** Validate a /pdf body; the URL must be the viewer's own /print page. */
export function parsePdfRequest(b: Record<string, unknown>, origin = getViewerOrigin()): PdfRequest {
  const url = str(b.url, "url");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, "bad url");
  }
  if (u.protocol !== "http:" || !sameOrigin(url, origin) || u.pathname !== "/print" || u.username || u.password)
    throw new HttpError(400, "url must be the viewer's /print page");
  if (!PAPERS.has(b.paper as string)) throw new HttpError(400, "bad paper");
  if (!ORIENTATIONS.has(b.orientation as string)) throw new HttpError(400, "bad orientation");
  const m = (b.margins_mm ?? {}) as Record<string, unknown>;
  if (typeof m !== "object" || m === null) throw new HttpError(400, "bad margins_mm");
  return {
    url: u.href,
    paper: b.paper as PdfRequest["paper"],
    orientation: b.orientation as PdfRequest["orientation"],
    header_template: str(b.header_template, "header_template"),
    footer_template: str(b.footer_template, "footer_template"),
    margins_mm: { top: num(m.top, 0, 100, "margin"), bottom: num(m.bottom, 0, 100, "margin"),
      left: num(m.left, 0, 100, "margin"), right: num(m.right, 0, 100, "margin") },
    ready_timeout_ms: num(b.ready_timeout_ms, 100, 300_000, "ready_timeout_ms"),
    nav_timeout_ms: num(b.nav_timeout_ms, 100, 300_000, "nav_timeout_ms"),
  };
}

export function startBridge(pick: PickFn): Promise<Bridge> {
  const token = crypto.randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let port = 0;
  let picking = false;

  const authorized = (h: string | undefined) => {
    const got = Buffer.from(h ?? "");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, { detail: "bad host" });
    if (req.method !== "POST") return send(res, 405, { detail: "method not allowed" }, { Allow: "POST" });
    if (!authorized(req.headers.authorization)) return send(res, 401, { detail: "unauthorized" });
    if (req.headers.origin !== undefined) return send(res, 403, { detail: "browser requests are refused" });
    const ct = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (ct && ct !== "application/json") return send(res, 415, { detail: "content-type must be application/json" });
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/pick" && path !== "/pdf") return send(res, 404, { detail: "not found" });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse((await readBody(req)).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "bad json");
      body = parsed;
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { detail: e.message });
      return send(res, 400, { detail: "bad json" });
    }
    if (path === "/pick") {
      if (picking) return send(res, 409, { detail: "a folder dialog is already open" });
      const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 200) : "Choose a folder";
      picking = true;
      try {
        return send(res, 200, { path: await pick(prompt) });
      } finally {
        picking = false;
      }
    }
    return send(res, 200, await renderPdf(parsePdfRequest(body)));
  };

  const server = http.createServer({ requestTimeout: 0, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { detail: e.message });
      console.error("bridge: request failed", e);
      send(res, 500, { detail: "internal error" });
    });
  });
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, token, close: () => server.close() });
    });
  });
}
