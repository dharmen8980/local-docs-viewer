# Development

Running from source, the dev server, and the tests.

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
