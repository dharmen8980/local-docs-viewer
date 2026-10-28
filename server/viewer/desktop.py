"""Desktop mode (`--desktop`): the server runs as a child of the Electron shell.

- The folder dialog and PDF export go through the shell's loopback "bridge" (POST JSON,
  `Authorization: Bearer <token>`, Host 127.0.0.1:<bridge port>): no osascript/zenity, no
  Playwright / system Chrome (playwright is never imported in this mode).
- Once uvicorn accepts connections, one line `LDV_READY http://127.0.0.1:<port>/` goes to stdout.
- The shell keeps our stdin open; EOF (it quit or died) -> graceful uvicorn shutdown, hard
  os._exit after HARD_EXIT_S.
Stdlib only (asyncio streams): no new runtime dependencies."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import sys
import threading
from urllib.parse import urlsplit

from .pdf import (
    MARGINS_MM,
    NAV_TIMEOUT_MS,
    READY_TIMEOUT_MS,
    TITLE_SPAN,
    PdfError,
    PdfJob,
    pdf_templates,
    print_url,
)
from .roots import PICK_PROMPT, PICK_TIMEOUT, Picker, PickerError

log = logging.getLogger("viewer.desktop")

READY_PREFIX = "LDV_READY"
HARD_EXIT_S = 3.0
GRACEFUL_S = 2  # uvicorn timeout_graceful_shutdown in desktop mode (< HARD_EXIT_S)
REQUEST_MAX = 1024 * 1024  # the bridge refuses bigger bodies
RESPONSE_MAX = 512 * 1024 * 1024  # base64 PDF
PDF_SLACK_S = 60.0  # bridge round trip on top of nav + ready timeouts (printToPDF itself)
PDF_STATUSES = {500, 502, 503, 504}


class BridgeError(Exception):
    def __init__(self, detail: str, status: int | None = None):
        super().__init__(detail)
        self.detail = detail
        self.status = status  # HTTP status from the bridge, None: no answer


def check_bridge(url: str, token: str) -> str | None:
    """Why the bridge env is unusable, or None."""
    if not url or not token:
        return "--desktop needs DOCS_VIEWER_BRIDGE_URL and DOCS_VIEWER_BRIDGE_TOKEN (set by the desktop app)"
    try:
        u = urlsplit(url)
        port = u.port
    except ValueError:
        return f"DOCS_VIEWER_BRIDGE_URL is not a valid URL: {url[:100]!r}"
    if u.scheme != "http" or u.hostname != "127.0.0.1" or not port or u.path not in ("", "/") \
            or u.query or u.fragment or u.username or u.password:
        return f"DOCS_VIEWER_BRIDGE_URL must be http://127.0.0.1:<port>, got {url[:100]!r}"
    if len(token) < 16 or not all(33 <= ord(c) < 127 for c in token):
        return "DOCS_VIEWER_BRIDGE_TOKEN must be at least 16 printable ASCII characters"
    return None


class BridgeClient:
    """Minimal HTTP/1.1 client for the bridge: one POST per connection (Connection: close)."""

    def __init__(self, url: str, token: str):
        err = check_bridge(url, token)
        if err:
            raise ValueError(err)
        u = urlsplit(url)
        self.port: int = u.port  # type: ignore[assignment]
        self._token = token

    def __repr__(self) -> str:  # never show the token
        return f"BridgeClient(http://127.0.0.1:{self.port})"

    async def post(self, path: str, payload: dict, *, timeout: float) -> tuple[int, dict]:
        """-> (status, JSON object). TimeoutError past `timeout`; BridgeError if unreachable / garbled."""
        return await asyncio.wait_for(self._post(path, payload), timeout)

    async def _post(self, path: str, payload: dict) -> tuple[int, dict]:
        body = json.dumps(payload, ensure_ascii=False).encode()
        if len(body) > REQUEST_MAX:
            raise BridgeError("bridge request too large")
        head = (f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                f"Authorization: Bearer {self._token}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(body)}\r\nAccept: application/json\r\nConnection: close\r\n\r\n")
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", self.port, limit=64 * 1024)
        except OSError as e:
            raise BridgeError(f"desktop bridge unreachable: {e.strerror or e}") from e
        try:
            writer.write(head.encode("latin-1") + body)
            await writer.drain()
            status, data = await _read_response(reader)
        except (OSError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ValueError) as e:
            raise BridgeError(f"bad answer from the desktop bridge: {type(e).__name__}") from e
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (OSError, asyncio.CancelledError):
                pass
        try:
            obj = json.loads(data) if data else {}
        except ValueError:
            obj = None
        if not isinstance(obj, dict):
            raise BridgeError(f"desktop bridge answered HTTP {status} without a JSON object", status)
        return status, obj


async def _read_response(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    line = await reader.readline()
    parts = line.decode("latin-1").split(None, 2)
    if len(parts) < 2 or not parts[0].startswith("HTTP/1.") or not parts[1].isdigit():
        raise ValueError("bad status line")
    status = int(parts[1])
    headers: dict[str, str] = {}
    while True:
        h = await reader.readline()
        if h in (b"\r\n", b"\n"):
            break
        if not h:
            raise ValueError("truncated headers")
        k, _, v = h.decode("latin-1").partition(":")
        headers[k.strip().lower()] = v.strip()
    if "chunked" in headers.get("transfer-encoding", "").lower():
        out = bytearray()
        while True:
            size = int((await reader.readline()).split(b";", 1)[0].strip() or b"x", 16)
            if size == 0:
                break
            if len(out) + size > RESPONSE_MAX:
                raise ValueError("response too large")
            out += await reader.readexactly(size)
            await reader.readexactly(2)  # CRLF
        return status, bytes(out)
    if "content-length" in headers:
        n = int(headers["content-length"])
        if not 0 <= n <= RESPONSE_MAX:
            raise ValueError("response too large")
        return status, await reader.readexactly(n)
    out = bytearray()  # Connection: close, body until EOF
    while chunk := await reader.read(1 << 16):
        out += chunk
        if len(out) > RESPONSE_MAX:
            raise ValueError("response too large")
    return status, bytes(out)


def _detail(obj: dict, status: int) -> str:
    err = obj.get("error")
    d = obj.get("detail") or (err.get("detail") if isinstance(err, dict) else err)
    return str(d)[:300] if d else f"HTTP {status}"


def bridge_picker(client: BridgeClient, *, prompt: str = PICK_PROMPT, timeout: float = PICK_TIMEOUT) -> Picker:
    """A RootSwitcher picker backed by the shell's native folder dialog (a sheet on its window)."""

    async def pick() -> str | None:
        try:
            status, obj = await client.post("/pick", {"prompt": prompt}, timeout=timeout)
        except TimeoutError:
            return None  # treated as a cancel, like the osascript/zenity dialogs
        except BridgeError as e:
            raise PickerError(f"folder dialog failed: {e.detail}") from e
        if status == 409:
            raise PickerError("a folder dialog is already open", 409)
        if status == 401:
            raise PickerError("folder dialog failed: the desktop bridge refused our token")
        if status != 200:
            raise PickerError(f"folder dialog failed: {_detail(obj, status)}")
        path = obj.get("path")
        if path is None or path == "":
            return None
        if not isinstance(path, str) or not os.path.isabs(path) or "\0" in path:
            raise PickerError("folder dialog failed: the desktop bridge returned an invalid path")
        return path

    return pick


