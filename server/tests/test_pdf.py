"""PDF export: /api/pdf path rules, the request-blocking route guard and an end-to-end
render through the system Google Chrome (skipped when Chrome or the UI build is missing)."""

import asyncio
import contextlib
import os
import re
import socket
import struct
import threading
import time
import zlib

import httpx
import pytest
import uvicorn

from conftest import running, write
from viewer.app import create_app
from viewer.config import DEFAULT_UI_DIR, Settings
from viewer.pdf import PdfRenderer, find_chrome, make_route_guard, make_ws_guard, same_origin, sweep_stale_profiles


@pytest.fixture
def tree(root):
    write(root / "doc.md", "# Title\n\nhello\n")
    write(root / "flow.mmd", "graph TD\n  A-->B\n")
    write(root / "script.py", "print(1)\n")
    write(root / "notes.txt", "x\n")
    write(root / "secret.md", "# no\n")
    write(root / ".env", "A=1\n")
    write(root / "private" / "api_token.md", "# no\n")
    write(root / "sub" / "ok.md", "# ok\n")
    return root


def test_pdf_refuses_traversal_and_denied(tree):
    with running(tree) as c:
        # raw query strings, so the encoded forms reach the server as written
        for q in ("../doc.md", "sub/../../doc.md", "/etc/passwd", "%2e%2e/doc.md", "sub/..%2f..%2fdoc.md",
                  "%2Fetc%2Fpasswd"):
            r = c.get(f"/api/pdf?path={q}")
            assert r.status_code == 403, (q, r.status_code, r.text)
        for p in ("secret.md", ".env", "private/api_token.md", "SECRET.md"):
            r = c.get("/api/pdf", params={"path": p})
            assert r.status_code == 403, (p, r.status_code)
        assert c.get("/api/pdf", params={"path": "missing.md"}).status_code == 404
        assert c.get("/api/pdf").status_code == 400
        assert c.get("/api/pdf", params={"path": "sub"}).status_code == 400  # a folder


def test_pdf_only_markdown_and_mermaid(tree):
    with running(tree) as c:
        for p in ("script.py", "notes.txt"):
            r = c.get("/api/pdf", params={"path": p})
            assert r.status_code == 400 and "markdown" in r.json()["detail"]
        for bad in ({"paper": "a3"}, {"orientation": "sideways"}, {"toc": "maybe"}):
            r = c.get("/api/pdf", params={"path": "doc.md", **bad})
            assert r.status_code == 400
        # valid request, but this test app has no UI build -> clear 503, no browser started
        r = c.get("/api/pdf", params={"path": "doc.md"})
        assert r.status_code == 503 and "npm run build" in r.json()["detail"]
        assert c.post("/api/pdf", params={"path": "doc.md"}).status_code == 405


def test_pdf_refuses_cross_site_requests(tree):
    with running(tree) as c:
        # a hostile web page triggering renders, e.g. <img src=http://127.0.0.1:8765/api/pdf?...>
        for h in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                  {"Origin": "https://evil.example"}, {"Origin": "null"},
                  {"Origin": "http://127.0.0.1.evil.example:8765"},
                  {"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors",
                   "Sec-Fetch-Dest": "image"}):
            r = c.get("/api/pdf", params={"path": "doc.md"}, headers=h)
            assert r.status_code == 403 and "cross-site" in r.json()["detail"], (h, r.status_code)
        # the viewer itself, the next dev proxy and a typed URL pass the check (then hit the
        # missing UI build in this test app)
        for h in ({}, {"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Site": "none"},
                  {"Origin": "http://127.0.0.1:8765", "Sec-Fetch-Site": "same-origin"},
                  {"Origin": "http://localhost:3000"}):
            r = c.get("/api/pdf", params={"path": "doc.md"}, headers=h)
            assert r.status_code == 503, (h, r.status_code, r.text)


def test_pdf_head_and_auto_orientation(tree):
    with running(tree) as c:
        r = c.head("/api/pdf", params={"path": "doc.md"})
        assert r.status_code == 405 and r.headers["allow"] == "GET"
        for o in ("auto", "AUTO", "portrait", "landscape"):
            r = c.get("/api/pdf", params={"path": "flow.mmd", "orientation": o})
            assert r.status_code == 503, (o, r.status_code)  # valid; no UI build here


