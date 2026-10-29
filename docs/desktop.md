# Desktop app

The desktop app (Electron, in `desktop/`) bundles the UI and a frozen copy of
this server (PyInstaller; no Python, uv or Chrome needed) and runs the server
as a child process in desktop mode. Same viewer, same security model, in its
own window; PDF export uses the app's built-in Chromium.

**Download** from [Releases](https://github.com/dharmen8980/local-docs-viewer/releases):
`local-docs-viewer-<version>-mac-arm64.dmg` (Apple Silicon), `-mac-x64.dmg`
(Intel), `-linux-x86_64.AppImage` or `-linux-amd64.deb`. `SHA256SUMS.txt`
lists the checksums.

**First launch on macOS.** The app is not signed with an Apple Developer ID
(it is ad-hoc signed, so it runs on Apple Silicon) and not notarized, so
Gatekeeper blocks the first launch of a downloaded copy. Drag it to
Applications, then either right-click it → **Open** → **Open** (macOS 15 and
later: try to open it once, then System Settings → Privacy & Security →
**Open Anyway**), or remove the quarantine flag:

```sh
xattr -dr com.apple.quarantine "/Applications/Local Docs Viewer.app"
```

**Using it.** File → **Open Folder…** (Cmd/Ctrl+O) picks a folder; the app
reopens the last one on start. It is read-only by default: **Settings → Allow
editing** (on Linux under File) turns on editing after a confirmation, is
remembered, and restarts the server (unsaved editor changes are lost).
Help → **Show Logs** / **Open Data Folder**.

**Where things live** (`<userData>`): macOS `~/Library/Application Support/Local Docs Viewer`,
Linux `~/.config/Local Docs Viewer`.

- `<userData>/data`: the server's data dir (`state.json` with recent folders
  and the last folder; per-folder history, trash and audit log when editing
  is on; see [Recovery data](editing.md#recovery-data-the-data-dir)).
- `<userData>/logs/server.log`: server output (rotated at 5 MB).
- `<userData>/settings.json`: Allow editing and the last viewer port (reused so
  the window's origin, and the UI's saved preferences, stay the same);
  `window-state.json`: window size and position.

**Linux.** AppImage: `chmod +x local-docs-viewer-*.AppImage` and run it; it
needs FUSE 2 (`sudo apt install libfuse2` on Ubuntu 22.04+, `libfuse2t64` on
24.04+). On Ubuntu 24.04+ AppArmor blocks the unprivileged user namespaces
Chromium's sandbox uses from an AppImage; prefer the `.deb`
(`sudo apt install ./local-docs-viewer-*.deb`, which installs the setuid
sandbox helper) rather than turning the sandbox off. The app quits when its
last window closes (macOS: it keeps running, as usual).

**Building from source** (Node 22+, uv; builds for this machine's OS and CPU
only, since PyInstaller does not cross-compile):

```sh
cd desktop && npm ci && npm run dist   # or dist:mac / dist:linux
# -> desktop/release/*.dmg | *.AppImage *.deb
```

`npm run dist` builds `web/out` fresh (`npm ci && npm run build` in `web/`),
freezes the server (`scripts/build-server.sh`: a uv-managed CPython, runtime
deps only plus PyInstaller from the `build` dependency group (exact pins,
hashes in `uv.lock`, `--locked`), playwright excluded, then a `--self-check` of the binary: app
imports, SQLite FTS5, no playwright), compiles the shell (`tsc`) and runs
electron-builder. Its `afterPack` hook (`scripts/after-pack.js`) sets the
Electron fuses (RunAsNode, `NODE_OPTIONS` and `--inspect` off; embedded asar
integrity validation and load-app-from-asar-only on; no extra `file:`
privileges) and ad-hoc signs the macOS bundle inside-out. Releases are built
by `.github/workflows/desktop-release.yml` on `v*` tags (macOS arm64 and x64,
Linux x64; tests and a packaged-app smoke test first; the release is created
as a draft).

Dev run: `cd desktop && npm start` (uses `uv run viewer` from this checkout
and the current `web/out`). Checks: `npm test` (bridge request refusals) and
`npm run e2e` (Playwright drives the dev app with a throw-away profile and a
seeded folder: tree, open a file, PDF export, FTS5 search, clean quit);
`npm run e2e:packaged` runs the same API checks against the packaged app,
launched as-is (its fuses forbid the debugger hooks Playwright needs).
`LDV_USER_DATA_DIR=/abs/path` points the app at another profile (tests).

## Desktop mode (the server side)

Desktop mode is not meant to be started by hand; the app runs:

```sh
viewer --desktop --port P --ui-dir <bundled web/out> --data-dir <userData>/data [--allow-edit]
# env: DOCS_VIEWER_BRIDGE_URL=http://127.0.0.1:<bridge port>  DOCS_VIEWER_BRIDGE_TOKEN=<random>
```

What changes in desktop mode (`--desktop` or `DOCS_VIEWER_DESKTOP=1`):

- Both bridge variables are required (the server exits with an error
  otherwise). The bridge URL must be `http://127.0.0.1:<port>`.
- The folder dialog and PDF export go through the app's loopback "bridge"
  (`POST /pick`, `POST /pdf`, JSON, `Authorization: Bearer <token>`) instead of
  osascript/zenity and Playwright. PDFs are rendered by the app's own Chromium
  (`printToPDF`) in a hidden, sandboxed window that can only reach this
  viewer's origin, so no system Chrome is needed. `playwright` is never
  imported. A dialog left open for 10 minutes counts as a cancel.
- Once the server accepts connections it prints one line to stdout:
  `LDV_READY http://127.0.0.1:P/`.
- The app keeps the server's stdin open. When stdin reaches EOF (the app quit
  or crashed) the server shuts down gracefully and exits for good after ~3s.
- Everything else is unchanged: same loopback binding, Host/Origin checks,
  token-gated edit and folder endpoints, deny lists, CSP. `state.json` (recent
  folders, last folder) lives in the data dir the app passes, so the app
  reopens the last folder.

`python -m viewer` is equivalent to `uv run viewer` (and is the entry point of
the packaged server binary). Plain `uv run viewer` works exactly as before,
including Playwright PDF export.
