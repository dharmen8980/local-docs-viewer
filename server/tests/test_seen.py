"""Changes history (/api/seen*, viewer.seen): CRUD, limits and pruning, renames, namespacing by
root, the RootGate checks, path refusals, the data-dir overlap refusal, root switches, SSE."""

import hashlib
import json
import os
import socket
import sqlite3
import threading

import httpx
import pytest
import uvicorn
from conftest import snapshot_fs, wait_until, write
from test_roots import canon, outer, post

from viewer.config import Settings, save_state
from viewer.roots import RootSwitcher
from viewer.seen import SEEN_FILE, SeenDB


@pytest.fixture
def two(tmp_path):
    a, b = tmp_path / "alpha", tmp_path / "beta"
    write(a / "a.md", "alpha\n")
    write(a / "docs/x.md", "x\n")
    write(a / "docs/sub/y.md", "y\n")
    write(a / ".env", "SECRET=1\n")
    write(b / "b.md", "beta\n")
    return a, b


def seen_post(c, op, body, **kw):
    return post(c, f"/api/seen/{op}", {"root": c.root, **body}, **kw)


@pytest.fixture
def c(tmp_path, two):
    a, _ = two
    with outer(a, tmp_path / "data") as client:
        client.root = canon(a)
        yield client


def load(c, root=None):
    r = c.get("/api/seen", params={"root": root or c.root})
    assert r.status_code == 200, r.text
    return {x["path"]: x for x in r.json()["records"]}


def snap(c, path):
    r = c.get("/api/seen/snapshot", params={"root": c.root, "path": path})
    assert r.status_code == 200, r.text
    return r.json()["snapshot"]


# -- CRUD ----------------------------------------------------------------------------------------

def test_config_and_crud(c, tmp_path, two):
    a, _ = two
    before = snapshot_fs(a)
    cfg = c.get("/api/config").json()
    assert cfg["seen_enabled"] is True and cfg["root_path"] == c.root
    assert load(c) == {}
    r = seen_post(c, "commit", {"path": "a.md", "mtime": 1.5, "size": 6, "text": "alpha\n", "client": "t1"})
    assert r.status_code == 200, r.text
    rec = r.json()["record"]
    assert rec["path"] == "a.md" and rec["mtime"] == 1.5 and rec["size"] == 6 and rec["root"] == c.root
    assert rec["viewedAt"] > 0
    assert load(c)["a.md"]["mtime"] == 1.5
    s = snap(c, "a.md")
    assert s == {"path": "a.md", "mtime": 1.5, "size": 6, "viewedAt": rec["viewedAt"], "text": "alpha\n"}
    # text absent: snapshot left alone
    assert seen_post(c, "commit", {"path": "a.md", "mtime": 2, "size": 7}).status_code == 200
    assert load(c)["a.md"]["mtime"] == 2 and snap(c, "a.md")["text"] == "alpha\n"
    # text null: snapshot dropped
    assert seen_post(c, "commit", {"path": "a.md", "mtime": 3, "size": 7, "text": None}).status_code == 200
    assert snap(c, "a.md") is None and load(c)["a.md"]["mtime"] == 3
    # get
    r = seen_post(c, "get", {"paths": ["a.md", "docs/x.md", "../x", "a.md"]})
    assert [x["path"] for x in r.json()["records"]] == ["a.md"]
    # mark: records only, tree files only, snapshots kept
    seen_post(c, "commit", {"path": "docs/x.md", "mtime": 1, "size": 2, "text": "x\n"})
    r = seen_post(c, "mark", {"entries": [{"path": "docs/x.md", "mtime": 9, "size": 2},
                                          {"path": "gone.md", "mtime": 1, "size": 1},
                                          {"path": ".env", "mtime": 1, "size": 1}]})
    assert r.status_code == 200
    assert [x["path"] for x in r.json()["records"]] == ["docs/x.md"]
    assert load(c)["docs/x.md"]["mtime"] == 9 and snap(c, "docs/x.md")["text"] == "x\n"
    assert set(load(c)) == {"a.md", "docs/x.md"}
    # stored in the data dir, never in the root
    assert (tmp_path / "data" / SEEN_FILE).is_file()
    assert oct((tmp_path / "data" / SEEN_FILE).stat().st_mode & 0o777) == "0o600"
    assert snapshot_fs(a) == before