class BridgePdfRenderer:
    """PdfRenderer's interface (render/close), rendered by the shell's own Chromium (printToPDF in a
    locked-down hidden window that only reaches this viewer's origin). Jobs are serialised."""

    def __init__(self, port: int, client: BridgeClient):
        self.origin = f"http://127.0.0.1:{port}"
        self.client = client
        self._lock = asyncio.Lock()

    def print_url(self, job: PdfJob) -> str:
        return print_url(self.origin, job)

    def payload(self, job: PdfJob) -> dict:
        # the page title is only known after the page ran: Chrome fills the title span from document.title
        header, footer = pdf_templates(job, title_html=TITLE_SPAN)
        return {"url": self.print_url(job), "paper": job.paper, "orientation": job.orientation,
                "header_template": header, "footer_template": footer, "margins_mm": dict(MARGINS_MM),
                "ready_timeout_ms": READY_TIMEOUT_MS, "nav_timeout_ms": NAV_TIMEOUT_MS}

    async def close(self) -> None:  # nothing held between renders
        return None

    async def render(self, job: PdfJob) -> tuple[bytes, dict]:
        async with self._lock:
            timeout = (READY_TIMEOUT_MS + NAV_TIMEOUT_MS) / 1000 + PDF_SLACK_S
            try:
                status, obj = await self.client.post("/pdf", self.payload(job), timeout=timeout)
            except TimeoutError:
                raise PdfError(504, "timed out waiting for the desktop app to render the PDF")
            except BridgeError as e:
                raise PdfError(503, f"PDF export unavailable: {e.detail}")
            if status != 200:
                why = "refused our token" if status == 401 else _detail(obj, status)
                raise PdfError(503 if status in (401, 404, 405) else 500,
                               f"PDF export failed: desktop bridge HTTP {status}: {why}")
            err = obj.get("error")
            if err is not None:
                err = err if isinstance(err, dict) else {}
                st = err.get("status")
                st = st if isinstance(st, int) and st in PDF_STATUSES else 500
                raise PdfError(st, str(err.get("detail") or "PDF export failed")[:500])
            try:
                data = base64.b64decode(obj.get("pdf_base64") or "", validate=True)
            except (binascii.Error, TypeError, ValueError):
                data = b""
            if not data.startswith(b"%PDF-"):
                raise PdfError(500, "PDF export failed: the desktop app returned no PDF")
            errors = obj.get("errors")
            errors = dict(errors) if isinstance(errors, dict) else {}
            if errors.get("fatal"):
                raise PdfError(502, f"print page could not render the document: {errors['fatal']}")
            if errors.get("orientation") not in ("portrait", "landscape"):
                errors["orientation"] = "landscape" if job.orientation == "landscape" else "portrait"
            return data, errors


