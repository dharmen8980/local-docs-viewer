"""Regression tests for review findings (deny bypasses, long-line lookup, index races, symlinks)."""

import os
import unicodedata

import pytest

from conftest import running, wait_until, write
from viewer.config import Settings
from viewer.paths import PathGuard
from viewer.search import SearchIndex, match_lines, needles_for
from viewer.store import Store

ENDPOINTS = ("/api/file", "/api/content", "/api/text", "/api/raw", "/api/csv")


def _case_insensitive(root) -> bool:
    probe = root / "zqCaseProbe"
    probe.write_text("x")
    try:
        return os.path.exists(root / "zqcaseprobe")
    finally:
        probe.unlink()


def test_long_s_does_not_bypass_deny(root):
    write(root / "sub" / "secret.txt", "zqsecretdata\n")
    write(root / "sub" / "ok.md", "fine\n")
    variants = ["sub/secret.txt", "sub/SECRET.TXT", "sub/ſecret.txt", "sub/./ſecret.txt",
                "sub/ſECRET.txt", "ſub/ſecret.txt"]
    with running(root) as c:
        for rel in variants:
            for ep in ENDPOINTS:
                r = c.get(ep, params={"path": rel})
                assert r.status_code in (403, 404), (ep, rel, r.status_code)
                assert b"zqsecretdata" not in r.content
            r = c.get("/api/text", params={"path": rel, "line": 1})
            assert b"zqsecretdata" not in r.content
        # allowed files still work, and a differently-cased request maps to the on-disk name
        assert c.get("/api/file", params={"path": "sub/ok.md"}).status_code == 200
        if _case_insensitive(root):
            r = c.get("/api/file", params={"path": "SUB/OK.md"})
            assert r.status_code == 200 and r.json()["path"] == "sub/ok.md"


def test_long_s_symlink_target_is_denied(root):
    write(root / "secret.txt", "zqsecretdata\n")
    os.symlink("ſecret.txt", root / "link.md")
    with running(root) as c:
        assert "link.md" not in {f["path"] for f in c.get("/api/tree").json()["files"]}
        for ep in ENDPOINTS:
            r = c.get(ep, params={"path": "link.md"})
            assert r.status_code in (403, 404), (ep, r.status_code)
            assert b"zqsecretdata" not in r.content


def test_custom_pattern_unicode_normalisation(root):
    nfc = unicodedata.normalize("NFC", "café")
    nfd = unicodedata.normalize("NFD", nfc)
    write(root / f"{nfc}.txt", "zqcafedata\n")
    write(root / "plain.txt", "ok\n")
    with running(root, deny=[f"*{nfc}*"]) as c:
        assert {f["path"] for f in c.get("/api/tree").json()["files"]} == {"plain.txt"}
        for rel in (f"{nfc}.txt", f"{nfd}.txt", f"{nfd.upper()}.TXT"):
            for ep in ENDPOINTS:
                r = c.get(ep, params={"path": rel})
                assert r.status_code in (403, 404), (ep, rel, r.status_code)
                assert b"zqcafedata" not in r.content
    s = Settings.make(str(root), deny=[f"*{nfd}*"])  # NFD pattern also matches NFC names
    assert PathGuard(s).is_denied(f"{nfc}.txt")


def test_line_lookup_with_line_longer_than_window(root):
    lines = [f"line {i}\n" for i in range(1, 2001)]
    lines.append("L" * 400_000 + "\n")  # line 2001: longer than LINE_WINDOW / 2
    lines += [f"after {i}\n" for i in range(5)]
    write(root / "big.log", "".join(lines))
    with running(root) as c:
        r = c.get("/api/text", params={"path": "big.log", "line": 2001}).json()
        seg = r["segments"][0]
        first = seg["start_line"]
        last = first + seg["text"].count("\n") - (1 if seg["text"].endswith("\n") else 0)
        assert first <= 2001 <= last, (first, last, seg["start"], seg["end"])


def test_match_lines_prefers_lines_with_all_terms():
    body = "# Identity design\n" + "design notes\n" * 10 + "| Failure modes | KMS Sign failure: retry |\n"
    q = "KMS Sign failure"
    matches, count = match_lines(body, needles_for(q), q.split())
    assert matches[0]["line"] == 12
    assert count == 12


def _make_store(root):
    s = Settings.make(str(root))
    store = Store(PathGuard(s))
    store.full_scan()
    return store, SearchIndex(store, s.search_max_bytes)


def test_stale_upsert_does_not_drop_fresh_row(root):
    f = write(root / "f.md", "one\n")
    store, ix = _make_store(root)
    stale = store.get("f.md")
    f.write_text("two two\n")
    os.utime(f, ns=(stale.mtime_ns + 10**9, stale.mtime_ns + 10**9))
    store.full_scan()
    ix.upsert(store.get("f.md"))
    assert ix.search("two")["content"]
    ix.upsert(stale)  # a slower thread finishing with the old Entry
    assert ix.search("two")["content"], "fresh row was deleted by a stale upsert"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_in_root_symlink_refreshed_with_target(root):
    t = write(root / "a" / "target.md", "short\n")
    os.symlink("a/target.md", root / "link.md")
    store, _ix = _make_store(root)
    assert store.get("link.md").size == t.stat().st_size
    t.write_text("much longer content now\n")
    ch = store.apply_scopes(["a/target.md"])  # what the watcher reports
    assert ch is not None and "link.md" in ch.modified
    assert store.get("link.md").size == t.stat().st_size


def test_in_root_symlink_live(root):
    t = write(root / "a" / "target.md", "short\n")
    os.symlink("a/target.md", root / "link.md")
    with running(root, watch=True) as c:
        import time
        time.sleep(0.3)
        t.write_text("much longer content now\n")
        size = t.stat().st_size

        def link_size():
            files = {f["path"]: f["size"] for f in c.get("/api/tree").json()["files"]}
            return files.get("link.md") == size

        wait_until(link_size, timeout=10)


def test_forwarded_host_checked(root):
    """The `next dev` proxy forwards with Host 127.0.0.1; the browser's Host arrives in
    X-Forwarded-Host and must be validated too (DNS-rebinding defence)."""
    write(root / "ok.md", "ok\n")
    with running(root) as c:
        assert c.get("/api/config", headers={"x-forwarded-host": "localhost:3000"}).status_code == 200
        assert c.get("/api/config", headers={"x-forwarded-host": "127.0.0.1:3000"}).status_code == 200
        for bad in ("evil.example:3000", "127.0.0.1:3000, evil.example"):
            r = c.get("/api/content", params={"path": "ok.md"}, headers={"x-forwarded-host": bad})
            assert r.status_code == 400 and b"ok\\n" not in r.content
        r = c.get("/api/config", headers={"forwarded": 'for=1.2.3.4;host="evil.example"'})
        assert r.status_code == 400
