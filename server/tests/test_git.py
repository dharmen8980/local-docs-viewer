"""Read-only git views: status, HEAD version, blame; path rules; untrusted repo config."""

import os
import subprocess
import time

import pytest
from conftest import running, snapshot_fs, write

from viewer import git as gitmod
from viewer.config import settings_from_args

GIT = gitmod.find_git("")
pytestmark = pytest.mark.skipif(GIT is None, reason="git (2.32+) not available")


def g(repo, *args, env=None):
    e = {"PATH": "/usr/bin:/bin", "HOME": str(repo), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
         "GIT_AUTHOR_NAME": "Ann Author", "GIT_AUTHOR_EMAIL": "ann@example.com",
         "GIT_COMMITTER_NAME": "Ann Author", "GIT_COMMITTER_EMAIL": "ann@example.com", **(env or {})}
    return subprocess.run([GIT, *args], cwd=repo, env=e, check=True, capture_output=True).stdout.decode()


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    g(r, "init", "-q", "-b", "main")
    write(r / "docs" / "a.md", "# A\n\none\ntwo\nthree\n")
    write(r / "docs" / "keep.md", "same\n")
    write(r / "top.txt", "top\n")
    write(r / "docs" / ".env", "SECRET=1\n")
    write(r / "docs" / "old.md", "old\n")
    g(r, "add", "-A")
    g(r, "commit", "-q", "-m", "first commit")
    return r


def files_of(c):
    res = c.get("/api/git/status")
    assert res.status_code == 200, res.text
    return {f["path"]: f for f in res.json()["files"]}


def test_status_counts_and_kinds(repo):
    write(repo / "docs" / "a.md", "# A\n\none\nTWO\nthree\nfour\n")
    write(repo / "docs" / "new.md", "n1\nn2\n")
    (repo / "docs" / "old.md").unlink()
    g(repo, "mv", "top.txt", "docs/moved.txt")
    with running(repo) as c:
        cfg = c.get("/api/config").json()
        assert cfg["git_enabled"] is True
        body = c.get("/api/git/status").json()
        assert body["branch"] == "main" and len(body["head"]) == 12
        f = {x["path"]: x for x in body["files"]}
        assert set(f) == {"docs/a.md", "docs/new.md", "docs/old.md", "docs/moved.txt"}
        assert (f["docs/a.md"]["status"], f["docs/a.md"]["added"], f["docs/a.md"]["removed"]) == ("M", 2, 1)
        assert (f["docs/new.md"]["status"], f["docs/new.md"]["added"], f["docs/new.md"]["removed"]) == ("??", 2, 0)
        assert (f["docs/old.md"]["status"], f["docs/old.md"]["removed"], f["docs/old.md"]["mtime"]) == ("D", 1, None)
        assert f["docs/moved.txt"]["status"] == "R" and f["docs/moved.txt"]["origPath"] == "top.txt"
        assert f["docs/a.md"]["kind"] == "markdown"
        assert c.get("/api/git/status").headers["cache-control"] == "no-store"


def test_status_hides_denied_and_ignored(repo):
    write(repo / "docs" / ".env", "SECRET=2\n")  # modified, but denied
    write(repo / "notes-secret.md", "x\n")  # untracked, denied
    write(repo / "node_modules" / "m.js", "x\n")  # ignored folder
    with running(repo) as c:
        assert files_of(c) == {}
    with running(repo, ignore=["docs"]) as c:
        write(repo / "docs" / "a.md", "changed\n")
        assert "docs/a.md" not in files_of(c)


def test_subfolder_root(repo):
    write(repo / "docs" / "a.md", "changed\n")
    write(repo / "elsewhere.md", "outside\n")
    g(repo, "mv", "top.txt", "docs/in.txt")  # renamed in from outside the root
    with running(repo / "docs") as c:
        body = c.get("/api/git/status").json()
        assert body["prefix"] == "docs/"
        f = {x["path"]: x for x in body["files"]}
        assert set(f) == {"a.md", "in.txt"}
        assert f["in.txt"]["status"] == "A" and f["in.txt"]["origPath"] is None and f["in.txt"]["added"] == 1
        head = c.get("/api/git/file", params={"path": "a.md"}).json()
        assert head["head"]["text"] == "# A\n\none\ntwo\nthree\n" and head["status"] == "M"
        assert c.get("/api/git/file", params={"path": "in.txt"}).json()["head"] is None  # HEAD side not shown
        assert c.get("/api/git/file", params={"path": "../top.txt"}).status_code == 403
        bl = c.get("/api/git/blame", params={"path": "keep.md"}).json()
        assert bl["tracked"] and bl["lines"][0]["text"] == "same"


