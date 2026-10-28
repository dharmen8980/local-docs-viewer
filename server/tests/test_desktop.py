"""Desktop mode (--desktop): the bridge client/picker/PDF renderer against a fake Electron bridge,
the CLI ready line, exit on stdin EOF, and that playwright is never imported."""

import asyncio
import base64
import contextlib
import json
import os
import socket
import subprocess
import sys
import textwrap
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from conftest import write
from fastapi.testclient import TestClient

from viewer.app import create_app
from viewer.config import Settings, settings_from_args
from viewer.desktop import (
    BridgeClient,
    BridgePdfRenderer,
    bridge_picker,
    check_bridge,
    ready_line,
    start_stdin_watchdog,
)
from viewer.pdf import MARGINS_MM, NAV_TIMEOUT_MS, READY_TIMEOUT_MS, PdfError, PdfJob
from viewer.roots import PickerError, RootSwitcher

TOKEN = "t" * 43
FAKE_PDF = b"%PDF-1.7\n% fake\n%%EOF\n"


class FakeBridge:
    """Loopback HTTP server speaking the bridge contract; `answer(path, body) -> (status, obj)`."""

    def __init__(self, answer=None, token=TOKEN):
        self.token = token
        self.answer = answer or (lambda path, body: (200, {"path": None}))
        self.requests: list[dict] = []
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, obj):
                data = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._send(405, {"detail": "method"})

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                bridge.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
                if self.headers.get("Host") != f"127.0.0.1:{bridge.port}":
                    return self._send(401, {"detail": "host"})
                if self.headers.get("Authorization") != f"Bearer {bridge.token}":
                    return self._send(401, {"detail": "unauthorized"})
                status, obj = bridge.answer(self.path, body)
                self._send(status, obj)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._t = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()

    def client(self, token=TOKEN):
        return BridgeClient(self.url, token)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# -- bridge env / settings ----------------------------------------------------------------------

def test_check_bridge():
    assert check_bridge("http://127.0.0.1:5000", TOKEN) is None
    assert check_bridge("http://127.0.0.1:5000/", TOKEN) is None
    for bad in ("", "https://127.0.0.1:5000", "http://localhost:5000", "http://127.0.0.1", "http://10.0.0.1:5000",
                "http://127.0.0.1:5000/x", "http://u:p@127.0.0.1:5000", "http://127.0.0.1:99999", "not a url"):
        assert check_bridge(bad, TOKEN), bad
    assert check_bridge("http://127.0.0.1:5000", "")
    assert check_bridge("http://127.0.0.1:5000", "short")
    assert check_bridge("http://127.0.0.1:5000", "x" * 20 + "\r\nX-Evil: 1")
    with pytest.raises(ValueError):
        BridgeClient("http://example.com:80", TOKEN)
    assert TOKEN not in repr(BridgeClient("http://127.0.0.1:5000", TOKEN))


def test_settings_desktop_flag(tmp_path):
    env = {"DOCS_VIEWER_BRIDGE_URL": "http://127.0.0.1:5000", "DOCS_VIEWER_BRIDGE_TOKEN": TOKEN}
    s = settings_from_args(["--desktop", "--data-dir", str(tmp_path)], env=env)
    assert s.desktop and s.bridge_url == env["DOCS_VIEWER_BRIDGE_URL"] and s.bridge_token == TOKEN
    assert TOKEN not in repr(s)
    s = settings_from_args(["--data-dir", str(tmp_path)], env={**env, "DOCS_VIEWER_DESKTOP": "1"})
    assert s.desktop
    s = settings_from_args(["--data-dir", str(tmp_path)], env=env)  # not desktop: bridge env ignored
    assert not s.desktop and s.bridge_url == "" and s.bridge_token == ""


# -- picker --------------------------------------------------------------------------------------

def test_picker_success_and_cancel(tmp_path):
    answers = [(200, {"path": str(tmp_path)}), (200, {"path": None}), (200, {"path": "relative/x"})]
    with FakeBridge(lambda p, b: answers.pop(0)) as br:
        pick = bridge_picker(br.client())
        assert asyncio.run(pick()) == str(tmp_path)
        req = br.requests[0]
        assert req["path"] == "/pick" and req["body"] == {"prompt": "Choose a folder to view"}
        assert req["headers"]["Content-Type"] == "application/json"
        assert asyncio.run(pick()) is None
        with pytest.raises(PickerError):
            asyncio.run(pick())


