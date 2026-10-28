// Main window bounds persisted in userData/window-state.json; restored only if still on a screen.

import { BrowserWindow, Rectangle, screen } from "electron";
import { readJson, userFile, writeJson } from "./settings";

interface WindowState extends Rectangle {
  maximized: boolean;
}

const FILE = () => userFile("window-state.json");
const DEFAULT = { width: 1280, height: 860 };

function visible(r: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    r.x < a.x + a.width - 40 && r.x + r.width > a.x + 40 && r.y >= a.y - 10 && r.y < a.y + a.height - 40);
}

export function loadWindowState(): Partial<WindowState> & { width: number; height: number } {
  const s = readJson(FILE()) as Partial<WindowState> | null;
  const nums = s && [s.x, s.y, s.width, s.height].every((n) => Number.isFinite(n));
  if (!nums || s!.width! < 400 || s!.height! < 300) return { ...DEFAULT };
  const r = { x: s!.x!, y: s!.y!, width: s!.width!, height: s!.height! };
  return visible(r) ? { ...r, maximized: s!.maximized === true } : { width: r.width, height: r.height };
}

/** Save bounds on move/resize (debounced) and on close. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    writeJson(FILE(), { ...win.getNormalBounds(), maximized: win.isMaximized() });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("close", save);
}