def test_file_head_versions(repo):
    write(repo / "docs" / "new.md", "brand new\n")
    (repo / "docs" / "old.md").unlink()
    write(repo / "bin.dat", b"\0\1\2")
    g(repo, "add", "bin.dat")
    g(repo, "commit", "-q", "-m", "bin")
    with running(repo) as c:
        same = c.get("/api/git/file", params={"path": "docs/keep.md"}).json()
        assert same["status"] is None and same["head"]["text"] == "same\n" and same["exists"]
        new = c.get("/api/git/file", params={"path": "docs/new.md"}).json()
        assert new["status"] == "??" and new["head"] is None
        gone = c.get("/api/git/file", params={"path": "docs/old.md"}).json()
        assert gone["status"] == "D" and not gone["exists"] and gone["head"]["text"] == "old\n"
        assert c.get("/api/git/file", params={"path": "bin.dat"}).json()["head"]["binary"] is True
        assert c.get("/api/git/file", params={"path": "docs/never.md"}).status_code == 404
        assert c.get("/api/git/file", params={"path": ".git/config"}).status_code == 403
        assert c.get("/api/git/file", params={"path": "/etc/passwd"}).status_code == 403
        assert c.get("/api/git/file").status_code == 400


def test_denied_file_in_history_is_refused(repo):
    (repo / "docs" / ".env").unlink()  # still in HEAD, deleted on disk
    g(repo, "rm", "-q", "--cached", "docs/.env")
    write(repo / "SECRET.md", "s\n")
    g(repo, "add", "SECRET.md")
    g(repo, "commit", "-q", "-m", "secret")
    os.unlink(repo / "SECRET.md")
    with running(repo) as c:
        for p in ("docs/.env", "SECRET.md", "secret.md", "docs/./.env", "docs/x/../.env"):
            r = c.get("/api/git/file", params={"path": p})
            assert r.status_code in (400, 403), (p, r.text)
            assert "SECRET" not in r.text and "s\\n" not in r.text
            assert c.get("/api/git/blame", params={"path": p}).status_code in (400, 403, 404)
        assert "SECRET.md" not in files_of(c)


def test_renamed_file_head_version(repo):
    g(repo, "mv", "docs/keep.md", "docs/kept.md")
    write(repo / "docs" / "kept.md", "same\nmore\n")
    with running(repo) as c:
        f = files_of(c)["docs/kept.md"]
        assert f["status"] == "R" and f["origPath"] == "docs/keep.md"
        body = c.get("/api/git/file", params={"path": "docs/kept.md"}).json()
        assert body["origPath"] == "docs/keep.md" and body["head"]["text"] == "same\n"


def test_rename_from_denied_name_shows_nothing_of_it(repo):
    g(repo, "mv", "docs/.env", "docs/plain.txt")
    with running(repo) as c:
        f = files_of(c)["docs/plain.txt"]
        assert f["status"] == "A" and f["origPath"] is None and (f["added"], f["removed"]) == (1, 0)
        body = c.get("/api/git/file", params={"path": "docs/plain.txt"})
        assert body.json()["head"] is None and body.json()["origPath"] is None
        assert c.get("/api/git/file", params={"path": "docs/.env"}).status_code == 403
        assert ".env" not in c.get("/api/git/status").text


def test_symlink_to_denied_file_is_refused(repo):
    os.symlink("docs/.env", repo / "link.md")
    with running(repo) as c:
        assert c.get("/api/git/file", params={"path": "link.md"}).status_code == 403
        assert "link.md" not in files_of(c)


def test_blame(repo):
    write(repo / "docs" / "a.md", "# A\n\none\nTWO\nthree\n")
    g(repo, "commit", "-q", "-am", "second commit\n\nbody")
    write(repo / "docs" / "a.md", "# A\n\none\nTWO\nthree\nlocal\n")
    with running(repo) as c:
        b = c.get("/api/git/blame", params={"path": "docs/a.md"}).json()
        assert b["tracked"] and b["total"] == 6 and len(b["lines"]) == 6
        by_line = {ln["line"]: b["commits"][ln["commit"]] for ln in b["lines"]}
        assert by_line[1]["summary"] == "first commit" and by_line[1]["author"] == "Ann Author"
        assert by_line[4]["summary"] == "second commit" and len(by_line[4]["short"]) == 8
        assert by_line[6]["uncommitted"] and by_line[6]["summary"] == ""
        part = c.get("/api/git/blame", params={"path": "docs/a.md", "start": 3, "count": 2}).json()
        assert [ln["line"] for ln in part["lines"]] == [3, 4] and part["total"] == 6
        assert c.get("/api/git/blame", params={"path": "docs/a.md", "count": 999999}).status_code == 422
        write(repo / "u.md", "untracked\n")
        assert c.get("/api/git/blame", params={"path": "u.md"}).json()["tracked"] is False
        write(repo / "b.bin", b"\0\0")
        assert c.get("/api/git/blame", params={"path": "b.bin"}).status_code == 400


