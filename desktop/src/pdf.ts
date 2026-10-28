// PDF export in Electron's own Chromium: the bridge's /pdf job renders the viewer's static /print
// page in a hidden, offscreen, sandboxed window on a non-persistent session whose every request
// that is not same-origin with the viewer is blocked (the equivalent of pdf.py's route guards),
// then webContents.printToPDF. One render at a time; the window is destroyed after each job.
// Error statuses and messages match pdf.py (504/503/502/500). Every await on the page is raced
// against a deadline, so a hung print page (renderer spinning) fails the job with 504, the renderer
// is killed and the queue moves on, instead of wedging every later export.

import { BrowserWindow, session, Session } from "electron";
import { getViewerOrigin, hardenSession, markInternal, SECURE_PREFS } from "./security";

export interface PdfRequest {
  url: string;
  paper: "a4" | "letter";
  orientation: "portrait" | "landscape" | "auto";
  header_template: string;
  footer_template: string;
  margins_mm: { top: number; bottom: number; left: number; right: number };
  ready_timeout_ms: number;
  nav_timeout_ms: number;
}

export type PdfResult =
  | { pdf_base64: string; errors: Record<string, unknown>; title: string }
  | { error: { status: number; detail: string } };

export class RenderError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail);
  }
}

const PARTITION = "ldv-pdf"; // no "persist:" prefix: in memory only
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// printToPDF + the post-ready reads, beyond nav + ready. Python gives up at nav + ready + 60s, so
// the whole job always ends here first (and the hidden window is gone before Python answers 504).
export const PRINT_SLACK_MS = 30_000;

/** `p`, or a rejection with `err()` once `ms` has passed (the timer never outlives the race). */
export function within<T>(p: Promise<T>, ms: number, err: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(err()), Math.max(0, ms));
  });
  p.catch(() => undefined); // a late rejection of the losing promise is not unhandled
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
let ses: Session | null = null;

function pdfSession(): Session {
  if (!ses) {
    ses = session.fromPartition(PARTITION, { cache: false });
    hardenSession(ses, { pdf: true });
  }
  return ses;
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialised: one hidden window at a time. */
export function renderPdf(job: PdfRequest): Promise<PdfResult> {
  const run = queue.then(() => renderOne(job));
  queue = run.catch(() => undefined);
  return run;
}

async function renderOne(job: PdfRequest): Promise<PdfResult> {
  const s = pdfSession();
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    paintWhenInitiallyHidden: true,
    webPreferences: { ...SECURE_PREFS, session: s, offscreen: true, backgroundThrottling: false, devTools: false,
      plugins: false, javascript: true, images: true },
  });
  const wc = win.webContents;
  markInternal(wc);
  wc.setAudioMuted(true);
  wc.on("will-prevent-unload", (e) => e.preventDefault());
  let hung = false;
  const stuck = (detail: string) => () => {
    hung = true;
    return new RenderError(504, detail);
  };
  const end = Date.now() + job.nav_timeout_ms + job.ready_timeout_ms + PRINT_SLACK_MS;
  const STUCK = "PDF export timed out (the print page stopped responding)";
  try {
    let status = 0;
    wc.on("did-navigate", (_e, url, code) => {
      if (url.startsWith(getViewerOrigin())) status = code;
    });
    try {
      await within(wc.loadURL(job.url), job.nav_timeout_ms, stuck("timed out loading the print page"));
    } catch (e) {
      if (e instanceof RenderError) throw e;
      // ERR_ABORTED etc. with a non-200 response still reaches did-navigate
      if (!status) throw new RenderError(503, `print page unavailable (HTTP ?); run 'npm run build' in web/`);
    }
    if (status !== 200)
      throw new RenderError(503, `print page unavailable (HTTP ${status || "?"}); run 'npm run build' in web/`);

    // executeJavaScript runs as the embedder, so the page's CSP (no 'unsafe-eval') does not apply.
    // Each call is raced against `until` (a hung renderer never answers).
    const ev = <T>(expr: string, until = end, detail = STUCK) =>
      within(wc.executeJavaScript(expr, false) as Promise<T>, until - Date.now(), stuck(detail));
    const deadline = Date.now() + job.ready_timeout_ms;
    const notReady = `document did not finish rendering within ${Math.floor(job.ready_timeout_ms / 1000)}s ` +
      "(diagrams, images or fonts still loading)";
    while (!(await ev<boolean>("window.__PDF_READY__ === true", deadline, notReady))) {
      if (Date.now() >= deadline) throw new RenderError(504, notReady);
      await sleep(100);
    }
    const errors = (await ev<Record<string, unknown> | null>("window.__PDF_ERRORS__ || {}")) || {};
    if (errors.fatal) throw new RenderError(502, `print page could not render the document: ${String(errors.fatal)}`);
    const title = String((await ev<unknown>("window.__PDF_TITLE__ || ''")) || "");
    // The header's <span class="title"> is filled from document.title: use the page's chosen title.
    if (title) await ev<unknown>(`document.title = ${JSON.stringify(title)}; 0`);
    // orientation=auto: the page picks one from the diagram's aspect ratio
    const chosen = String((await ev<unknown>("window.__PDF_ORIENTATION__ || ''")) || "");
    const landscape = (chosen || job.orientation) === "landscape";
    errors.orientation = landscape ? "landscape" : "portrait";
    const inch = (mm: number) => mm / 25.4;
    const m = job.margins_mm;
    const data = await within(wc.printToPDF({
      pageSize: job.paper === "a4" ? "A4" : "Letter",
      landscape,
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: inch(m.top), bottom: inch(m.bottom), left: inch(m.left), right: inch(m.right) },
      displayHeaderFooter: true,
      headerTemplate: job.header_template,
      footerTemplate: job.footer_template,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    }), end - Date.now(), stuck(STUCK));
    return { pdf_base64: data.toString("base64"), errors, title };
  } catch (e) {
    if (e instanceof RenderError) return { error: { status: e.status, detail: e.detail } };
    const err = e as Error;
    console.error("pdf: export failed", err);
    const msg = (err?.message || "").split("\n")[0].slice(0, 300);
    return { error: { status: 500, detail: `PDF export failed: ${err?.name || "Error"}: ${msg}` } };
  } finally {
    // A renderer stuck in a loop may ignore a plain close: kill it first.
    if (hung && !wc.isDestroyed()) wc.forcefullyCrashRenderer();
    if (!win.isDestroyed()) win.destroy();
    await within(s.clearStorageData(), 5_000, () => new Error("clearStorageData timed out")).catch(() => undefined);
  }
}
