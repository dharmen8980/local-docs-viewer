"""Editing is off by default; when on, every /api/edit request needs the token and same-origin."""

import os

import pytest

from conftest import editing, running, snapshot_fs, write
from viewer.app import create_app
from viewer.config import ConfigError, Settings, settings_from_args

EDIT_ENDPOINTS = [
    ("PUT", "/api/edit/file", {"path": "new.md", "content": "x", "base_sha256": None}),
    ("POST", "/api/edit/mkdir", {"path": "newdir"}),
    ("POST", "/api/edit/move", {"from": "a.md", "to": "b.md"}),
    ("POST", "/api/edit/copy", {"from": "a.md", "to": "c.md"}),
    ("POST", "/api/edit/delete", {"path": "a.md"}),
    ("GET", "/api/edit/trash", None),
    ("POST", "/api/edit/trash/restore", {"id": "00000000000000000000-00000000"}),
    ("POST", "/api/edit/trash/purge", {"all": True}),
    ("GET", "/api/edit/history?path=a.md", None),
    ("GET", "/api/edit/history/content?path=a.md&id=00000000000000000000-00000000", None),
    ("POST", "/api/edit/history/restore", {"path": "a.md", "id": "00000000000000000000-00000000"}),
    ("GET", "/api/edit/audit?limit=5", None),
]


@pytest.fixture
def tree(root):
    write(root / "a.md", "# A\n")
    write(root / "sub" / "b.md", "b\n")
    return root


def test_disabled_by_default(tree, data_dir):
    before = snapshot_fs(tree)
    with running(tree, data_dir=str(data_dir)) as c:
        cfg = c.get("/api/config").json()
        assert cfg["edit_enabled"] is False and "edit_token" not in cfg
        for method, url, body in EDIT_ENDPOINTS:
            for m in {method, "GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"}:
                r = c.request(m, url, json=body, headers={"X-Edit-Token": "guess"})
                assert r.status_code == 403, (m, url, r.status_code)
                if m != "HEAD":
                    assert r.json() == {"detail": "editing disabled"}
        files = {"files": ("x.md", b"hello", "text/markdown")}
        assert c.post("/api/edit/upload", data={"dir": ""}, files=files).status_code == 403
        assert c.post("/api/edit", json={}).status_code == 403
        # everything else still 405s for non-GET methods
        assert c.post("/api/tree").status_code == 405
        assert c.put("/api/file?path=a.md").status_code == 405
    assert snapshot_fs(tree) == before
    assert not data_dir.exists()  # read-only mode never creates the data dir


def test_settings_from_args_and_env(tmp_path):
    s = settings_from_args(["--root", str(tmp_path)], env={})
    assert s.allow_edit is False and s.history_keep == 50 and s.upload_max_bytes == 25 * 1024 * 1024
    assert "md" in s.upload_ext and "exe" not in s.upload_ext
    assert ".ldv-tmp-*" in s.ignore
    s = settings_from_args(["--root", str(tmp_path), "--data-dir", str(tmp_path / "d"), "--history-keep", "3",
                            "--upload-max-mb", "1", "--upload-ext", "md,TXT", "--upload-ext", ".png"], env={})
    assert s.data_dir == os.path.realpath(tmp_path / "d") and s.history_keep == 3
    assert s.upload_max_bytes == 1024 * 1024 and s.upload_ext == ("md", "png", "txt")
    s = settings_from_args(["--root", str(tmp_path)], env={"DOCS_VIEWER_ALLOW_EDIT": "1",
                                                           "DOCS_VIEWER_DATA_DIR": str(tmp_path / "e")})
    assert s.allow_edit and s.data_dir == os.path.realpath(tmp_path / "e")
    assert settings_from_args(["--root", str(tmp_path), "--allow-edit"], env={}).allow_edit


def test_data_dir_inside_root_refused(tmp_path, root):
    for dd in (root / ".data", root / "sub" / "deeper", root, tmp_path):
        s = Settings.make(str(root), allow_edit=True, data_dir=str(dd), watch=False, reconcile_interval=0)
        with pytest.raises(ConfigError):
            create_app(s)
    # via a symlink that resolves inside the root
    os.symlink(root, tmp_path / "alias")
    s = Settings.make(str(root), allow_edit=True, data_dir=str(tmp_path / "alias" / "d"))
    with pytest.raises(ConfigError):
        create_app(s)
    assert not (root / ".data").exists() and not (root / "sub").exists()


def test_cli_refuses_overlapping_data_dir(root):
    from viewer.cli import main

    with pytest.raises(SystemExit) as e:
        main(["--root", str(root), "--allow-edit", "--data-dir", str(root / "d"), "--ui-dir", str(root) + "-x"])
    assert "refusing to start" in str(e.value)


