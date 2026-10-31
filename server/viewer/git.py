"""Read-only git awareness: uncommitted changes (status + line counts), the HEAD version of a file
and blame, for the current root when it is inside a git work tree.

The browsed repository is untrusted. Its config can name programs that git runs on its own
(core.fsmonitor, clean/smudge/process filters, textconv, external diff, hooks, pagers, ssh and
credential helpers, ...), so every call goes through `GitRepo.run`:

- an argument list (never a shell), cwd at the work tree, stdin closed, a timeout (the whole
  process group is killed) and a cap on the output;
- a minimal environment: no system or global config, no inherited GIT_* variables, no prompts,
  no optional locks (status never refreshes or writes the index), no lazy fetches (git 2.45+;
  older git refuses partial clones), literal pathspecs, attributes from the empty tree rather
  than the work tree's .gitattributes (git 2.40+);
- command-line-scope config (GIT_CONFIG_COUNT, which beats every config file) that switches off
  fsmonitor, hooks, pagers, transports and credential helpers, refuses embedded bare repos and
  blanks every filter driver, protocol policy and promisor remote the repository's config
  defines (listed with `git config -l` first);
- only subcommands that read: rev-parse, symbolic-ref, config -l, status, diff-index, ls-tree,
  cat-file (no --filters / --textconv) and blame, with --no-ext-diff / --no-textconv where they
  apply and --ignore-submodules=all (status would otherwise run git in each submodule).

Paths are root-relative and go through PathGuard (or, for files deleted since HEAD, the same
lexical check as the seen history); denied and ignored names are never listed nor served from
history. See docs/security.md and docs/git.md."""

from __future__ import annotations

import contextlib
import logging
import os
import re
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

from .config import Settings, canonical_path
from .paths import PathError, PathGuard, kind_of
from .readers import CONTENT_MAX

log = logging.getLogger("viewer")

GIT_MIN_VERSION = (2, 32)  # GIT_CONFIG_COUNT (2.31, command-line-scope config) and GIT_CONFIG_GLOBAL (2.32)
ATTR_SOURCE_VERSION = (2, 40)  # GIT_ATTR_SOURCE: attributes from a fixed tree, not the work tree
NO_LAZY_FETCH_VERSION = (2, 45)  # GIT_NO_LAZY_FETCH; older git refuses partial clones (see _repo_overrides)
GIT_TIMEOUT = 10.0  # seconds per git call
STATUS_TIMEOUT = 20.0  # status hashes changed files: allow more
DETECT_TIMEOUT = 5.0
OUTPUT_MAX = 32 * 1024 * 1024  # bytes of stdout read from one git call
STDERR_MAX = 64 * 1024
STATUS_MAX_ENTRIES = 5000
STATUS_CACHE_S = 1.5  # one status serves a burst of requests (feed + file view)
COUNT_MAX_FILES = 1000  # untracked/new files whose lines are counted by reading them
BLAME_CHUNK = 2000
BLAME_MAX_CHUNK = 5000
CONCURRENCY = 4  # git processes per root at once
BINARY_SNIFF = 8000  # git's own heuristic: a NUL byte in the first 8000 bytes

# Command-line-scope config applied to every call (GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n).
SAFE_CONFIG: tuple[tuple[str, str], ...] = (
    ("core.fsmonitor", "false"),  # a hook command in the repo config would run on status/diff
    ("core.useBuiltinFSMonitor", "false"),
    ("core.hooksPath", os.devnull),
    ("core.pager", "cat"),
    ("core.untrackedCache", "false"),
    ("core.sshCommand", "false"),
    ("core.askPass", ""),
    ("credential.helper", ""),  # an empty value resets the list
    # No transport at all. GIT_NO_LAZY_FETCH is what stops a partial clone fetching a missing object;
    # this is the second line (per-protocol keys override protocol.allow, so each is set too, and
    # _repo_overrides adds any other protocol.<name>.allow the repository sets).
    ("protocol.allow", "never"),
    *((f"protocol.{p}.allow", "never") for p in ("file", "git", "ssh", "http", "https", "ext")),
    ("core.attributesFile", os.devnull),  # repo config could point it at a file that assigns filters
    ("safe.bareRepository", "explicit"),  # never adopt a bare repo checked into the folder
    ("submodule.recurse", "false"),
    ("diff.ignoreSubmodules", "all"),
    ("status.submoduleSummary", "false"),
    ("log.showSignature", "false"),
    ("blame.ignoreRevsFile", ""),
    ("gc.auto", "0"),
    ("maintenance.auto", "false"),
)
# Filter driver keys blanked for every driver the repository defines (an empty clean/smudge/process
# means "no filter"; required=false so the missing filter is not an error).
FILTER_KEY = re.compile(r"^filter\.(.+)\.(clean|smudge|process|required)$", re.S)
PROTOCOL_KEY = re.compile(r"^protocol\.(.+)\.allow$", re.S)
REMOTE_KEY = re.compile(r"^remote\.(.+)\.(promisor|uploadpack)$", re.S)
EMPTY_TREE = {"sha1": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
              "sha256": "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"}
