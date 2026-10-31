"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
from urllib.parse import quote, urlsplit

import anyio

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse, ServerSentEvent
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .config import Settings
from .edit import Editor
from .edit_routes import DEV_UI_PORT, MAX_UPLOAD_FILES, EditGate, is_edit_path, register_edit_routes
from .git import GitLink, register_git_routes
from .paths import INLINE_MIME, PathError, PathGuard, ext_of, kind_of, mime_of
from .pdf import ORIENTATIONS, PAPERS, PdfError, PdfJob, PdfRenderer
from .readers import CONTENT_MAX, read_csv, read_xlsx, text_chunks
from .search import SearchIndex
from .store import Change, Store, reconcile_loop, watch_loop

log = logging.getLogger("viewer")

CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'none'")
SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
PDF_CSP = "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
ALLOWED_METHODS = {"GET", "HEAD"}
ROOTS_PREFIX = "/api/roots"  # folder switching; served by the outer RootSwitcher (roots.py), RootGate-guarded
SEEN_PREFIX = "/api/seen"  # "changed since you last looked" history (seen.py); same outer app and gate


def is_roots_path(path: str) -> bool:
    return path == ROOTS_PREFIX or path.startswith(ROOTS_PREFIX + "/")


def is_seen_path(path: str) -> bool:
    return path == SEEN_PREFIX or path.startswith(SEEN_PREFIX + "/")


def is_gated_path(path: str) -> bool:
    """Paths the outer RootSwitcher serves itself, behind RootGate."""
    return is_roots_path(path) or is_seen_path(path)


