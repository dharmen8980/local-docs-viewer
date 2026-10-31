"""Runtime folder switching: an outer ASGI app that owns the per-root inner app (create_app).

A browser request can never name an arbitrary path: new folders only enter through the native
folder dialog (a human at this machine) or --root / DOCS_VIEWER_ROOT; /api/roots/switch only
accepts a folder that is already in the recent list."""

from __future__ import annotations

import asyncio
import dataclasses
import hmac
import logging
import os
import secrets
import shutil
import sys
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .app import (
    ALLOWED_HOSTS,
    ROOTS_PREFIX,
    SecurityMiddleware,
    _same_site_request,
    create_app,
    is_gated_path,
    is_roots_path,
    is_seen_path,
    mount_ui,
)
from .config import (
    RECENT_MAX,
    ConfigError,
    Settings,
    canonical_path,
    load_state,
    path_within,
    save_state,
)
from .edit_routes import DEV_UI_PORT, MAX_UPLOAD_FILES, _send_json
from .seen import SEEN_JSON_MAX, SeenDB, register_seen_routes, seen_disabled_reason

log = logging.getLogger("viewer")

PICK_TIMEOUT = 600.0  # seconds a native folder dialog may stay open
PICK_PROMPT = "Choose a folder to view"
ROOTS_JSON_MAX = 64 * 1024
NO_STORE = {"Cache-Control": "no-store"}

Picker = Callable[[], Awaitable[str | None]]  # -> chosen folder, or None if cancelled


class PickerError(Exception):
    def __init__(self, detail: str, status: int = 500):  # status: what /api/roots/pick answers
        super().__init__(detail)
        self.status = status


async def _run_dialog(cmd: list[str], cancelled: Callable[[int, str], bool]) -> str | None:
    """Run a folder dialog as a child process (killed on timeout, cancellation or shutdown)."""
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.DEVNULL,
                                                    stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE)
    except OSError as e:
        raise PickerError(f"could not open the folder dialog: {e.strerror or e}") from e
    try:
        out, err = await asyncio.wait_for(proc.communicate(), PICK_TIMEOUT)
    except TimeoutError:
        return None  # treated as a cancel
    finally:
        if proc.returncode is None:
            proc.kill()
            await asyncio.shield(proc.wait())
    text, msg = out.decode("utf-8", "replace"), err.decode("utf-8", "replace").strip()
    if proc.returncode == 0:
        text = text.removesuffix("\n")  # keep any other whitespace: it is the name
        return text or None
    if cancelled(proc.returncode, msg):
        return None
    raise PickerError(f"folder dialog failed: {msg[:200] or f'exit {proc.returncode}'}")


async def osascript_picker() -> str | None:
    script = f'POSIX path of (choose folder with prompt "{PICK_PROMPT}")'
    return await _run_dialog(["osascript", "-e", script], lambda rc, msg: "-128" in msg)  # -128: user cancelled


async def zenity_picker() -> str | None:
    return await _run_dialog(["zenity", "--file-selection", "--directory", f"--title={PICK_PROMPT}"],
                             lambda rc, msg: rc in (1, 5))  # 1: cancel, 5: zenity's own timeout


def default_picker() -> Picker | None:
    if sys.platform == "darwin" and shutil.which("osascript"):
        return osascript_picker
    if sys.platform.startswith("linux") and shutil.which("zenity"):
        return zenity_picker
    return None


class _Inner:
    """One per-root app; its lifespan runs in a dedicated task so startup and shutdown happen in
    the same task whichever request triggered the switch."""

    def __init__(self, app: FastAPI):
        self.app = app
        self.settings: Settings = app.state.settings
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._error: BaseException | None = None
        self._task: asyncio.Task | None = None

    async def _run(self) -> None:
        try:
            async with self.app.router.lifespan_context(self.app):
                self._ready.set()
                await self._stop.wait()
        except BaseException as e:
            if not self._ready.is_set():
                self._error = e
                self._ready.set()
                return
            log.exception("error shutting down the app for %s", self.settings.root)

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"root-lifespan:{self.settings.root_key}")
        await self._ready.wait()
        if self._error is not None:
            raise self._error

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await asyncio.shield(self._task)


