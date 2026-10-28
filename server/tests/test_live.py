"""New/renamed files and folders show up without a restart; SSE delivers change events."""

import json
import os
import socket
import threading
import time

import httpx
import uvicorn

from conftest import running, wait_until, write
from viewer.app import create_app
from viewer.config import Settings


def tree_paths(c):
    t = c.get("/api/tree").json()
    return {f["path"] for f in t["files"]}, set(t["dirs"]), t["version"]


def test_watcher_picks_up_changes(root):
    write(root / "old.md", "zqoldword\n")
    write(root / "folder" / "inner.md", "zqinnerword\n")
    # reconcile disabled: the file-system watcher alone must do the work
    with running(root, watch=True, reconcile_interval=0) as c:
        files, dirs, v0 = tree_paths(c)
        assert files == {"old.md", "folder/inner.md"}
        time.sleep(0.3)  # let the watcher start

        write(root / "new.md", "zqfreshword appears here\n")
        wait_until(lambda: "new.md" in tree_paths(c)[0])
        wait_until(lambda: c.get("/api/search?q=zqfreshword").json()["content"])

        write(root / "brand" / "deep" / "file.txt", "zqdeepword\n")
        wait_until(lambda: "brand/deep/file.txt" in tree_paths(c)[0])
        assert {"brand", "brand/deep"} <= tree_paths(c)[1]
        wait_until(lambda: c.get("/api/search?q=zqdeepword").json()["content"])

        os.rename(root / "old.md", root / "renamed.md")
        wait_until(lambda: (lambda f: "renamed.md" in f and "old.md" not in f)(tree_paths(c)[0]))
        wait_until(lambda: [h["path"] for h in c.get("/api/search?q=zqoldword").json()["content"]] == ["renamed.md"])

        os.rename(root / "folder", root / "moved")
        wait_until(lambda: (lambda f: "moved/inner.md" in f and "folder/inner.md" not in f)(tree_paths(c)[0]))
        wait_until(lambda: "folder" not in tree_paths(c)[1] and "moved" in tree_paths(c)[1])

        os.remove(root / "new.md")
        wait_until(lambda: "new.md" not in tree_paths(c)[0])
        wait_until(lambda: not c.get("/api/search?q=zqfreshword").json()["content"])
        assert tree_paths(c)[2] > v0


def test_reconcile_catches_changes_without_watcher(root):
    write(root / "a.md", "x\n")
    with running(root, watch=False, reconcile_interval=0.5) as c:
        write(root / "late" / "b.md", "zqlateword\n")
        wait_until(lambda: "late/b.md" in tree_paths(c)[0], timeout=10)
        wait_until(lambda: c.get("/api/search?q=zqlateword").json()["content"], timeout=10)


def test_rename_inference(root):
    from viewer.paths import PathGuard
    from viewer.store import Store

    write(root / "d1" / "x.md", "same\n")
    write(root / "y.md", "other\n")
    store = Store(PathGuard(Settings.make(str(root))))
    store.full_scan()
    os.rename(root / "d1", root / "d2")
    os.rename(root / "y.md", root / "d2" / "y.md")
    ch = store.apply_scopes(["d1", "d2", "y.md"])
    assert sorted((r["from"], r["to"]) for r in ch.renames) == [("d1/x.md", "d2/x.md"), ("y.md", "d2/y.md")]
    assert ch.added == [] and ch.deleted == [] and ch.dirs_changed
    assert store.apply_scopes([""]) is None  # no further diff


def test_in_place_file_rename_inferred(root):
    from viewer.paths import PathGuard
    from viewer.store import Store

    write(root / "d" / "x.md", "same\n")
    store = Store(PathGuard(Settings.make(str(root))))
    store.full_scan()
    os.rename(root / "d" / "x.md", root / "d" / "renamed.md")
    ch = store.apply_scopes(["d/x.md", "d/renamed.md"])
    assert ch.renames == [{"from": "d/x.md", "to": "d/renamed.md"}]
    assert ch.added == [] and ch.deleted == []


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_sse_change_event_real_server(root):
    write(root / "seed.md", "seed\n")
    port = _free_port()
    app = create_app(Settings.make(str(root), reconcile_interval=2, ui_dir=str(root) + "-no-ui"))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                           timeout_graceful_shutdown=2))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    try:
        wait_until(lambda: server.started, timeout=10)
        got: list[dict] = []
        connected = threading.Event()

        def listen():
            with httpx.Client(timeout=20) as client:
                with client.stream("GET", f"http://127.0.0.1:{port}/api/events") as r:
                    assert r.status_code == 200
                    assert r.headers["content-type"].startswith("text/event-stream")
                    connected.set()
                    event = None
                    for line in r.iter_lines():
                        if line.startswith("event:"):
                            event = line.split(":", 1)[1].strip()
                        elif line.startswith("data:") and event == "change":
                            data = json.loads(line.split(":", 1)[1])
                            got.append(data)
                            if "brand_new.md" in data["added"]:
                                return

        lt = threading.Thread(target=listen, daemon=True)
        lt.start()
        assert connected.wait(10)
        time.sleep(0.5)
        write(root / "brand_new.md", "hi\n")
        lt.join(15)
        assert any("brand_new.md" in d["added"] for d in got), got
        ev = next(d for d in got if "brand_new.md" in d["added"])
        assert set(ev) == {"version", "added", "modified", "deleted", "renames", "dirs_changed"}
        assert ev["version"] >= 2
    finally:
        server.should_exit = True
        th.join(10)
    assert not th.is_alive()