def test_blame_too_large(repo, monkeypatch):
    monkeypatch.setattr(gitmod, "CONTENT_MAX", 10)
    with running(repo) as c:
        assert c.get("/api/git/blame", params={"path": "docs/a.md"}).status_code == 413
        assert c.get("/api/git/file", params={"path": "docs/a.md"}).json()["head"]["tooLarge"] is True


@pytest.mark.parametrize("kind", ["fsmonitor", "external", "textconv", "filter", "process", "hooks", "pager"])
def test_malicious_config_does_not_run(repo, tmp_path, kind):
    marker = tmp_path / f"pwned-{kind}"
    script = tmp_path / "evil.sh"
    script.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat\n")
    script.chmod(0o755)
    cfg = {
        "fsmonitor": [("core.fsmonitor", str(script))],
        "external": [("diff.external", str(script))],
        "textconv": [("diff.evil.textconv", str(script))],
        "filter": [("filter.evil.clean", str(script)), ("filter.evil.smudge", str(script)),
                   ("filter.evil.required", "true")],
        "process": [("filter.evil.process", str(script)), ("filter.evil.required", "true")],
        "hooks": [("core.hooksPath", str(tmp_path))],
        "pager": [("core.pager", str(script)), ("pager.status", str(script)), ("pager.blame", str(script))],
    }[kind]
    for k, v in cfg:
        g(repo, "config", k, v)
    write(repo / ".gitattributes", "*.md diff=evil filter=evil\n")
    for hook in ("post-index-change", "reference-transaction", "pre-auto-gc"):
        (tmp_path / hook).write_text(script.read_text())
        (tmp_path / hook).chmod(0o755)
    write(repo / "docs" / "a.md", "# A\n\nchanged\n")
    write(repo / "docs" / "fresh.md", "fresh\n")
    with running(repo) as c:
        assert files_of(c)["docs/a.md"]["status"] == "M"
        assert c.get("/api/git/file", params={"path": "docs/a.md"}).json()["head"]["text"].startswith("# A")
        assert c.get("/api/git/blame", params={"path": "docs/a.md"}).json()["tracked"]
    assert not marker.exists()


@pytest.mark.parametrize("case", ["default", "no-lazy-fetch-env", "old-git"])
def test_partial_clone_never_fetches(repo, tmp_path, monkeypatch, case):
    """A promisor remote with an ext:: URL and a missing blob: reading that blob must not fetch it."""
    marker = tmp_path / "pwned-fetch"
    write(repo / "docs" / "lazy.md", "lazy\n")
    g(repo, "add", "-A")
    g(repo, "commit", "-q", "-m", "lazy")
    oid = g(repo, "rev-parse", "HEAD:docs/lazy.md").strip()
    os.remove(repo / ".git" / "objects" / oid[:2] / oid[2:])
    for k, v in [("extensions.partialClone", "origin"), ("remote.origin.promisor", "true"),
                 ("protocol.ext.allow", "always"), ("protocol.file.allow", "always"),
                 ("remote.origin.url", f"ext::sh -c touch% {marker}")]:
        g(repo, "config", k, v)
    write(repo / "docs" / "lazy.md", "changed\n")
    if case == "no-lazy-fetch-env":
        # as git before 2.45, which ignores GIT_NO_LAZY_FETCH: the protocol overrides must hold
        base = gitmod._base_env
        monkeypatch.setattr(gitmod, "_base_env", lambda exe=None: {
            k: v for k, v in base(exe).items() if k != "GIT_NO_LAZY_FETCH"})
    if case == "old-git":
        monkeypatch.setattr(gitmod, "version_of", lambda exe: (2, 44))
    with running(repo) as c:
        res = c.get("/api/git/file", params={"path": "docs/lazy.md"})
        c.get("/api/git/blame", params={"path": "docs/lazy.md"})
        st = c.get("/api/git/status")
        if case == "old-git":
            assert res.status_code == 503 and st.status_code == 503  # partial clones need 2.45+
    assert not marker.exists()