def test_picker_409_auth_and_unreachable():
    with FakeBridge(lambda p, b: (409, {"detail": "busy"})) as br:
        with pytest.raises(PickerError) as ei:
            asyncio.run(bridge_picker(br.client())())
        assert ei.value.status == 409
        with pytest.raises(PickerError) as ei:
            asyncio.run(bridge_picker(br.client("w" * 43))())
        assert ei.value.status == 500 and "token" in str(ei.value)
    with pytest.raises(PickerError):  # nobody listening
        asyncio.run(bridge_picker(BridgeClient(f"http://127.0.0.1:{free_port()}", TOKEN))())


def test_picker_timeout_is_cancel():
    def slow(p, b):
        time.sleep(1.5)
        return 200, {"path": "/tmp"}

    with FakeBridge(slow) as br:
        t0 = time.monotonic()
        assert asyncio.run(bridge_picker(br.client(), timeout=0.3)()) is None
        assert time.monotonic() - t0 < 1.2


def test_roots_pick_through_bridge(tmp_path):
    a = tmp_path / "a"
    a.mkdir()
    with FakeBridge(lambda p, b: (409, {})) as br:
        s = Settings.make(None, data_dir=str(tmp_path / "data"), ui_dir=str(tmp_path / "no-ui"), watch=False,
                          reconcile_interval=0)
        sw = RootSwitcher(s, picker=bridge_picker(br.client()))
        with TestClient(sw, base_url="http://127.0.0.1") as c:
            tok = c.get("/api/config").json()["root_token"]
            h = {"Content-Type": "application/json", "X-Root-Token": tok}
            r = c.post("/api/roots/pick", content="{}", headers=h)
            assert r.status_code == 409  # the shell already shows a dialog
            br.answer = lambda p, b: (200, {"path": str(a)})
            r = c.post("/api/roots/pick", content="{}", headers=h)
            assert r.status_code == 200 and r.json()["current"] == sw.current
            assert os.path.samefile(sw.current, a)


# -- PDF -----------------------------------------------------------------------------------------

JOB = PdfJob(path="sub/my doc.md", display_path="repo/sub/my doc.md", title="my doc.md", paper="letter",
             orientation="auto", toc=True)


def ok_pdf(p, b, **errors):
    return 200, {"pdf_base64": base64.b64encode(FAKE_PDF).decode(), "title": "My Doc",
                 "errors": {"mermaid": 1, "images": 0, "orientation": "landscape", **errors}}


def test_pdf_success_and_payload():
    with FakeBridge(ok_pdf) as br:
        data, errors = asyncio.run(BridgePdfRenderer(4321, br.client()).render(JOB))
        assert data == FAKE_PDF and errors == {"mermaid": 1, "images": 0, "orientation": "landscape"}
        req = br.requests[0]
        assert req["path"] == "/pdf"
        b = req["body"]
        u = urlsplit(b["url"])
        assert (u.scheme, u.netloc, u.path) == ("http", "127.0.0.1:4321", "/print")
        assert parse_qs(u.query) == {"p": ["sub/my doc.md"], "paper": ["letter"], "orientation": ["auto"],
                                     "toc": ["1"]}
        assert b["paper"] == "letter" and b["orientation"] == "auto"
        assert b["margins_mm"] == MARGINS_MM == {"top": 18, "bottom": 16, "left": 16, "right": 16}
        assert b["ready_timeout_ms"] == READY_TIMEOUT_MS == 45000 and b["nav_timeout_ms"] == NAV_TIMEOUT_MS == 20000
        assert '<span class="title"></span>' in b["header_template"]
        assert "repo/sub/my doc.md" in b["footer_template"] and 'class="pageNumber"' in b["footer_template"]
        assert set(b) == {"url", "paper", "orientation", "header_template", "footer_template", "margins_mm",
                          "ready_timeout_ms", "nav_timeout_ms"}


def test_pdf_footer_escaped():
    with FakeBridge(ok_pdf) as br:
        job = PdfJob(path="a.md", display_path="<script>x</script>.md", title="<b>")
        asyncio.run(BridgePdfRenderer(1, br.client()).render(job))
        foot = br.requests[0]["body"]["footer_template"]
        assert "<script>" not in foot and "&lt;script&gt;" in foot


