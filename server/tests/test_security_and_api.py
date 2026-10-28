"""Security headers, host checks, methods, misc endpoints."""

import os

import pytest

from conftest import running, write
from viewer.app import CSP, find_repo_prefix


@pytest.fixture
def tree(tmp_path, root):
    write(root / "doc.md", "# Title\n\nSome **markdown** with zqmdword.\n")
    write(root / "img.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    write(root / "img.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 20)
    write(root / "doc.pdf", b"%PDF-1.4\n")
    write(root / "script.py", "print('zqpyword')\n")
    write(root / "Dockerfile", "FROM scratch\n")
    write(root / "parity_logs" / "run_offset", "123\n")
    write(root / "blob.bin", b"\0\1\2\3")
    write(root / "data.tsv", "a\tb\n1\t2\n")
    write(root / "semi.csv", "a;b;c\n1;2;3\n4;5;6\n")
    write(root / "__pycache__" / "m.pyc", b"\0")
    write(root / ".DS_Store", b"\0")
    write(root / "sub" / ".DS_Store", b"\0")
    write(root / "sub" / "keep.txt", "keep\n")
    return root


def test_headers_hosts_methods(tree):
    with running(tree) as c:
        r = c.get("/api/tree")
        assert r.headers["content-security-policy"] == CSP
        assert r.headers["referrer-policy"] == "no-referrer"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert "access-control-allow-origin" not in r.headers
        assert c.get("/api/tree", headers={"host": "evil.com"}).status_code == 400
        assert c.get("/api/tree", headers={"host": "localhost:8765"}).status_code == 200
        for m in ("POST", "PUT", "DELETE", "PATCH"):
            r = c.request(m, "/api/tree")
            assert r.status_code == 405
        assert c.post("/api/whatever").status_code == 405
        r = c.get("/api/does/not/exist")
        assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")
        assert c.head("/api/tree").status_code == 200


def test_ignore_list(tree):
    with running(tree) as c:
        t = c.get("/api/tree").json()
        paths = {f["path"] for f in t["files"]}
        assert not any("__pycache__" in p or ".DS_Store" in p for p in paths)
        assert "__pycache__" not in t["dirs"] and "sub" in t["dirs"]
        assert "sub/keep.txt" in paths
    with running(tree, ignore=["sub"]) as c:
        t = c.get("/api/tree").json()
        assert "sub" not in t["dirs"]
        assert c.get("/api/file?path=sub/keep.txt").status_code == 403


def test_kinds_and_raw(tree):
    with running(tree) as c:
        kinds = {f["path"]: f["kind"] for f in c.get("/api/tree").json()["files"]}
        assert kinds["doc.md"] == "markdown" and kinds["script.py"] == "code"
        assert kinds["Dockerfile"] == "code" and kinds["parity_logs/run_offset"] == "text"
        assert kinds["blob.bin"] == "binary" and kinds["img.svg"] == "image" and kinds["doc.pdf"] == "pdf"
        f = c.get("/api/file?path=img.png").json()
        assert f["mime"] == "image/png" and f["name"] == "img.png" and isinstance(f["mtime"], float)

        r = c.get("/api/raw?path=img.svg")
        assert r.headers["content-type"].startswith("image/svg+xml")
        assert "sandbox" in r.headers["content-security-policy"]
        assert r.headers["content-disposition"].startswith("inline")
        r = c.get("/api/raw?path=doc.pdf")
        assert r.headers["content-type"] == "application/pdf"
        assert r.headers["content-disposition"].startswith("inline")
        r = c.get("/api/raw?path=doc.md")
        assert r.headers["content-type"] == "application/octet-stream"
        assert r.headers["content-disposition"].startswith("attachment")
        assert r.headers["x-content-type-options"] == "nosniff"


