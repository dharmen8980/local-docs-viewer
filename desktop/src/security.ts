// App-wide hardening. Every renderer is sandboxed with context isolation and no preload; every
// session refuses permission requests and blocks requests that are not same-origin with the viewer
// (http://127.0.0.1:<port>). Navigation and popups stay on the viewer origin; http(s)/mailto links
// elsewhere go to the system browser; everything else is dropped.

import path from "node:path";
import { app, BrowserWindowConstructorOptions, Session, shell, WebContents, WebPreferences } from "electron";

let viewerOrigin = ""; // set once the server's port is known; "" blocks everything

export const setViewerOrigin = (o: string) => void (viewerOrigin = o);
export const getViewerOrigin = () => viewerOrigin;

/** Same scheme family (http~ws), host and port as `origin`. */
export function sameOrigin(url: string, origin = viewerOrigin): boolean {
  if (!origin) return false;
  try {
    const u = new URL(url), o = new URL(origin);
    const scheme = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
    return scheme === o.protocol && u.host === o.host;
  } catch {
    return false;
  }
}

const EXTERNAL = new Set(["http:", "https:", "mailto:"]);

function openExternal(url: string): void {
  try {
    if (EXTERNAL.has(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    /* not a URL */
  }
}

export const SECURE_PREFS: WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  safeDialogs: true,
};

/** Before `ready`: sandbox everything, refuse remote debugging, resolve nothing but loopback. */
export function hardenAppEarly(): void {
  app.enableSandbox();
  // Dev-tree e2e only (Playwright's _electron needs CDP); packaged builds never allow it.
  const e2e = !app.isPackaged && process.env.LDV_E2E === "1";
  for (const sw of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) {
    if (app.commandLine.hasSwitch(sw) && !e2e) {
      console.error(`refusing to start with --${sw}`);
      app.exit(1);
    }
  }
  // Same belt and braces as the server's headless Chrome: only 127.0.0.1 resolves.
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
}

// Non-network schemes the main window needs: Chromium's PDF viewer (chrome-extension:, chrome:),
// devtools in dev, and the page's own data:/blob: URLs.
const MAIN_SCHEMES = new Set(["data:", "blob:", "chrome-extension:", "chrome:", "devtools:"]);
const PDF_SCHEMES = new Set(["data:", "blob:"]);

/** Deny permissions, block foreign requests, (optionally) route downloads to a save dialog. */
export function hardenSession(ses: Session, opts: { pdf: boolean; origin?: () => string }): void {
  const origin = opts.origin ?? getViewerOrigin;
  const schemes = opts.pdf ? PDF_SCHEMES : MAIN_SCHEMES;
  // clipboard-sanitized-write is the only grant: "Copy" buttons on the viewer's own pages.
  const allowed = (wc: WebContents | null, perm: string, from?: string) =>
    !opts.pdf && perm === "clipboard-sanitized-write" && sameOrigin(from || wc?.getURL() || "", origin());
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed(wc, perm, details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, perm, from) => allowed(wc, perm, from));
  ses.setDevicePermissionHandler(() => false);
  ses.setUSBProtectedClassesHandler(() => []);
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, cb) => {
    let scheme = "";
    try {
      scheme = new URL(d.url).protocol;
    } catch {
      /* unparsable: blocked */
    }
    const ok = sameOrigin(d.url, origin()) || schemes.has(scheme);
    if (!ok) console.warn(`blocked ${opts.pdf ? "pdf " : ""}request to ${d.url.slice(0, 200)}`);
    cb({ cancel: !ok });
  });
  ses.on("will-download", (e, item) => {
    if (opts.pdf || !sameOrigin(item.getURL().replace(/^blob:/, ""), origin())) {
      e.preventDefault();
      return;
    }
    // No save path set: Electron shows the standard save dialog, starting in Downloads.
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath("downloads"), item.getFilename()) });
  });
}

/** Popups from the viewer's own pages (e.g. "open raw file") get the same locked-down prefs. */
const popupOptions = (): BrowserWindowConstructorOptions => ({
  width: 1000,
  height: 800,
  autoHideMenuBar: true,
  webPreferences: { ...SECURE_PREFS, plugins: true, devTools: !app.isPackaged },
});

// Hidden PDF renderers: never open anything externally, never spawn popups.
const internal = new WeakSet<WebContents>();
export const markInternal = (wc: WebContents) => void internal.add(wc);

/** Every webContents ever created: navigation stays on the viewer, no webviews, popups vetted. */
export function hardenWebContents(): void {
  app.on("web-contents-created", (_e, wc) => {
    const guard = (e: Electron.Event, url: string) => {
      if (sameOrigin(url)) return;
      e.preventDefault();
      if (!internal.has(wc)) openExternal(url);
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", (e, url) => {
      if (!sameOrigin(url)) e.preventDefault();
    });
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (internal.has(wc)) return { action: "deny" };
      if (sameOrigin(url)) return { action: "allow", overrideBrowserWindowOptions: popupOptions() };
      openExternal(url);
      return { action: "deny" };
    });
  });
}
