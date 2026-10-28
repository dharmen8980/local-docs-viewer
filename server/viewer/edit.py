"""Opt-in write operations (tier 3). Every mutation goes through WriteGuard.locate and runs under
one process-wide lock, inside Store.mutate so the tree/search/SSE are updated immediately."""

from __future__ import annotations

import contextlib
import hashlib
import os
import posixpath
import secrets
import stat as stat_mod
import threading
import time
import unicodedata
from dataclasses import dataclass

from .config import ConfigError, Settings
from .fsops import (SymlinkError, fsync_fd, lstat_at, open_dir_chain, open_dir_chain_from, open_regular,
                    parent_fd, rename_noreplace)
from .paths import PathError, PathGuard, ext_of, fold
from .recovery import COPY_CHUNK, Audit, History, RecoveryError, Trash, _read_json, _write_json
from .store import Store

# bidi overrides / zero-width characters that can disguise a name
_DISGUISE = set("\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e"
                "\u2066\u2067\u2068\u2069\ufeff")
_UNSAFE_UPLOAD = set('<>:"|?*')
MAX_SUFFIX = 999
HISTORY_TEXT_MAX = 2 * 1024 * 1024


class EditError(Exception):
    def __init__(self, status: int, detail: str, **extra):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.extra = extra

    def body(self) -> dict:
        return {"detail": self.detail, **self.extra}


def _bad_char(c: str) -> bool:
    return unicodedata.category(c) in ("Cc", "Cs") or c in _DISGUISE


@dataclass
class Loc:
    rel: str  # root-relative, existing components spelled as on disk
    abs: str
    st: os.stat_result | None  # lstat of the target, None if it does not exist
    comps: list[str]
    first_missing: int  # index of the first missing component (len(comps) if all exist)
    req_name: str  # last component as requested

    @property
    def exists(self) -> bool:
        return self.st is not None

    @property
    def parent_exists(self) -> bool:
        return self.first_missing >= len(self.comps) - 1

    @property
    def is_dir(self) -> bool:
        return self.st is not None and stat_mod.S_ISDIR(self.st.st_mode)

    @property
    def is_file(self) -> bool:
        return self.st is not None and stat_mod.S_ISREG(self.st.st_mode)