def test_same_origin():
    o = "http://127.0.0.1:8790"
    assert same_origin("http://127.0.0.1:8790/print?p=x", o)
    assert same_origin("http://127.0.0.1:8790/_next/static/a.js", o)
    assert not same_origin("http://127.0.0.1:8791/", o)
    assert not same_origin("https://127.0.0.1:8790/", o)
    assert not same_origin("http://localhost:8790/", o)
    assert not same_origin("http://127.0.0.1.evil.com:8790/", o)
    assert not same_origin("http://evil.com/?http://127.0.0.1:8790", o)
    assert not same_origin("http://user@evil.com:8790/", o)


class FakeRequest:
    def __init__(self, url):
        self.url = url


class FakeRoute:
    def __init__(self, url):
        self.request = FakeRequest(url)
        self.result = None

    async def continue_(self):
        self.result = "continue"

    async def abort(self, code="failed"):
        self.result = f"abort:{code}"


def test_route_guard_aborts_external_requests():
    blocked = []
    handler = make_route_guard("http://127.0.0.1:8790", blocked)

    async def run(url):
        route = FakeRoute(url)
        await handler(route, route.request)
        return route.result

    async def main():
        own = ["http://127.0.0.1:8790/print?p=a.md", "http://127.0.0.1:8790/api/raw?path=x.png"]
        ext = ["https://cdn.jsdelivr.net/npm/aws-icons/x.svg", "http://fonts.googleapis.com/css",
               "http://127.0.0.1:9999/api/raw", "http://localhost:8790/", "ws://127.0.0.1:8790/",
               "https://127.0.0.1:8790/", "http://169.254.169.254/latest/meta-data"]
        for u in own:
            assert await run(u) == "continue", u
        for u in ext:
            assert (await run(u)).startswith("abort"), u
        assert blocked == ext

    asyncio.run(main())


class FakeWsRoute:
    def __init__(self, url):
        self.url = url
        self.result = None

    def connect_to_server(self):
        self.result = "connect"

    async def close(self, code=None, reason=None):
        self.result = f"close:{code}"


def test_ws_guard_closes_websockets():
    blocked = []
    handler = make_ws_guard("http://127.0.0.1:8790", blocked)

    async def main():
        ext = ["ws://127.0.0.1:8793/ws", "ws://localhost:8790/", "wss://echo.websocket.org/",
               "ws://1.1.1.1/", "wss://127.0.0.1:8790/"]
        for u in ext:
            ws = FakeWsRoute(u)
            await handler(ws)
            assert ws.result == "close:1008", u
        assert blocked == ext
        ws = FakeWsRoute("ws://127.0.0.1:8790/x")
        await handler(ws)
        assert ws.result == "connect"

    asyncio.run(main())


def test_idle_closer_closes_at_the_idle_deadline():
    """Reuse during the idle sleep must not push the close a whole extra period out."""

    async def main():
        r = PdfRenderer(8790, idle_close_s=1.0)
        closed = []

        async def fake_shutdown():
            closed.append(time.monotonic())
            r._ctx = None

        r._shutdown = fake_shutdown
        r._ctx = object()
        start = time.monotonic()
        r._last_used = start
        task = asyncio.create_task(r._idle_closer())
        await asyncio.sleep(0.6)
        r._last_used = time.monotonic()  # used again at ~0.6 s: deadline ~1.6 s
        await asyncio.wait_for(task, timeout=5)
        assert closed, "idle Chrome was not closed"
        elapsed = closed[0] - start
        assert 1.5 <= elapsed < 1.95, elapsed  # the old loop closed at ~2.0 s

    asyncio.run(main())


def test_sweep_stale_profiles(tmp_path):
    old, fresh, busy, other = (tmp_path / n for n in ("ldv-chrome-old", "ldv-chrome-new", "ldv-chrome-busy",
                                                       "unrelated-old"))
    for d in (old, fresh, busy, other):
        d.mkdir()
        (d / "Preferences").write_text("{}")
    (busy / "SingletonLock").symlink_to(f"host-{os.getpid()}")  # a live process holds it
    dead = old / "SingletonLock"
    dead.symlink_to("host-999999999")  # stale lock from a dead Chrome
    past = time.time() - 3600
    for d in (old, busy, other):
        os.utime(d, (past, past))
    removed = sweep_stale_profiles(str(tmp_path), max_age_s=600)
    assert removed == [str(old)]
    assert not old.exists() and fresh.exists() and busy.exists() and other.exists()