def test_commit_needs_a_visible_file(c):
    assert seen_post(c, "commit", {"path": "missing.md", "mtime": 1, "size": 1}).status_code == 404
    assert seen_post(c, "commit", {"path": "docs", "mtime": 1, "size": 1}).status_code == 400
    assert load(c) == {}


@pytest.mark.parametrize("bad", ["../alpha/a.md", "/etc/passwd", "a/../a.md", "./a.md", "docs//x.md",
                                 "docs/", ".env", "docs/.env.local", "my-secret.md", "a\\b", "", "a\0b",
                                 "node_modules/x.md"])
def test_path_refusals(c, bad):
    assert seen_post(c, "commit", {"path": bad, "mtime": 1, "size": 1, "text": "x"}).status_code in (400, 403)
    assert seen_post(c, "rename", {"from": "a.md", "to": bad}).status_code == 403
    assert seen_post(c, "rename", {"from": bad, "to": "a.md"}).status_code == 403
    r = c.get("/api/seen/snapshot", params={"root": c.root, "path": bad})
    assert r.status_code == 403
    assert seen_post(c, "get", {"paths": [bad]}).json()["records"] == []
    assert load(c) == {}


def test_bad_bodies(c):
    for body in ({"path": "a.md", "mtime": "x", "size": 1}, {"path": "a.md", "mtime": 1, "size": -1},
                 {"path": "a.md", "size": 1}, {"path": 5, "mtime": 1, "size": 1}):
        assert seen_post(c, "commit", body).status_code == 422, body
    r = post(c, "/api/seen/commit", {"path": "a.md", "mtime": 1, "size": 1})  # no root
    assert r.status_code == 422
    r = c.post("/api/seen/commit", content='{"root": %s, "path": "a.md", "mtime": NaN, "size": 1}'
               % json.dumps(c.root), headers={"Content-Type": "application/json", "X-Root-Token": c.root_token})
    assert r.status_code == 422
    assert post(c, "/api/seen/nope", {"root": c.root}).status_code == 404
    assert load(c) == {}


# -- commit by digest (page unload, body over the keepalive cap) --------------------------------

def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_commit_by_digest_match(c, two):
    a, _ = two
    text = "# big\n" + "line \u00e9 \U0001f600\n" * 5000
    write(a / "big.md", text)
    seen_post(c, "commit", {"path": "big.md", "mtime": 1, "size": 1, "text": "older"})
    r = seen_post(c, "commit", {"path": "big.md", "mtime": 2, "size": 3, "textSha256": sha(text)})
    assert r.status_code == 200, r.text
    s = snap(c, "big.md")
    assert s["text"] == text and s["mtime"] == 2 and s["size"] == 3
    # invalid UTF-8 on disk: the UI saw it with U+FFFD, like /api/content serves it
    (a / "bad.txt").write_bytes(b"ok \xff\xfe end\n")
    shown = c.get("/api/content", params={"path": "bad.txt"}).json()["text"]
    assert seen_post(c, "commit", {"path": "bad.txt", "mtime": 1, "size": 9, "textSha256": sha(shown)}).status_code == 200
    assert snap(c, "bad.txt")["text"] == shown
    # `text` wins over the digest
    seen_post(c, "commit", {"path": "big.md", "mtime": 3, "size": 3, "text": "given", "textSha256": sha(text)})
    assert snap(c, "big.md")["text"] == "given"


def test_commit_by_digest_mismatch_drops_the_copy(c, two):
    a, _ = two
    seen_post(c, "commit", {"path": "a.md", "mtime": 1, "size": 6, "text": "alpha\n"})
    write(a / "a.md", "changed again\n")  # the file moved on after the user saw "seen\n"
    r = seen_post(c, "commit", {"path": "a.md", "mtime": 5, "size": 5, "textSha256": sha("seen\n")})
    assert r.status_code == 200
    assert snap(c, "a.md") is None and load(c)["a.md"]["mtime"] == 5