class RootGate:
    """Guards mutating /api/roots/* and /api/seen/* requests like EditGate: X-Root-Token,
    Sec-Fetch-Site same-origin (if sent), loopback viewer/dev Origin (if sent), application/json,
    bounded body. --lock-root -> 403 below /api/roots only (the changes history still works).
    GET/HEAD pass (read-only routes)."""

    def __init__(self, app, *, token: str, origins: set[str], locked: bool):
        self.app = app
        self.token = token.encode()
        self.origins = origins
        self.locked = locked

    def _refusal(self, scope) -> tuple[int, str] | None:
        method = scope["method"]
        if method in ("GET", "HEAD"):
            return None
        if method != "POST":
            return 405, "Method Not Allowed"
        if self.locked and is_roots_path(scope["path"]):
            return 403, "folder switching disabled (--lock-root)"
        headers: dict[bytes, list[bytes]] = {}
        for k, v in scope.get("headers", []):
            headers.setdefault(k.lower(), []).append(v)
        tok = headers.get(b"x-root-token", [])
        if len(tok) != 1 or not hmac.compare_digest(tok[0], self.token):
            return 403, "missing or invalid root token"
        if any(v.strip().lower() != b"same-origin" for v in headers.get(b"sec-fetch-site", [])):
            return 403, "cross-site requests are refused"
        for o in headers.get(b"origin", []):
            if o.decode("latin-1").strip().lower() not in self.origins:
                return 403, "requests from this origin are refused"
        ct = b";".join(headers.get(b"content-type", [])).split(b";", 1)[0].strip().lower()
        if ct != b"application/json":
            return 403, "content-type must be application/json"
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not is_gated_path(scope["path"]):
            return await self.app(scope, receive, send)
        refusal = self._refusal(scope)
        if refusal is not None:
            extra = [(b"allow", b"GET, HEAD, POST")] if refusal[0] == 405 else []
            return await _send_json(send, refusal[0], {"detail": refusal[1]}, extra)
        if scope["method"] != "POST":
            return await self.app(scope, receive, send)
        limit = SEEN_JSON_MAX if is_seen_path(scope["path"]) else ROOTS_JSON_MAX
        for k, v in scope.get("headers", []):
            if k.lower() == b"content-length":
                try:
                    if int(v) > limit:
                        return await _send_json(send, 413, {"detail": "request body too large"})
                except ValueError:
                    return await _send_json(send, 400, {"detail": "invalid content-length"})
        chunks, size, more = [], 0, True  # buffer the body under a hard limit, then replay it
        while more:
            msg = await receive()
            if msg["type"] == "http.disconnect":
                return
            chunk = msg.get("body", b"")
            size += len(chunk)
            if size > limit:
                return await _send_json(send, 413, {"detail": "request body too large"})
            chunks.append(chunk)
            more = msg.get("more_body", False)
        body = b"".join(chunks)
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore")


class PathBody(_Body):
    path: str


