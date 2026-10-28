"""Regressions from the third review: case-variant data dirs, per-root recovery stores,
check-then-write races through swapped symlinks, no-op history restores."""

import hashlib
import json
import os
import unicodedata

import pytest
from fastapi.testclient import TestClient

from conftest import editing, running, snapshot_fs, store_of, write
from viewer.app import create_app
from viewer.config import ConfigError, Settings


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _case_insensitive(p) -> bool:
    return os.path.exists(str(p).swapcase()) or os.path.exists(os.path.join(os.path.dirname(p), os.path.basename(p).upper()))


# --- 1. data dir spelled with another case / normalisation -----------------------------------
def test_case_and_unicode_variant_data_dir_refused(tmp_path):
    root = tmp_path / "ci" / "root"
    root.mkdir(parents=True)
    if not _case_insensitive(root):
        pytest.skip("case-sensitive file system")
    for dd in (tmp_path / "ci" / "ROOT" / ".data", tmp_path / "CI" / "Root" / "x" / "y"):
        s = Settings.make(str(root), allow_edit=True, data_dir=str(dd), watch=False, reconcile_interval=0)
        assert s.data_dir_overlaps_root(), dd
        with pytest.raises(ConfigError):
            create_app(s)
    # root spelled differently, data dir canonical
    s = Settings.make(str(tmp_path / "ci" / "ROOT"), allow_edit=True, data_dir=str(root / ".d"))
    with pytest.raises(ConfigError):
        create_app(s)
    # NFC on disk, NFD in the data dir path
    nfc = tmp_path / unicodedata.normalize("NFC", "café")
    nfc.mkdir()
    nfd = str(tmp_path / unicodedata.normalize("NFD", "café")) + "/.data"
    s = Settings.make(str(nfc), allow_edit=True, data_dir=nfd)
    with pytest.raises(ConfigError):
        create_app(s)
    assert not (root / ".data").exists() and not (root / "x").exists()


def test_read_only_hides_case_variant_data_dir(tmp_path):
    root = tmp_path / "root"
    write(root / "doc.md", "zqvisible\n")
    if not _case_insensitive(root):
        pytest.skip("case-sensitive file system")
    write(root / ".data" / "roots" / "k" / "history" / "h" / "v1", "zqsecrethistory\n")
    write(root / ".data" / "roots" / "k" / "audit.jsonl", '{"op":"zqauditop"}\n')
    with running(root, data_dir=str(tmp_path / "ROOT" / ".DATA")) as c:
        t = c.get("/api/tree").json()
        assert [f["path"] for f in t["files"]] == ["doc.md"] and not [d for d in t["dirs"] if "data" in d.lower()]
        for q in ("zqsecrethistory", "zqauditop"):
            assert not c.get(f"/api/search?q={q}").json()["content"]
        for p in (".data/roots/k/audit.jsonl", ".DATA/roots/k/audit.jsonl"):
            assert c.get(f"/api/content?path={p}").status_code in (403, 404)
            assert c.get(f"/api/raw?path={p}").status_code in (403, 404)
        assert c.get("/api/search?q=zqvisible").json()["content"]


# --- 2. the recovery store is per root -------------------------------------------------------
def test_recovery_store_is_per_root(tmp_path):
    ra, rb, data = tmp_path / "ra", tmp_path / "rb", tmp_path / "data"
    write(ra / "docs" / "plan.md", "A-private\n")
    write(rb / "docs" / "other.md", "B\n")
    with editing(ra, data) as a:
        assert a.put("/api/edit/file",
                      json={"path": "docs/plan.md", "content": "A2\n", "base_sha256": sha(b"A-private\n")}).status_code == 200
        tid = a.post("/api/edit/delete", json={"path": "docs/plan.md"}).json()["trash_id"]
        sa = store_of(a)
    with editing(rb, data) as b:
        sb = store_of(b)
        assert sa != sb and sa.parent == sb.parent
        assert b.get("/api/edit/trash").json()["items"] == []
        assert b.post("/api/edit/trash/restore", json={"id": tid}).status_code == 404
        assert b.get("/api/edit/audit?limit=50").json()["items"] == []
        write(rb / "docs" / "plan.md", "B-plan\n")
        assert b.get("/api/edit/history?path=docs/plan.md").json()["versions"] == []
        assert not (rb / "docs" / "plan.md").read_text().startswith("A")
    with editing(ra, data) as a:
        assert [i["id"] for i in a.get("/api/edit/trash").json()["items"]] == [tid]
        assert a.post("/api/edit/trash/restore", json={"id": tid}).status_code == 200
        assert (ra / "docs" / "plan.md").read_text() == "A2\n"
        assert len(a.get("/api/edit/history?path=docs/plan.md").json()["versions"]) == 1


def test_store_marker_mismatch_refused(tmp_path):
    root, data = tmp_path / "root", tmp_path / "data"
    root.mkdir()
    s = Settings.make(str(root), allow_edit=True, data_dir=str(data), watch=False, reconcile_interval=0)
    os.makedirs(s.store_dir)
    with open(os.path.join(s.store_dir, "root.json"), "w") as f:
        json.dump({"root": "/somewhere/else"}, f)
    with pytest.raises(ConfigError):
        create_app(s)


