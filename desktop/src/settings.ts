// Small JSON files in userData: app settings and window bounds. Written atomically (tmp + rename);
// a missing or corrupt file falls back to defaults.

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface Settings {
  allowEdit: boolean; // --allow-edit for the server; default off
  port: number | null; // last viewer port, reused so the origin (and its localStorage) stays stable
}

const DEFAULTS: Settings = { allowEdit: false, port: null };

export const userFile = (name: string) => path.join(app.getPath("userData"), name);

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`could not write ${file}:`, e);
  }
}

const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535;

export function loadSettings(): Settings {
  const raw = readJson(userFile("settings.json")) as Partial<Settings> | null;
  return {
    allowEdit: raw?.allowEdit === true,
    port: validPort(raw?.port) ? raw!.port! : DEFAULTS.port,
  };
}

export function saveSettings(s: Settings): void {
  writeJson(userFile("settings.json"), s);
}