class WriteGuard:
    """Path rules for writes: stricter than PathGuard (which only has to make reads safe)."""

    def __init__(self, guard: PathGuard):
        self.guard = guard
        self.root = guard.root

    def check_name(self, name: str) -> None:
        if not isinstance(name, str) or name == "":
            raise EditError(400, "empty name")
        if name in (".", ".."):
            raise EditError(403, "path is outside the root")
        if "/" in name or "\\" in name or "\0" in name:
            raise EditError(400, "name must not contain '/', '\\' or NUL")
        nf = unicodedata.normalize("NFKC", name)
        if nf.strip() in (".", "..") or "/" in nf or "\\" in nf:
            raise EditError(403, "name looks like a path separator or traversal")
        if any(_bad_char(c) for c in name):
            raise EditError(400, "name must not contain control characters")
        if len(name.encode("utf-8", errors="surrogatepass")) > 255:
            raise EditError(400, "name is longer than 255 bytes")
        if name != name.rstrip(" .") or name != name.lstrip(" "):
            raise EditError(400, "name must not start with a space or end with a space or dot")
        if self.guard.is_denied(name):
            raise EditError(403, f"name is not allowed (deny list): {name}")
        if self.guard.is_ignored(name):
            raise EditError(403, f"name is not allowed (ignore list): {name}")

    def split(self, rel) -> list[str]:
        if not isinstance(rel, str) or rel.strip() == "":
            raise EditError(400, "path is required")
        if "\0" in rel:
            raise EditError(400, "invalid path")
        if rel.startswith("/") or rel.startswith("\\") or os.path.isabs(rel) or (len(rel) > 1 and rel[1] == ":"):
            raise EditError(403, "absolute paths are not allowed")
        if "\\" in rel:
            raise EditError(400, "use '/' as the path separator")
        comps = rel.split("/")
        if any(c in (".", "..") for c in comps):
            raise EditError(403, "path is outside the root")
        if any(c == "" for c in comps):
            raise EditError(400, "empty path component")
        for c in comps:
            self.check_name(c)
        return comps

    def locate(self, rel, *, allow_root: bool = False) -> Loc:
        if allow_root and rel in ("", None):
            st = os.lstat(self.root)
            return Loc("", self.root, st, [], 0, "")
        comps = self.split(rel)
        cur = self.root
        names: list[str] = []
        st: os.stat_result | None = None
        first_missing = len(comps)
        for i, c in enumerate(comps):
            last = i == len(comps) - 1
            name = None
            if first_missing == len(comps):
                try:
                    entries = os.listdir(cur)
                except OSError:
                    entries = []
                if c in entries:
                    name = c
                else:
                    k = fold(c)
                    cands = [e for e in entries if fold(e) == k]
                    if len(cands) > 1:
                        raise EditError(409, f"ambiguous name: {c}")
                    name = cands[0] if cands else None
            if name is None:
                first_missing = min(first_missing, i)
                names.append(c)
                st = None
                continue
            if self.guard.is_hidden(name):
                raise EditError(403, "path is not allowed")
            p = os.path.join(cur, name)
            try:
                st = os.lstat(p)
            except OSError:
                raise EditError(409, "path changed while checking it")
            if stat_mod.S_ISLNK(st.st_mode):
                raise EditError(403, "symlinks cannot be edited or written through")
            if not last and not stat_mod.S_ISDIR(st.st_mode):
                raise EditError(400, f"not a folder: {'/'.join(names + [name])}")
            names.append(name)
            cur = p
        abs_path = os.path.join(self.root, *names)
        # belt and braces: the deepest existing folder must be its own realpath, inside the root
        anc = (os.path.dirname(abs_path) if first_missing == len(comps)
               else os.path.join(self.root, *names[:first_missing]))
        if os.path.realpath(anc) != anc or not self.guard.inside(anc) or not os.path.isdir(anc):
            raise EditError(403, "path is not allowed")
        if self.guard.excluded and self.guard.is_excluded(abs_path):
            raise EditError(403, "path is not allowed")
        rel_out = "/".join(names)
        if st is not None:
            try:  # the read gate must agree (deny on disk names, realpath inside the root)
                self.guard.resolve(rel_out)
            except PathError as e:
                raise EditError(e.status, e.detail)
        return Loc(rel_out, abs_path, st if first_missing == len(comps) else None, comps,
                   first_missing, comps[-1])

    def check_tree(self, abs_dir: str) -> None:
        """Refuse moving/deleting a folder that contains deny-listed entries (they are invisible
        in the UI, so the user cannot know what they would be moving)."""
        for dirpath, dirs, files in os.walk(abs_dir, followlinks=False):
            for n in dirs + files:
                if self.guard.is_denied(n):
                    raise EditError(403, "folder contains protected (deny-listed) files")


def _sanitize_upload_name(raw: str) -> str:
    n = (raw or "").replace("\\", "/").split("/")[-1]
    n = unicodedata.normalize("NFC", n)
    n = "".join("_" if (_bad_char(c) or c in _UNSAFE_UPLOAD or unicodedata.category(c) in ("Zl", "Zp", "Cf")
                        or any(x in unicodedata.normalize("NFKC", c) for x in "/\\"))
                else c for c in n)
    n = n.strip().strip(".").strip()
    if "." in n:
        stem, ext = n.rsplit(".", 1)
        stem = stem.rstrip(" .") or "upload"
        n = f"{stem}.{ext}"
    while len(n.encode("utf-8")) > 255:
        stem, dot, ext = n.rpartition(".")
        if not dot or len(ext.encode()) > 32:
            n = n[:-1]
        else:
            n = stem[:-1].rstrip(" .") + "." + ext
    return n or "upload"


def _suffixed(name: str, i: int) -> str:
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        return f"{name}-{i}"
    return f"{stem}-{i}.{ext}"


def _sha_of(f) -> str:
    h = hashlib.sha256()
    f.seek(0)
    while chunk := f.read(COPY_CHUNK):
        h.update(chunk)
    f.seek(0)
    return h.hexdigest()