@pytest.mark.parametrize("answer,status,detail", [
    ((200, {"error": {"status": 504, "detail": "timed out loading the print page"}}), 504, "timed out loading"),
    ((200, {"error": {"status": 504, "detail": "document did not finish rendering within 45s"}}), 504, "45s"),
    ((200, {"error": {"status": 503, "detail": "print page unavailable (HTTP 404)"}}), 503, "HTTP 404"),
    ((200, {"error": {"status": 502, "detail": "print page could not render the document: boom"}}), 502, "boom"),
    ((200, {"error": {"status": 500, "detail": "PDF export failed: Error: x"}}), 500, "Error: x"),
    ((200, {"error": {"status": 418, "detail": "odd"}}), 500, "odd"),
    ((200, {"error": "garbage"}), 500, "PDF export failed"),
    ((200, {"pdf_base64": "not base64!!", "errors": {}}), 500, "no PDF"),
    ((200, {"pdf_base64": base64.b64encode(b"<html>").decode(), "errors": {}}), 500, "no PDF"),
    (ok_pdf(None, None, fatal="parse error"), 502, "parse error"),
    ((400, {"detail": "url must be same-origin"}), 500, "same-origin"),
    ((405, {}), 503, "HTTP 405"),
])
def test_pdf_error_mapping(answer, status, detail):
    with FakeBridge(lambda p, b: answer) as br:
        with pytest.raises(PdfError) as ei:
            asyncio.run(BridgePdfRenderer(1, br.client()).render(JOB))
        assert ei.value.status == status and detail in ei.value.detail, (ei.value.status, ei.value.detail)


def test_pdf_auth_and_unreachable():
    with FakeBridge(ok_pdf) as br:
        with pytest.raises(PdfError) as ei:
            asyncio.run(BridgePdfRenderer(1, br.client("w" * 43)).render(JOB))
        assert ei.value.status == 503 and "token" in ei.value.detail
    with pytest.raises(PdfError) as ei:
        asyncio.run(BridgePdfRenderer(1, BridgeClient(f"http://127.0.0.1:{free_port()}", TOKEN)).render(JOB))
    assert ei.value.status == 503


def test_pdf_missing_orientation_defaults():
    with FakeBridge(lambda p, b: (200, {"pdf_base64": base64.b64encode(FAKE_PDF).decode(), "title": ""})) as br:
        _, errors = asyncio.run(BridgePdfRenderer(1, br.client()).render(
            PdfJob(path="a.md", display_path="a.md", title="a", orientation="landscape")))
        assert errors == {"orientation": "landscape"}


def test_pdf_renders_serialised():
    active, peak = [0], [0]
    lock = threading.Lock()

    def answer(p, b):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.2)
        with lock:
            active[0] -= 1
        return ok_pdf(p, b)

    with FakeBridge(answer) as br:
        r = BridgePdfRenderer(1, br.client())

        async def go():
            await asyncio.gather(*(r.render(JOB) for _ in range(3)))

        asyncio.run(go())
    assert peak[0] == 1 and len(br.requests) == 3


def test_api_pdf_in_desktop_app(tmp_path, root):
    write(root / "doc.md", "# T\n")
    ui = tmp_path / "ui"
    write(ui / "print.html", "<html></html>")
    write(ui / "index.html", "<html></html>")
    with FakeBridge(ok_pdf) as br:
        s = Settings.make(str(root), ui_dir=str(ui), watch=False, reconcile_interval=0, desktop=True,
                          bridge_url=br.url, bridge_token=TOKEN, data_dir=str(tmp_path / "data"))
        app = create_app(s)
        assert isinstance(app.state.pdf, BridgePdfRenderer)
        with TestClient(app, base_url="http://127.0.0.1") as c:
            r = c.get("/api/pdf", params={"path": "doc.md"})
            assert r.status_code == 200 and r.content == FAKE_PDF
            assert r.headers["X-PDF-Orientation"] == "landscape" and r.headers["X-PDF-Mermaid-Errors"] == "1"
            br.answer = lambda p, b: (200, {"error": {"status": 504, "detail": "timed out loading the print page"}})
            r = c.get("/api/pdf", params={"path": "doc.md"})
            assert r.status_code == 504 and r.json()["detail"] == "timed out loading the print page"
        u = urlsplit(br.requests[0]["body"]["url"])
        assert u.netloc == f"127.0.0.1:{s.port}" and parse_qs(u.query)["p"] == ["doc.md"]


# -- process: ready line, stdin EOF, no playwright --------------------------------------------------

