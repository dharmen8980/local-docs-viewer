# local-docs-viewer

A local-only web viewer for one folder of documents. It is **read-only by
default**; editing and file management can be switched on with `--allow-edit`
(see [Editing](#editing-opt-in)). The folder is given with `--root` /
`DOCS_VIEWER_ROOT`, or chosen in the browser with the native folder dialog and
switched at runtime from a list of recent folders (see [Choosing and switching
folders](#choosing-and-switching-folders)). A FastAPI server (`server/viewer/`)
reads the folder and serves a static Next.js single-page app (`web/`, built to
`web/out`) on `http://127.0.0.1:8765/`.

What it does:

- A file tree with sorting by name or modified time, a filter box and a
  "Recently changed" list.
- Viewers for each file type:
  - Markdown: GFM, a table of contents, mermaid diagrams, shiki highlighting,
    and relative links and images that resolve inside the folder.
  - `.mmd` diagrams and source code with line anchors.
  - JSON as a tree or as source.
  - CSV and xlsx as sortable tables.
  - Images and PDFs.
  - Large logs, loaded in chunks with real line numbers. The whole file is
    never loaded.
- Full-text search (SQLite FTS5, in memory) with folder and type filters.
  Match lines are ranked (whole phrase, then most distinct terms, then
  whole-word hits). Choosing a markdown/mermaid match opens
  `/?p=...&hl=<query>&hll=<match line>` and scrolls to the rendered block that
  best matches that line.
- Live updates through Server-Sent Events: new, modified, renamed and deleted
  files and folders.
- Deep links (`/?p=<path>#<heading>` or `#L<line>`), light/dark themes and a
  print stylesheet for markdown.
- **Download PDF** for markdown and `.mmd` files: a properly paginated PDF
  rendered by headless Google Chrome on the server (see [PDF export](#pdf-export)).
- Opt-in editing (`--allow-edit`): a CodeMirror editor with live preview, file
  management (new, rename, move, duplicate, upload, delete to Trash), version
  history and undo (see [Editing](#editing-opt-in)).

## Prerequisites

- [uv](https://docs.astral.sh/uv/). It provides Python 3.13 (sqlite with FTS5).
- Node.js and npm. Built and tested with Node 26 and Next.js 16.4.
- Google Chrome, only for PDF export. The system install is used
  (`/Applications/Google Chrome.app` or `~/Applications/...` on macOS,
  `google-chrome` on Linux, or the `DOCS_VIEWER_CHROME` env var pointing at the
  executable). The `playwright` Python package drives it; **never run
  `playwright install`**, no browser is downloaded.

## Install

```sh
git clone https://github.com/dharmen8980/local-docs-viewer.git
cd local-docs-viewer
uv sync                 # Python deps into .venv
cd web && npm ci        # JS deps (all assets are bundled; nothing loads from a CDN)
```

If the default uv cache is not writable, use
`UV_CACHE_DIR=$PWD/.cache/uv uv sync`.

## Build and run

```sh
cd web && npm run build        # writes web/out (static export)
cd .. && uv run viewer         # http://127.0.0.1:8765/  (choose a folder in the browser)
uv run viewer --root ~/notes   # or start on a given folder
```

If `web/out` is missing, the server still serves `/api/*`. It prints a hint to
run `npm run build`, and `/` returns a 503 JSON message.

## Dev mode (hot reload for the UI)

```sh
uv run viewer                  # backend on 127.0.0.1:8765
cd web && npm run dev          # Next dev server on http://127.0.0.1:3000
```

In the development phase, `next.config.ts` proxies `/api/*` to
`http://127.0.0.1:${DOCS_VIEWER_PORT:-8765}`. It also turns off gzip so the SSE
stream is not buffered. The production build is a plain `output: 'export'` with
no rewrites. Both npm scripts set `NEXT_TELEMETRY_DISABLED=1`, and the dev
server binds to 127.0.0.1 only.

Dev mode keeps the DNS-rebinding defence: the `/api` rewrite only applies when
the browser's `Host` is `127.0.0.1` or `localhost` (any other Host gets a 404),
and FastAPI also rejects requests whose `X-Forwarded-Host` / `Forwarded: host=`
is not loopback. `next dev` sends the same CSP, `Referrer-Policy` and `nosniff`
headers as production, with `'unsafe-eval'` and a same-host websocket added
because React refresh and HMR need them.

## Configuration

Precedence is CLI flag, then environment variable, then default. The root
folder has no built-in default: without `--root` / `DOCS_VIEWER_ROOT` the
viewer reopens the folder used last (`last_root` in `<data dir>/state.json`, if
it still exists) and otherwise starts with no folder selected.

| Setting | Flag | Env | Default |
|---|---|---|---|
| Root folder | `--root PATH` | `DOCS_VIEWER_ROOT` | the last folder chosen (from `state.json`), else none: choose one in the browser (resolved with realpath at startup); a given folder that does not exist is a startup error |
| Lock the root | `--lock-root` | `DOCS_VIEWER_LOCK_ROOT=1` | off (the browser may switch folders); needs a root |
| Port | `--port N` | `DOCS_VIEWER_PORT` | `8765` |
| Host | none | none | always `127.0.0.1` (hardcoded, not configurable) |
| Deny patterns (add) | `--deny PATTERN` (repeatable) | `DOCS_VIEWER_DENY` (comma-separated) | `.env`, `.env*`, `*token*`, `*secret*`, `*credential*`, `*.pem`, `*.key` |
| Drop default deny list | `--no-default-deny` | none | off |
| Ignore patterns (add) | `--ignore PATTERN` (repeatable) | `DOCS_VIEWER_IGNORE` (comma-separated) | `__pycache__`, `*.pyc`, `.DS_Store`, `node_modules`, `.venv`, `.git` |
| Search size limit | `--search-max-mb N` | `DOCS_VIEWER_SEARCH_MAX_MB` | `2` (larger files are not indexed for content search) |
| UI directory | `--ui-dir PATH` | none | `web/out` next to this README |
| Editing | `--allow-edit` | `DOCS_VIEWER_ALLOW_EDIT=1` | off (read-only) |
| Data dir (history, trash, audit, `state.json`) | `--data-dir PATH` | `DOCS_VIEWER_DATA_DIR` | `.data` next to this README |
| Versions kept per file | `--history-keep N` | none | `50` |
| Upload size limit per file | `--upload-max-mb N` | none | `25` |
| Upload extensions | `--upload-ext EXT` (repeatable or comma-separated; replaces the list) | none | `png jpg jpeg gif webp svg pdf md mmd txt csv json yaml yml py sh log` |
| Desktop mode (set by the desktop app) | `--desktop` | `DOCS_VIEWER_DESKTOP=1` | off; see [Desktop app](#desktop-app) |

Deny and ignore patterns are case-insensitive `fnmatch` globs. Names and
patterns are compared after Unicode NFKC normalisation and case folding (so
NFD spellings and look-alikes such as U+017F `ſ` for `s` match too, as they do
on APFS). They are checked against every path component, both of the requested
path and of its realpath-resolved form, and against the names as they actually
exist on disk (each component is matched to its real directory entry). A denied path is refused with 403. An ignored path is
just hidden noise.

Example:

```sh
uv run viewer --root ~/notes --port 9000 --deny '*.sqlite' --ignore 'dist'
```

`.ldv-tmp-*` (the editor's temporary files during an atomic save) is on the
default ignore list, so it never shows in the tree or search.

## Choosing and switching folders

The folder name in the sidebar header opens a menu with the current folder's
full path, the recent folders (click to switch, or forget one) and **Choose
folder...**, which opens the operating system's folder dialog on the machine
running the server (macOS: `osascript` `choose folder`; Linux: `zenity
--file-selection --directory` if installed; elsewhere only recent folders and
`--root` are available). The dialog may open behind the browser window. When
no folder is selected the page shows the same choices in its centre. After a
switch the page reloads on the new folder (it asks first if the editor has
unsaved changes); the server keeps running.

The server builds a fresh app for the new folder (tree scan, search index,
watcher, edit store), starts it, swaps it in and then shuts the old one down;
open live-update streams of the old folder end and the browser reconnects.
Switches are serialised, and only one folder dialog can be open at a time.
With `--allow-edit` each folder gets its own recovery store (keyed by its
path) and a new edit token; a folder that contains the data dir (or lies
inside it) is refused with 400 and the current folder stays.

The last folder and up to 10 recent folders (canonical paths, most recent
first) are remembered in `<data dir>/state.json`
(`{"last_root": ..., "recent": [...]}`, written atomically, mode 0600). A
folder given with `--root` / `DOCS_VIEWER_ROOT` is recorded there too; folders
that no longer exist are dropped from the list. In read-only mode nothing is
written if the data dir lies inside the folder being viewed.

`--lock-root` (or `DOCS_VIEWER_LOCK_ROOT=1`) pins the folder given at startup:
the menu is hidden and every `POST /api/roots/*` returns 403.

### The /api/roots endpoints and their security model

| Request | Result |
|---|---|
| `GET /api/roots` | `{"current", "recent", "picker_available", "switch_enabled"}` |
| `POST /api/roots/pick` `{}` | opens the folder dialog (up to 10 minutes; 409 if one is open, 501 if no dialog is available); `{"cancelled": true}` or `{"cancelled": false, "current": path}` |
| `POST /api/roots/switch` `{"path"}` | switches, but **only to a path in the recent list** (exact match, else 403) |
| `POST /api/roots/forget` `{"path"}` | removes a recent folder (400 for the current one) |

All answers are JSON with `Cache-Control: no-store`. A browser request can
never name an arbitrary folder: new folders enter only through the native
dialog (a person at this machine clicking) or `--root` / `DOCS_VIEWER_ROOT`.
The mutating requests are guarded like `/api/edit/*`: a per-launch random
`X-Root-Token` (from `/api/config` as `root_token`, only for same-site
requests; it survives folder switches), `Sec-Fetch-Site: same-origin` or no
such header, no `Origin` or a loopback viewer/dev-server origin,
`Content-Type: application/json` and a small body; anything else gets 403. The
Host allowlist, forwarded-host check, CSP and other headers apply as
everywhere. With no folder selected `/api/config` returns `"no_root": true`
(with `root_name` / `root_path` null), the UI and `/api/roots` are served, and
every other `/api/*` answers 409 `{"detail":"no folder selected"}`.
`/api/config` also reports `root_path` (full canonical path) and
`root_switch_enabled`.

## Editing (opt-in)

```sh
uv run viewer --allow-edit                       # or DOCS_VIEWER_ALLOW_EDIT=1 uv run viewer
uv run viewer --allow-edit --data-dir ~/ldv-data  # keep history/trash elsewhere
```

Without the flag the viewer behaves exactly as before: no edit UI is shown,
every `/api/edit/*` request (any method) returns 403 `{"detail":"editing
disabled"}` and nothing in the docs folder can change (the data dir only
receives `state.json`, the remembered folders). With the
flag the header shows an **Editing enabled** badge and the server logs
`EDITING ENABLED` with the data dir path.

> **Important: if the folder you edit has no git history** (for example a
> git-ignored working folder), the viewer's data dir (`.data/` by default) is the only safety net
> for changes made from the browser: version history and Trash live there.
> Back it up before deleting it (see [Backing up and clearing the data
> dir](#backing-up-and-clearing-the-data-dir)).

What you can do in the browser:

- **Edit** (header button) for markdown, mermaid, code, JSON, CSV and text
  files up to 2 MB. CodeMirror 6 (bundled, loaded only when you click Edit)
  with syntax highlighting, line numbers, a wrap toggle and find/replace
  (Cmd/Ctrl-F). Markdown and `.mmd` open side by side with a live preview
  (about 300 ms delay); the toolbar switches between editor / split / preview.
  **Cmd/Ctrl-S** saves (pressed during a save, it saves again once that one
  finishes); **Esc** anywhere in the editor view (editor, toolbar, banners;
  not while a menu, dialog or the find panel is open) or **Done** leaves the
  editor.
- **Unsaved changes** show as a dot in the header and a `●` in the tab title.
  Closing the tab warns; tree clicks, search jumps, links and Back/Forward ask
  *Save / Discard / Cancel*.
- **JSON** is checked before saving (line and column of the error); *Save
  anyway* writes it regardless.
- **Conflicts:** saves send the hash of the text the editor loaded. If the file
  changed on disk in the meantime (the server answers 409, or a live update
  arrives while you have unsaved edits) a banner offers *Overwrite with mine*,
  *Reload theirs (discard mine)* and *Copy mine to clipboard*, with a line diff.
  If you have no unsaved edits the editor simply reloads. A change on disk
  that equals your text (for example the same edit saved elsewhere) is adopted
  silently, and the viewer's own saves never show up as outside changes. If the
  file is deleted while the editor has no unsaved edits, a banner says so but
  nothing counts as unsaved.
- **Images:** pasting or dropping an image into a markdown editor uploads it to
  an `assets/` folder next to the document (created if missing) as
  `image-YYYYMMDD-HHMMSS.png` and inserts `![](assets/...)` as its own
  paragraph: after the paragraph the cursor is in (lines are never split), or
  on the blank line the cursor is on.
- **File management:** right-click a tree row (files and folders) or use the
  `...` menu in the header: New file, New folder, Upload files, Rename, Move
  to..., Duplicate, Copy path, Version history, Delete. Drag a tree row onto a
  folder to move it (with a confirm). Drop files from your computer onto a
  folder in the tree, or onto the open page (uploads to its folder). Names are
  checked as you type against the same rules the server enforces.
- **Renames and moves do not rewrite links** inside other documents; the
  rename and move dialogs say so. The open file is followed to its new path.
- **Undo** in the toasts: delete restores from Trash, move/rename moves back,
  save offers *Restore previous version*.
- **Version history** (sheet): earlier versions with time, size and reason,
  content preview, diff against the current text, and Restore (the current
  version is saved to history first). Restoring a version identical to the
  current file changes nothing and says so; with unsaved edits open the
  confirm warns that they will conflict with the restored version.
  Focus returns to the control that opened a dialog or sheet when it closes.
- **Trash and activity** (sidebar footer): restore, restore to another path,
  delete permanently, empty trash; the Activity tab lists recent operations
  from the audit log with *Move back* for moves.

### Recovery data (the data dir)

Everything is stored under the data dir, never inside the docs root. It is not
served by any read endpoint and not indexed for search. Each docs root gets its
own store, so two roots sharing one data dir never see or restore each other's
history or trash (the path is printed at startup with `EDITING ENABLED`):

```
.data/state.json                   {last_root, recent}: the remembered folders (see Choosing and switching folders)
.data/roots/<key>/                 <key> = first 24 hex chars of sha256(canonical root path)
  root.json                        {root}; the server refuses to start if it names a different root
  audit.jsonl                      one JSON line per change: ts, op, path, to, size, sha256, history_id, trash_id (never contents)
  history/<sha256 of path>/<id>    previous bytes of a file, plus <id>.json {id, path, saved_at, size, sha256, reason}
  trash/<id>/                      a deleted file or folder, plus trash/<id>/manifest.json {id, original_path, deleted_at, kind, size, file_count}
```

Older builds wrote `history/`, `trash/` and `audit.jsonl` directly under the
data dir; those are not migrated (move them into the root's folder by hand if
you need them).

- A history version is written **before every overwrite**: save, upload with
  overwrite, move over an existing file, and history restore. The newest
  `--history-keep` (default 50) versions per file are kept. History follows
  moves and renames (including folder moves).
- **Delete** moves the file or the whole folder into `trash/` (a rename on the
  same file system, otherwise copy + fsync + remove). Restore puts it back at
  its original path (refused with 409 if something is there, unless you pick
  *Restore to...*). Items stay until you delete them permanently or empty the
  Trash.

### Backing up and clearing the data dir

The data dir is plain files; stop the server (or at least do not edit) while
copying it.

```sh
cd local-docs-viewer
# back up
tar czf ~/ldv-data-$(date +%Y%m%d).tgz .data
# free space: empty the Trash in the UI, or remove only the history
rm -rf .data/roots/*/history
# clear everything (history, trash, audit log and the remembered folders are gone for good)
rm -rf .data
```

The server recreates the folders on the next edit.

### Limits

- Text edits up to 2 MB per file (the editor refuses larger saves).
- Uploads: `--upload-max-mb` per file (default 25 MB, enforced while
  streaming, nothing is written above the limit), at most 20 files per
  request, extensions from `--upload-ext` only. Uploaded names are cleaned
  (directories stripped, Unicode normalised, unsafe characters replaced);
  a name that already exists gets `-1`, `-2`, ... unless overwrite is chosen
  (the old file then goes to history).
- Names are refused if they are empty, `.`/`..`, contain `/`, `\`, NUL,
  control or bidi characters, are longer than 255 bytes, start with a space or
  end with a space or dot, or match the deny or ignore list (so you cannot
  create `.env`, `x_token.md` or `__pycache__`). Existing names are compared
  ignoring case and Unicode normalisation, as APFS does.
- Folders that contain deny-listed files cannot be moved or deleted from the
  viewer (you could not see what would be affected).
- Symlinks are never written through or operated on.

### How writes are protected

When editing is on the server generates a random token at every launch
(`secrets.token_urlsafe(32)`). The UI reads it from `GET /api/config` (sent
with `Cache-Control: no-store`, and left out for cross-site requests). Every
`/api/edit/*` request, including the GET reads of history, trash and audit,
must:

- carry `X-Edit-Token` equal to the token (constant-time compare);
- pass the existing Host allowlist (`127.0.0.1` / `localhost`, else 400);
- have `Sec-Fetch-Site: same-origin` or no such header, and no `Origin` or
  exactly `http://127.0.0.1:<port>` / `http://localhost:<port>` (or port 3000
  for the dev server);
- use `Content-Type: application/json` (or `multipart/form-data` for upload
  only). A cross-site "simple" request such as a `text/plain` form post is
  therefore refused.

Anything else gets 403. Non-GET methods on every other route still get 405, and
the CSP is unchanged. Each write then goes through one guard: every path
component (including the new name) is checked against the root, the deny and
ignore lists and the name rules; no component may be a symlink (checked with
lstat), and the operation itself works through file descriptors of the
parent folders opened with `O_NOFOLLOW`, so a folder swapped for a symlink
after the check is refused (403) instead of followed; files are written
atomically (a `.ldv-tmp-*` file created with `O_EXCL` in the same folder,
fsync, original mode kept, renamed into place, temp file removed on any
error); creates, copies, moves and Trash restores use a no-replace rename (unless
overwrite was chosen), so they
never clobber a file that appeared in the meantime (409); and
a single process-wide lock serialises all changes. The tree, the search index
and the live-update stream are updated immediately, so each change is reported
once (moves as renames). The server refuses to start with `--allow-edit` if
the data dir is inside the root or the root is inside the data dir. Paths are
compared after resolving the real on-disk spelling, ignoring case and Unicode
normalisation, and by file identity, so `.../LOCAL_DEV/.data` or an NFD
spelling cannot slip past. In read-only mode a data dir inside the root is
hidden from the tree, search and every read endpoint under any spelling.

## PDF export

The file header of a markdown or mermaid file has a **PDF** menu: *Download PDF*
(A4, orientation *Auto* by default), paper A4/Letter, orientation
Auto/Portrait/Landscape and an optional table of contents (the choice is
remembered in localStorage). *Auto* prints markdown in portrait and a
standalone `.mmd` diagram in whichever orientation shows it larger (wide
flowcharts and sequence diagrams go landscape); the response header
`X-PDF-Orientation` says which one was used. The browser fetches
`GET /api/pdf?path=&paper=a4|letter&orientation=auto|portrait|landscape&toc=0|1`
and saves the result through an object URL; errors appear as a toast. If a
diagram failed or an image was missing, the toast says so (the response carries
`X-PDF-Mermaid-Errors` / `X-PDF-Image-Errors`). The existing Print button
(browser print dialog) is still there.

How it works:

1. `/api/pdf` runs the same `PathGuard.resolve` as every other endpoint (403
   outside the root or denied, 404 missing), then accepts only the `markdown`
   and `mermaid` kinds (else 400) and files up to 2 MB (else 413).
2. The server drives the system Chrome (headless, through Playwright) to its own
   static page `http://127.0.0.1:<port>/print?p=<path>&paper=&orientation=&toc=`.
   That route of the static export (`web/src/app/print`) renders only the
   document, always in the light theme, with the same markdown/mermaid renderers
   as the viewer, plus a cover block (title = first h1 or file name, repo-relative
   path, modified date) and, if asked, a table of contents on its own page.
3. The page sets `window.__PDF_READY__ = true` once every mermaid diagram has
   rendered (or shows its error and source), every image has loaded or failed,
   code highlighting is done and fonts are ready; `window.__PDF_ERRORS__` has the
   counts. The server waits up to 45 s for it (then 504).
4. `page.pdf()` prints with the CSS page size, backgrounds, a small header (doc
   title) and a footer (`path`, `page X of Y`), PDF bookmarks from the headings
   and a tagged PDF. The bytes are returned from memory as an attachment
   (`<name>.pdf`); nothing is written to disk inside the root.

Pagination rules (`globals.css`, section "PDF print layout"):

- `@page` size and margins come from the query (A4 or Letter, either orientation).
- Images, mermaid figures, blockquotes, table rows and short code blocks have
  `break-inside: avoid`; headings `break-after: avoid`; orphans/widows 3.
- Images and diagrams are scaled (aspect ratio kept) to at most the page width
  and roughly the printable page height, so they are never cut across pages.
  A standalone `.mmd` diagram is sized to fit page 1 under a compact cover.
- A tall figure right after a heading (or a heading and a one-line lead-in) is
  shrunk by the height of that lead, so the heading prints on the same page as
  its figure instead of alone on an otherwise blank page.
- Code blocks over 40 lines may split between pages but never in the middle of
  a line; wide code shrinks its font (down to 5.5pt) to fit, and only lines that
  still do not fit wrap.
- Tables span the page width, wrap their cells and repeat the header row on
  each page.
- Links print as plain text; in-repo links show their target path, `#anchor`
  links become PDF-internal links.

Browser lifecycle: jobs are serialised (one Chrome at a time, behind a lock).
The browser is reused while idle for less than 60 s, then closed; it is also
closed on server shutdown. If Chrome is not found, `/api/pdf` returns 503 with
a message saying so; if `web/out` has no `print.html`, 503 asks you to run
`npm run build`. `HEAD /api/pdf` answers 405 (it would need a render).
Cross-site requests are refused with 403: when the browser sends
`Sec-Fetch-Site` it must be `same-origin` or `none`, and an `Origin` header must
be a loopback `http://` origin, so a web page cannot make the viewer launch
Chrome with e.g. `<img src="http://127.0.0.1:8765/api/pdf?...">`. Temporary
profiles left behind by a crashed or killed server (`ldv-chrome-*` in the temp
dir, older than 10 minutes and not locked by a live Chrome) are removed the next
time Chrome starts. In dev mode the PDF is still rendered from the built `web/out`
served by FastAPI, so rebuild after changing the print page.

## Desktop app

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
  is on; see [Recovery data](#recovery-data-the-data-dir)).
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

### Desktop mode (the server side)

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

## Security model

- **Loopback only.** Uvicorn binds `127.0.0.1` and there is no host option.
  `TrustedHostMiddleware` accepts only `Host: 127.0.0.1` or `localhost`, which
  blocks DNS rebinding. There is no CORS.
- **Read-only by default.** Only GET and HEAD routes exist; anything else
  returns 405 (except the token-guarded `POST /api/roots/*`, see [The
  /api/roots endpoints](#the-apiroots-endpoints-and-their-security-model)). Without `--allow-edit` the server never writes inside the root,
  and `/api/edit/*` returns 403. With it, writes are limited to `/api/edit/*`
  and protected as described in [How writes are protected](#how-writes-are-protected).
  The search index lives in an in-memory SQLite database.
- **One path check for every endpoint** (`PathGuard.resolve`). It rejects empty
  paths, absolute paths and NUL bytes. It joins the path to the root, applies
  realpath, and requires the result to stay inside the root. It then applies the
  deny and ignore lists to both the requested and the resolved components.
  Outside the root or denied gives 403, missing gives 404. Denied files are
  never listed, served or indexed.
- **Symlinks.** Symlinked folders are never descended into. A symlinked file is
  shown only if its target is inside the root and passes the deny list. The
  `runtime_workdir/` links that point into the repo (including `.env`) are
  therefore hidden and refused.
- **Headers on every response:**
  - A strict `Content-Security-Policy`: `default-src 'self'`, no external
    hosts, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
    `wasm-unsafe-eval` is not needed, because shiki uses its JavaScript regex
    engine.
  - `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- **`/api/raw`.** Only images and PDFs are served inline. SVGs get
  `Content-Security-Policy: sandbox; default-src 'none'; ...`. Everything else
  is sent as an `application/octet-stream` attachment.
- **Markdown.**
  - Rendered through `rehype-sanitize` (default schema).
  - External images are never loaded; a placeholder is shown instead.
  - External links open only on click, in a new tab with `rel=noreferrer`.
  - Mermaid runs with `securityLevel: 'strict'`. External `img:` URLs in
    mermaid nodes (and `<img src>` in labels) are replaced with a local
    placeholder before rendering, and the diagram shows "N external images
    blocked". Nothing is fetched from a CDN, even in `next dev`.
- **PDF export network lockdown.** Headless Chrome runs with a temporary
  profile in the system temp dir (deleted when the browser closes) and with
  background networking, component updates, sync, default apps, domain
  reliability, crash reporting/metrics, extensions and the first-run flow
  disabled. `--host-resolver-rules` makes every host except 127.0.0.1
  unresolvable, service workers are blocked, and a `route('**/*')` handler
  aborts every HTTP(S) request whose origin is not exactly
  `http://127.0.0.1:<port>` (blocked URLs are logged). Playwright's `route`
  does not see WebSockets, so a `route_web_socket('**/*')` handler closes every
  WebSocket as well (the viewer has none). The print page itself keeps the same
  strict CSP (`connect-src 'self'`) and never loads external images
  (placeholders, as in the viewer).
- **No telemetry, no external calls.** No Google fonts (system font stack), no
  CDN, and Next telemetry is disabled. FastAPI's OpenTelemetry hooks are
  switched off.

## Tests

```sh
uv run pytest -q
```

The tests use pytest `tmp_path` fixtures only and never touch the real root.
They cover path safety, the deny list, symlinks, large-file chunking, search,
security headers and live updates (watcher, reconcile, renames, SSE).
`test_pdf.py` checks that `/api/pdf` refuses traversal, denied and
non-markdown paths and cross-site requests, that the request-blocking route
and WebSocket handlers abort external URLs, the idle-close deadline and the
stale-profile sweep, and (only when Chrome and `web/out` exist, otherwise skipped) renders a
real PDF end to end on a free port and checks the temporary profile is removed.
`test_edit_*.py` cover editing: off by default (every endpoint 403, nothing
changes), token/Origin/Sec-Fetch-Site/Host/content-type checks, traversal and
symlink refusals, denied and ignored names, atomic saves and 409 conflicts,
history pruning and restore, trash, uploads, and that the tree, search and SSE
see each change exactly once. `test_roots.py` covers folder switching: startup
resolution (CLI > env > `state.json`), the no-folder mode, pick (with a fake
dialog), cancel, switch only to recent folders, forget, the token / Origin /
Sec-Fetch-Site / content-type gate, `--lock-root`, edit mode per folder and
the data-dir overlap refusal, the old app's SSE streams and background tasks
ending after a switch, and serialised concurrent switches. No test opens a
real dialog. All of them use `tmp_path` roots and data dirs.
`test_desktop.py` covers desktop mode against a fake bridge: picker success,
cancel, 409, timeout and token refusal; PDF success, the payload (same-origin
`/print` URL and query, templates, margins, timeouts) and every error-status
mapping; the CLI refusing `--desktop` without the bridge env, printing
`LDV_READY` once it accepts connections, exiting on stdin EOF; and that
playwright is never imported.

Frontend checks: `cd web && npm run lint && npx tsc --noEmit`.

## Known limits

- Live updates come from `watchfiles` plus a full stat rescan every 10 s, which
  catches events FSEvents coalesces or misses.
- Renames are inferred within one batch of changes, in two ways:
  - The same size, mtime and basename means a move, which includes folder
    renames.
  - A unique same-directory match on size and mtime means an in-place rename.
  - If a rename is split across two batches, it shows up as a delete plus an
    add. The UI then shows a "deleted or moved" notice.
- `/api/content` refuses files over 2 MB with 413; viewers fall back to the
  chunked text viewer. Code highlighting is limited to files under 300 KB.
- Chunks snap to line boundaries. With very long lines (one line in
  `runtime.log` is about 107 KB), a head or tail chunk can be much smaller than
  128 KB.
- Search offsets are computed from the decoded text, so they can be slightly off
  in files with invalid UTF-8. Files larger than the search limit are not
  content-indexed (their names are still searchable).
- CSV previews show the first 5000 rows, and xlsx the first 1000 rows per
  sheet, with values stringified.
- In dark mode each mermaid diagram is rendered twice (dark for the screen, a
  light copy that only `@media print` shows), so printing uses light colours.
- PDF export: diagrams wider than the page are scaled down to the page width.
  Very wide or very large diagrams inside a markdown document can print with
  tiny labels (2-3pt) in portrait; for diagram-heavy documents choose
  Landscape. Standalone `.mmd` files pick landscape automatically (*Auto*), but
  extremely wide ones (5:1 and more) are still limited by the page width. External images (including
  mermaid `img:` icons from a CDN) print as placeholders. Diagrams are not
  rasterised, so text in the PDF stays selectable.
- Folders that contain only hidden symlinks still appear as empty folders.
- macOS and Linux only: the write path relies on POSIX `dir_fd`/`O_NOFOLLOW`
  file operations, so native Windows is not supported (WSL should work).

## License

[MIT](LICENSE)