class Editor:
    def __init__(self, settings: Settings, guard: PathGuard, store: Store):
        self.s = settings
        self.guard = guard
        self.wg = WriteGuard(guard)
        self.store = store
        self.root = guard.root
        os.makedirs(settings.data_dir, mode=0o700, exist_ok=True)
        self.store_dir = settings.store_dir
        os.makedirs(self.store_dir, mode=0o700, exist_ok=True)
        self._check_marker()
        self.history = History(self.store_dir, settings.history_keep)
        self.trash = Trash(self.store_dir)
        self.audit = Audit(self.store_dir)
        self.lock = threading.Lock()
        self.token = secrets.token_urlsafe(32)
        old = os.umask(0o022)
        os.umask(old)
        self.new_file_mode = 0o666 & ~old

    def _check_marker(self) -> None:
        """Each root has its own store under <data>/roots/<key>; root.json records which root it
        belongs to, and a store that belongs to a different root is never used."""
        marker = os.path.join(self.store_dir, "root.json")
        data = _read_json(marker)
        if data is None:
            if os.path.exists(marker):
                raise ConfigError(f"unreadable recovery store marker {marker}")
            _write_json(marker, {"root": self.s.root, "created_at": time.time()})
        elif data.get("root") != self.s.root:
            raise ConfigError(f"recovery store {self.store_dir} belongs to {data.get('root')!r}, "
                              f"not {self.s.root!r}")

    # --- plumbing -----------------------------------------------------------
    def _run(self, fn):
        """(result, Change|None). Mutations are serialised by self.lock and run with the store's
        scan lock held, so watcher rescans never see half-done operations."""
        with self.lock:
            try:
                return self.store.mutate(fn)
            except RecoveryError as e:
                raise EditError(e.status, e.detail)
            except SymlinkError:
                raise EditError(403, "symlinks cannot be edited or written through")
            except FileExistsError:
                raise EditError(409, "destination exists")
            except FileNotFoundError:
                raise EditError(404, "not found")
            except IsADirectoryError:
                raise EditError(409, "destination is a folder")
            except OSError as e:
                raise EditError(500, f"file system error: {e.strerror or type(e).__name__}")

    def _current(self, rel: str) -> dict:
        with open_regular(self.root, rel) as f:
            st = os.fstat(f.fileno())
            return {"sha256": _sha_of(f), "size": st.st_size, "mtime": st.st_mtime_ns / 1e9}

    def _history_save(self, rel: str, reason: str) -> str:
        with open_regular(self.root, rel) as f:
            return self.history.save(rel, f, reason)["id"]

    def _atomic_write(self, rel: str, source, mode: int, *, exclusive: bool = False) -> tuple[str, int]:
        """Write bytes (or a binary file object) to root-relative rel via a same-directory temp
        file, relative to the parent folder's descriptor. exclusive: fail (409) if something
        appeared at rel meanwhile. Returns (sha256, size). Never leaves the temp file behind."""
        with parent_fd(self.root, rel) as (pfd, name):
            for _ in range(16):
                tmp = f".ldv-tmp-{secrets.token_hex(6)}"
                try:
                    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600,
                                 dir_fd=pfd)
                    break
                except FileExistsError:
                    continue
            else:
                raise EditError(500, "could not create a temporary file")
            h = hashlib.sha256()
            size = 0
            try:
                with os.fdopen(fd, "wb") as f:
                    if isinstance(source, (bytes, bytearray)):
                        f.write(source)
                        h.update(source)
                        size = len(source)
                    else:
                        while chunk := source.read(COPY_CHUNK):
                            f.write(chunk)
                            h.update(chunk)
                            size += len(chunk)
                    f.flush()
                    os.fchmod(f.fileno(), mode)
                    os.fsync(f.fileno())
                cur = lstat_at(pfd, name)  # a symlink may not have appeared at the target meanwhile
                if cur is not None and stat_mod.S_ISLNK(cur.st_mode):
                    raise EditError(403, "symlinks cannot be edited or written through")
                if exclusive:
                    rename_noreplace(tmp, name, src_dir_fd=pfd, dst_dir_fd=pfd)
                else:
                    os.replace(tmp, name, src_dir_fd=pfd, dst_dir_fd=pfd)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp, dir_fd=pfd)
                raise
            fsync_fd(pfd)
        return h.hexdigest(), size

    def _mkdirs(self, names: list[str], first_missing: int, upto: int) -> str | None:
        """Create names[first_missing:upto] (each relative to its parent's descriptor);
        returns the topmost created rel path."""
        if first_missing >= upto:
            return None
        fd = open_dir_chain(self.root, names[:first_missing])
        try:
            for i in range(first_missing, upto):
                os.mkdir(names[i], dir_fd=fd)
                nfd = open_dir_chain_from(fd, names[i])
                os.close(fd)
                fd = nfd
        finally:
            os.close(fd)
        return "/".join(names[: first_missing + 1])

    def _make_parents(self, loc: Loc) -> str | None:
        """Create the missing parent folders of loc; returns the topmost created rel path."""
        names = loc.rel.split("/")
        return self._mkdirs(names, loc.first_missing, len(names) - 1)

    def _result(self, loc: Loc, sha: str, size: int, history_id) -> dict:
        with parent_fd(self.root, loc.rel) as (pfd, name):
            st = os.stat(name, dir_fd=pfd, follow_symlinks=False)
        return {"path": loc.rel, "sha256": sha, "size": size, "mtime": st.st_mtime_ns / 1e9,
                "history_id": history_id}

    # --- operations ---------------------------------------------------------
    def save(self, path: str, content: str, base_sha256: str | None, create: bool = False):
        data = content.encode("utf-8")
        if len(data) > self.s.edit_max_bytes:
            raise EditError(413, f"content larger than {self.s.edit_max_bytes} bytes")
        new_sha = hashlib.sha256(data).hexdigest()

        def fn():
            loc = self.wg.locate(path)
            hid = None
            if loc.exists:
                if not loc.is_file:
                    raise EditError(409, "a folder exists at this path")
                cur = self._current(loc.rel)
                if base_sha256 is None or create:
                    raise EditError(409, "file already exists", current=cur)
                if cur["sha256"] != base_sha256:
                    raise EditError(409, "file changed on disk since it was loaded", current=cur)
                if cur["sha256"] != new_sha:
                    hid = self._history_save(loc.rel, "save")
                    self._atomic_write(loc.rel, data, stat_mod.S_IMODE(loc.st.st_mode))
                op = "save"
            else:
                if base_sha256 is not None and not create:
                    raise EditError(409, "file no longer exists", current=None)
                if not loc.parent_exists:
                    raise EditError(404, "parent folder does not exist")
                self._atomic_write(loc.rel, data, self.new_file_mode, exclusive=True)
                op = "create"
            res = self._result(loc, new_sha, len(data), hid)
            self.audit.log(op, loc.rel, size=len(data), sha256=new_sha, history_id=hid)
            return res, [loc.rel], None

        return self._run(fn)

    def mkdir(self, path: str):
        def fn():
            loc = self.wg.locate(path)
            if loc.exists:
                raise EditError(409, "already exists")
            names = loc.rel.split("/")
            top = self._mkdirs(names, loc.first_missing, len(names))
            self.audit.log("mkdir", loc.rel)
            return {"path": loc.rel}, [top], None

        return self._run(fn)

    def move(self, src: str, to: str, overwrite: bool = False, create_parents: bool = False):
        def fn():
            s = self.wg.locate(src)
            if not s.exists:
                raise EditError(404, "source not found")
            if not (s.is_file or s.is_dir):
                raise EditError(400, "only files and folders can be moved")
            d = self.wg.locate(to)
            dst_rel = d.rel
            case_rename = d.exists and os.path.samestat(s.st, d.st)
            if case_rename:
                if d.req_name == os.path.basename(s.abs) and posixpath.dirname(d.rel) == posixpath.dirname(s.rel):
                    raise EditError(400, "source and destination are the same")
                dst_rel = posixpath.join(posixpath.dirname(d.rel), d.req_name)
            if s.is_dir:
                if fold(dst_rel).startswith(fold(s.rel) + "/"):
                    raise EditError(400, "cannot move a folder into itself")
                self.wg.check_tree(s.abs)
            hid = None
            scopes = [s.rel, dst_rel]
            if d.exists and not case_rename:
                if not overwrite:
                    raise EditError(409, "destination exists")
                if s.is_dir or not d.is_file:
                    raise EditError(409, "only a file can overwrite a file")
                hid = self._history_save(d.rel, "move-overwrite")
            if not d.parent_exists:
                if not create_parents:
                    raise EditError(404, "destination folder does not exist")
                top = self._make_parents(d)
                if top:
                    scopes.append(top)
            with parent_fd(self.root, s.rel) as (sfd, sname), parent_fd(self.root, dst_rel) as (dfd, dname):
                now = lstat_at(sfd, sname)
                if now is None or not os.path.samestat(now, s.st):
                    raise EditError(409, "source changed while moving it")
                try:
                    if case_rename:
                        os.rename(sname, dname, src_dir_fd=sfd, dst_dir_fd=dfd)
                    elif d.exists:
                        os.replace(sname, dname, src_dir_fd=sfd, dst_dir_fd=dfd)
                    else:
                        rename_noreplace(sname, dname, src_dir_fd=sfd, dst_dir_fd=dfd)
                except OSError as e:
                    if e.errno == 18:  # EXDEV
                        raise EditError(400, "cannot move across file systems")
                    raise
                fsync_fd(sfd)
                fsync_fd(dfd)
            self.history.rekey(s.rel, dst_rel)
            self.audit.log("move", s.rel, to=dst_rel, history_id=hid)
            return {"from": s.rel, "to": dst_rel, "history_id": hid}, scopes, [(s.rel, dst_rel)]

        return self._run(fn)

    def copy(self, src: str, to: str):
        def fn():
            s = self.wg.locate(src)
            if not s.exists:
                raise EditError(404, "source not found")
            if not s.is_file:
                raise EditError(400, "only files can be duplicated")
            d = self.wg.locate(to)
            if d.exists:
                raise EditError(409, "destination exists")
            if not d.parent_exists:
                raise EditError(404, "destination folder does not exist")
            with open_regular(self.root, s.rel) as f:
                sha, size = self._atomic_write(d.rel, f, stat_mod.S_IMODE(s.st.st_mode), exclusive=True)
            self.audit.log("copy", s.rel, to=d.rel, size=size, sha256=sha)
            return {"from": s.rel, "to": d.rel, "sha256": sha, "size": size}, [d.rel], None

        return self._run(fn)

    def delete(self, path: str):
        def fn():
            s = self.wg.locate(path)
            if not s.exists:
                raise EditError(404, "not found")
            if not (s.is_file or s.is_dir):
                raise EditError(400, "only files and folders can be deleted")
            if s.is_dir:
                self.wg.check_tree(s.abs)
            with parent_fd(self.root, s.rel) as (pfd, name):
                now = lstat_at(pfd, name)
                if now is None or not os.path.samestat(now, s.st):
                    raise EditError(409, "path changed while deleting it")
                man = self.trash.put(pfd, name, s.rel)
                fsync_fd(pfd)
            self.audit.log("delete", s.rel, trash_id=man["id"], size=man["size"])
            return {"path": s.rel, "trash_id": man["id"], "kind": man["kind"]}, [s.rel], None

        return self._run(fn)

    def trash_list(self) -> dict:
        return {"items": self.trash.list()}

    def trash_restore(self, tid: str, to: str | None = None):
        def fn():
            try:
                man, item = self.trash.get(tid)
            except RecoveryError as e:
                raise EditError(e.status, e.detail)
            d = self.wg.locate(to or man["original_path"])
            if d.exists:
                raise EditError(409, "a file or folder already exists at the restore location",
                                path=d.rel)
            if os.path.isdir(item) and not os.path.islink(item):
                self.wg.check_tree(item)
            scopes = [d.rel]
            top = self._make_parents(d)
            if top:
                scopes.append(top)
            with parent_fd(self.root, d.rel) as (pfd, name):
                try:
                    self.trash.take(tid, pfd, name)
                except FileExistsError:
                    raise EditError(409, "a file or folder already exists at the restore location",
                                    path=d.rel)
                fsync_fd(pfd)
            if d.rel != man["original_path"]:
                self.history.rekey(man["original_path"], d.rel)
            self.audit.log("restore", d.rel, trash_id=tid)
            return {"path": d.rel, "id": tid}, scopes, None

        return self._run(fn)

    def trash_purge(self, tid: str | None = None, everything: bool = False):
        def fn():
            if everything:
                n = self.trash.purge_all()
                self.audit.log("purge", "", size=n)
                return {"purged": n}, [], None
            if tid is None:
                raise EditError(400, "id or all:true is required")
            man = self.trash.purge(tid)
            self.audit.log("purge", man["original_path"], trash_id=tid)
            return {"purged": 1}, [], None

        return self._run(fn)

    def _history_path(self, path: str) -> str:
        return self.wg.locate(path).rel

    def history_list(self, path: str) -> dict:
        rel = self._history_path(path)
        return {"path": rel, "versions": self.history.list(rel)}

    def history_content(self, path: str, vid: str) -> tuple[dict, bytes, bool]:
        rel = self._history_path(path)
        try:
            man, blob = self.history.get(rel, vid)
        except RecoveryError as e:
            raise EditError(e.status, e.detail)
        with open(blob, "rb") as f:
            data = f.read(HISTORY_TEXT_MAX + 1)
        return man, data[:HISTORY_TEXT_MAX], len(data) > HISTORY_TEXT_MAX

    def history_restore(self, path: str, vid: str):
        def fn():
            loc = self.wg.locate(path)
            if not loc.exists:
                raise EditError(404, "file not found (restore it from the trash first)")
            if not loc.is_file:
                raise EditError(409, "a folder exists at this path")
            try:
                man, blob = self.history.get(loc.rel, vid)
            except RecoveryError as e:
                raise EditError(e.status, e.detail)
            with open(blob, "rb") as f:
                old = f.read()  # before saving the current version, which may prune this one
            old_sha = hashlib.sha256(old).hexdigest()
            if self._current(loc.rel)["sha256"] == old_sha:
                # identical to the current file: nothing to write, no no-op version
                res = {**self._result(loc, old_sha, len(old), None), "restored_id": vid,
                       "unchanged": True}
                return res, [], None
            hid = self._history_save(loc.rel, "restore")
            sha, size = self._atomic_write(loc.rel, old, stat_mod.S_IMODE(loc.st.st_mode))
            self.audit.log("history-restore", loc.rel, size=size, sha256=sha, history_id=hid)
            return {**self._result(loc, sha, size, hid), "restored_id": vid}, [loc.rel], None

        return self._run(fn)

    def prepare_upload_name(self, raw: str) -> str:
        name = _sanitize_upload_name(raw)
        ext = ext_of(name)
        if ext not in self.s.upload_ext:
            raise EditError(415, f"file type not allowed: {('.' + ext) if ext else '(no extension)'}",
                            name=raw)
        self.wg.check_name(name)
        return name

    def upload(self, dir_rel: str, files: list[tuple[str, object]], overwrite: bool = False,
               create_dir: bool = False):
        """files: [(raw filename, binary file object)], already size-checked while streaming."""
        if not files:
            raise EditError(400, "no files")
        names = [self.prepare_upload_name(raw) for raw, _f in files]  # validate all before writing

        def fn():
            d = self.wg.locate(dir_rel or "", allow_root=True)
            scopes: list[str] = []
            if not d.exists:
                if not create_dir:
                    raise EditError(404, "folder does not exist")
                names_ = d.rel.split("/")
                scopes.append(self._mkdirs(names_, d.first_missing, len(names_)))
            elif not d.is_dir:
                raise EditError(400, "not a folder")
            taken: set[str] = set()
            items = []
            for name, (_raw, fobj) in zip(names, files):
                cand, i = name, 0
                while True:
                    loc = self.wg.locate(posixpath.join(d.rel, cand) if d.rel else cand)
                    if fold(cand) in taken:
                        pass
                    elif not loc.exists or (overwrite and loc.is_file):
                        break
                    elif overwrite:
                        raise EditError(409, f"a folder exists at {loc.rel}")
                    i += 1
                    if i > MAX_SUFFIX:
                        raise EditError(409, f"too many files named like {name}")
                    cand = _suffixed(name, i)
                taken.add(fold(cand))
                hid = None
                mode = self.new_file_mode
                if loc.exists:
                    hid = self._history_save(loc.rel, "upload-overwrite")
                    mode = stat_mod.S_IMODE(loc.st.st_mode)
                fobj.seek(0)
                sha, size = self._atomic_write(loc.rel, fobj, mode, exclusive=not loc.exists)
                self.audit.log("upload", loc.rel, size=size, sha256=sha, history_id=hid)
                items.append({"path": loc.rel, "size": size, "sha256": sha, "history_id": hid})
                scopes.append(loc.rel)
            return {"paths": [it["path"] for it in items], "items": items}, scopes, None

        return self._run(fn)

    def audit_recent(self, limit: int = 100) -> dict:
        return {"items": self.audit.recent(limit)}
