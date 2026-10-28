"""Save/history, trash, upload, copy, mkdir, audit."""

import hashlib
import json
import os
import stat

import pytest

from conftest import editing, store_of, write


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def no_temp_files(root):
    return not [n for _d, _ds, fs in os.walk(root) for n in fs if n.startswith(".ldv-tmp-")]


@pytest.fixture
def tree(root):
    write(root / "doc.md", "v0\n")
    write(root / "sub" / "b.md", "b\n")
    os.chmod(root / "doc.md", 0o640)
    return root


def save(c, path, content, base, **kw):
    return c.put("/api/edit/file", json={"path": path, "content": content, "base_sha256": base, **kw})


def test_save_atomic_conflict_history(tree, data_dir):
    with editing(tree, data_dir, history_keep=3) as c:
        cur = c.get("/api/content?path=doc.md").json()
        assert cur["sha256"] == sha(b"v0\n")
        base = cur["sha256"]
        for i in range(1, 6):
            r = save(c, "doc.md", f"v{i}\n", base)
            assert r.status_code == 200, r.text
            res = r.json()
            assert res["path"] == "doc.md" and res["sha256"] == sha(f"v{i}\n".encode()) and res["history_id"]
            assert res["size"] == 3 and res["mtime"] > 0
            base = res["sha256"]
        assert (tree / "doc.md").read_text() == "v5\n"
        assert stat.S_IMODE(os.stat(tree / "doc.md").st_mode) == 0o640
        assert no_temp_files(tree)
        # stale base -> 409 with the current state
        r = save(c, "doc.md", "mine\n", sha(b"v0\n"))
        assert r.status_code == 409
        assert r.json()["current"]["sha256"] == sha(b"v5\n") and r.json()["current"]["size"] == 3
        assert (tree / "doc.md").read_text() == "v5\n"
        # creating where something exists -> 409
        assert save(c, "doc.md", "x", None).status_code == 409
        assert save(c, "doc.md", "x", base, create=True).status_code == 409
        assert save(c, "sub", "x", None).status_code == 409
        # unchanged content: no new version
        r = save(c, "doc.md", "v5\n", base)
        assert r.status_code == 200 and r.json()["history_id"] is None
        # history pruned to --history-keep, newest first
        h = c.get("/api/edit/history?path=doc.md").json()["versions"]
        assert [v["size"] for v in h] == [3, 3, 3]
        assert [c.get(f"/api/edit/history/content?path=doc.md&id={v['id']}").text for v in h] == ["v4\n", "v3\n", "v2\n"]
        assert all(v["reason"] == "save" and v["path"] == "doc.md" and v["sha256"] for v in h)
        # restore v2: the current version goes to history first
        r = c.post("/api/edit/history/restore", json={"path": "doc.md", "id": h[2]["id"]})
        assert r.status_code == 200, r.text
        assert (tree / "doc.md").read_text() == "v2\n"
        h2 = c.get("/api/edit/history?path=doc.md").json()["versions"]
        assert h2[0]["reason"] == "restore" and len(h2) == 3
        assert c.get(f"/api/edit/history/content?path=doc.md&id={h2[0]['id']}").text == "v5\n"
        assert stat.S_IMODE(os.stat(tree / "doc.md").st_mode) == 0o640
        r = c.get("/api/edit/history/content?path=doc.md&id=00000000000000000000-00000000")
        assert r.status_code == 404
        # create a new file; deleted-meanwhile file -> 409
        r = save(c, "sub/new.md", "hello", None)
        assert r.status_code == 200 and r.json()["history_id"] is None
        assert (tree / "sub" / "new.md").read_text() == "hello"
        assert save(c, "nope/new.md", "x", None).status_code == 404
        assert save(c, "gone.md", "x", sha(b"x")).status_code == 409
        assert no_temp_files(tree)
        # history and audit live only in the data dir
        sd = store_of(c)
        assert sd.parent.parent == data_dir.resolve() and json.loads((sd / "root.json").read_text())["root"]
        assert (sd / "history").is_dir() and (sd / "audit.jsonl").is_file()
        audit = [json.loads(l) for l in (sd / "audit.jsonl").read_text().splitlines()]
        assert {a["op"] for a in audit} >= {"save", "history-restore", "create"}
        assert all("content" not in a for a in audit)
        items = c.get("/api/edit/audit?limit=2").json()["items"]
        assert len(items) == 2 and items[0]["op"] == "create" and items[0]["path"] == "sub/new.md"


def test_atomic_write_failure_leaves_no_temp(tree, data_dir, monkeypatch):
    with editing(tree, data_dir) as c:
        base = sha(b"v0\n")
        real_replace = os.replace

        def boom(src, dst, *a, **kw):
            if os.path.basename(src).startswith(".ldv-tmp-"):
                raise OSError(5, "simulated I/O error")
            return real_replace(src, dst, *a, **kw)

        monkeypatch.setattr(os, "replace", boom)
        r = save(c, "doc.md", "new\n", base)
        assert r.status_code == 500
        monkeypatch.setattr(os, "replace", real_replace)
        assert (tree / "doc.md").read_text() == "v0\n"
        assert no_temp_files(tree)


