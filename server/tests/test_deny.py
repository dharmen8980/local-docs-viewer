"""Deny-listed files are refused by the API and never listed or indexed."""

import os

from conftest import running, write

DENIED = {
    ".env": "zqdenyenv",
    ".env.local": "zqdenyenvlocal",
    "api_token.txt": "zqdenytoken",
    "my_secret.md": "zqdenysecret",
    "aws_credentials.json": '{"k": "zqdenycred"}',
    "server.pem": "zqdenypem",
    "id.key": "zqdenykey",
    "secrets/plain.txt": "zqdenyfolder",
    "API_TOKEN.TXT": "zqdenyupper",
}
WORDS = ["zqdenyenv", "zqdenyenvlocal", "zqdenytoken", "zqdenysecret", "zqdenycred", "zqdenypem",
         "zqdenykey", "zqdenyfolder", "zqdenyupper", "zqdeny"]


def make(root):
    for rel, text in DENIED.items():
        if rel == "API_TOKEN.TXT" and os.path.exists(root / "api_token.txt"):
            write(root / "sub" / rel, text)  # case-insensitive filesystems
        else:
            write(root / rel, text)
    write(root / "ok.md", "visible zqokword\n")
    os.symlink(".env", root / "innocent.md")
    write(root / "__pycache__" / "x.cpython-313.pyc", "zqdenypyc")
    write(root / ".DS_Store", "zqdenyds")
    write(root / "mod.pyc", "zqdenypyc2")


def test_denied_refused_everywhere(root):
    make(root)
    with running(root) as c:
        tree = c.get("/api/tree").json()
        paths = {f["path"] for f in tree["files"]}
        assert paths == {"ok.md"}, paths
        assert tree["dirs"] == [] or set(tree["dirs"]) <= {"sub"}
        targets = list(DENIED) + ["sub/API_TOKEN.TXT", "innocent.md", "secrets", ".DS_Store",
                                  "__pycache__/x.cpython-313.pyc", "mod.pyc", "SECRETS/plain.txt"]
        for rel in targets:
            for ep in ("/api/file", "/api/content", "/api/text", "/api/raw", "/api/csv"):
                r = c.get(ep, params={"path": rel})
                assert r.status_code in (403, 404), (ep, rel, r.status_code)
                assert b"zqdeny" not in r.content
        for w in WORDS:
            res = c.get("/api/search", params={"q": w}).json()
            assert res["content"] == [] and res["names"] == [], w
        for q in ["token", "secret", "credential", "env", "pem", "key"]:
            res = c.get("/api/search", params={"q": q}).json()
            assert res["names"] == [], q
        assert c.get("/api/search?q=zqokword").json()["content"][0]["path"] == "ok.md"


def test_custom_deny_and_no_default(root):
    write(root / "internal_notes.md", "zqcustomword\n")
    write(root / "my_secret.md", "zqsecretword\n")
    write(root / "plain.md", "zqplainword\n")
    with running(root, deny=["internal*"]) as c:
        paths = {f["path"] for f in c.get("/api/tree").json()["files"]}
        assert paths == {"plain.md"}
        assert c.get("/api/file?path=internal_notes.md").status_code == 403
        assert c.get("/api/search?q=zqcustomword").json()["content"] == []
    with running(root, no_default_deny=True) as c:
        paths = {f["path"] for f in c.get("/api/tree").json()["files"]}
        assert paths == {"plain.md", "my_secret.md", "internal_notes.md"}
        assert c.get("/api/search?q=zqsecretword").json()["content"][0]["path"] == "my_secret.md"
    with running(root, no_default_deny=True, deny=["*notes*"]) as c:
        paths = {f["path"] for f in c.get("/api/tree").json()["files"]}
        assert paths == {"plain.md", "my_secret.md"}


def test_settings_from_args_and_env(root):
    from viewer.config import settings_from_args

    s = settings_from_args(["--root", str(root), "--deny", "a*", "--ignore", "b*", "--port", "9000"],
                           env={"DOCS_VIEWER_DENY": "c*, d*", "DOCS_VIEWER_IGNORE": "e*"})
    assert s.port == 9000 and s.root == os.path.realpath(root)
    assert {".env", "*token*", "a*", "c*", "d*"} <= set(s.deny)
    assert {"__pycache__", "b*", "e*"} <= set(s.ignore)
    s = settings_from_args(["--no-default-deny"], env={"DOCS_VIEWER_ROOT": str(root), "DOCS_VIEWER_PORT": "9001",
                                                       "DOCS_VIEWER_SEARCH_MAX_MB": "1"})
    assert s.deny == () and s.port == 9001 and s.search_max_bytes == 1024 * 1024
