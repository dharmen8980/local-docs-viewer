// Local Docs Viewer desktop shell: starts the bridge, spawns the Python viewer server (--desktop) on
// a loopback port, and shows it in one hardened window. See bridge.ts for the Python <-> Electron
// contract and security.ts for the renderer lockdown.

import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage, session, shell } from "electron";
import { Bridge, startBridge } from "./bridge";
import { buildMenu, HOMEPAGE } from "./menu";
import { hardenAppEarly, hardenSession, hardenWebContents, SECURE_PREFS, setViewerOrigin } from "./security";
import { dataDir, freePort, logFile, logsDir, ServerProcess } from "./server-process";
import { loadSettings, saveSettings, Settings } from "./settings";
import { loadWindowState, trackWindowState } from "./window-state";

const PICK_EVENT = "ldv:pick-folder"; // web/src/components/root-switcher.tsx PICK_FOLDER_EVENT

app.setName("Local Docs Viewer");
// A throw-away profile for automated checks (e2e/smoke.mjs; packaged too). Absolute paths only.
const udd = process.env.LDV_USER_DATA_DIR;
if (udd && path.isAbsolute(udd)) app.setPath("userData", udd);
hardenAppEarly();
hardenWebContents();

let settings: Settings;
let bridge: Bridge | null = null;
let mainWindow: BrowserWindow | null = null;
let viewerUrl: string | null = null;
let skipUnloadPrompt = false;
let quitDone = false;
const server = new ServerProcess();

const iconPath = () => app.isPackaged ? null : path.join(__dirname, "..", "build", "icon.png");

function createWindow(): BrowserWindow {
  const state = loadWindowState();
  const icon = iconPath();
  const win = new BrowserWindow({
    ...state,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: "Local Docs Viewer",
    backgroundColor: "#ffffff",
    ...(icon && process.platform === "linux" && fs.existsSync(icon) ? { icon } : {}),
    webPreferences: { ...SECURE_PREFS, plugins: true /* inline PDFs */, devTools: !app.isPackaged },
  });
  if (state.maximized) win.maximize();
  trackWindowState(win);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  // beforeunload (unsaved edits): ask like a browser would, unless a restart was already confirmed.
  win.webContents.on("will-prevent-unload", (e) => {
    if (skipUnloadPrompt) return e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", buttons: ["Leave", "Stay"], defaultId: 1, cancelId: 1,
      message: "Leave this page?", detail: "Changes you made may not be saved.",
    });
    if (choice === 0) e.preventDefault();
  });
  if (viewerUrl) void win.loadURL(viewerUrl);
  mainWindow = win;
  return win;
}

function showWindow(): void {
  const win = mainWindow ?? (viewerUrl ? createWindow() : null);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Bridge /pick: a folder sheet on the main window, brought to the front. */
async function pickFolder(prompt: string): Promise<string | null> {
  showWindow();
  if (process.platform === "darwin") app.focus({ steal: true });
  const opts: Electron.OpenDialogOptions = { title: prompt, message: prompt, properties: ["openDirectory", "createDirectory"] };
  const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0] ?? null;
}

const showLogs = () => {
  if (fs.existsSync(logFile())) shell.showItemInFolder(logFile());
  else void shell.openPath(logsDir());
};

async function startServer(): Promise<void> {
  const port = await freePort(settings.port);
  setViewerOrigin(`http://127.0.0.1:${port}`);
  viewerUrl = await server.start({
    port, allowEdit: settings.allowEdit, bridgeUrl: bridge!.url, bridgeToken: bridge!.token,
    onExit: (code, signal) => void serverDied(`exit code ${code ?? signal}`),
  });
  if (settings.port !== port) saveSettings((settings = { ...settings, port }));
}

/** (Re)start the server and point the window at it; on failure offer Retry / Show Logs / Quit. */
async function launch(): Promise<void> {
  for (;;) {
    try {
      await server.stop();
      await startServer();
      if (mainWindow) {
        skipUnloadPrompt = true;
        await mainWindow.loadURL(viewerUrl!).catch(() => undefined);
        skipUnloadPrompt = false;
      } else createWindow();
      return;
    } catch (e) {
      const choice = await failureDialog("The viewer server could not start.", `${(e as Error).message}\n\nLog: ${logFile()}`, "Retry");
      if (choice !== "retry") return;
    }
  }
}

async function failureDialog(message: string, detail: string, retry: string): Promise<"retry" | "quit"> {
  for (;;) {
    const opts = { type: "error" as const, buttons: [retry, "Show Logs", "Quit"], defaultId: 0, cancelId: 2, message, detail };
    const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts);
    if (response === 1) {
      showLogs();
      continue;
    }
    if (response === 2) app.quit();
    return response === 0 ? "retry" : "quit";
  }
}

async function serverDied(why: string): Promise<void> {
  const choice = await failureDialog("The viewer server stopped unexpectedly.", `${why}\n\nLog: ${logFile()}`, "Restart");
  if (choice === "retry") await launch();
}

async function setAllowEdit(on: boolean): Promise<void> {
  const opts = {
    type: "question" as const, buttons: ["Restart", "Cancel"], defaultId: 0, cancelId: 1,
    message: on ? "Allow editing?" : "Turn off editing?",
    detail: (on ? "Editing lets this app change, move and delete files in the open folder (deleted files go to the Trash). "
      : "") + "The viewer restarts; unsaved changes in the editor are lost.",
  };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts);
  if (response === 0) {
    settings = { ...settings, allowEdit: on };
    saveSettings(settings);
  }
  menu();
  if (response === 0) await launch();
}

function menu(): void {
  buildMenu({
    allowEdit: settings.allowEdit,
    setAllowEdit: (on) => void setAllowEdit(on),
    showLogs,
    openDataFolder: () => {
      fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      void shell.openPath(dataDir());
    },
    // The page runs its own "Choose folder..." flow (token, unsaved-changes prompt, reload);
    // the server then asks the bridge for the dialog.
    openFolder: () => {
      showWindow();
      void mainWindow?.webContents.executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(PICK_EVENT)})); 0`)
        .catch(() => undefined);
    },
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => showWindow());
  // After all windows closed (their beforeunload prompts included): stop the server, then exit.
  app.on("will-quit", (e) => {
    if (quitDone) return;
    e.preventDefault();
    quitDone = true;
    void server.stop().finally(() => {
      bridge?.close();
      app.exit(0);
    });
  });

  void app.whenReady().then(async () => {
    settings = loadSettings();
    hardenSession(session.defaultSession, { pdf: false });
    app.setAboutPanelOptions({ applicationName: "Local Docs Viewer", applicationVersion: app.getVersion(),
      copyright: "MIT License", website: HOMEPAGE });
    const icon = iconPath();
    if (icon && process.platform === "darwin" && fs.existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    menu();
    bridge = await startBridge(pickFolder);
    await launch();
  });
}