def test_history_follows_move(tree, data_dir):
    with editing(tree, data_dir) as c:
        r = save(c, "doc.md", "v1\n", sha(b"v0\n"))
        assert r.status_code == 200
        r = c.post("/api/edit/move", json={"from": "doc.md", "to": "sub/renamed.md"})
        assert r.status_code == 200 and r.json()["from"] == "doc.md" and r.json()["to"] == "sub/renamed.md"
        assert c.get("/api/edit/history?path=doc.md").json()["versions"] == []
        h = c.get("/api/edit/history?path=sub/renamed.md").json()["versions"]
        assert len(h) == 1 and h[0]["path"] == "sub/renamed.md"
        assert c.get(f"/api/edit/history/content?path=sub/renamed.md&id={h[0]['id']}").text == "v0\n"
        # folder move re-keys the files below it
        assert c.post("/api/edit/move", json={"from": "sub", "to": "moved/deeper", "create_parents": True}).status_code == 200
        h = c.get("/api/edit/history?path=moved/deeper/renamed.md").json()["versions"]
        assert len(h) == 1
        # move onto an existing file: needs overwrite and keeps the overwritten bytes
        write(tree / "x.md", "x\n")
        write(tree / "y.md", "y\n")
        assert c.post("/api/edit/move", json={"from": "x.md", "to": "y.md"}).status_code == 409
        assert c.post("/api/edit/move", json={"from": "x.md", "to": "nodir/y.md"}).status_code == 404
        r = c.post("/api/edit/move", json={"from": "x.md", "to": "y.md", "overwrite": True})
        assert r.status_code == 200 and r.json()["history_id"]
        assert (tree / "y.md").read_text() == "x\n" and not (tree / "x.md").exists()
        h = c.get("/api/edit/history?path=y.md").json()["versions"]
        assert [v["reason"] for v in h] == ["move-overwrite"]
        # a folder can never overwrite
        (tree / "d1").mkdir()
        assert c.post("/api/edit/move", json={"from": "d1", "to": "y.md", "overwrite": True}).status_code == 409


def test_case_only_rename(tree, data_dir):
    with editing(tree, data_dir) as c:
        r = c.post("/api/edit/move", json={"from": "doc.md", "to": "Doc.md"})
        assert r.status_code == 200, r.text
        assert "Doc.md" in os.listdir(tree)
        assert c.post("/api/edit/move", json={"from": "Doc.md", "to": "Doc.md"}).status_code == 400


def test_delete_restore_purge(tree, data_dir):
    with editing(tree, data_dir) as c:
        r = c.post("/api/edit/delete", json={"path": "doc.md"})
        assert r.status_code == 200
        tid = r.json()["trash_id"]
        assert not (tree / "doc.md").exists()
        assert c.post("/api/edit/delete", json={"path": "doc.md"}).status_code == 404
        r = c.post("/api/edit/delete", json={"path": "sub"})
        assert r.status_code == 200
        tid_dir = r.json()["trash_id"]
        items = c.get("/api/edit/trash").json()["items"]
        assert [i["id"] for i in items] == [tid_dir, tid]
        assert items[0]["kind"] == "dir" and items[0]["file_count"] == 1 and items[0]["original_path"] == "sub"
        assert items[1]["kind"] == "file" and items[1]["size"] == 3
        # restore conflict
        write(tree / "doc.md", "other\n")
        r = c.post("/api/edit/trash/restore", json={"id": tid})
        assert r.status_code == 409
        r = c.post("/api/edit/trash/restore", json={"id": tid, "to": "restored/doc.md"})
        assert r.status_code == 200 and r.json()["path"] == "restored/doc.md"
        assert (tree / "restored" / "doc.md").read_text() == "v0\n"
        assert (tree / "doc.md").read_text() == "other\n"
        assert stat.S_IMODE(os.stat(tree / "restored" / "doc.md").st_mode) == 0o640
        r = c.post("/api/edit/trash/restore", json={"id": tid_dir})
        assert r.status_code == 200 and (tree / "sub" / "b.md").read_text() == "b\n"
        assert c.get("/api/edit/trash").json()["items"] == []
        assert c.post("/api/edit/trash/restore", json={"id": tid}).status_code == 404
        assert c.post("/api/edit/trash/restore", json={"id": "../../etc"}).status_code == 400
        # purge one / all
        t1 = c.post("/api/edit/delete", json={"path": "doc.md"}).json()["trash_id"]
        c.post("/api/edit/delete", json={"path": "restored"})
        c.post("/api/edit/delete", json={"path": "sub/b.md"})
        assert c.post("/api/edit/trash/purge", json={"id": t1}).status_code == 200
        assert len(c.get("/api/edit/trash").json()["items"]) == 2
        assert c.post("/api/edit/trash/purge", json={}).status_code == 400
        assert c.post("/api/edit/trash/purge", json={"all": True}).json() == {"purged": 2}
        assert c.get("/api/edit/trash").json()["items"] == []
        assert os.listdir(store_of(c) / "trash") == []
        ops = [i["op"] for i in c.get("/api/edit/audit").json()["items"]]
        assert ops[:2] == ["purge", "purge"] and "restore" in ops and "delete" in ops


