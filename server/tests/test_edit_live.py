"""Edits are reflected immediately in the tree, the search index and SSE (once, renames as renames),
and the recovery store is never exposed by read endpoints."""

import json
import socket
import threading
import time

import httpx
import uvicorn

from conftest import editing, wait_until, write
from viewer.app import create_app
from viewer.config import Settings


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_live_updates_once(root, data_dir):
    write(root / "doc.md", "zqalpha\n")
    write(root / "folder" / "inner.md", "zqinner\n")
    port = _free_port()
    app = create_app(Settings.make(str(root), port=port, reconcile_interval=1, ui_dir=str(root) + "-no-ui",
                                   allow_edit=True, data_dir=str(data_dir)))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                           timeout_graceful_shutdown=2))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    events: list[dict] = []
    stop = threading.Event()
    try:
        wait_until(lambda: server.started, timeout=10)
        base = f"http://127.0.0.1:{port}"
        connected = threading.Event()

        def listen():
            try:
                _listen()
            except httpx.HTTPError:
                pass  # server shutting down

        def _listen():
            with httpx.Client(timeout=30) as client, client.stream("GET", base + "/api/events") as r:
                connected.set()
                ev = None
                for line in r.iter_lines():
                    if stop.is_set():
                        return
                    if line.startswith("event:"):
                        ev = line.split(":", 1)[1].strip()
                    elif line.startswith("data:") and ev == "change":
                        events.append(json.loads(line.split(":", 1)[1]))

        lt = threading.Thread(target=listen, daemon=True)
        lt.start()
        assert connected.wait(10)
        c = httpx.Client(base_url=base, timeout=10)
        wait_until(lambda: not c.get("/api/search?q=x").json()["indexing"])
        time.sleep(0.6)  # watcher running
        tok = c.get("/api/config").json()["edit_token"]
        c.headers["X-Edit-Token"] = tok

        def tree():
            t = c.get("/api/tree").json()
            return {f["path"]: f for f in t["files"]}, set(t["dirs"])

        def hits(q):
            return [h["path"] for h in c.get("/api/search", params={"q": q}).json()["content"]]

        base_sha = c.get("/api/content?path=doc.md").json()["sha256"]
        r = c.put("/api/edit/file", json={"path": "doc.md", "content": "zqbeta here\n", "base_sha256": base_sha})
        assert r.status_code == 200, r.text
        # no waiting: the store and index are updated before the response
        assert tree()[0]["doc.md"]["size"] == len("zqbeta here\n")
        assert hits("zqbeta") == ["doc.md"] and hits("zqalpha") == []

        r = c.post("/api/edit/move", json={"from": "doc.md", "to": "folder/moved.md"})
        assert r.status_code == 200
        files, _ = tree()
        assert "folder/moved.md" in files and "doc.md" not in files
        assert hits("zqbeta") == ["folder/moved.md"]

        r = c.post("/api/edit/move", json={"from": "folder", "to": "folder2"})
        assert r.status_code == 200
        files, dirs = tree()
        assert {"folder2/moved.md", "folder2/inner.md"} <= set(files) and "folder" not in dirs
        assert hits("zqinner") == ["folder2/inner.md"]

        r = c.post("/api/edit/delete", json={"path": "folder2/inner.md"})
        assert r.status_code == 200
        assert "folder2/inner.md" not in tree()[0] and hits("zqinner") == []

        r = c.post("/api/edit/upload", data={"dir": "folder2"},
                   files={"files": ("up.md", b"zqupload\n", "text/markdown")})
        assert r.status_code == 200
        assert "folder2/up.md" in tree()[0] and hits("zqupload") == ["folder2/up.md"]

        r = c.post("/api/edit/mkdir", json={"path": "empty"})
        assert r.status_code == 200 and "empty" in tree()[1]

        # let the watcher and two reconcile passes see the same changes
        time.sleep(3)
        def count(pred):
            return sum(1 for e in events if pred(e))

        assert count(lambda e: "doc.md" in e["modified"]) == 1, events
        assert count(lambda e: {"from": "doc.md", "to": "folder/moved.md"} in e["renames"]) == 1, events
        assert count(lambda e: {"from": "folder/inner.md", "to": "folder2/inner.md"} in e["renames"]) == 1
        assert count(lambda e: {"from": "folder/moved.md", "to": "folder2/moved.md"} in e["renames"]) == 1
        assert count(lambda e: "folder2/inner.md" in e["deleted"]) == 1
        assert count(lambda e: "folder2/up.md" in e["added"]) == 1
        all_added = [p for e in events for p in e["added"]]
        all_deleted = [p for e in events for p in e["deleted"]]
        assert all_added == ["folder2/up.md"], events
        assert all_deleted == ["folder2/inner.md"], events
        assert len(events) == 6, events
        assert not any(".ldv-tmp" in json.dumps(e) for e in events)
        c.close()
    finally:
        stop.set()
        server.should_exit = True
        th.join(10)
    assert not th.is_alive()


def test_read_endpoints_never_expose_data_dir(tmp_path, root):
    data_dir = tmp_path / "data"
    write(root / "doc.md", "zqoriginalword\n")
    with editing(root, data_dir) as c:
        base = c.get("/api/content?path=doc.md").json()["sha256"]
        assert c.put("/api/edit/file", json={"path": "doc.md", "content": "new\n", "base_sha256": base}).status_code == 200
        c.post("/api/edit/mkdir", json={"path": "d"})
        write(root / "d" / "gone.md", "zqtrashedword\n")
        c.post("/api/edit/delete", json={"path": "d"})
        # data dir is a sibling of the root: every read endpoint refuses it
        for url in ("/api/file", "/api/content", "/api/raw", "/api/text"):
            for p in ("../data/audit.jsonl", "../data/history", "..%2Fdata%2Faudit.jsonl"):
                assert c.get(f"{url}?path={p}").status_code == 403, (url, p)
        t = c.get("/api/tree").json()
        assert [f["path"] for f in t["files"]] == ["doc.md"]
        assert c.get("/api/search?q=zqoriginalword").json()["content"] == []
        assert c.get("/api/search?q=zqtrashedword").json()["content"] == []
        assert c.get("/api/search?q=audit").json()["names"] == []
