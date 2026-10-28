"""Path, deny-list and symlink safety for every mutation."""

import os

import pytest

from conftest import editing, snapshot_fs, write

TRAVERSAL = ["../x.md", "a/../../x.md", "sub/../../x.md", "/etc/x.md", "\\x.md", "sub\\..\\..\\x.md",
             "./x.md", "sub/./x.md", "..", ".", "", "sub//x.md", "sub/", "\u2025/x.md", "\uff0e\uff0e/x.md",
             "sub\uff0fx.md", "C:/x.md", "x\x00.md"]
BAD_NAMES = [".env", ".ENV", ".env.local", "x_token.md", "X_TOKEN.md", "my-\u017fecret.md", "creds.pem",
             "id.key", "__pycache__", "a.pyc", ".DS_Store", ".ldv-tmp-123", "node_modules", "sub/.env",
             "sub/secret/x.md", "x\x01.md", "x\x7f.md", "trailing.", "trailing ", " leading.md", "a" * 256 + ".md",
             "\u202eevil.md", "x\u200b.md"]


@pytest.fixture
def world(tmp_path, root):
    outside = tmp_path / "outside"
    write(outside / "victim.md", "outside\n")
    write(root / "a.md", "# A\n")
    write(root / "sub" / "b.md", "b\n")
    write(root / "guarded" / "keep.md", "k\n")
    write(root / "guarded" / ".env", "SECRET=1\n")
    os.symlink(root / "sub", root / "linkdir")
    os.symlink(outside, root / "outlink")
    os.symlink(root / "a.md", root / "lnk.md")
    os.symlink(outside / "victim.md", root / "outfile.md")
    return root, outside


def _calls(path):
    """Every mutation with `path` as its (destination) argument."""
    return [
        ("PUT", "/api/edit/file", {"path": path, "content": "x", "base_sha256": None}),
        ("POST", "/api/edit/mkdir", {"path": path}),
        ("POST", "/api/edit/move", {"from": "a.md", "to": path}),
        ("POST", "/api/edit/move", {"from": path, "to": "moved.md"}),
        ("POST", "/api/edit/copy", {"from": "a.md", "to": path}),
        ("POST", "/api/edit/copy", {"from": path, "to": "copied.md"}),
        ("POST", "/api/edit/delete", {"path": path}),
    ]


def _assert_refused(c, path, ok=(400, 403, 404, 409, 422)):
    for m, url, body in _calls(path):
        r = c.request(m, url, json=body)
        assert r.status_code in ok, (m, url, body, r.status_code, r.text)
    if path == "":
        return  # upload dir "" is the root folder, a valid target
    files = {"files": ("x.md", b"x", "text/markdown")}
    r = c.post("/api/edit/upload", data={"dir": path}, files=files)
    assert r.status_code in ok, (path, r.text)


def test_traversal_and_bad_names(world, data_dir):
    root, outside = world
    before, before_out = snapshot_fs(root), snapshot_fs(outside)
    with editing(root, data_dir) as c:
        for p in TRAVERSAL + BAD_NAMES:
            _assert_refused(c, p)
        # query-string variants for the history reads
        for q in ("..%2Fx.md", "%2E%2E/x.md", "sub/..%2F..%2Fx.md", "%2Fetc%2Fpasswd", ".env", "lnk.md"):
            r = c.get(f"/api/edit/history?path={q}")
            assert r.status_code in (400, 403), q
        r = c.get("/api/edit/history/content?path=a.md&id=../../audit")
        assert r.status_code == 400
    assert snapshot_fs(root) == before and snapshot_fs(outside) == before_out
    assert not (root.parent / "x.md").exists()


def test_symlinks_refused(world, data_dir):
    root, outside = world
    before, before_out = snapshot_fs(root), snapshot_fs(outside)
    with editing(root, data_dir) as c:
        for p in ("linkdir/x.md", "linkdir/b.md", "outlink/x.md", "outlink/victim.md", "lnk.md", "outfile.md",
                  "linkdir", "outlink", "linkdir/new/deeper.md", "outlink/new"):
            for m, url, body in _calls(p):
                r = c.request(m, url, json=body)
                assert r.status_code in (403, 404), (m, url, body, r.status_code, r.text)
            r = c.post("/api/edit/upload", data={"dir": p, "create_dir": "1"},
                       files={"files": ("x.md", b"x", "text/markdown")})
            assert r.status_code in (400, 403, 404), (p, r.text)
        # saving onto a symlinked file must not write the target
        r = c.put("/api/edit/file", json={"path": "lnk.md", "content": "pwn", "base_sha256": None})
        assert r.status_code == 403
        r = c.put("/api/edit/file", json={"path": "outfile.md", "content": "pwn", "create": True})
        assert r.status_code == 403
    assert snapshot_fs(root) == before and snapshot_fs(outside) == before_out


def test_folder_moves_and_deny_contents(world, data_dir):
    root, _ = world
    before = snapshot_fs(root)
    with editing(root, data_dir) as c:
        for to in ("sub/inner", "sub/x/y", "SUB/inner", "sub"):
            r = c.post("/api/edit/move", json={"from": "sub", "to": to, "create_parents": True})
            assert r.status_code in (400, 409), (to, r.text)
        # a folder holding deny-listed files cannot be moved or deleted (the user cannot see them)
        assert c.post("/api/edit/move", json={"from": "guarded", "to": "g2"}).status_code == 403
        assert c.post("/api/edit/delete", json={"path": "guarded"}).status_code == 403
        # renaming into a denied/ignored name
        for to in (".env", "sub/.env", "a_secret.md", "__pycache__", ".ldv-tmp-x"):
            assert c.post("/api/edit/move", json={"from": "a.md", "to": to}).status_code == 403, to
            assert c.post("/api/edit/mkdir", json={"path": to}).status_code == 403, to
    assert snapshot_fs(root) == before


def test_upload_name_rules(world, data_dir):
    root, _ = world
    with editing(root, data_dir) as c:
        for name in (".env", "x_token.md", "creds.md.pem", "a.pyc", "evil.exe", "noext", "x.html"):
            r = c.post("/api/edit/upload", data={"dir": "sub"}, files={"files": (name, b"x", "text/plain")})
            assert r.status_code in (403, 415), (name, r.text)
        # one bad file aborts the whole request before anything is written
        r = c.post("/api/edit/upload", data={"dir": "sub"},
                   files=[("files", ("ok.md", b"x", "text/plain")), ("files", ("bad.exe", b"x", "text/plain"))])
        assert r.status_code == 415
        assert not (root / "sub" / "ok.md").exists()


def test_case_variant_of_existing_denied(tmp_path, data_dir):
    root = tmp_path / "r2"
    write(root / "doc.md", "d\n")
    write(root / "Secret.txt", "s\n")
    with editing(root, data_dir, no_default_deny=True, deny=["secret.txt"]) as c:
        r = c.put("/api/edit/file", json={"path": "SECRET.TXT", "content": "x", "create": True})
        assert r.status_code == 403
        r = c.post("/api/edit/move", json={"from": "doc.md", "to": "\u017fecret.txt"})
        assert r.status_code == 403
    assert (root / "Secret.txt").read_text() == "s\n" and (root / "doc.md").exists()