def test_read_only_hides_in_root_data_dir(root):
    write(root / "doc.md", "zqvisible\n")
    write(root / ".data" / "history" / "x" / "v1", "zqsecrethistory\n")
    write(root / ".data" / "audit.jsonl", "{}\n")
    with running(root, data_dir=str(root / ".data")) as c:
        t = c.get("/api/tree").json()
        assert all(not p["path"].startswith(".data") for p in t["files"]) and ".data" not in t["dirs"]
        assert c.get("/api/file?path=.data/audit.jsonl").status_code == 403
        assert not c.get("/api/search?q=zqsecrethistory").json()["content"]


def test_auth(tree, data_dir):
    with editing(tree, data_dir) as c:
        tok = c.token
        assert isinstance(tok, str) and len(tok) >= 40
        cfg = c.get("/api/config").json()
        assert cfg["edit_enabled"] is True
        assert {"deny_patterns", "ignore_patterns", "upload_ext", "upload_max_bytes"} <= set(cfg)
        body = {"path": "x.md", "content": "x", "base_sha256": None}
        ok = c.put("/api/edit/file", json=body)
        assert ok.status_code == 200, ok.text
        del c.headers["X-Edit-Token"]
        body["path"] = "y.md"
        assert c.put("/api/edit/file", json=body).status_code == 403
        assert c.put("/api/edit/file", json=body, headers={"X-Edit-Token": tok + "x"}).status_code == 403
        assert c.put("/api/edit/file", json=body, headers={"X-Edit-Token": ""}).status_code == 403
        assert c.get("/api/edit/history?path=x.md").status_code == 403
        assert c.get("/api/edit/trash").status_code == 403
        assert c.get("/api/edit/audit").status_code == 403
        c.headers["X-Edit-Token"] = tok
        assert c.get("/api/edit/history?path=x.md").status_code == 200
        bad_headers = [
            {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "none"},
            {"Origin": "http://evil.com"}, {"Origin": "null"}, {"Origin": "http://127.0.0.1:9999"},
            {"Origin": "https://127.0.0.1"}, {"Origin": "http://localhost.evil.com"},
        ]
        for h in bad_headers:
            r = c.put("/api/edit/file", json=body, headers=h)
            assert r.status_code == 403, h
            assert c.get("/api/edit/trash", headers=h).status_code == 403, h
        assert c.put("/api/edit/file", json=body, headers={"host": "evil.com"}).status_code == 400
        assert c.put("/api/edit/file", json=body, headers={"X-Forwarded-Host": "evil.com"}).status_code == 400
        # CSRF "simple request" content types are refused before the body is looked at
        for ct in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"):
            r = c.put("/api/edit/file", content=b'{"path":"y.md","content":"x","base_sha256":null}',
                      headers={"content-type": ct})
            assert r.status_code == 403, ct
        r = c.post("/api/edit/upload", content=b"{}", headers={"content-type": "application/json"})
        assert r.status_code == 403
        assert c.patch("/api/edit/file", json=body).status_code == 405
        # allowed: same-origin, own origin and the dev server origin
        for i, h in enumerate(({"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8765"},
                               {"Origin": "http://localhost:3000"}, {"Origin": "http://127.0.0.1:3000"})):
            r = c.put("/api/edit/file", json={**body, "path": f"ok-{i}.md"}, headers=h)
            assert r.status_code == 200, (h, r.text)
        assert not (tree / "y.md").exists()
        # a cross-site page must not be able to read the token either
        assert "edit_token" not in c.get("/api/config", headers={"Sec-Fetch-Site": "cross-site"}).json()
        # other routes keep refusing writes
        assert c.post("/api/tree", headers={"X-Edit-Token": tok}).status_code == 405


def test_body_size_limit(tree, data_dir):
    with editing(tree, data_dir) as c:
        big = "x" * (2 * 1024 * 1024 + 1)
        r = c.put("/api/edit/file", json={"path": "big.md", "content": big, "base_sha256": None})
        assert r.status_code == 413
        r = c.put("/api/edit/file", content=b"x" * (13 * 1024 * 1024),
                  headers={"content-type": "application/json"})
        assert r.status_code == 413
        def chunks():  # no content-length: the streaming limit applies
            for _ in range(14):
                yield b"x" * (1024 * 1024)

        r = c.put("/api/edit/file", content=chunks(), headers={"content-type": "application/json"})
        assert r.status_code == 413
        assert not (tree / "big.md").exists()