def test_commit_by_digest_missing_and_oversize(c, two):
    a, _ = two
    # missing file: refused like any commit, nothing recorded
    r = seen_post(c, "commit", {"path": "gone.md", "mtime": 1, "size": 1, "textSha256": sha("x")})
    assert r.status_code == 404 and "gone.md" not in load(c)
    # over the /api/content limit: the record is kept without a copy, the file is never stored
    big = "x" * (2 * 1024 * 1024 + 1)
    write(a / "huge.txt", big)
    seen_post(c, "commit", {"path": "huge.txt", "mtime": 1, "size": 1, "text": "stale"})
    r = seen_post(c, "commit", {"path": "huge.txt", "mtime": 2, "size": len(big), "textSha256": sha(big)})
    assert r.status_code == 200
    assert snap(c, "huge.txt") is None and load(c)["huge.txt"]["mtime"] == 2
    # a malformed digest is a validation error
    for bad in ("abc", sha("x").upper(), "g" * 64, 5):
        assert seen_post(c, "commit", {"path": "a.md", "mtime": 1, "size": 1, "textSha256": bad}).status_code == 422


# -- clear ---------------------------------------------------------------------------------------

def test_clear(tmp_path, two):
    a, b = two
    dd = tmp_path / "data"
    with outer(a, dd) as c:
        c.root = canon(a)
        for p in ("a.md", "docs/x.md"):
            seen_post(c, "commit", {"path": p, "mtime": 1, "size": 2, "text": p})
        c.sw.seen.commit(canon(b), "b.md", 1, 1, "beta")  # another root's history is untouched
        q = c.sw.app.state.store.subscribe()
        r = seen_post(c, "clear", {"client": "tab-1"})
        assert r.status_code == 200 and r.json() == {"cleared": 2}
        assert load(c) == {} and snap(c, "a.md") is None
        assert q.get_nowait() == ("seen", {"paths": [], "client": "tab-1", "cleared": True})
        assert seen_post(c, "clear", {}).json() == {"cleared": 0}
        assert q.get_nowait()[1]["cleared"] is True
        assert c.sw.seen.snapshot(canon(b), "b.md")["text"] == "beta"
        # a stale root is refused
        assert post(c, "/api/seen/clear", {"root": canon(b)}).status_code == 409
        assert c.sw.seen.load(canon(b))


# -- rename --------------------------------------------------------------------------------------

def test_rename_file_and_folder(c):
    for p in ("a.md", "docs/x.md", "docs/sub/y.md"):
        seen_post(c, "commit", {"path": p, "mtime": 1, "size": 2, "text": f"text of {p}"})
    db_add = c.sw.seen  # a record that only shares the prefix string must not move
    db_add.mark(c.root, [("docsy.md", 1, 1)])
    r = seen_post(c, "rename", {"from": "docs", "to": "notes/docs"})
    assert r.status_code == 200 and r.json() == {"moved": 2}
    assert set(load(c)) == {"a.md", "notes/docs/x.md", "notes/docs/sub/y.md", "docsy.md"}
    assert snap(c, "notes/docs/sub/y.md")["text"] == "text of docs/sub/y.md"
    assert snap(c, "docs/x.md") is None
    # exact file rename replaces a record already at the target
    seen_post(c, "rename", {"from": "a.md", "to": "docsy.md"})
    recs = load(c)
    assert "a.md" not in recs and recs["docsy.md"]["mtime"] == 1 and recs["docsy.md"]["size"] == 2
    assert snap(c, "docsy.md")["text"] == "text of a.md"
    assert seen_post(c, "rename", {"from": "nothing", "to": "else"}).json() == {"moved": 0}
    assert seen_post(c, "rename", {"from": "docsy.md", "to": "docsy.md"}).json() == {"moved": 0}


# -- limits and pruning --------------------------------------------------------------------------