def _host_only(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("["):
        return value.split("]", 1)[0] + "]"
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _forwarded_hosts_ok(scope) -> bool:
    """DNS-rebinding defence behind the `next dev` proxy: the proxy rewrites Host to
    127.0.0.1 but reports the browser's Host in X-Forwarded-Host, so check that too."""
    for k, v in scope.get("headers", []):
        if k.lower() in (b"x-forwarded-host", b"forwarded"):
            text = v.decode("latin-1")
            if k.lower() == b"forwarded":
                vals = [p.split("=", 1)[1].strip('"') for part in text.split(",")
                        for p in part.split(";") if p.strip().lower().startswith("host=")]
            else:
                vals = text.split(",")
            if any(_host_only(h) not in ALLOWED_HOSTS for h in vals if h.strip()):
                return False
    return True


class SecurityMiddleware:
    """Pure ASGI: refuse non-GET/HEAD (except below /api/edit, which EditGate guards, and, with
    roots=True, below /api/roots and /api/seen, which RootGate guards), add security headers to
    every response."""

    def __init__(self, app, *, roots: bool = False):
        self.app = app
        self.roots = roots

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if (scope["method"] not in ALLOWED_METHODS and not is_edit_path(scope["path"])
                and not (self.roots and is_gated_path(scope["path"]))):
            body = b'{"detail":"Method Not Allowed"}'
            await send({"type": "http.response.start", "status": 405, "headers": [
                (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                (b"allow", b"GET, HEAD"), (b"content-security-policy", CSP.encode()),
                (b"referrer-policy", b"no-referrer"), (b"x-content-type-options", b"nosniff")]})
            await send({"type": "http.response.body", "body": body})
            return

        if not _forwarded_hosts_ok(scope):
            body = b'{"detail":"Invalid forwarded host"}'
            await send({"type": "http.response.start", "status": 400, "headers": [
                (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                (b"content-security-policy", CSP.encode()),
                (b"referrer-policy", b"no-referrer"), (b"x-content-type-options", b"nosniff")]})
            await send({"type": "http.response.body", "body": body})
            return

        async def wrapped(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                names = {k.lower() for k, _ in headers}
                if b"content-security-policy" not in names:
                    headers.append((b"content-security-policy", CSP.encode()))
                if b"referrer-policy" not in names:
                    headers.append((b"referrer-policy", b"no-referrer"))
                if b"x-content-type-options" not in names:
                    headers.append((b"x-content-type-options", b"nosniff"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, wrapped)


def find_repo_prefix(root: str) -> str:
    cur = root
    while True:
        if os.path.lexists(os.path.join(cur, ".git")):
            rel = os.path.relpath(root, cur)
            return "" if rel == "." else rel.replace(os.sep, "/") + "/"
        parent = os.path.dirname(cur)
        if parent == cur:
            return ""
        cur = parent


def _same_site_request(request: Request) -> bool:
    """True unless the browser says the request came from another site: Sec-Fetch-Site must be
    absent, 'same-origin' or 'none' (typed URL), and Origin absent or a loopback origin (the
    viewer itself or the `next dev` server on another loopback port)."""
    sfs = request.headers.get("sec-fetch-site")
    if sfs is not None and sfs.strip().lower() not in ("same-origin", "none"):
        return False
    origin = request.headers.get("origin")
    if origin is not None:
        try:
            u = urlsplit(origin.strip())
            ok = u.scheme == "http" and (u.hostname or "") in ALLOWED_HOSTS and not u.path.strip("/")
            u.port  # noqa: B018 - raises on a malformed port
        except ValueError:
            return False
        if not ok:
            return False
    return True


def _err(e: PathError) -> JSONResponse:
    return JSONResponse({"detail": e.detail}, status_code=e.status)


def mount_ui(app: FastAPI, ui_dir: str) -> None:
    """/print + the static export at /, or a 503 hint on / when the UI is not built."""
    def get(path: str):
        return app.api_route(path, methods=["GET", "HEAD"])

    if os.path.isdir(ui_dir):
        # The static export writes /print as print.html; StaticFiles does not add ".html".
        @get("/print")
        def ui_print():
            f = os.path.join(ui_dir, "print.html")
            if not os.path.isfile(f):
                return JSONResponse({"detail": "print page not built; run 'npm run build'"}, status_code=404)
            return FileResponse(f, media_type="text/html", headers={"Cache-Control": "no-cache"})

        app.mount("/", StaticFiles(directory=ui_dir, html=True), name="ui")
    else:
        msg = (f"UI build not found at {ui_dir}. Run 'npm run build' in the web/ "
               "directory; the API is still available under /api.")
        log.warning(msg)

        @get("/")
        def ui_missing():
            return JSONResponse({"detail": msg}, status_code=503)


def make_pdf_renderer(settings: Settings):
    """--desktop: rendered by the Electron shell over its bridge; else Playwright + system Chrome
    (playwright itself is only imported on the first export)."""
    if settings.desktop:
        from .desktop import BridgeClient, BridgePdfRenderer  # local: desktop imports roots imports app

        return BridgePdfRenderer(settings.port, BridgeClient(settings.bridge_url, settings.bridge_token))
    return PdfRenderer(settings.port)


def create_app(settings: Settings) -> FastAPI:
    if settings.root is None:
        raise ValueError("create_app needs a root (RootSwitcher serves the no-folder mode)")
    settings.validate()  # ConfigError: data dir overlaps the root while editing is enabled
    guard = PathGuard(settings)
    store = Store(guard)
    editor = Editor(settings, guard, store) if settings.allow_edit else None
    index = SearchIndex(store, settings.search_max_bytes)
    repo_prefix = find_repo_prefix(settings.root)
    git = GitLink(settings, guard)  # detected on first use (off: not a repo, no git, --git off)
    pdf = make_pdf_renderer(settings)
    closing = asyncio.Event()  # set on lifespan shutdown: ends this app's SSE streams (root switch)

    async def on_change(ch: Change) -> None:
        data = ch.to_json()
        store.publish(ch)
        await asyncio.to_thread(index.apply_change, data)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        store.bind_loop(asyncio.get_running_loop())
        await asyncio.to_thread(store.full_scan)
        index.start_background_build()
        stop = asyncio.Event()
        tasks = []
        if settings.watch:
            tasks.append(asyncio.create_task(watch_loop(store, on_change, stop)))
        if settings.reconcile_interval > 0:
            tasks.append(asyncio.create_task(reconcile_loop(store, on_change, settings.reconcile_interval, stop)))
        try:
            yield
        finally:
            closing.set()
            stop.set()
            index.stop()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await pdf.close()

    app = FastAPI(
        title="local-docs-viewer", version=__version__, lifespan=lifespan,
        docs_url=None, redoc_url=None, openapi_url=None,
        telemetry={"tracing": False, "metrics": False, "logs": False,
                   "operation_spans": False, "auto_configure": False},
    )
    app.state.settings = settings
    app.state.store = store
    app.state.index = index
    app.state.pdf = pdf
    app.state.editor = editor
    app.state.closing = closing
    app.state.git = git
    app.state.config_extra = None  # RootSwitcher: request -> {"root_switch_enabled", "root_token"?}

    def get(path: str):
        return app.api_route(path, methods=["GET", "HEAD"])

    @get("/api/config")
    def api_config(request: Request):
        out = {"root_name": os.path.basename(settings.root), "repo_prefix": repo_prefix,
               "search_max_bytes": settings.search_max_bytes, "version": __version__,
               "edit_enabled": editor is not None, "deny_patterns": list(settings.deny),
               "ignore_patterns": list(settings.ignore), "upload_ext": list(settings.upload_ext),
               "upload_max_bytes": settings.upload_max_bytes, "edit_max_bytes": settings.edit_max_bytes,
               "upload_max_files": MAX_UPLOAD_FILES, "root_path": settings.root, "no_root": False,
               "root_switch_enabled": False, "git_enabled": git.repo() is not None}
        if editor is not None and _same_site_request(request):
            out["edit_token"] = editor.token
        if app.state.config_extra is not None:
            out.update(app.state.config_extra(request))
        return JSONResponse(out, headers={"Cache-Control": "no-store"})

    @get("/api/tree")
    def api_tree():
        return store.snapshot()

    def meta(rel, real, st):
        name = os.path.basename(rel)
        kind = kind_of(name, real)
        return {"path": rel, "name": name, "size": st.st_size, "mtime": st.st_mtime_ns / 1e9,
                "kind": kind, "ext": ext_of(name), "mime": mime_of(name, kind)}

    @get("/api/file")
    def api_file(path: str | None = None):
        try:
            r, st = guard.resolve_file(path)
        except PathError as e:
            return _err(e)
        return meta(r.rel, r.real, st)

    @get("/api/content")
    def api_content(path: str | None = None):
        try:
            r, st = guard.resolve_file(path)
        except PathError as e:
            return _err(e)
        if st.st_size > CONTENT_MAX:
            return JSONResponse({"detail": "file too large for full content; use /api/text",
                                 "size": st.st_size}, status_code=413)
        with open(r.real, "rb") as f:
            data = f.read(CONTENT_MAX + 1)
        if len(data) > CONTENT_MAX:
            return JSONResponse({"detail": "file too large", "size": len(data)}, status_code=413)
        return {"path": r.rel, "text": data.decode("utf-8", errors="replace"),
                "size": len(data), "truncated": False, "sha256": hashlib.sha256(data).hexdigest(),
                "mtime": st.st_mtime_ns / 1e9}

    @get("/api/text")
    def api_text(path: str | None = None, start: int | None = Query(None, ge=0),
                 length: int | None = Query(None, ge=0), line: int | None = Query(None, ge=1)):
        try:
            r, st = guard.resolve_file(path)
        except PathError as e:
            return _err(e)
        res = text_chunks(r.real, st.st_size, start=start, length=length, line=line)
        out = {"path": r.rel, **res}
        if line is not None:
            out["line"] = line
        return out

    @get("/api/raw")
    def api_raw(path: str | None = None):
        try:
            r, st = guard.resolve_file(path)
        except PathError as e:
            return _err(e)
        name = os.path.basename(r.rel)
        ext = ext_of(name)
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"}
        if ext in INLINE_MIME:
            if ext == "svg":
                headers["Content-Security-Policy"] = SVG_CSP
            elif ext == "pdf":
                headers["Content-Security-Policy"] = PDF_CSP
            return FileResponse(r.real, media_type=INLINE_MIME[ext], filename=name,
                                content_disposition_type="inline", headers=headers, stat_result=st)
        return FileResponse(r.real, media_type="application/octet-stream", filename=name,
                            content_disposition_type="attachment", headers=headers, stat_result=st)

    @get("/api/csv")
    def api_csv(path: str | None = None):
        try:
            r, st = guard.resolve_file(path)
        except PathError as e:
            return _err(e)
        ext = ext_of(r.rel)
        if ext not in ("csv", "tsv"):
            return JSONResponse({"detail": "not a csv/tsv file"}, status_code=400)
        return {"path": r.rel, **read_csv(r.real, ext)}

    @get("/api/xlsx")
    def api_xlsx(path: str | None = None):
        try:
            r, st = guard.resolve_file(path)
        except PathError as e:
            return _err(e)
        if ext_of(r.rel) != "xlsx":
            return JSONResponse({"detail": "not an xlsx file"}, status_code=400)
        try:
            return {"path": r.rel, **read_xlsx(r.real)}
        except Exception as e:  # corrupt workbook
            return JSONResponse({"detail": f"could not read workbook: {type(e).__name__}"}, status_code=422)

    @get("/api/search")
    def api_search(q: str = "", folder: str = "", types: str = "", limit: int = 50):
        return index.search(q, folder=folder, types=types, limit=limit)

    @app.get("/api/events")
    async def api_events():
        q = store.subscribe()
        shutdown = anyio.Event()  # set by sse-starlette when the server starts shutting down

        async def gen():
            try:
                # flush headers immediately (proxies such as `next dev` hold
                # them until the first byte) and set the client retry delay
                yield ServerSentEvent(comment="connected", retry=3000)
                while not shutdown.is_set() and not closing.is_set():
                    data = None
                    with anyio.move_on_after(0.5):  # wake up regularly to notice shutdown
                        data = await q.get()
                    if data is None:
                        continue
                    event, data = data if isinstance(data, tuple) else ("change", data)
                    yield {"event": event, "data": json.dumps(data)}
            finally:
                store.unsubscribe(q)

        return EventSourceResponse(gen(), ping=15, shutdown_event=shutdown, shutdown_grace_period=1.0,
                                   headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.head("/api/pdf")
    def api_pdf_head():
        # HEAD would have to render to report the real length; answer it without a render.
        return JSONResponse({"detail": "Method Not Allowed"}, status_code=405, headers={"Allow": "GET"})

    @app.get("/api/pdf")
    async def api_pdf(request: Request, path: str | None = None, paper: str = "a4",
                      orientation: str = "portrait", toc: str = "0"):
        # Each export drives a headless Chrome: refuse cross-site triggers (e.g. an <img> on
        # some web page pointing here). The response is unreadable cross-origin anyway.
        if not _same_site_request(request):
            return JSONResponse({"detail": "cross-site PDF export requests are refused"}, status_code=403)
        try:
            r, st = guard.resolve_file(path)
        except PathError as e:
            return _err(e)
        name = os.path.basename(r.rel)
        if kind_of(name, r.real) not in ("markdown", "mermaid"):
            return JSONResponse({"detail": "PDF export is only available for markdown and mermaid files"},
                                status_code=400)
        paper, orientation = paper.lower(), orientation.lower()
        if paper not in PAPERS or orientation not in ORIENTATIONS or toc not in ("0", "1", "true", "false"):
            return JSONResponse({"detail": "paper must be a4|letter, orientation portrait|landscape, toc 0|1"},
                                status_code=400)
        if st.st_size > CONTENT_MAX:
            return JSONResponse({"detail": "file too large to export", "size": st.st_size}, status_code=413)
        if not os.path.isfile(os.path.join(settings.ui_dir, "print.html")):
            return JSONResponse({"detail": "UI build not found; run 'npm run build' in web/"}, status_code=503)
        job = PdfJob(path=r.rel, display_path=f"{repo_prefix}{r.rel}", title=name, paper=paper,
                     orientation=orientation, toc=toc in ("1", "true"))
        try:
            data, errors = await pdf.render(job)
        except PdfError as e:
            return JSONResponse({"detail": e.detail}, status_code=e.status)
        stem = name.rsplit(".", 1)[0] if "." in name.lstrip(".") else name
        fname = f"{stem}.pdf"
        ascii_name = "".join(c if c.isascii() and c.isprintable() and c not in '"\\;' else "_" for c in fname)
        headers = {"Content-Disposition": f'attachment; filename="{ascii_name}"; '
                                          f"filename*=UTF-8''{quote(fname, safe='')}",
                   "Cache-Control": "no-store",
                   "X-PDF-Mermaid-Errors": str(int(errors.get("mermaid", 0) or 0)),
                   "X-PDF-Image-Errors": str(int(errors.get("images", 0) or 0)),
                   "X-PDF-Orientation": str(errors.get("orientation") or orientation)}
        return Response(content=data, media_type="application/pdf", headers=headers)

    if editor is not None:
        register_edit_routes(app, editor, on_change)

    register_git_routes(app, git.repo, _same_site_request)

    @get("/api/{rest:path}")
    def api_not_found(rest: str):
        return JSONResponse({"detail": "Not Found"}, status_code=404)

    mount_ui(app, settings.ui_dir)

    origins = {f"http://{h}:{p}" for h in ALLOWED_HOSTS for p in (settings.port, DEV_UI_PORT)}
    app.add_middleware(EditGate, token=editor.token if editor else None, origins=origins,
                       json_max=settings.edit_max_bytes * 6 + 64 * 1024,
                       upload_max=settings.upload_max_bytes * MAX_UPLOAD_FILES + 1024 * 1024)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
    app.add_middleware(SecurityMiddleware)  # outermost: also covers TrustedHost rejections
    return app
