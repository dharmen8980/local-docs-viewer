// Application menu: macOS-standard app menu (About, Settings, Hide, Quit); on Linux the settings
// and Quit live in File. Devtools only when unpackaged.

import { app, Menu, MenuItemConstructorOptions, shell } from "electron";

export const HOMEPAGE = "https://github.com/dharmen8980/local-docs-viewer";

export interface MenuActions {
  allowEdit: boolean;
  openFolder(): void;
  setAllowEdit(on: boolean): void;
  showLogs(): void;
  openDataFolder(): void;
}

export function buildMenu(a: MenuActions): void {
  const mac = process.platform === "darwin";
  const dev = !app.isPackaged;
  const settings: MenuItemConstructorOptions = {
    label: "Settings",
    submenu: [{ label: "Allow editing", type: "checkbox", checked: a.allowEdit, click: (i) => a.setAllowEdit(i.checked) }],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: "about" }, { type: "separator" }, settings, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
      ] as MenuItemConstructorOptions[],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => a.openFolder() },
        { type: "separator" },
        ...(mac ? [{ role: "close" }] : [settings, { type: "separator" }, { role: "quit" }]) as MenuItemConstructorOptions[],
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" },
        ...(dev ? [{ role: "toggleDevTools" }] : []) as MenuItemConstructorOptions[],
        { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Show Logs", click: () => a.showLogs() },
        { label: "Open Data Folder", click: () => a.openDataFolder() },
        { type: "separator" },
        { label: "Project Homepage", click: () => void shell.openExternal(HOMEPAGE) },
        ...(mac ? [] : [{ type: "separator" }, { role: "about" }]) as MenuItemConstructorOptions[],
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