OID = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
VERSION = re.compile(r"git version (\d+)\.(\d+)")
STATUS_RANK = {"U": 0, "M": 1, "R": 2, "A": 3, "??": 4, "D": 5}


def check_rel(rel, hidden):
    from .seen import check_rel as check  # local import: seen imports app imports this module

    return check(rel, hidden)


class GitError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# -- finding git ------------------------------------------------------------------------------------

_found: dict[tuple[str, str], str | None] = {}
_versions: dict[str, tuple[int, int]] = {}
_found_lock = threading.Lock()


def _base_env(exe: str | None = None) -> dict[str, str]:
    """The whole environment of a git call: nothing inherited but HOME (git looks there for the
    user's ignore and attributes files; config from it is off) and a fixed PATH."""
    path = ["/usr/bin", "/bin"]
    if exe:
        path.insert(0, os.path.dirname(exe))
    env = {
        "PATH": os.pathsep.join(path),
        "LC_ALL": "C",
        "LANG": "C",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_LITERAL_PATHSPECS": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_ADVICE": "0",
        "GIT_PAGER": "cat",
        "PAGER": "cat",
        "GIT_SSH_COMMAND": "false",
        "GIT_ASKPASS": "false",
        "SSH_ASKPASS": "false",
        "GIT_EDITOR": "false",
    }
    home = os.environ.get("HOME")
    if home and os.path.isabs(home):
        env["HOME"] = home
    return env


def _version(exe: str) -> tuple[int, int] | None:
    try:
        p = subprocess.run([exe, "--version"], env=_base_env(exe), stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=DETECT_TIMEOUT, cwd="/")
    except (OSError, subprocess.SubprocessError):
        return None
    m = VERSION.search(p.stdout.decode("utf-8", "replace")) if p.returncode == 0 else None
    return (int(m.group(1)), int(m.group(2))) if m else None


def _xcode_git() -> str | None:
    """macOS: /usr/bin/git is a shim that opens an "install the command line developer tools"
    dialog when they are missing. `xcode-select -p` only prints the active developer dir (exit 2
    if there is none), so ask it and run the real git inside that dir directly."""
    try:
        p = subprocess.run(["/usr/bin/xcode-select", "-p"], stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=DETECT_TIMEOUT, env={"PATH": "/usr/bin:/bin"}, cwd="/")
    except (OSError, subprocess.SubprocessError):
        return None
    dev = p.stdout.decode("utf-8", "replace").strip()
    if p.returncode != 0 or not os.path.isabs(dev):
        return None
    exe = os.path.join(dev, "usr", "bin", "git")
    return exe if os.path.isfile(exe) and os.access(exe, os.X_OK) else None


def _candidates(path_env: str) -> list[str]:
    out = []
    dirs = [d for d in path_env.split(os.pathsep) if os.path.isabs(d)]
    found = shutil.which("git", path=os.pathsep.join(dirs)) if dirs else None
    if found:
        out.append(found)
    # A Finder-launched desktop app gets PATH=/usr/bin:/bin:/usr/sbin:/sbin: also try the usual places.
    out += ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", "/bin/git"]
    return list(dict.fromkeys(out))