def test_limits_and_pruning(tmp_path):
    db = SeenDB(str(tmp_path / "d"), snapshot_max_chars=10, snapshots_total_chars=25, snapshots_max=3,
                seen_max_per_root=4)
    r = "/root"
    db.commit(r, "big", 1, 1, "x" * 11)  # over the per-snapshot limit: record kept, no text
    assert db.snapshot(r, "big") is None and [x["path"] for x in db.get(r, ["big"])] == ["big"]
    db.commit(r, "emoji", 1, 1, "\U0001f600" * 5)  # 10 UTF-16 units: fits
    assert db.snapshot(r, "emoji")["text"] == "\U0001f600" * 5
    db.commit(r, "emoji2", 1, 1, "\U0001f600" * 6)  # 12 units: too long
    assert db.snapshot(r, "emoji2") is None
    # total chars: 10 + 10 + 10 > 25 -> the oldest snapshot goes
    db.commit(r, "s1", 1, 1, "a" * 10)
    db.commit(r, "s2", 1, 1, "b" * 10)
    assert db.snapshot(r, "emoji") is None and db.snapshot(r, "s1") and db.snapshot(r, "s2")
    # count: at most 3 snapshots (across roots)
    db.commit("/other", "o1", 1, 1, "c")
    db.commit("/other", "o2", 1, 1, "d")
    assert db.snapshot(r, "s1") is None and db.snapshot(r, "s2") and db.snapshot("/other", "o2")
    # seen records: at most 4 per root, oldest first; other roots untouched
    assert len(db.load(r)) == 4  # big, emoji, emoji2, s1, s2 -> big dropped
    assert {x["path"] for x in db.load(r)} == {"emoji", "emoji2", "s1", "s2"}
    db.mark(r, [("m1", 1, 1), ("m2", 1, 1)])
    assert {x["path"] for x in db.load(r)} == {"s1", "s2", "m1", "m2"}
    assert {x["path"] for x in db.load("/other")} == {"o1", "o2"}
    db.close()


def test_disk_full_keeps_the_record(tmp_path, monkeypatch):
    db = SeenDB(str(tmp_path / "d"))
    db.commit("/r", "old", 1, 1, "old text")
    calls = []
    orig = db._write_commit

    def flaky(conn, root, path, mtime, size, text, now):
        calls.append(text)
        if len(calls) == 1:
            raise sqlite3.OperationalError("database or disk is full")
        return orig(conn, root, path, mtime, size, text, now)

    monkeypatch.setattr(db, "_write_commit", flaky)
    rec = db.commit("/r", "new", 2, 3, "new text")
    assert rec["path"] == "new" and calls == ["new text", None]
    assert db.snapshot("/r", "new") is None and [x["mtime"] for x in db.get("/r", ["new"])] == [2]
    db.close()


# -- namespacing and root switches ---------------------------------------------------------------

def test_roots_are_namespaced_and_switch(tmp_path, two):
    a, b = two
    dd = tmp_path / "data"
    save_state(str(dd), {"last_root": None, "recent": [canon(b)]})
    with outer(a, dd) as c:
        c.root = canon(a)
        seen_post(c, "commit", {"path": "a.md", "mtime": 1, "size": 1, "text": "A"})
        assert post(c, "/api/roots/switch", {"path": canon(b)}).status_code == 200
        # a stale tab still naming the old root is refused: nothing written into beta's history
        r = seen_post(c, "commit", {"path": "b.md", "mtime": 1, "size": 1})
        assert r.status_code == 409
        assert c.get("/api/seen", params={"root": canon(a)}).status_code == 409
        c.root = canon(b)
        assert load(c) == {}
        assert seen_post(c, "commit", {"path": "b.md", "mtime": 2, "size": 1, "text": "B"}).status_code == 200
        assert post(c, "/api/roots/switch", {"path": canon(a)}).status_code == 200
        c.root = canon(a)
        assert set(load(c)) == {"a.md"} and snap(c, "a.md")["text"] == "A"
    # survives a restart (on disk in the data dir)
    with outer(b, dd) as c:
        c.root = canon(b)
        assert set(load(c)) == {"b.md"}


def test_no_folder_mode(tmp_path):
    with outer(None, tmp_path / "data") as c:
        cfg = c.get("/api/config").json()
        assert cfg["no_root"] and cfg["seen_enabled"] is False
        c.root = "/x"
        assert c.get("/api/seen", params={"root": "/x"}).status_code == 409
        assert seen_post(c, "commit", {"path": "a.md", "mtime": 1, "size": 1}).status_code == 409


