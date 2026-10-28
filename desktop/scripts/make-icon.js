// Renders build/icon.svg to build/icon.png (1024x1024, transparent) with Electron's own Chromium:
//   npx electron scripts/make-icon.js
// electron-builder derives .icns (mac) and the Linux icon set from the PNG.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "..", "build", "icon.svg"), "utf8");
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  win.webContents.setZoomFactor(1);
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 300));
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  if (img.getSize().width !== 1024) img = img.resize({ width: 1024, height: 1024, quality: "best" });
  fs.writeFileSync(path.join(__dirname, "..", "build", "icon.png"), img.toPNG());
  console.log("wrote build/icon.png", img.getSize());
  app.exit(0);
});