def find_git(setting: str = "", path_env: str | None = None) -> str | None:
    """The git executable to use, or None. `setting` (--git / DOCS_VIEWER_GIT): "" = detect,
    "off" = disabled, else an absolute path. Cached per process."""
    setting = (setting or "").strip()
    if setting.lower() in ("off", "0", "false", "no", "none"):
        return None
    path_env = os.environ.get("PATH", "") if path_env is None else path_env
    key = (setting, path_env)
    with _found_lock:
        if key in _found:
            return _found[key]
    exe = None
    if setting:
        if not os.path.isabs(setting) or not os.path.isfile(setting) or not os.access(setting, os.X_OK):
            log.warning("git: DOCS_VIEWER_GIT / --git %r is not an executable file; git features are off", setting)
            cands = []
        else:
            cands = [setting]
    else:
        cands = _candidates(path_env)
    for c in cands:
        if not (os.path.isfile(c) and os.access(c, os.X_OK)):
            continue
        real = os.path.realpath(c)
        if sys.platform == "darwin" and real == "/usr/bin/git":
            real = _xcode_git()  # never run the shim itself
            if real is None:
                continue
        v = _version(real)
        if v is None:
            continue
        if v < GIT_MIN_VERSION:
            log.warning("git: %s is version %d.%d, %d.%d or newer is needed", real, *v, *GIT_MIN_VERSION)
            continue
        exe = real
        break
    with _found_lock:
        _found[key] = exe
        if exe is not None:
            _versions[exe] = v
    return exe


def version_of(exe: str) -> tuple[int, int]:
    """The version find_git saw for exe (it found it, so it is at least GIT_MIN_VERSION)."""
    with _found_lock:
        v = _versions.get(exe)
    return v if v is not None else (_version(exe) or GIT_MIN_VERSION)


# -- running git ------------------------------------------------------------------------------------