def test_lock_root_keeps_history(tmp_path, two):
    # Decision: --lock-root pins the folder, but the history is not the folder, so its writes stay allowed.
    a, b = two
    dd = tmp_path / "data"
    save_state(str(dd), {"last_root": None, "recent": [canon(b)]})
    with outer(a, dd, lock_root=True) as c:
        c.root = canon(a)
        assert c.get("/api/config").json()["seen_enabled"] is True
        assert seen_post(c, "commit", {"path": "a.md", "mtime": 1, "size": 1, "text": "A"}).status_code == 200
        assert seen_post(c, "mark", {"entries": [{"path": "docs/x.md", "mtime": 1, "size": 2}]}).status_code == 200
        assert seen_post(c, "rename", {"from": "docs/x.md", "to": "docs/z.md"}).status_code == 200
        assert seen_post(c, "get", {"paths": ["a.md"]}).json()["records"][0]["path"] == "a.md"
        assert set(load(c)) == {"a.md", "docs/z.md"}
        assert seen_post(c, "clear", {}).json() == {"cleared": 2}
        # while every /api/roots POST is refused
        for op, body in (("switch", {"path": canon(b)}), ("pick", {}), ("forget", {"path": canon(b)})):
            r = post(c, f"/api/roots/{op}", body)
            assert r.status_code == 403 and "--lock-root" in r.json()["detail"], op
        assert c.get("/api/config").json()["root_path"] == canon(a)


def test_data_dir_overlap_disables(tmp_path, two):
    a, _ = two
    before = snapshot_fs(a)
    for dd in (a / ".data", tmp_path):  # data dir inside the root / root inside the data dir
        with outer(a, dd) as c:
            c.root = canon(a)
            assert c.get("/api/config").json()["seen_enabled"] is False
            assert c.get("/api/seen", params={"root": c.root}).status_code == 403
            for op, body in (("commit", {"path": "a.md", "mtime": 1, "size": 1, "text": "x"}),
                             ("mark", {"entries": [{"path": "a.md", "mtime": 1, "size": 1}]}),
                             ("rename", {"from": "a.md", "to": "b.md"}), ("get", {"paths": ["a.md"]}),
                             ("clear", {})):
                assert seen_post(c, op, body).status_code == 403, op
    assert snapshot_fs(a) == before
    assert not (tmp_path / SEEN_FILE).exists()


def test_unwritable_data_dir_disables(tmp_path, two):
    a, _ = two
    blocker = tmp_path / "file"
    blocker.write_text("not a dir")
    with outer(a, blocker / "data") as c:
        c.root = canon(a)
        assert c.get("/api/config").json()["seen_enabled"] is False
        assert c.get("/api/seen", params={"root": c.root}).status_code == 503


# -- the gate ------------------------------------------------------------------------------------

def test_gate(c):
    body = {"path": "a.md", "mtime": 1, "size": 1}
    c.sw.seen.commit(c.root, "a.md", 1, 1, "kept")  # a refused clear must not touch it
    for tok in (False, "wrong"):
        assert seen_post(c, "commit", body, token=tok).status_code == 403
        assert seen_post(c, "clear", {}, token=tok).status_code == 403
    for h in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Origin": "http://evil.example"},
              {"Origin": "http://127.0.0.1:9999"}, {"Origin": "null"}, {"Content-Type": "text/plain"},
              {"Content-Type": "application/x-www-form-urlencoded"}):
        for op, b in (("commit", body), ("mark", {"entries": [body]}), ("rename", {"from": "a.md", "to": "z.md"}),
                      ("get", {"paths": ["a.md"]}), ("clear", {})):
            r = seen_post(c, op, b, **h)
            assert r.status_code == 403, (op, h)
            assert r.headers["content-security-policy"]
    assert seen_post(c, "commit", body, Host="evil.example").status_code == 400
    assert seen_post(c, "commit", body, **{"X-Forwarded-Host": "evil.example"}).status_code == 400
    h = {"Content-Type": "application/json", "X-Root-Token": c.root_token}
    assert c.put("/api/seen/commit", content="{}", headers=h).status_code == 405
    assert c.delete("/api/seen/commit", headers=h).status_code == 405
    assert c.delete("/api/seen/clear", headers=h).status_code == 405
    assert c.get("/api/seen/clear", params={"root": c.root}).status_code == 404
    assert seen_post(c, "clear", {}, Host="evil.example").status_code == 400
    assert set(load(c)) == {"a.md"} and snap(c, "a.md")["text"] == "kept"
    r = seen_post(c, "commit", body, **{"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8765"})
    assert r.status_code == 200
    r = seen_post(c, "commit", body, Origin="http://localhost:3000")
    assert r.status_code == 200