# --- 3. a folder swapped for a symlink between the check and the write -----------------------
@pytest.fixture
def raceworld(tmp_path, root):
    outside = tmp_path / "outside"
    write(outside / "a.md", "OUT\n")
    write(outside / "z.md", "OUTZ\n")
    write(root / "docs" / "a.md", "in\n")
    write(root / "docs" / "z.md", "z\n")
    write(root / "top.md", "top\n")
    return root, outside


def _swapper(c, root, outside, trigger):
    """Make WriteGuard.locate swap root/docs for a symlink to `outside` right after it has checked
    `trigger` (simulating a local process racing the server)."""
    wg = c.app.state.editor.wg
    orig = wg.locate
    state = {"swapped": False}

    def locate(rel, **kw):
        res = orig(rel, **kw)
        if rel == trigger and not state["swapped"]:
            os.rename(root / "docs", root / "docs-real")
            os.symlink(outside, root / "docs")
            state["swapped"] = True
        return res

    wg.locate = locate

    def undo():
        wg.locate = orig
        if state["swapped"]:
            os.unlink(root / "docs")
            os.rename(root / "docs-real", root / "docs")

    return undo


def test_symlink_swap_race_never_writes_outside(raceworld, data_dir):
    root, outside = raceworld
    before_out = snapshot_fs(outside)
    with editing(root, data_dir) as c:
        tid = c.post("/api/edit/delete", json={"path": "docs/z.md"}).json()["trash_id"]
        write(outside / "z.md", "OUTZ\n")  # unchanged outside (z.md stays only outside)
        ops = [
            ("docs/new.md", "PUT", "/api/edit/file", {"json": {"path": "docs/new.md", "content": "PWN", "base_sha256": None}}),
            ("docs/a.md", "PUT", "/api/edit/file", {"json": {"path": "docs/a.md", "content": "PWN", "base_sha256": sha(b"in\n")}}),
            ("docs/newdir", "POST", "/api/edit/mkdir", {"json": {"path": "docs/newdir"}}),
            ("docs/deep/x/y.md", "POST", "/api/edit/move", {"json": {"from": "top.md", "to": "docs/deep/x/y.md", "create_parents": True}}),
            ("docs/c.md", "POST", "/api/edit/copy", {"json": {"from": "top.md", "to": "docs/c.md"}}),
            ("docs/m.md", "POST", "/api/edit/move", {"json": {"from": "top.md", "to": "docs/m.md"}}),
            ("docs/a.md", "POST", "/api/edit/move", {"json": {"from": "docs/a.md", "to": "moved.md"}}),
            ("docs/a.md", "POST", "/api/edit/delete", {"json": {"path": "docs/a.md"}}),
            ("docs", "POST", "/api/edit/upload", {"data": {"dir": "docs"}, "files": {"files": ("u.md", b"PWN", "text/markdown")}}),
            ("docs/z.md", "POST", "/api/edit/trash/restore", {"json": {"id": tid}}),
        ]
        for trigger, m, url, kw in ops:
            undo = _swapper(c, root, outside, trigger)
            try:
                r = c.request(m, url, **kw)
            finally:
                undo()
            assert r.status_code in (403, 409), (url, trigger, r.status_code, r.text)
            assert snapshot_fs(outside) == before_out, (url, trigger)
        # nothing from outside reached the history, and the in-root files are intact
        assert c.get("/api/edit/history?path=docs/a.md").json()["versions"] == []
        assert (root / "docs" / "a.md").read_text() == "in\n" and (root / "top.md").read_text() == "top\n"
        assert [i["id"] for i in c.get("/api/edit/trash").json()["items"]] == [tid]
        assert not [n for _d, _ds, fs in os.walk(root) for n in fs if n.startswith(".ldv-tmp-")]


def test_create_never_replaces_a_file_that_appeared(raceworld, data_dir):
    root, _outside = raceworld
    with editing(root, data_dir) as c:
        wg = c.app.state.editor.wg
        orig = wg.locate

        def locate(rel, **kw):
            res = orig(rel, **kw)
            if rel == "docs/new.md":
                write(root / "docs" / "new.md", "theirs\n")  # created by someone else meanwhile
            return res

        wg.locate = locate
        r = c.put("/api/edit/file", json={"path": "docs/new.md", "content": "mine", "base_sha256": None})
        wg.locate = orig
        assert r.status_code == 409
        assert (root / "docs" / "new.md").read_text() == "theirs\n"


# --- 4. restoring a version identical to the current file is a no-op -------------------------
def test_history_restore_identical_is_noop(root, data_dir):
    write(root / "d.md", "v0\n")
    with editing(root, data_dir) as c:
        r = c.put("/api/edit/file", json={"path": "d.md", "content": "v1\n", "base_sha256": sha(b"v0\n")})
        r = c.put("/api/edit/file", json={"path": "d.md", "content": "v0\n", "base_sha256": sha(b"v1\n")})
        vs = c.get("/api/edit/history?path=d.md").json()["versions"]
        v0 = [v for v in vs if v["sha256"] == sha(b"v0\n")][0]
        r = c.post("/api/edit/history/restore", json={"path": "d.md", "id": v0["id"]})
        assert r.status_code == 200 and r.json()["unchanged"] is True and r.json()["history_id"] is None
        assert len(c.get("/api/edit/history?path=d.md").json()["versions"]) == len(vs)
        assert (root / "d.md").read_text() == "v0\n"
