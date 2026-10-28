"""HTTP layer for editing: the /api/edit/* auth gate (pure ASGI) and the routes."""

from __future__ import annotations

import asyncio
import hmac
import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.formparsers import MultiPartException, MultiPartParser

from .edit import EditError, Editor

EDIT_PREFIX = "/api/edit"
DEV_UI_PORT = 3000  # `next dev` (its /api proxy forwards the browser's Origin)
MAX_UPLOAD_FILES = 20
EDIT_METHODS = {"GET", "HEAD", "POST", "PUT", "DELETE"}
MUTATING = {"POST", "PUT", "DELETE"}


def is_edit_path(path: str) -> bool:
    return path == EDIT_PREFIX or path.startswith(EDIT_PREFIX + "/")


class _BodyTooLarge(Exception):
    pass


async def _send_json(send, status: int, data: dict, extra_headers=()) -> None:
    body = json.dumps(data).encode()
    await send({"type": "http.response.start", "status": status, "headers": [
        (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
        (b"cache-control", b"no-store"), *extra_headers]})
    await send({"type": "http.response.body", "body": body})


class EditGate:
    """Guards every /api/edit/* request (all methods). Sits inside TrustedHostMiddleware, so a
    foreign Host is still a 400. Disabled -> 403 for everything below /api/edit."""

    def __init__(self, app, *, token: str | None, origins: set[str], json_max: int, upload_max: int):
        self.app = app
        self.token = token.encode() if token else None
        self.origins = origins
        self.json_max = json_max
        self.upload_max = upload_max

    def _refusal(self, scope) -> tuple[int, str] | None:
        if self.token is None:
            return 403, "editing disabled"
        method = scope["method"]
        if method not in EDIT_METHODS:
            return 405, "Method Not Allowed"
        headers: dict[bytes, list[bytes]] = {}
        for k, v in scope.get("headers", []):
            headers.setdefault(k.lower(), []).append(v)
        tok = headers.get(b"x-edit-token", [])
        if len(tok) != 1 or not hmac.compare_digest(tok[0], self.token):
            return 403, "missing or invalid edit token"
        sfs = headers.get(b"sec-fetch-site", [])
        if any(v.strip().lower() != b"same-origin" for v in sfs):
            return 403, "cross-site edit requests are refused"
        for o in headers.get(b"origin", []):
            if o.decode("latin-1").strip().lower() not in self.origins:
                return 403, "edit requests from this origin are refused"
        if method in MUTATING:
            ct = b";".join(headers.get(b"content-type", [])).split(b";", 1)[0].strip().lower()
            want = b"multipart/form-data" if scope["path"] == EDIT_PREFIX + "/upload" else b"application/json"
            if ct != want:
                return 403, f"content-type must be {want.decode()}"
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not is_edit_path(scope["path"]):
            return await self.app(scope, receive, send)
        refusal = self._refusal(scope)
        if refusal is not None:
            extra = [(b"allow", b"GET, HEAD, POST, PUT, DELETE")] if refusal[0] == 405 else []
            return await _send_json(send, refusal[0], {"detail": refusal[1]}, extra)

        limit = self.upload_max if scope["path"] == EDIT_PREFIX + "/upload" else self.json_max
        for k, v in scope.get("headers", []):
            if k.lower() == b"content-length":
                try:
                    if int(v) > limit:
                        return await _send_json(send, 413, {"detail": "request body too large"})
                except ValueError:
                    return await _send_json(send, 400, {"detail": "invalid content-length"})
        seen = 0
        started = exceeded = False

        async def limited_receive():
            nonlocal seen, exceeded
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    exceeded = True
                    raise _BodyTooLarge()
            return msg

        async def tracking_send(msg):
            nonlocal started
            if exceeded:  # the framework turned our exception into its own error: report a 413
                if msg["type"] == "http.response.start" and not started:
                    started = True
                    await _send_json(send, 413, {"detail": "request body too large"})
                return
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            if not started:
                await _send_json(send, 413, {"detail": "request body too large"})


class _UploadTooLarge(Exception):
    pass


class _LimitedMultiPart(MultiPartParser):
    """Starlette's streaming parser with a per-file byte limit enforced while the data arrives
    (parts are spooled in memory / the system temp dir, never inside the root)."""

    def __init__(self, *a, file_limit: int, **kw):
        super().__init__(*a, **kw)
        self.file_limit = file_limit
        self._file_bytes = 0

    def on_part_begin(self) -> None:
        super().on_part_begin()
        self._file_bytes = 0

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self._current_part.file is not None:
            self._file_bytes += end - start
            if self._file_bytes > self.file_limit:
                raise _UploadTooLarge()
        super().on_part_data(data, start, end)


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class SaveBody(_Body):
    path: str
    content: str
    base_sha256: str | None = None
    create: bool = False


class PathBody(_Body):
    path: str


class MoveBody(_Body):
    src: str = Field(alias="from")
    to: str
    overwrite: bool = False
    create_parents: bool = False


class CopyBody(_Body):
    src: str = Field(alias="from")
    to: str


class TrashRestoreBody(_Body):
    id: str
    to: str | None = None


class PurgeBody(_Body):
    id: str | None = None
    all: bool = False


class HistoryRestoreBody(_Body):
    path: str
    id: str


def _truthy(v) -> bool:
    return isinstance(v, str) and v.strip().lower() in ("1", "true", "yes", "on")


def register_edit_routes(app: FastAPI, editor: Editor, on_change) -> None:
    def err(e: EditError) -> JSONResponse:
        return JSONResponse(e.body(), status_code=e.status, headers={"Cache-Control": "no-store"})

    async def run(fn, *args):
        try:
            res, ch = await asyncio.to_thread(fn, *args)
        except EditError as e:
            return err(e)
        if ch is not None:
            await on_change(ch)
        return res

    async def read(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except EditError as e:
            return err(e)

    def get(path: str):
        return app.api_route(EDIT_PREFIX + path, methods=["GET", "HEAD"])

    @app.put(EDIT_PREFIX + "/file")
    async def edit_save(b: SaveBody):
        return await run(editor.save, b.path, b.content, b.base_sha256, b.create)

    @app.post(EDIT_PREFIX + "/mkdir")
    async def edit_mkdir(b: PathBody):
        return await run(editor.mkdir, b.path)

    @app.post(EDIT_PREFIX + "/move")
    async def edit_move(b: MoveBody):
        return await run(editor.move, b.src, b.to, b.overwrite, b.create_parents)

    @app.post(EDIT_PREFIX + "/copy")
    async def edit_copy(b: CopyBody):
        return await run(editor.copy, b.src, b.to)

    @app.post(EDIT_PREFIX + "/delete")
    async def edit_delete(b: PathBody):
        return await run(editor.delete, b.path)

    @get("/trash")
    async def edit_trash():
        return await read(editor.trash_list)

    @app.post(EDIT_PREFIX + "/trash/restore")
    async def edit_trash_restore(b: TrashRestoreBody):
        return await run(editor.trash_restore, b.id, b.to)

    @app.post(EDIT_PREFIX + "/trash/purge")
    async def edit_trash_purge(b: PurgeBody):
        return await run(editor.trash_purge, b.id, b.all)

    @get("/history")
    async def edit_history(path: str | None = None):
        return await read(editor.history_list, path)

    @get("/history/content")
    async def edit_history_content(path: str | None = None, id: str | None = None):
        res = await read(editor.history_content, path, id)
        if isinstance(res, Response):
            return res
        man, data, truncated = res
        return Response(data, media_type="text/plain; charset=utf-8", headers={
            "Cache-Control": "no-store", "X-History-Truncated": "1" if truncated else "0",
            "X-History-Sha256": man["sha256"], "X-History-Size": str(man["size"])})

    @app.post(EDIT_PREFIX + "/history/restore")
    async def edit_history_restore(b: HistoryRestoreBody):
        return await run(editor.history_restore, b.path, b.id)

    @get("/audit")
    async def edit_audit(limit: int = 100):
        return await read(editor.audit_recent, limit)

    @app.post(EDIT_PREFIX + "/upload")
    async def edit_upload(request: Request):
        parser = _LimitedMultiPart(request.headers, request.stream(), max_files=MAX_UPLOAD_FILES,
                                   max_fields=20, file_limit=editor.s.upload_max_bytes)
        try:
            form = await parser.parse()
        except _UploadTooLarge:
            return err(EditError(413, f"file larger than {editor.s.upload_max_bytes} bytes"))
        except MultiPartException as e:
            return err(EditError(400, e.message))
        try:
            files = [(f.filename or "", f.file) for k, f in form.multi_items()
                     if k in ("files", "files[]") and not isinstance(f, str)]
            fields = {k: v for k, v in form.multi_items() if isinstance(v, str)}
            return await run(editor.upload, fields.get("dir", ""), files,
                             _truthy(fields.get("overwrite")), _truthy(fields.get("create_dir")))
        finally:
            await form.close()