def test_worktree_attributes_assign_no_filter(repo, tmp_path, monkeypatch):
    """Attributes come from the empty tree: a driver missed by the config listing (e.g. added
    between the listing and the call) still never runs from a .gitattributes in the work tree."""
    if gitmod.version_of(GIT) < gitmod.ATTR_SOURCE_VERSION:
        pytest.skip("GIT_ATTR_SOURCE needs git 2.40+")
    marker = tmp_path / "pwned-attr"
    script = tmp_path / "evil.sh"
    script.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat\n")
    script.chmod(0o755)
    g(repo, "config", "filter.evil.clean", str(script))
    write(repo / ".gitattributes", "*.md filter=evil\n")
    write(repo / "docs" / "a.md", "# A\n\nchanged\n")
    monkeypatch.setattr(gitmod, "FILTER_KEY", gitmod.re.compile(r"(?!)"))  # no driver is blanked
    with running(repo) as c:
        assert files_of(c)["docs/a.md"]["status"] == "M"
        assert c.get("/api/git/blame", params={"path": "docs/a.md"}).json()["tracked"]
    assert not marker.exists()


def test_never_writes_inside_the_repo(repo):
    write(repo / "docs" / "a.md", "changed\n")
    write(repo / "docs" / "fresh.md", "x\n")
    time.sleep(1.1)  # past racy-git granularity: a status that refreshed the index would rewrite it
    before = snapshot_fs(repo)
    with running(repo) as c:
        files_of(c)
        c.get("/api/git/file", params={"path": "docs/a.md"})
        c.get("/api/git/blame", params={"path": "docs/a.md"})
    assert snapshot_fs(repo) == before


def test_not_a_repo_turns_git_off(root):
    write(root / "a.md", "x\n")
    with running(root) as c:
        assert c.get("/api/config").json()["git_enabled"] is False
        r = c.get("/api/git/status")
        assert r.status_code == 404 and "not enabled" in r.json()["detail"]


def test_git_off_setting(repo):
    with running(repo, git="off") as c:
        assert c.get("/api/config").json()["git_enabled"] is False
        assert c.get("/api/git/blame", params={"path": "docs/a.md"}).status_code == 404
    with running(repo, git="/nonexistent/git") as c:
        assert c.get("/api/config").json()["git_enabled"] is False


def test_root_inside_dot_git(repo):
    with running(repo / ".git") as c:
        assert c.get("/api/config").json()["git_enabled"] is False


def test_cross_site_and_methods(repo):
    with running(repo) as c:
        assert c.get("/api/git/status", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
        assert c.get("/api/git/status", headers={"Origin": "http://evil.example"}).status_code == 403
        assert c.get("/api/git/status", headers={"Host": "evil.example"}).status_code == 400
        assert c.post("/api/git/status").status_code == 405


def test_timeout_kills_git(repo, tmp_path):
    slow = tmp_path / "slowgit"
    slow.write_text("#!/bin/sh\nsleep 30\n")
    slow.chmod(0o755)
    t = time.monotonic()
    with pytest.raises(gitmod.GitError) as e:
        gitmod.run_git(str(slow), ["status"], cwd=str(repo), env={"PATH": "/usr/bin:/bin"}, timeout=0.5)
    assert e.value.status == 504 and time.monotonic() - t < 5


def test_output_limit(repo):
    with pytest.raises(gitmod.GitError) as e:
        gitmod.run_git(GIT, ["cat-file", "-p", "HEAD"], cwd=str(repo), env={"PATH": "/usr/bin:/bin"}, limit=10)
    assert e.value.status == 413


def test_status_timeout_is_an_error_not_a_crash(repo, monkeypatch):
    monkeypatch.setattr(gitmod, "STATUS_TIMEOUT", 0.0001)
    with running(repo) as c:
        assert c.get("/api/git/status").status_code == 504


def test_find_git_and_setting():
    assert gitmod.find_git("off") is None
    assert gitmod.find_git("relative/git") is None
    assert gitmod.find_git(GIT) == GIT
    assert gitmod.find_git("", path_env="") is not None or not os.path.exists("/usr/bin/git")
    s = settings_from_args(["--root", "/tmp", "--git", "off"], env={})
    assert s.git == "off"
    assert settings_from_args(["--root", "/tmp"], env={"DOCS_VIEWER_GIT": "/x/git"}).git == "/x/git"


def test_unborn_head(tmp_path):
    r = tmp_path / "fresh"
    r.mkdir()
    g(r, "init", "-q")
    write(r / "a.md", "one\ntwo\n")
    g(r, "add", "a.md")
    write(r / "b.md", "b\n")
    with running(r) as c:
        f = files_of(c)
        assert (f["a.md"]["status"], f["a.md"]["added"]) == ("A", 2)
        assert f["b.md"]["status"] == "??"
        assert c.get("/api/git/file", params={"path": "a.md"}).json()["head"] is None
        assert c.get("/api/git/blame", params={"path": "a.md"}).json()["tracked"] is False
