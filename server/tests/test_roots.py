"""Runtime folder switching (RootSwitcher): startup resolution, no-folder mode, pick/switch/forget,
the /api/roots gate, --lock-root, edit mode per root, lifespan/SSE of replaced apps, concurrency."""

import asyncio
import contextlib
import json
import os
import socket
import stat
import threading
import time

import httpx
import pytest
import uvicorn
from conftest import wait_until, write
from fastapi.testclient import TestClient

from viewer import cli
from viewer.config import Settings, load_state, save_state, settings_from_args
from viewer.roots import RootSwitcher

ORIGIN = "http://127.0.0.1"


class FakePicker:
    """Async picker returning queued answers (None = cancel); never opens a dialog."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = 0
        self.gate: asyncio.Event | None = None

    async def __call__(self):
        self.calls += 1
        if self.gate is not None:
            while not self.gate.is_set():
                await asyncio.sleep(0.01)
        return self.answers.pop(0) if self.answers else None


@contextlib.contextmanager
def outer(root, data_dir, *, picker=None, ui_dir=None, **kw):
    kw.setdefault("watch", False)
    kw.setdefault("reconcile_interval", 0)
    s = Settings.make(str(root) if root is not None else None, data_dir=str(data_dir),
                      ui_dir=ui_dir or str(data_dir) + "-no-ui", **kw)
    sw = RootSwitcher(s, picker=picker)
    with TestClient(sw, base_url="http://127.0.0.1") as c:
        c.sw = sw
        cfg = c.get("/api/config").json()
        c.root_token = cfg.get("root_token")
        yield c


def post(c, path, body=None, token=True, **headers):
    h = {"Content-Type": "application/json", **headers}
    if token:
        h["X-Root-Token"] = c.root_token if token is True else token
    return c.post(path, content=json.dumps(body if body is not None else {}), headers=h)


def files(c):
    return {f["path"] for f in c.get("/api/tree").json()["files"]}


@pytest.fixture
def two(tmp_path):
    a, b = tmp_path / "alpha", tmp_path / "beta"
    write(a / "a.md", "zqalphaword\n")
    write(b / "b.md", "zqbetaword\n")
    return a, b


def canon(p):
    from viewer.config import canonical_path
    return canonical_path(str(p))


# -- startup resolution --------------------------------------------------------------------------

def test_resolution_order(tmp_path, two):
    a, b = two
    dd = tmp_path / "data"
    save_state(str(dd), {"last_root": canon(b), "recent": [canon(b)]})
    env = {"DOCS_VIEWER_DATA_DIR": str(dd)}
    s = settings_from_args(["--root", str(a)], env={**env, "DOCS_VIEWER_ROOT": str(b)})
    assert (s.root, s.root_source) == (canon(a), "cli")
    s = settings_from_args([], env={**env, "DOCS_VIEWER_ROOT": str(a)})
    assert (s.root, s.root_source) == (canon(a), "env")
    s = settings_from_args([], env=env)
    assert (s.root, s.root_source) == (canon(b), "state")
    os.rename(b, tmp_path / "gone")  # remembered folder no longer exists -> no root
    s = settings_from_args([], env=env)
    assert (s.root, s.root_source) == (None, "")
    assert settings_from_args(["--data-dir", str(tmp_path / "empty")], env={}).root is None
    assert settings_from_args(["--lock-root", "--root", str(a)], env={}).lock_root
    assert settings_from_args(["--root", str(a)], env={"DOCS_VIEWER_LOCK_ROOT": "1"}).lock_root
    assert not settings_from_args(["--root", str(a)], env={}).lock_root


def test_state_file_malformed_and_mode(tmp_path):
    dd = tmp_path / "data"
    dd.mkdir()
    (dd / "state.json").write_text("{not json")
    assert load_state(str(dd)) == {"last_root": None, "recent": []}
    (dd / "state.json").write_text(json.dumps({"last_root": "relative", "recent": ["/x", 3, "rel", "/x"]}))
    assert load_state(str(dd)) == {"last_root": None, "recent": ["/x"]}
    save_state(str(dd), {"last_root": "/x", "recent": [f"/r{i}" for i in range(15)]})
    assert stat.S_IMODE(os.stat(dd / "state.json").st_mode) == 0o600
    st = load_state(str(dd))
    assert st["last_root"] == "/x" and len(st["recent"]) == 10
    assert not [n for n in os.listdir(dd) if n != "state.json"]  # no temp files left behind


def test_cli_root_recorded_in_state(tmp_path, two):
    a, _ = two
    dd = tmp_path / "data"
    with outer(a, dd) as c:
        assert c.get("/api/roots").json()["current"] == canon(a)
    st = load_state(str(dd))
    assert st == {"last_root": canon(a), "recent": [canon(a)]}
    s = settings_from_args([], env={"DOCS_VIEWER_DATA_DIR": str(dd)})
    assert s.root == canon(a)


def test_cli_exits(tmp_path, monkeypatch):
    monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **k: pytest.fail("must not serve"))
    with pytest.raises(SystemExit, match="root folder not found"):
        cli.main(["--root", str(tmp_path / "missing"), "--data-dir", str(tmp_path / "d")])
    monkeypatch.delenv("DOCS_VIEWER_ROOT", raising=False)
    with pytest.raises(SystemExit, match="--lock-root needs a folder"):
        cli.main(["--lock-root", "--data-dir", str(tmp_path / "d")])
    served = {}
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, **k: served.setdefault("app", app))
    cli.main(["--data-dir", str(tmp_path / "d"), "--port", "9999"])  # no root: still starts
    assert isinstance(served["app"], RootSwitcher) and served["app"].base.root is None


# -- no-folder mode ------------------------------------------------------------------------------

def test_no_root_mode(tmp_path):
    ui = tmp_path / "ui"
    write(ui / "index.html", "<html>INDEX</html>")
    write(ui / "print.html", "<html>PRINT</html>")
    with outer(None, tmp_path / "data", ui_dir=str(ui)) as c:
        cfg = c.get("/api/config")
        assert cfg.headers["cache-control"] == "no-store"
        cfg = cfg.json()
        assert cfg["no_root"] is True and cfg["root_name"] is None and cfg["root_path"] is None
        assert cfg["repo_prefix"] == "" and cfg["edit_enabled"] is False and "version" in cfg
        assert cfg["root_switch_enabled"] is True and cfg["root_token"]
        for p in ("/api/tree", "/api/events", "/api/search?q=x", "/api/file?path=a"):
            r = c.get(p)
            assert r.status_code == 409 and r.json() == {"detail": "no folder selected"}, p
        assert post(c, "/api/edit/mkdir", {"path": "x"}).status_code == 409
        assert c.post("/api/tree").status_code == 405  # SecurityMiddleware still refuses
        r = c.get("/api/roots")
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        assert r.json() == {"current": None, "recent": [], "picker_available": False, "switch_enabled": True}
        assert "INDEX" in c.get("/").text and "PRINT" in c.get("/print").text
        h = c.get("/").headers
        assert "default-src 'self'" in h["content-security-policy"] and h["x-content-type-options"] == "nosniff"
        assert post(c, "/api/roots/pick").status_code == 501  # no picker on this machine
        assert c.get("/api/roots", headers={"Host": "evil.example"}).status_code == 400
        assert c.get("/api/config", headers={"X-Forwarded-Host": "evil.example"}).status_code == 400
        assert "root_token" not in c.get("/api/config", headers={"Sec-Fetch-Site": "cross-site"}).json()


# -- pick / switch / forget ----------------------------------------------------------------------

def test_pick_switch_forget(tmp_path, two):
    a, b = two
    pk = FakePicker(str(b), None)
    with outer(None, tmp_path / "data", picker=pk) as c:
        assert c.get("/api/roots").json()["picker_available"] is True
        r = post(c, "/api/roots/pick")
        assert r.status_code == 200 and r.json() == {"cancelled": False, "current": canon(b)}
        assert r.headers["cache-control"] == "no-store"
        assert files(c) == {"b.md"}
        cfg = c.get("/api/config").json()
        assert cfg["no_root"] is False and cfg["root_path"] == canon(b) and cfg["root_name"] == "beta"
        assert cfg["root_token"] == c.root_token  # the token belongs to the outer layer
        r = post(c, "/api/roots/pick")  # cancelled
        assert r.status_code == 200 and r.json() == {"cancelled": True}
        assert c.get("/api/roots").json()["current"] == canon(b)

    # restart: b is remembered; a is recent only via the CLI
    with outer(a, tmp_path / "data", picker=FakePicker()) as c:
        assert files(c) == {"a.md"}
        info = c.get("/api/roots").json()
        assert info["current"] == canon(a) and info["recent"] == [canon(a), canon(b)]
        r = post(c, "/api/roots/switch", {"path": canon(b)})
        assert r.status_code == 200 and r.json() == {"current": canon(b)}
        assert files(c) == {"b.md"}
        wait_until(lambda: c.get("/api/search?q=zqbetaword").json()["content"])
        assert not c.get("/api/search?q=zqalphaword").json()["content"]
        assert c.get("/api/roots").json()["recent"] == [canon(b), canon(a)]
        # arbitrary paths are refused, even existing ones
        for p in (str(tmp_path), "/", str(a) + "/../alpha", canon(a) + "/"):
            r = post(c, "/api/roots/switch", {"path": p})
            assert r.status_code == 403, p
        assert files(c) == {"b.md"}
        assert post(c, "/api/roots/switch", {}).status_code == 422
        # forget
        assert post(c, "/api/roots/forget", {"path": canon(b)}).status_code == 400  # current
        r = post(c, "/api/roots/forget", {"path": canon(a)})
        assert r.status_code == 200 and r.json()["recent"] == [canon(b)]
        assert post(c, "/api/roots/switch", {"path": canon(a)}).status_code == 403
    assert load_state(str(tmp_path / "data"))["recent"] == [canon(b)]


def test_missing_recent_dropped(tmp_path, two):
    a, b = two
    dd = tmp_path / "data"
    save_state(str(dd), {"last_root": None, "recent": [canon(b), str(tmp_path / "nope")]})
    with outer(a, dd) as c:
        assert c.get("/api/roots").json()["recent"] == [canon(a), canon(b)]
        b.rename(tmp_path / "beta2")
        assert c.get("/api/roots").json()["recent"] == [canon(a)]
        assert post(c, "/api/roots/switch", {"path": canon(b)}).status_code == 403
    assert load_state(str(dd))["recent"] == [canon(a)]


def test_picked_folder_that_vanished(tmp_path):
    with outer(None, tmp_path / "data", picker=FakePicker(str(tmp_path / "missing"))) as c:
        r = post(c, "/api/roots/pick")
        assert r.status_code == 400 and "not found" in r.json()["detail"]
        assert c.get("/api/roots").json()["current"] is None


def test_only_one_dialog_at_a_time(tmp_path, two):
    _, b = two
    pk = FakePicker(str(b))
    with outer(None, tmp_path / "data", picker=pk) as c:
        pk.gate = asyncio.Event()
        out = {}
        t = threading.Thread(target=lambda: out.setdefault("r", post(c, "/api/roots/pick")))
        t.start()
        wait_until(lambda: pk.calls == 1)
        r = post(c, "/api/roots/pick")
        assert r.status_code == 409 and "already open" in r.json()["detail"]
        pk.gate.set()
        t.join(10)
        assert out["r"].json() == {"cancelled": False, "current": canon(b)}


# -- the gate ------------------------------------------------------------------------------------

def test_gate(tmp_path, two):
    a, b = two
    save_state(str(tmp_path / "data"), {"last_root": None, "recent": [canon(b)]})
    with outer(a, tmp_path / "data", port=8765) as c:
        body = {"path": canon(b)}
        assert post(c, "/api/roots/switch", body, token=False).status_code == 403
        assert post(c, "/api/roots/switch", body, token="wrong").status_code == 403
        r = c.post("/api/roots/switch", content=json.dumps(body), headers=[
            ("Content-Type", "application/json"), ("X-Root-Token", c.root_token), ("X-Root-Token", c.root_token)])
        assert r.status_code == 403
        for h in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "none"},
                  {"Origin": "http://evil.example"}, {"Origin": "http://127.0.0.1:9999"}, {"Origin": "null"},
                  {"Content-Type": "text/plain"}, {"Content-Type": "application/x-www-form-urlencoded"}):
            r = post(c, "/api/roots/switch", body, **h)
            assert r.status_code == 403, h
            assert r.headers["content-security-policy"]
        assert post(c, "/api/roots/switch", body, Host="evil.example").status_code == 400
        assert post(c, "/api/roots/switch", body, **{"X-Forwarded-Host": "evil.example"}).status_code == 400
        h = {"Content-Type": "application/json", "X-Root-Token": c.root_token}
        assert c.put("/api/roots/switch", content="{}", headers=h).status_code == 405
        assert c.delete("/api/roots/forget", headers=h).status_code == 405
        r = c.post("/api/roots/switch", content=b"{" + b" " * 70000 + b"}", headers=h)
        assert r.status_code == 413
        assert files(c) == {"a.md"}  # nothing switched
        assert c.get("/api/roots").json()["current"] == canon(a)
        # allowed: same-origin, viewer and dev-server origins
        r = post(c, "/api/roots/switch", body, **{"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8765"})
        assert r.status_code == 200
        r = post(c, "/api/roots/switch", {"path": canon(a)}, Origin="http://localhost:3000")
        assert r.status_code == 200
        assert post(c, "/api/roots/nope").status_code == 404
        # inner-app /api/config: token only for same-site requests
        assert c.get("/api/config").json()["root_token"] == c.root_token
        assert "root_token" not in c.get("/api/config", headers={"Origin": "http://evil.example"}).json()


def test_lock_root(tmp_path, two):
    a, b = two
    save_state(str(tmp_path / "data"), {"last_root": None, "recent": [canon(b)]})
    with outer(a, tmp_path / "data", picker=FakePicker(str(b)), lock_root=True) as c:
        cfg = c.get("/api/config").json()
        assert cfg["root_switch_enabled"] is False
        assert c.get("/api/roots").json()["switch_enabled"] is False
        tok = c.sw.token
        for p, body in (("/api/roots/pick", {}), ("/api/roots/switch", {"path": canon(b)}),
                        ("/api/roots/forget", {"path": canon(b)})):
            r = post(c, p, body, token=tok)
            assert r.status_code == 403 and "disabled" in r.json()["detail"], p
        assert c.sw.picker.calls == 0
        assert files(c) == {"a.md"}


# -- edit mode -----------------------------------------------------------------------------------

def test_edit_mode_per_root(tmp_path, two):
    a, b = two
    dd = tmp_path / "data"
    inside = tmp_path / "holder"
    (inside / "data").mkdir(parents=True)
    with outer(a, dd, picker=FakePicker(str(b), str(tmp_path), str(inside / "data" / "x")), allow_edit=True) as c:
        cfg = c.get("/api/config").json()
        tok_a = cfg["edit_token"]
        r = c.post("/api/edit/mkdir", json={"path": "new"}, headers={"X-Edit-Token": tok_a})
        assert r.status_code == 200 and (a / "new").is_dir()
        store_a = c.sw.app.state.settings.store_dir
        assert post(c, "/api/roots/pick").status_code == 200
        cfg = c.get("/api/config").json()
        assert cfg["edit_enabled"] and cfg["root_path"] == canon(b) and cfg["edit_token"] != tok_a
        assert c.post("/api/edit/mkdir", json={"path": "n2"}, headers={"X-Edit-Token": tok_a}).status_code == 403
        r = c.post("/api/edit/delete", json={"path": "b.md"}, headers={"X-Edit-Token": cfg["edit_token"]})
        assert r.status_code == 200 and not (b / "b.md").exists()
        store_b = c.sw.app.state.settings.store_dir
        assert store_a != store_b and os.path.dirname(store_a) == os.path.dirname(store_b)
        assert os.listdir(os.path.join(store_b, "trash"))
        assert not os.path.isdir(os.path.join(store_a, "trash")) or not os.listdir(os.path.join(store_a, "trash"))
        # a root that contains the data dir is refused while editing; the current root stays
        r = post(c, "/api/roots/pick")
        assert r.status_code == 400 and "data dir" in r.json()["detail"]
        assert c.get("/api/config").json()["root_path"] == canon(b)
        assert canon(tmp_path) not in c.get("/api/roots").json()["recent"]
        r = post(c, "/api/roots/pick")  # missing folder
        assert r.status_code == 400


def test_data_dir_inside_root_read_only_not_persisted(tmp_path):
    root = tmp_path / "r"
    write(root / "x.md", "x")
    with outer(root, root / ".data") as c:
        assert c.get("/api/roots").json()["current"] == canon(root)
        assert {f["path"] for f in c.get("/api/tree").json()["files"]} == {"x.md"}
    assert not (root / ".data").exists()  # read-only never writes inside the root


# -- lifespan / SSE / concurrency ----------------------------------------------------------------

def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_switch_ends_old_sse_and_lifespan_real_server(tmp_path, two):
    a, b = two
    dd = tmp_path / "data"
    save_state(str(dd), {"last_root": None, "recent": [canon(b)]})
    port = _free_port()
    sw = RootSwitcher(Settings.make(str(a), port=port, data_dir=str(dd), ui_dir=str(dd) + "-no-ui",
                                    reconcile_interval=0.5, watch=False), picker=None)
    retired = []
    sw.on_retire = retired.append
    server = uvicorn.Server(uvicorn.Config(sw, host="127.0.0.1", port=port, log_level="warning",
                                           timeout_graceful_shutdown=2))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    base = f"http://127.0.0.1:{port}"
    try:
        wait_until(lambda: server.started, timeout=10)
        old_app = sw.app
        ended = threading.Event()
        connected = threading.Event()

        def listen():
            with httpx.Client(timeout=20) as client, client.stream("GET", f"{base}/api/events") as r:
                assert r.status_code == 200
                connected.set()
                for _ in r.iter_lines():
                    pass
            ended.set()

        lt = threading.Thread(target=listen, daemon=True)
        lt.start()
        assert connected.wait(10)
        tok = httpx.get(f"{base}/api/config").json()["root_token"]
        r = httpx.post(f"{base}/api/roots/switch", json={"path": canon(b)}, headers={"X-Root-Token": tok})
        assert r.status_code == 200
        assert ended.wait(10), "old SSE stream did not end"
        assert old_app.state.closing.is_set()
        assert sw.app is not old_app and retired[-1].app is old_app
        assert retired[-1]._task.done() and old_app.state.index._stopped.is_set()
        # the new app is live: reconcile picks up a new file, SSE works again
        assert {f["path"] for f in httpx.get(f"{base}/api/tree").json()["files"]} == {"b.md"}
        write(b / "late.md", "x")
        wait_until(lambda: "late.md" in {f["path"] for f in httpx.get(f"{base}/api/tree").json()["files"]})
        write(a / "ignored.md", "x")
        time.sleep(1.2)
        assert "ignored.md" not in {e.path for e in old_app.state.store.all_entries()}  # old loops stopped
    finally:
        server.should_exit = True
        th.join(10)
    assert not th.is_alive()
    assert sw.inner is None


def test_switches_are_serialised(tmp_path):
    roots = []
    for i in range(4):
        r = tmp_path / f"r{i}"
        write(r / f"f{i}.md", "x")
        roots.append(canon(r))
    s = Settings.make(roots[0], data_dir=str(tmp_path / "data"), ui_dir=str(tmp_path / "no-ui"),
                      watch=False, reconcile_interval=0)
    sw = RootSwitcher(s, picker=None)
    retired = []
    sw.on_retire = retired.append
    active = {"n": 0, "max": 0}
    orig = sw._start

    async def slow_start(settings):
        active["n"] += 1
        active["max"] = max(active["max"], active["n"])
        await asyncio.sleep(0.05)
        try:
            return await orig(settings)
        finally:
            active["n"] -= 1

    sw._start = slow_start

    async def main():
        await sw.startup()
        res = await asyncio.gather(*[sw.switch_to(p) for p in roots[1:]])
        assert res == roots[1:]
        assert active["max"] == 1
        assert sw.current == roots[-1]
        assert all(i._task.done() for i in retired) and len(retired) == 3
        assert not sw.inner._task.done()
        await sw.shutdown()
        assert sw.inner is None

    asyncio.run(main())
    assert load_state(str(tmp_path / "data"))["recent"] == list(reversed(roots))


def test_switched_away_index_stops_and_is_freed(tmp_path, two):
    from viewer.search import SearchIndex
    a, b = two
    with outer(a, tmp_path / "data") as c:
        c.sw._remember(canon(b))
        idx = c.sw.app.state.index
        wait_until(lambda: not idx.indexing)
        assert idx._rows
        assert post(c, "/api/roots/switch", {"path": canon(b)}).status_code == 200
        assert idx._stopped.is_set() and idx._rows == {}
        assert idx._db.execute("SELECT count(*) FROM docs").fetchone()[0] == 0
        assert not hasattr(c.sw, "retired")  # stopped apps are not kept by the switcher
    # a stopped index abandons its build instead of reading the whole old tree
    from viewer.paths import PathGuard
    from viewer.store import Store
    store = Store(PathGuard(Settings.make(str(a), data_dir=str(tmp_path / "data"))))
    store.full_scan()
    idx = SearchIndex(store, 1 << 20)
    idx.stop()
    idx.build()
    assert idx._rows == {} and not idx.indexing


def test_control_handlers_run_on_event_loop(tmp_path):
    import inspect

    with outer(None, tmp_path / "data") as c:
        eps = [r.endpoint for r in c.sw.control.routes if hasattr(r, "endpoint") and r.path.startswith("/api")]
        assert eps and all(inspect.iscoroutinefunction(e) for e in eps)  # sync ones would race on self.state


def test_remembered_root_refused_when_editing_falls_back(tmp_path, monkeypatch):
    dd = tmp_path / "data"
    inside = dd / "docs"
    write(inside / "x.md", "x")
    save_state(str(dd), {"last_root": canon(inside), "recent": [canon(inside)]})
    served = {}
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, **k: served.setdefault("app", app))
    monkeypatch.delenv("DOCS_VIEWER_ROOT", raising=False)
    cli.main(["--allow-edit", "--data-dir", str(dd)])
    assert served["app"].base.root is None  # no-folder mode instead of "refusing to start"
    with pytest.raises(SystemExit):  # an explicitly requested root still refuses
        cli.main(["--allow-edit", "--root", str(inside), "--data-dir", str(dd)])


def test_dialog_runner_parsing():
    from viewer.roots import PickerError, _run_dialog

    never = lambda rc, msg: False
    assert asyncio.run(_run_dialog(["sh", "-c", "printf '/a b /\\n'"], never)) == "/a b /"
    assert asyncio.run(_run_dialog(["sh", "-c", "echo 'User canceled. (-128)' >&2; exit 1"],
                                   lambda rc, msg: "-128" in msg)) is None
    with pytest.raises(PickerError, match="boom"):
        asyncio.run(_run_dialog(["sh", "-c", "echo boom >&2; exit 2"], never))
    with pytest.raises(PickerError):
        asyncio.run(_run_dialog(["/nonexistent-picker-binary"], never))