# -- process lifecycle ---------------------------------------------------------------------------

def ready_line(port: int) -> str:
    return f"{READY_PREFIX} http://127.0.0.1:{port}/"


def bound_port(server, fallback: int) -> int:
    for srv in getattr(server, "servers", None) or []:
        for sock in getattr(srv, "sockets", None) or []:
            try:
                return int(sock.getsockname()[1])
            except (OSError, IndexError, TypeError, ValueError):
                pass
    return fallback


def make_server(config, port: int):
    """uvicorn.Server that prints the ready line once its sockets listen (startup complete)."""
    import uvicorn

    class DesktopServer(uvicorn.Server):
        async def startup(self, sockets=None) -> None:
            await super().startup(sockets=sockets)
            if self.started and not self.should_exit:
                print(ready_line(bound_port(self, port)), flush=True)

    return DesktopServer(config)


def _stdin_eof(stream) -> None:
    try:
        while stream.read(65536):
            pass
    except (OSError, ValueError):
        pass


def start_stdin_watchdog(server, *, stream=None, hard_exit_s: float = HARD_EXIT_S) -> threading.Thread:
    """Daemon thread: stdin EOF -> server.should_exit (graceful), then os._exit(0) after hard_exit_s."""
    stream = stream if stream is not None else getattr(sys.stdin, "buffer", sys.stdin)

    def run() -> None:
        _stdin_eof(stream)
        server.should_exit = True  # before any I/O: stderr may be a broken pipe once the shell died
        t = threading.Timer(hard_exit_s, os._exit, (0,))
        t.daemon = True
        t.start()
        try:
            print("[viewer] stdin closed (desktop app gone): shutting down", file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass

    th = threading.Thread(target=run, name="stdin-watchdog", daemon=True)
    th.start()
    return th