def test_mkdir_copy(tree, data_dir):
    with editing(tree, data_dir) as c:
        assert c.post("/api/edit/mkdir", json={"path": "n1/n2/n3"}).status_code == 200
        assert (tree / "n1" / "n2" / "n3").is_dir()
        assert c.post("/api/edit/mkdir", json={"path": "n1/n2"}).status_code == 409
        assert c.post("/api/edit/mkdir", json={"path": "doc.md/x"}).status_code == 400
        r = c.post("/api/edit/copy", json={"from": "doc.md", "to": "n1/doc copy.md"})
        assert r.status_code == 200 and r.json()["sha256"] == sha(b"v0\n")
        assert (tree / "n1" / "doc copy.md").read_text() == "v0\n"
        assert stat.S_IMODE(os.stat(tree / "n1" / "doc copy.md").st_mode) == 0o640
        assert c.post("/api/edit/copy", json={"from": "doc.md", "to": "n1/doc copy.md"}).status_code == 409
        assert c.post("/api/edit/copy", json={"from": "sub", "to": "sub2"}).status_code == 400
        assert c.post("/api/edit/copy", json={"from": "missing.md", "to": "m2.md"}).status_code == 404
        assert c.post("/api/edit/copy", json={"from": "doc.md", "to": "nodir/x.md"}).status_code == 404
        assert no_temp_files(tree)


def test_upload(tree, data_dir):
    with editing(tree, data_dir, upload_max_bytes=1000, upload_ext=("png", "md", "txt")) as c:
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 10
        r = c.post("/api/edit/upload", data={"dir": "sub"},
                   files=[("files", ("../../evil/pic.png", png, "image/png")),
                          ("files", ("C:\\Users\\me\\note.md", b"n", "text/markdown")),
                          ("files[]", ("we<i>rd:na|me?.md", b"w", "text/markdown")),
                          ("files", ("Cafe\u0301 \u202e.md", b"c", "text/markdown"))])
        assert r.status_code == 200, r.text
        paths = r.json()["paths"]
        assert paths[:3] == ["sub/pic.png", "sub/note.md", "sub/we_i_rd_na_me_.md"]
        assert paths[3].startswith("sub/Caf\u00e9")
        assert (tree / "sub" / "pic.png").read_bytes() == png
        assert not (tree.parent / "evil").exists()
        # collisions get a suffix, also within one request
        r = c.post("/api/edit/upload", data={"dir": "sub"},
                   files=[("files", ("pic.png", b"2", "image/png")), ("files", ("PIC.png", b"3", "image/png"))])
        assert r.json()["paths"] == ["sub/pic-1.png", "sub/PIC-2.png"]
        # overwrite keeps the old bytes in history
        r = c.post("/api/edit/upload", data={"dir": "sub", "overwrite": "1"},
                   files=[("files", ("pic.png", b"new", "image/png"))])
        assert r.status_code == 200 and r.json()["paths"] == ["sub/pic.png"] and r.json()["items"][0]["history_id"]
        assert (tree / "sub" / "pic.png").read_bytes() == b"new"
        h = c.get("/api/edit/history?path=sub/pic.png").json()["versions"]
        assert h[0]["reason"] == "upload-overwrite" and h[0]["size"] == len(png)
        # size limit is enforced while streaming; nothing written
        r = c.post("/api/edit/upload", data={"dir": "sub"}, files=[("files", ("big.md", b"x" * 1001, "text/plain"))])
        assert r.status_code == 413
        assert not (tree / "sub" / "big.md").exists()
        # extension allowlist, missing dir, create_dir, root dir
        r = c.post("/api/edit/upload", data={"dir": "sub"}, files=[("files", ("x.pdf", b"%PDF", "application/pdf"))])
        assert r.status_code == 415
        r = c.post("/api/edit/upload", data={"dir": "nodir"}, files=[("files", ("x.md", b"x", "text/plain"))])
        assert r.status_code == 404
        r = c.post("/api/edit/upload", data={"dir": "docs/assets", "create_dir": "1"},
                   files=[("files", ("image-20260101-120000.png", png, "image/png"))])
        assert r.status_code == 200 and r.json()["paths"] == ["docs/assets/image-20260101-120000.png"]
        r = c.post("/api/edit/upload", data={"dir": ""}, files=[("files", ("top.txt", b"t", "text/plain"))])
        assert r.json()["paths"] == ["top.txt"]
        assert c.post("/api/edit/upload", files={"dir": (None, "sub")}).status_code == 400
        assert no_temp_files(tree)