class RootSwitcher:
    """Outer ASGI app: security stack -> RootGate -> /api/roots, /api/seen + no-folder mode, or
    the current inner app. Switch = build + validate, start the new lifespan, swap under a lock, stop the old
    one (its SSE streams end; clients reconnect / reload)."""

    _DEFAULT = object()

    def __init__(self, settings: Settings, *, picker: Picker | None | object = _DEFAULT):
        self.base = settings
        self.picker: Picker | None = default_picker() if picker is RootSwitcher._DEFAULT else picker  # type: ignore[assignment]
        self.token = secrets.token_urlsafe(32)  # per launch; survives root switches
        self.locked = settings.lock_root
        self.inner: _Inner | None = None
        self.on_retire: Callable[[_Inner], None] | None = None  # tests: observe stopped apps (none kept)
        self._lock = asyncio.Lock()
        self._picking = False
        self.state = load_state(settings.data_dir)
        self.seen = SeenDB(settings.data_dir)  # changes history, shared by every root (namespaced)
        self.control = self._build_control()
        origins = {f"http://{h}:{p}" for h in ALLOWED_HOSTS for p in (settings.port, DEV_UI_PORT)}
        gate = RootGate(self._dispatch, token=self.token, origins=origins, locked=self.locked)
        self._stack = SecurityMiddleware(TrustedHostMiddleware(gate, allowed_hosts=ALLOWED_HOSTS), roots=True)

    # -- state ---------------------------------------------------------------------------------

    @property
    def app(self) -> FastAPI | None:
        return self.inner.app if self.inner else None

    @property
    def current(self) -> str | None:
        return self.inner.settings.root if self.inner else None

    def recent(self) -> list[str]:
        live = [p for p in self.state["recent"] if os.path.isdir(p)]
        if live != self.state["recent"]:
            self.state["recent"] = live
            self._save()
        return list(live)

    def _remember(self, root: str) -> None:
        self.state["last_root"] = root
        self.state["recent"] = ([root] + [p for p in self.state["recent"] if p != root])[:RECENT_MAX]
        self._save()

    def _save(self) -> None:
        s = self.base
        # read-only mode never writes inside the browsed folder: skip persisting if the data dir is in it
        if self.current is not None and path_within(s.data_dir, self.current):
            return
        try:
            save_state(s.data_dir, self.state)
        except OSError as e:
            log.warning("could not write %s/state.json: %s", s.data_dir, e)

    def roots_info(self) -> dict:
        return {"current": self.current, "recent": self.recent(),
                "picker_available": self.picker is not None, "switch_enabled": not self.locked}

    def _seen_enabled(self, settings: Settings | None) -> bool:
        return settings is not None and seen_disabled_reason(settings) is None and self.seen.available()

    def _config_extra(self, request: Request, settings: Settings | None = None) -> dict:
        out: dict = {"root_switch_enabled": not self.locked, "seen_enabled": self._seen_enabled(settings)}
        if _same_site_request(request):
            out["root_token"] = self.token
        return out

    # -- lifecycle -----------------------------------------------------------------------------

    async def _start(self, settings: Settings) -> _Inner:
        app = create_app(settings)  # ConfigError: e.g. data dir overlaps the root while editing
        app.state.config_extra = lambda request: self._config_extra(request, settings)
        inner = _Inner(app)
        await inner.start()
        return inner

    async def startup(self) -> None:
        if self.base.root is not None:
            async with self._lock:
                self.inner = await self._start(self.base)
                self._remember(self.base.root)

    async def shutdown(self) -> None:
        async with self._lock:
            inner, self.inner = self.inner, None
            if inner is not None:
                await inner.stop()
            self.seen.close()

    async def switch_to(self, path: str) -> str:
        """Serve `path` (already vetted: from the dialog, the CLI or the recent list)."""
        async with self._lock:
            root = canonical_path(path)
            if not os.path.isdir(root):
                raise ConfigError(f"folder not found: {root}")
            old = self.inner
            if old is not None and old.settings.root == root:
                self._remember(root)
                return root
            new = await self._start(dataclasses.replace(self.base, root=root, root_source="browser"))
            self.inner = new
            self._remember(root)
            if old is not None:
                await old.stop()
                if self.on_retire is not None:
                    self.on_retire(old)
            log.info("now serving %s", root)
            return root

    # -- ASGI ----------------------------------------------------------------------------------

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self._lifespan(receive, send)
        await self._stack(scope, receive, send)

    async def _lifespan(self, receive, send) -> None:
        while True:
            msg = await receive()
            if msg["type"] == "lifespan.startup":
                try:
                    await self.startup()
                except BaseException as e:
                    log.exception("startup failed")
                    await send({"type": "lifespan.startup.failed", "message": str(e)})
                    return
                await send({"type": "lifespan.startup.complete"})
            elif msg["type"] == "lifespan.shutdown":
                await self.shutdown()
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def _dispatch(self, scope, receive, send):
        inner = self.inner  # captured once: an in-flight request finishes on the app it started on
        if inner is not None and not is_gated_path(scope.get("path", "")):
            return await inner.app(scope, receive, send)
        await self.control(scope, receive, send)

    def _build_control(self) -> FastAPI:
        s = self.base
        app = FastAPI(title="local-docs-viewer", version=__version__, docs_url=None, redoc_url=None,
                      openapi_url=None, telemetry={"tracing": False, "metrics": False, "logs": False,
                                                   "operation_spans": False, "auto_configure": False})

        # every handler is async: self.state is only touched on the event-loop thread (no worker-thread races)
        def j(data: dict, status: int = 200) -> JSONResponse:
            return JSONResponse(data, status_code=status, headers=NO_STORE)

        @app.api_route(ROOTS_PREFIX, methods=["GET", "HEAD"])
        async def roots_get():
            return j(self.roots_info())

        async def _switch(path: str) -> JSONResponse | str:
            try:
                return await self.switch_to(path)
            except ConfigError as e:
                return j({"detail": str(e)}, 400)

        @app.post(ROOTS_PREFIX + "/pick")
        async def roots_pick():
            if self.picker is None:
                return j({"detail": "no native folder dialog is available on this machine"}, 501)
            if self._picking:
                return j({"detail": "a folder dialog is already open"}, 409)
            self._picking = True
            try:
                chosen = await self.picker()
            except PickerError as e:
                return j({"detail": str(e)}, e.status)
            finally:
                self._picking = False
            if not chosen:
                return j({"cancelled": True})
            res = await _switch(chosen)  # a human chose it in the native dialog
            return res if isinstance(res, JSONResponse) else j({"cancelled": False, "current": res})

        @app.post(ROOTS_PREFIX + "/switch")
        async def roots_switch(b: PathBody):
            if b.path not in self.recent():  # exact match: the browser can only pick from the list
                return j({"detail": "folder is not in the recent list; choose it with the folder dialog"}, 403)
            if canonical_path(b.path) != b.path:  # replaced by a symlink etc. since it was chosen
                self.state["recent"] = [p for p in self.state["recent"] if p != b.path]
                self._save()
                return j({"detail": "folder has moved; choose it again with the folder dialog"}, 400)
            res = await _switch(b.path)
            return res if isinstance(res, JSONResponse) else j({"current": res})

        @app.post(ROOTS_PREFIX + "/forget")
        async def roots_forget(b: PathBody):
            if b.path == self.current:
                return j({"detail": "cannot forget the folder currently shown"}, 400)
            self.state["recent"] = [p for p in self.state["recent"] if p != b.path]
            if self.state["last_root"] == b.path:
                self.state["last_root"] = self.current
            self._save()
            return j(self.roots_info())

        register_seen_routes(app, self.seen, lambda: self.inner)

        @app.api_route(ROOTS_PREFIX + "/{rest:path}", methods=["GET", "HEAD", "POST"])
        async def roots_not_found(rest: str):
            return j({"detail": "Not Found"}, 404)

        # no folder selected (only reached when there is no inner app)
        @app.api_route("/api/config", methods=["GET", "HEAD"])
        async def config_no_root(request: Request):
            return j({"no_root": True, "root_name": None, "root_path": None, "repo_prefix": "",
                      "search_max_bytes": s.search_max_bytes, "version": __version__, "edit_enabled": False,
                      "deny_patterns": list(s.deny), "ignore_patterns": list(s.ignore),
                      "upload_ext": list(s.upload_ext), "upload_max_bytes": s.upload_max_bytes,
                      "edit_max_bytes": s.edit_max_bytes, "upload_max_files": MAX_UPLOAD_FILES,
                      "git_enabled": False, **self._config_extra(request)})

        @app.api_route("/api/{rest:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE"])
        async def no_root(rest: str):
            return j({"detail": "no folder selected"}, 409)

        mount_ui(app, s.ui_dir)
        return app