def _env(**extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith("DOCS_VIEWER_")}
    env.update(extra)
    return env


def test_desktop_without_bridge_env_exits(tmp_path):
    r = subprocess.run([sys.executable, "-m", "viewer", "--desktop", "--port", str(free_port()),
                        "--data-dir", str(tmp_path / "data")], env=_env(), capture_output=True, text=True,
                       timeout=30, stdin=subprocess.DEVNULL)
    assert r.returncode != 0 and "DOCS_VIEWER_BRIDGE_URL" in r.stderr and "LDV_READY" not in r.stdout
    r = subprocess.run([sys.executable, "-m", "viewer", "--port", str(free_port()), "--data-dir", str(tmp_path)],
                       env=_env(DOCS_VIEWER_DESKTOP="1", DOCS_VIEWER_BRIDGE_URL="http://evil.example:1",
                                DOCS_VIEWER_BRIDGE_TOKEN=TOKEN),
                       capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    assert r.returncode != 0 and "127.0.0.1" in r.stderr


def _read_line(stream, timeout):
    out: list = []
    t = threading.Thread(target=lambda: out.append(stream.readline()), daemon=True)
    t.start()
    t.join(timeout)
    return out[0] if out else None


def test_ready_line_pick_and_stdin_eof(tmp_path):
    folder = tmp_path / "docs"
    write(folder / "a.md", "# A\n")
    port = free_port()
    with FakeBridge(lambda p, b: (200, {"path": str(folder)})) as br:
        proc = subprocess.Popen(
            [sys.executable, "-m", "viewer", "--desktop", "--port", str(port), "--data-dir", str(tmp_path / "data"),
             "--ui-dir", str(tmp_path / "no-ui")],
            env=_env(DOCS_VIEWER_BRIDGE_URL=br.url, DOCS_VIEWER_BRIDGE_TOKEN=TOKEN),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            line = _read_line(proc.stdout, 30)
            assert line == ready_line(port) + "\n" == f"LDV_READY http://127.0.0.1:{port}/\n"
            base = f"http://127.0.0.1:{port}"
            cfg = httpx.get(f"{base}/api/config", timeout=5).json()  # accepting connections already
            assert cfg["no_root"] is True
            r = httpx.post(f"{base}/api/roots/pick", json={}, headers={"X-Root-Token": cfg["root_token"]}, timeout=10)
            assert r.status_code == 200 and not r.json()["cancelled"], r.text
            assert br.requests[-1]["path"] == "/pick"
            t0 = time.monotonic()
            proc.stdin.close()  # parent gone
            proc.wait(timeout=6)
            assert time.monotonic() - t0 < 5
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
    # the folder was remembered in the desktop data dir: the next launch reopens it
    st = json.loads((tmp_path / "data" / "state.json").read_text())
    assert os.path.samefile(st["last_root"], folder)


def test_stdin_watchdog_sets_should_exit():
    r, w = os.pipe()

    class S:
        should_exit = False

    s = S()
    with open(r, "rb") as rf:
        th = start_stdin_watchdog(s, stream=rf, hard_exit_s=3600)
        assert not s.should_exit
        os.close(w)
        th.join(5)
    assert s.should_exit


def test_desktop_never_imports_playwright(tmp_path, root):
    write(root / "doc.md", "# T\n")
    ui = tmp_path / "ui"
    write(ui / "print.html", "<html></html>")
    with FakeBridge(ok_pdf) as br:
        code = textwrap.dedent(f"""
            import sys
            import viewer.desktop, viewer.app, viewer.cli, viewer.roots, viewer.__main__
            from fastapi.testclient import TestClient
            from viewer.app import create_app
            from viewer.config import settings_from_args
            s = settings_from_args(["--desktop", "--root", {str(root)!r}, "--ui-dir", {str(ui)!r},
                                    "--data-dir", {str(tmp_path / "data")!r}])
            with TestClient(create_app(s), base_url="http://127.0.0.1") as c:
                r = c.get("/api/pdf", params={{"path": "doc.md"}})
                assert r.status_code == 200, r.text
            assert "playwright" not in sys.modules, [m for m in sys.modules if "playwright" in m]
            print("ok")
        """)
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60,
                           env=_env(DOCS_VIEWER_BRIDGE_URL=br.url, DOCS_VIEWER_BRIDGE_TOKEN=TOKEN))
    assert r.returncode == 0 and r.stdout.strip() == "ok", r.stderr[-2000:]