def _kill(p: subprocess.Popen) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(p.pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        p.kill()
    with contextlib.suppress(Exception):
        p.wait(timeout=5)


def run_git(exe: str, args: list[str], *, cwd: str, env: dict[str, str], timeout: float = GIT_TIMEOUT,
            limit: int = OUTPUT_MAX) -> tuple[int, bytes, bytes]:
    """(returncode, stdout, stderr). GitError 504 on timeout, 413 when stdout exceeds `limit`.
    The child runs in its own session so a timeout kills anything it started too."""
    try:
        p = subprocess.Popen([exe, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
    except OSError as e:
        raise GitError(503, f"could not run git: {e.strerror or e}")
    out, err = bytearray(), bytearray()
    deadline = time.monotonic() + timeout
    sel = selectors.DefaultSelector()
    try:
        sel.register(p.stdout, selectors.EVENT_READ)
        sel.register(p.stderr, selectors.EVENT_READ)
        while sel.get_map():
            left = deadline - time.monotonic()
            if left <= 0:
                raise GitError(504, "git took too long")
            for key, _ in sel.select(left):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    sel.unregister(key.fileobj)
                    continue
                if key.fileobj is p.stdout:
                    out += chunk
                    if len(out) > limit:
                        raise GitError(413, "git output too large")
                elif len(err) < STDERR_MAX:
                    err += chunk
        try:
            rc = p.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise GitError(504, "git took too long")
    except BaseException:
        _kill(p)
        raise
    finally:
        sel.close()
        for f in (p.stdout, p.stderr):
            with contextlib.suppress(Exception):
                f.close()
    return rc, bytes(out), bytes(err)


def _first_line(err: bytes) -> str:
    text = err.decode("utf-8", "replace").strip()
    return text.splitlines()[0][:300] if text else ""


# -- the repository of one root ---------------------------------------------------------------------

@dataclass
class _Entry:
    status: str
    path: str  # root-relative
    orig: str | None = None  # renames: the path in HEAD (root-relative), when it may be shown
    git_path: str = ""
    git_orig: str | None = None
    whole: bool = False  # compared with nothing: every line is new (e.g. renamed in from outside the root)


class GitRepo:
    def __init__(self, exe: str, toplevel: str, prefix: str, guard: PathGuard, object_format: str = "sha1"):
        self.exe = exe
        self.toplevel = toplevel  # canonical work tree
        self.prefix = prefix  # the root inside the work tree: "" or "sub/dir/"
        self.guard = guard
        self.version = version_of(exe)
        self.env = _base_env(exe)
        if self.version >= ATTR_SOURCE_VERSION and object_format in EMPTY_TREE:
            # .gitattributes in the work tree (untrusted, and it may change between two calls)
            # can then not assign filter= or diff= drivers; .git/info/attributes still applies.
            self.env["GIT_ATTR_SOURCE"] = EMPTY_TREE[object_format]
        self._sem = threading.BoundedSemaphore(CONCURRENCY)
        self._status_lock = threading.Lock()
        self._status_cache: tuple[float, dict] | None = None
        self._raw_lock = threading.Lock()
        self._raw_cache: tuple[float, list[_Entry]] | None = None

    # -- low level ------------------------------------------------------------------------------

    def _env(self, extra: list[tuple[str, str]]) -> dict[str, str]:
        pairs = list(SAFE_CONFIG) + extra
        env = dict(self.env)
        env["GIT_CONFIG_COUNT"] = str(len(pairs))
        for i, (k, v) in enumerate(pairs):
            env[f"GIT_CONFIG_KEY_{i}"] = k
            env[f"GIT_CONFIG_VALUE_{i}"] = v
        return env

    def _call(self, args: list[str], env: dict[str, str], *, timeout: float, limit: int) -> tuple[int, bytes, bytes]:
        if not self._sem.acquire(timeout=timeout):
            raise GitError(503, "git is busy, try again")
        try:
            return run_git(self.exe, ["--no-pager", *args], cwd=self.toplevel, env=env, timeout=timeout, limit=limit)
        finally:
            self._sem.release()

    def _repo_overrides(self) -> list[tuple[str, str]]:
        """Overrides for what the repository's config (and the files it includes) defines: every
        filter driver blanked, every protocol.<name>.allow set to never, every remote's promisor
        flag off and upload-pack command replaced. Listing config runs no program.
        Git older than NO_LAZY_FETCH_VERSION ignores GIT_NO_LAZY_FETCH, so a partial clone is
        refused there (GitError 503) rather than relying on the transport settings alone."""
        rc, out, err = self._call(["config", "--list", "-z", "--name-only"], self._env([]),
                                  timeout=GIT_TIMEOUT, limit=4 * 1024 * 1024)
        if rc != 0:
            raise GitError(502, f"git config failed: {_first_line(err)}")
        drivers, protocols, remotes, partial = set(), set(), set(), False
        for raw in out.split(b"\0"):
            key = os.fsdecode(raw)
            if m := FILTER_KEY.match(key):
                drivers.add(m.group(1))
            elif m := PROTOCOL_KEY.match(key):
                protocols.add(m.group(1))
            elif m := REMOTE_KEY.match(key):
                remotes.add(m.group(1))
                partial = partial or m.group(2) == "promisor"
            elif key.lower() == "extensions.partialclone":
                partial = True
        if partial and self.version < NO_LAZY_FETCH_VERSION:
            raise GitError(503, "this is a partial clone; git %d.%d or newer is needed for it" % NO_LAZY_FETCH_VERSION)
        over = []
        for d in sorted(drivers):
            over += [(f"filter.{d}.clean", ""), (f"filter.{d}.smudge", ""), (f"filter.{d}.process", ""),
                     (f"filter.{d}.required", "false")]
        over += [(f"protocol.{p}.allow", "never") for p in sorted(protocols)]
        for r in sorted(remotes):
            over += [(f"remote.{r}.promisor", "false"), (f"remote.{r}.uploadpack", "false")]
        return over

    def run(self, args: list[str], *, timeout: float = GIT_TIMEOUT, limit: int = OUTPUT_MAX,
            ok: tuple[int, ...] = (0,)) -> bytes:
        env = self._env(self._repo_overrides())
        rc, out, err = self._call(args, env, timeout=timeout, limit=limit)
        if rc not in ok:
            raise GitError(502, f"git {args[0]} failed: {_first_line(err)}")
        return out

    def git_path(self, rel: str) -> str:
        return self.prefix + rel

    def head(self) -> str | None:
        out = self.run(["rev-parse", "-q", "--verify", "HEAD^{commit}"], ok=(0, 1, 128))
        oid = out.decode("ascii", "replace").strip()
        return oid if OID.match(oid) else None

    def branch(self) -> str | None:
        out = self.run(["symbolic-ref", "-q", "--short", "HEAD"], ok=(0, 1, 128))
        name = os.fsdecode(out).strip()
        return name or None

    # -- path rules -----------------------------------------------------------------------------

    def _rel_of_git(self, git_path: str) -> str | None:
        """Root-relative path of a work tree path, or None if outside the root or not allowed."""
        if not git_path.startswith(self.prefix) or git_path.endswith("/"):
            return None
        rel = check_rel(git_path[len(self.prefix):], self.guard.rel_hidden)
        if rel is None:
            return None
        if self.guard.excluded and self.guard.is_excluded(os.path.join(self.guard.root, *rel.split("/"))):
            return None
        return rel

    def _visible(self, rel: str) -> tuple[str, os.stat_result] | None | bool:
        """On disk and visible: (canonical rel, stat); missing: None; hidden or refused: False."""
        try:
            r, st = self.guard.resolve_file(rel)
        except PathError as e:
            return None if e.status == 404 else False
        return r.rel, st

    # -- status ---------------------------------------------------------------------------------

    def _pathspec(self) -> list[str]:
        return ["--", self.prefix.rstrip("/")] if self.prefix else []

    def _raw_status(self) -> list[_Entry]:
        out = self.run(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all",
                        "--renames", *self._pathspec()], timeout=STATUS_TIMEOUT)
        toks = out.split(b"\0")
        entries: list[_Entry] = []
        i = 0
        while i < len(toks):
            t = os.fsdecode(toks[i])
            i += 1
            if not t:
                continue
            kind = t[0]
            if kind == "1":
                f = t.split(" ", 8)
                if len(f) < 9 or not f[2].startswith("N"):
                    continue  # submodule
                x, y = f[1][0], f[1][1]
                if x == "A" and y == "D":
                    continue  # added, then deleted again: nothing against HEAD
                st = "A" if x == "A" else "D" if "D" in (x, y) else "M"
                entries.append(_Entry(st, "", git_path=f[8]))
            elif kind == "2":
                f = t.split(" ", 9)
                orig = os.fsdecode(toks[i]) if i < len(toks) else ""
                i += 1
                if len(f) < 10 or not f[2].startswith("N"):
                    continue
                st = "D" if f[1][1] == "D" else ("R" if f[8].startswith("R") else "A")
                if st == "D":
                    # renamed in the index, then deleted: the HEAD file is gone
                    entries.append(_Entry("D", "", git_path=orig))
                else:
                    entries.append(_Entry(st, "", git_path=f[9], git_orig=orig))
            elif kind == "u":
                f = t.split(" ", 10)
                if len(f) >= 11:
                    entries.append(_Entry("U", "", git_path=f[10]))
            elif kind == "?":
                entries.append(_Entry("??", "", git_path=t[2:]))
        out_entries = []
        for e in entries:
            rel = self._rel_of_git(e.git_path)
            if rel is None:
                continue
            e.path = rel
            if e.git_orig is not None:
                orig = self._rel_of_git(e.git_orig)
                if orig is None:
                    # the HEAD side is outside the root or not allowed: never shown, not compared
                    e.status, e.git_orig, e.whole = "A", None, True
                else:
                    e.orig = orig
            out_entries.append(e)
        return out_entries

    def _numstat(self) -> dict[str, tuple[int | None, int | None]]:
        """git path -> (added, removed) against HEAD (None, None: binary). Renames keyed by the new path."""
        out = self.run(["diff-index", "-z", "--numstat", "-M", "--no-ext-diff", "--no-textconv",
                        "--ignore-submodules=all", "HEAD", *self._pathspec()], timeout=STATUS_TIMEOUT)
        res: dict[str, tuple[int | None, int | None]] = {}
        toks = out.split(b"\0")
        i = 0
        while i < len(toks):
            t = os.fsdecode(toks[i])
            i += 1
            if not t:
                continue
            parts = t.split("\t", 2)
            if len(parts) < 3:
                continue
            a, d, path = parts
            if path == "":  # rename: "<a>\t<d>\t" NUL src NUL dst NUL
                path = os.fsdecode(toks[i + 1]) if i + 1 < len(toks) else ""
                i += 2
            counts = (int(a), int(d)) if a.isdigit() and d.isdigit() else (None, None)
            res[path] = counts
        return res

    def _count_lines(self, rel: str) -> tuple[int | None, bool]:
        """(lines, binary) of a file on disk read through the guard."""
        try:
            r, st = self.guard.resolve_file(rel)
            if st.st_size > CONTENT_MAX:
                return None, False
            with open(r.real, "rb") as f:
                data = f.read(CONTENT_MAX + 1)
        except (PathError, OSError):
            return None, False
        if b"\0" in data[:BINARY_SNIFF]:
            return None, True
        return _line_count(data), False

    def status(self) -> dict:
        with self._status_lock:
            now = time.monotonic()
            if self._status_cache and now - self._status_cache[0] < STATUS_CACHE_S:
                return self._status_cache[1]
            res = self._status()
            self._status_cache = (time.monotonic(), res)
            return res

    def _status(self) -> dict:
        head = self.head()
        entries = self._raw_cached()
        numstat = self._numstat() if head and entries else {}
        files: list[dict] = []
        truncated = len(entries) > STATUS_MAX_ENTRIES
        with self.guard.cached_listings():
            self._collect(entries[:STATUS_MAX_ENTRIES], numstat, files)
        files.sort(key=lambda f: (-(f["mtime"] or 0), f["path"]))
        return {"head": head[:12] if head else None, "branch": self.branch(), "prefix": self.prefix,
                "files": files, "truncated": truncated}

    def _collect(self, entries: list[_Entry], numstat: dict, files: list[dict]) -> None:
        counted = 0
        for e in entries:
            item: dict = {"path": e.path, "status": e.status, "origPath": e.orig,
                          "added": None, "removed": None, "binary": False,
                          "kind": None, "mtime": None, "size": None}
            if e.status != "D":
                vis = self._visible(e.path)
                if vis is False or vis is None:
                    continue  # hidden (symlink out of the root, denied on-disk spelling) or gone meanwhile
                rel, st = vis
                item["path"] = rel
                item["kind"] = kind_of(os.path.basename(rel), os.path.join(self.guard.root, *rel.split("/")))
                item["mtime"] = st.st_mtime_ns / 1e9
                item["size"] = st.st_size
            else:
                item["kind"] = kind_of(os.path.basename(e.path))
            if e.status == "??" or (e.status == "A" and (e.whole or e.git_path not in numstat)):
                # not in HEAD: every line is new
                if counted < COUNT_MAX_FILES:
                    counted += 1
                    n, binary = self._count_lines(e.path)
                    item.update(added=n, removed=0 if n is not None else None, binary=binary)
            elif e.git_path in numstat:
                a, d = numstat[e.git_path]
                item.update(added=a, removed=d, binary=a is None)
            files.append(item)

    def _raw_cached(self) -> list[_Entry]:
        with self._raw_lock:
            now = time.monotonic()
            if self._raw_cache is None or now - self._raw_cache[0] >= STATUS_CACHE_S:
                self._raw_cache = (now, self._raw_status())
            return self._raw_cache[1]

    def _entry_for(self, rel: str) -> _Entry | None:
        for e in self._raw_cached():
            if e.path == rel:
                return e
        return None

    # -- one file -------------------------------------------------------------------------------

    def _resolve(self, path: str | None, *, allow_missing: bool) -> tuple[str, os.stat_result | None]:
        """(root-relative path, stat or None if missing). PathError for refused paths."""
        try:
            r, st = self.guard.resolve_file(path)
            return r.rel, st
        except PathError as e:
            if e.status != 404 or not allow_missing:
                raise
        # Deleted since HEAD: only the lexical rules can be checked (as for the seen history).
        rel = check_rel(path, self.guard.rel_hidden)
        if rel is None or self._rel_of_git(self.git_path(rel)) is None:
            raise PathError(403, "path is not allowed")
        return rel, None

    def _real_rel(self, rel: str) -> str:
        """The path git knows the file by: an in-root symlink is compared by its target."""
        r = self.guard.resolve(rel)
        real_rel = self.guard.rel_of(r.real)
        return real_rel if self.guard.inside(r.real) else rel

    def _head_blob(self, git_path: str) -> dict | None:
        """{oid, size, text, binary, tooLarge} of git_path in HEAD, or None if it is not there."""
        out = self.run(["ls-tree", "-z", "-l", "--full-tree", "HEAD", "--", git_path])
        for tok in out.split(b"\0"):
            if not tok:
                continue
            meta, _, name = tok.partition(b"\t")
            if os.fsdecode(name) != git_path:
                continue
            f = meta.split()
            if len(f) < 4:
                return None
            mode, typ, oid, size = f[0].decode(), f[1].decode(), f[2].decode(), f[3].decode()
            if typ != "blob" or not OID.match(oid):
                return None  # a folder or a submodule
            n = int(size) if size.isdigit() else 0
            res = {"oid": oid[:12], "size": n, "text": None, "binary": False, "tooLarge": False}
            if mode == "120000":
                res["binary"] = True  # a symlink: its target is not shown
                return res
            if n > CONTENT_MAX:
                res["tooLarge"] = True
                return res
            data = self.run(["cat-file", "blob", oid], limit=CONTENT_MAX + 1)
            if b"\0" in data[:BINARY_SNIFF]:
                res["binary"] = True
            else:
                res["text"] = data.decode("utf-8", errors="replace")
            return res
        return None

    def file(self, path: str | None) -> dict:
        rel, st = self._resolve(path, allow_missing=True)
        git_rel = self._real_rel(rel) if st is not None else rel
        if self._rel_of_git(self.git_path(git_rel)) is None:
            raise PathError(403, "path is not allowed")
        head = self.head()
        entry = self._entry_for(git_rel)
        if st is None and (entry is None or entry.status != "D"):
            raise PathError(404, "not found")
        head_rel = entry.orig if entry is not None and entry.orig else git_rel
        blob = self._head_blob(self.git_path(head_rel)) if head else None
        return {"path": rel, "status": entry.status if entry else None, "origPath": entry.orig if entry else None,
                "head": blob, "headCommit": head[:12] if head else None, "exists": st is not None}

    # -- blame ----------------------------------------------------------------------------------

    def blame(self, path: str | None, start: int, count: int) -> dict:
        rel, st = self._resolve(path, allow_missing=False)
        assert st is not None
        if st.st_size > CONTENT_MAX:
            raise GitError(413, "file too large to blame")
        r = self.guard.resolve(rel)
        with open(r.real, "rb") as f:
            data = f.read(CONTENT_MAX + 1)
        if b"\0" in data[:BINARY_SNIFF]:
            raise GitError(400, "binary file")
        total = _line_count(data)
        git_rel = self._real_rel(rel)
        base = {"path": rel, "start": start, "total": total, "lines": [], "commits": {}}
        entry = self._entry_for(git_rel)
        if not self.head() or (entry is not None and entry.status == "??"):
            return {**base, "tracked": False}
        if total == 0 or start > total:
            return {**base, "tracked": True}
        end = min(total, start + count - 1)
        out = self.run(["blame", "--porcelain", "--no-textconv", "-L", f"{start},{end}", "--",
                        self.git_path(git_rel)], ok=(0, 128))
        lines, commits = _parse_blame(out)
        if not lines:
            return {**base, "tracked": False}
        return {**base, "tracked": True, "lines": lines, "commits": commits}


def _line_count(data: bytes) -> int:
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)


def _parse_blame(out: bytes) -> tuple[list[dict], dict[str, dict]]:
    lines: list[dict] = []
    commits: dict[str, dict] = {}
    cur: dict | None = None
    cur_oid = ""
    for raw in out.split(b"\n"):
        if raw.startswith(b"\t"):
            if cur is not None:
                cur["text"] = raw[1:].decode("utf-8", errors="replace").rstrip("\r")
                lines.append(cur)
            cur = None
            continue
        head = raw.split(b" ")
        if cur is None and len(head) >= 3 and OID.match(head[0].decode("ascii", "replace")):
            cur_oid = head[0].decode()
            cur = {"line": int(head[2]), "origLine": int(head[1]), "commit": cur_oid}
            if cur_oid not in commits:
                commits[cur_oid] = {"short": cur_oid[:8], "author": "", "authorTime": 0, "summary": "",
                                    "uncommitted": set(cur_oid) == {"0"}}
            continue
        if cur is None:
            continue
        key, _, val = raw.partition(b" ")
        c = commits[cur_oid]
        if key == b"author":
            c["author"] = val.decode("utf-8", "replace")
        elif key == b"author-time" and val.isdigit():
            c["authorTime"] = int(val)
        elif key == b"summary" and not c["uncommitted"]:
            c["summary"] = val.decode("utf-8", "replace")
    return lines, commits


class GitLink:
    """The GitRepo of one root, detected once on first use (thread-safe)."""

    def __init__(self, settings: Settings, guard: PathGuard):
        self.settings = settings
        self.guard = guard
        self._lock = threading.Lock()
        self._done = False
        self._repo: GitRepo | None = None

    def repo(self) -> GitRepo | None:
        with self._lock:
            if not self._done:
                try:
                    self._repo = open_repo(self.settings, self.guard)
                except Exception:  # never let detection break the viewer
                    log.exception("git: detection failed for %s", self.settings.root)
                    self._repo = None
                self._done = True
            return self._repo


def open_repo(settings: Settings, guard: PathGuard) -> GitRepo | None:
    """The git work tree containing the root, or None (git off or missing, not a repo, the root
    inside .git, a repo git refuses to use, e.g. owned by another user)."""
    exe = find_git(settings.git)
    if exe is None or settings.root is None:
        return None
    env = dict(_base_env(exe))
    env["GIT_CONFIG_COUNT"] = str(len(SAFE_CONFIG))
    for i, (k, v) in enumerate(SAFE_CONFIG):
        env[f"GIT_CONFIG_KEY_{i}"] = k
        env[f"GIT_CONFIG_VALUE_{i}"] = v
    try:
        rc, out, err = run_git(exe, ["--no-pager", "rev-parse", "--is-inside-work-tree", "--show-toplevel",
                                     "--show-object-format"],
                               cwd=settings.root, env=env, timeout=DETECT_TIMEOUT, limit=64 * 1024)
    except GitError as e:
        log.info("git: disabled for %s: %s", settings.root, e.detail)
        return None
    lines = os.fsdecode(out).splitlines()
    if rc != 0 or len(lines) < 3 or lines[0].strip() != "true":
        if rc != 0 and b"dubious ownership" in err:
            log.info("git: %s is owned by another user; git features are off for it", settings.root)
        return None
    top = canonical_path(lines[1].strip())
    root = settings.root
    try:
        inside = os.path.commonpath([root, top]) == top
    except ValueError:
        inside = False
    if not inside:
        return None  # e.g. core.worktree pointing somewhere else
    rel = os.path.relpath(root, top)
    prefix = "" if rel == "." else rel.replace(os.sep, "/") + "/"
    if prefix and any(c in ("..", "", ".") for c in prefix.rstrip("/").split("/")):
        return None
    if ".git" in prefix.rstrip("/").split("/"):
        return None  # the root is inside a .git folder (git says it is not a work tree anyway)
    return GitRepo(exe, top, prefix, guard, lines[2].strip())


# -- routes -----------------------------------------------------------------------------------------

def register_git_routes(app: FastAPI, repo_of, same_site) -> None:
    """GET /api/git/status, /api/git/file, /api/git/blame on the per-root app. `repo_of()` -> the
    GitRepo or None (git off for this folder). Cross-site requests are refused (each call starts
    git processes), as for /api/pdf."""
    headers = {"Cache-Control": "no-store"}

    def guarded(request: Request):
        if not same_site(request):
            return JSONResponse({"detail": "cross-site git requests are refused"}, status_code=403)
        repo = repo_of()
        if repo is None:
            return JSONResponse({"detail": "git is not enabled for this folder"}, status_code=404)
        return repo

    def answer(fn):
        try:
            return JSONResponse(fn(), headers=headers)
        except (PathError, GitError) as e:
            return JSONResponse({"detail": e.detail}, status_code=e.status, headers=headers)

    def get(path: str):
        return app.api_route(path, methods=["GET", "HEAD"])

    @get("/api/git/status")
    def git_status(request: Request):
        repo = guarded(request)
        return repo if isinstance(repo, JSONResponse) else answer(repo.status)

    @get("/api/git/file")
    def git_file(request: Request, path: str | None = None):
        repo = guarded(request)
        return repo if isinstance(repo, JSONResponse) else answer(lambda: repo.file(path))

    @get("/api/git/blame")
    def git_blame(request: Request, path: str | None = None, start: int = Query(1, ge=1),
                  count: int = Query(BLAME_CHUNK, ge=1, le=BLAME_MAX_CHUNK)):
        repo = guarded(request)
        return repo if isinstance(repo, JSONResponse) else answer(lambda: repo.blame(path, start, count))
