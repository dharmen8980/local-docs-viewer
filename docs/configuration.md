# Configuration

Flags, environment variables, and how the docs folder is chosen and switched.

## Options

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
| Git views | `--git PATH\|off` | `DOCS_VIEWER_GIT` | found on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` (never the macOS stub); `off` turns them off; see [Git](git.md#which-git) |
| Desktop mode (set by the desktop app) | `--desktop` | `DOCS_VIEWER_DESKTOP=1` | off; see [Desktop app](desktop.md) |

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
the menu is hidden and every `POST /api/roots/*` returns 403. The changes
history (`/api/seen/*`, see [Security model](security.md#the-apiseen-endpoints))
keeps working, writes and **Clear history…** included: it lives in the data dir
and never changes which folder is shown or anything inside it.

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