def test_csv_xlsx(tree):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "First"
    ws.append(["name", "n", None])
    for i in range(1200):
        ws.append([f"r{i}", i, 1.5])
    wb.create_sheet("Second").append(["only"])
    wb.save(tree / "book.xlsx")
    with running(tree) as c:
        r = c.get("/api/csv?path=data.tsv").json()
        assert r["header"] == ["a", "b"] and r["rows"] == [["1", "2"]] and not r["truncated"]
        r = c.get("/api/csv?path=semi.csv").json()
        assert r["header"] == ["a", "b", "c"] and r["total_rows"] == 2
        assert c.get("/api/csv?path=doc.md").status_code == 400
        r = c.get("/api/xlsx?path=book.xlsx").json()
        first, second = r["sheets"]
        assert first["name"] == "First" and first["rows"][0] == ["name", "n", ""]
        assert first["rows"][2] == ["r1", "1", "1.5"]
        assert len(first["rows"]) == 1000 and first["total_rows"] == 1201 and first["truncated"]
        assert second["rows"] == [["only"]]


def test_csv_truncation(root):
    write(root / "many.csv", "h1,h2\n" + "".join(f"{i},x\n" for i in range(6000)))
    with running(root) as c:
        r = c.get("/api/csv?path=many.csv").json()
        assert len(r["rows"]) == 5000 and r["total_rows"] == 6000 and r["truncated"]


def test_search_features(tree):
    write(tree / "notes" / "alpha.md", "first line\nthe Quick-Brown fox jumps\nquick again\n")
    write(tree / "notes" / "beta.log", "nothing\n")
    write(tree / "other" / "gamma.txt", "quick brown\n")
    with running(tree) as c:
        r = c.get("/api/search", params={"q": "quick-brown"}).json()
        paths = [h["path"] for h in r["content"]]
        assert "notes/alpha.md" in paths
        hit = next(h for h in r["content"] if h["path"] == "notes/alpha.md")
        m = hit["matches"][0]
        assert m["line"] == 2 and m["offset"] == len(b"first line\n")
        s, e = m["ranges"][0]
        assert m["text"][s:e].lower() == "quick-brown"
        assert hit["match_count"] == 2
        # prefix on the last term
        assert c.get("/api/search", params={"q": "jum"}).json()["content"][0]["path"] == "notes/alpha.md"
        # folder and type filters
        r = c.get("/api/search", params={"q": "quick", "folder": "other"}).json()
        assert [h["path"] for h in r["content"]] == ["other/gamma.txt"]
        r = c.get("/api/search", params={"q": "quick", "types": "md"}).json()
        assert [h["path"] for h in r["content"]] == ["notes/alpha.md"]
        r = c.get("/api/search", params={"q": "123", "types": "(none)"}).json()
        assert [h["path"] for h in r["content"]] == ["parity_logs/run_offset"]
        # file names
        r = c.get("/api/search", params={"q": "alpha"}).json()
        assert r["names"][0] == {"path": "notes/alpha.md", "name": "alpha.md", "kind": "markdown"}
        # hostile FTS input never errors
        for q in ['"', 'a" OR "b', "NEAR(", "*", "(", "AND", "col:x", "^", '""""']:
            r = c.get("/api/search", params={"q": q})
            assert r.status_code == 200, q
            assert r.json()["indexing"] is False


def test_config_repo_prefix(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / "local_dev").mkdir()
    assert find_repo_prefix(os.path.realpath(repo / "local_dev")) == "local_dev/"
    assert find_repo_prefix(os.path.realpath(repo)) == ""
    with running(repo / "local_dev") as c:
        cfg = c.get("/api/config").json()
        assert cfg["root_name"] == "local_dev" and cfg["repo_prefix"] == "local_dev/"
        assert cfg["search_max_bytes"] == 2 * 1024 * 1024 and "version" in cfg


def test_static_ui_mounted_after_api(tmp_path, root):
    from fastapi.testclient import TestClient

    from viewer.app import create_app
    from viewer.config import Settings

    ui = tmp_path / "out"
    write(ui / "index.html", "<html>zqindex</html>")
    write(ui / "_next" / "static" / "app.js", "console.log(1)")
    app = create_app(Settings.make(str(root), watch=False, reconcile_interval=0, ui_dir=str(ui)))
    with TestClient(app, base_url="http://127.0.0.1") as c:
        r = c.get("/?p=some/file.md")
        assert r.status_code == 200 and "zqindex" in r.text
        assert r.headers["content-security-policy"] == CSP
        assert c.get("/_next/static/app.js").status_code == 200
        r = c.get("/api/unknown")
        assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")
        assert "zqindex" not in r.text
        assert c.post("/").status_code == 405