# ---------- end to end (real server, real Chrome) ----------

def _png(w=40, h=30):
    raw = b"".join(b"\0" + bytes([200, 60, 60]) * w for _ in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _first_mediabox(data: bytes) -> tuple[float, float]:
    m = re.search(rb"/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]", data)
    assert m, "no MediaBox"
    x0, y0, x1, y1 = (float(v) for v in m.groups())
    return x1 - x0, y1 - y0


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def real_server(root):
    port = _free_port()
    settings = Settings.make(str(root), port=port, watch=False, reconcile_interval=0, ui_dir=DEFAULT_UI_DIR)
    app = create_app(settings)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                           lifespan="on"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    deadline = time.monotonic() + 15
    while not server.started:
        if time.monotonic() > deadline or not t.is_alive():
            raise RuntimeError("server did not start")
        time.sleep(0.05)
    try:
        yield app, f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        t.join(timeout=30)


needs_chrome = pytest.mark.skipif(
    find_chrome() is None or not os.path.isfile(os.path.join(DEFAULT_UI_DIR, "print.html")),
    reason="needs the system Google Chrome and a UI build (npm run build)")


@needs_chrome
def test_pdf_end_to_end(root):
    long_text = "\n\n".join(f"Paragraph {i}: " + "lorem ipsum dolor sit amet " * 12 for i in range(40))
    write(root / "img" / "pic.png", _png())
    write(root / "doc.md", "# PDF test\n\n## Diagram\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n\n"
                           "![a picture](img/pic.png)\n\n![remote](https://example.com/x.png)\n\n"
                           "```python\nprint('hi')\n```\n\n## Text\n\n" + long_text + "\n")
    write(root / "flow.mmd", "graph LR\n  A --> B --> C\n")
    write(root / "wide.mmd", "graph LR\n" + "".join(f"  N{i}[Stage {i}] --> N{i + 1}[Stage {i + 1}]\n"
                                                     for i in range(12)))
    with real_server(root) as (app, base):
        with httpx.Client(base_url=base, timeout=120) as c:
            r = c.get("/api/pdf", params={"path": "doc.md", "toc": "1"})
            assert r.status_code == 200, r.text
            assert r.headers["content-type"] == "application/pdf"
            assert r.headers["content-disposition"].startswith('attachment; filename="doc.pdf"')
            assert r.headers["x-pdf-mermaid-errors"] == "0"
            assert r.headers["x-pdf-image-errors"] == "0"
            data = r.content
            assert data.startswith(b"%PDF")
            pages = len(re.findall(rb"/Type\s*/Page\b(?!s)", data))
            assert pages > 1, pages

            r = c.get("/api/pdf", params={"path": "flow.mmd", "paper": "letter", "orientation": "landscape"})
            assert r.status_code == 200 and r.content.startswith(b"%PDF")

            # orientation=auto: a wide standalone diagram goes landscape, a markdown doc stays portrait
            r = c.get("/api/pdf", params={"path": "wide.mmd", "orientation": "auto"})
            assert r.status_code == 200 and r.content.startswith(b"%PDF")
            assert r.headers["x-pdf-orientation"] == "landscape"
            w, h = _first_mediabox(r.content)
            assert w > h, (w, h)
            r = c.get("/api/pdf", params={"path": "doc.md", "orientation": "auto"})
            assert r.status_code == 200 and r.headers["x-pdf-orientation"] == "portrait"
            w, h = _first_mediabox(r.content)
            assert h > w, (w, h)

            profile = app.state.pdf._profile
            assert profile and os.path.isdir(profile)
            # the external image was never requested
            assert not any("example.com" in u for u in app.state.pdf.blocked)
        # nothing was written inside the root
        assert sorted(p.name for p in root.rglob("*")) == ["doc.md", "flow.mmd", "img", "pic.png", "wide.mmd"]
    # lifespan shutdown closed Chrome and removed the temporary profile
    assert not os.path.exists(profile)
