"""Path traversal is refused everywhere; outside symlinks are hidden."""

import os

import pytest

from conftest import running, write

ENDPOINTS = ["/api/file", "/api/content", "/api/text", "/api/raw", "/api/csv"]
BAD = ["../outside.txt", "a/../../outside.txt", "%2e%2e/outside.txt", "a/%2e%2e/%2e%2e/outside.txt",
       "/etc/passwd", "evil%00.txt", "..", ".", "", "link_out.txt", "link_out.csv", "linkdir/x.txt"]


@pytest.fixture
def setup(tmp_path, root):
    write(tmp_path / "outside.txt", "OUTSIDESECRETWORD\n")
    write(tmp_path / "outside.csv", "a,b\nOUTSIDESECRETWORD,2\n")
    write(tmp_path / "outdir" / "x.txt", "OUTSIDESECRETWORD\n")
    write(root / "a" / "inside.txt", "hello inside\n")
    write(root / "data.csv", "a,b\n1,2\n")
    os.symlink(tmp_path / "outside.txt", root / "link_out.txt")
    os.symlink(tmp_path / "outside.csv", root / "link_out.csv")
    os.symlink(tmp_path / "outdir", root / "linkdir")
    os.symlink(root / "a" / "inside.txt", root / "link_in.txt")
    return root


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_traversal_refused(setup, endpoint):
    with running(setup) as c:
        for bad in BAD:
            r = c.get(f"{endpoint}?path={bad}")
            assert r.status_code in (400, 403, 404), (endpoint, bad, r.status_code)
            assert b"OUTSIDESECRETWORD" not in r.content
        # missing parameter
        assert c.get(endpoint).status_code == 400


def test_valid_paths_work(setup):
    with running(setup) as c:
        assert c.get("/api/file?path=a/inside.txt").json()["kind"] == "text"
        assert c.get("/api/content?path=a/inside.txt").json()["text"] == "hello inside\n"
        assert c.get("/api/raw?path=a/./inside.txt").content == b"hello inside\n"
        assert c.get("/api/csv?path=data.csv").json()["rows"] == [["1", "2"]]
        # in-root symlink to an in-root file is fine
        assert c.get("/api/content?path=link_in.txt").json()["text"] == "hello inside\n"
        assert c.get("/api/file?path=nope.txt").status_code == 404


def test_outside_symlinks_absent_from_tree_and_search(setup):
    with running(setup) as c:
        tree = c.get("/api/tree").json()
        paths = {f["path"] for f in tree["files"]}
        assert "link_out.txt" not in paths and "link_out.csv" not in paths
        assert not any(p.startswith("linkdir") for p in paths)
        assert "linkdir" not in tree["dirs"]
        assert {"a/inside.txt", "data.csv", "link_in.txt"} <= paths
        res = c.get("/api/search?q=OUTSIDESECRETWORD").json()
        assert res["names"] == [] and res["content"] == []
