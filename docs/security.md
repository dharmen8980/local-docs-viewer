# Security model

- **Loopback only.** Uvicorn binds `127.0.0.1` and there is no host option.
  `TrustedHostMiddleware` accepts only `Host: 127.0.0.1` or `localhost`, which
  blocks DNS rebinding. There is no CORS.
- **Read-only by default.** Only GET and HEAD routes exist; anything else
  returns 405 (except the token-guarded `POST /api/roots/*`, see [The
  /api/roots endpoints](configuration.md#the-apiroots-endpoints-and-their-security-model)). Without `--allow-edit` the server never writes inside the root,
  and `/api/edit/*` returns 403. With it, writes are limited to `/api/edit/*`
  and protected as described in [How writes are protected](editing.md#how-writes-are-protected).
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