def test_body_limit(c):
    h = {"Content-Type": "application/json", "X-Root-Token": c.root_token}
    big = json.dumps({"root": c.root, "path": "a.md", "mtime": 1, "size": 1, "text": "\u0001" * (2 * 1024 * 1024 + 1)})
    assert len(big) > 12 * 1024 * 1024
    r = c.post("/api/seen/commit", content=big + " " * (4 * 1024 * 1024), headers=h)
    assert r.status_code == 413
    # a full-size snapshot (2 MB of escaped control characters) fits
    ok = json.dumps({"root": c.root, "path": "a.md", "mtime": 1, "size": 1, "text": "\u0001" * (2 * 1024 * 1024)})
    assert c.post("/api/seen/commit", content=ok, headers=h).status_code == 200
    assert len(snap(c, "a.md")["text"]) == 2 * 1024 * 1024


# -- SSE -----------------------------------------------------------------------------------------

def test_events_published_to_the_root_store(c):
    q = c.sw.app.state.store.subscribe()
    seen_post(c, "commit", {"path": "a.md", "mtime": 1, "size": 1, "client": "tab-1"})
    seen_post(c, "mark", {"entries": [{"path": "docs/x.md", "mtime": 1, "size": 1}]})
    seen_post(c, "mark", {"entries": []})  # nothing written: no event
    assert q.get_nowait() == ("seen", {"paths": ["a.md"], "client": "tab-1"})
    assert q.get_nowait() == ("seen", {"paths": ["docs/x.md"], "client": None})
    assert q.empty()


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_seen_event_on_the_sse_stream(tmp_path, two):
    a, _ = two
    port = _free_port()
    sw = RootSwitcher(Settings.make(str(a), port=port, data_dir=str(tmp_path / "data"),
                                    ui_dir=str(tmp_path / "no-ui"), reconcile_interval=0, watch=False), picker=None)
    server = uvicorn.Server(uvicorn.Config(sw, host="127.0.0.1", port=port, log_level="warning",
                                           timeout_graceful_shutdown=2))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    base = f"http://127.0.0.1:{port}"
    lines: list[str] = []
    connected = threading.Event()
    try:
        wait_until(lambda: server.started, timeout=10)

        def listen():
            with httpx.Client(timeout=20) as client, client.stream("GET", f"{base}/api/events") as r:
                connected.set()
                for line in r.iter_lines():
                    lines.append(line)
                    if line.startswith("data:") and "seen" in "".join(lines[-2:]):
                        return

        lt = threading.Thread(target=listen, daemon=True)
        lt.start()
        assert connected.wait(10)
        tok = httpx.get(f"{base}/api/config").json()["root_token"]
        wait_until(lambda: sw.app.state.store._subscribers, timeout=5)
        r = httpx.post(f"{base}/api/seen/commit", headers={"X-Root-Token": tok},
                       json={"root": canon(a), "path": "a.md", "mtime": 1, "size": 1, "client": "c9"})
        assert r.status_code == 200
        lt.join(10)
        assert "event: seen" in lines
        data = next(json.loads(x[5:]) for x in lines if x.startswith("data:"))
        assert data == {"paths": ["a.md"], "client": "c9"}
    finally:
        server.should_exit = True
        th.join(10)
    assert not os.path.exists(a / SEEN_FILE)
