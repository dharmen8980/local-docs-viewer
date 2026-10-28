"""Recovery store kept in the data dir (never inside the root): file history, trash, audit log.

Layout:
    <data>/history/<sha256(path)>/<id>        previous bytes of <path>
    <data>/history/<sha256(path)>/<id>.json   manifest {id, path, saved_at, size, sha256, reason}
    <data>/trash/<id>/item                    the deleted file or folder
    <data>/trash/<id>/manifest.json           {id, original_path, deleted_at, kind, size, file_count}
    <data>/audit.jsonl                        one JSON line per mutation (never file contents)
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import os
import re
import secrets
import shutil
import stat as stat_mod
import sys
import threading
import time

ID_RE = re.compile(r"^[0-9]{20}-[0-9a-f]{8}$")
COPY_CHUNK = 1024 * 1024


class RecoveryError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def new_id() -> str:
    return f"{time.time_ns():020d}-{secrets.token_hex(4)}"


def check_id(value: str | None) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise RecoveryError(400, "invalid id")
    return value


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(COPY_CHUNK):
            h.update(chunk)
    return h.hexdigest()


def fsync_dir(path: str) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write_json(path: str, data: dict) -> None:
    tmp = f"{path}.tmp-{secrets.token_hex(4)}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _read_json(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _fsync_tree(path: str) -> None:
    for dirpath, _dirs, files in os.walk(path):
        for fn in files:
            p = os.path.join(dirpath, fn)
            if os.path.islink(p):
                continue
            with contextlib.suppress(OSError):
                with open(p, "rb") as f:
                    os.fsync(f.fileno())
        fsync_dir(dirpath)


def move_any(src: str, dst: str, *, src_dir_fd: int | None = None, dst_dir_fd: int | None = None,
             noreplace: bool = False) -> None:
    """Rename (relative to optional dir fds), falling back to copy + fsync + remove across file
    systems. noreplace: fail with FileExistsError instead of replacing dst."""
    from .fsops import fd_path, rename_noreplace

    try:
        if noreplace:
            AT = -2 if sys.platform == "darwin" else -100  # AT_FDCWD
            rename_noreplace(src, dst, src_dir_fd=AT if src_dir_fd is None else src_dir_fd,
                             dst_dir_fd=AT if dst_dir_fd is None else dst_dir_fd)
        else:
            os.replace(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        return
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
    # cross-device fallback works on absolute paths (only between root and data dir)
    if src_dir_fd is not None:
        src = os.path.join(fd_path(src_dir_fd), src)
    if dst_dir_fd is not None:
        dst = os.path.join(fd_path(dst_dir_fd), dst)
    if os.path.lexists(dst):
        raise FileExistsError(errno.EEXIST, "destination exists", dst)
    try:
        if os.path.isdir(src) and not os.path.islink(src):
            shutil.copytree(src, dst, symlinks=True)
            _fsync_tree(dst)
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
            with open(dst, "rb") as f:
                os.fsync(f.fileno())
    except BaseException:
        if os.path.isdir(dst) and not os.path.islink(dst):
            shutil.rmtree(dst, ignore_errors=True)
        else:
            with contextlib.suppress(OSError):
                os.unlink(dst)
        raise
    if os.path.isdir(src) and not os.path.islink(src):
        shutil.rmtree(src)
    else:
        os.unlink(src)


def tree_stats(path: str) -> tuple[int, int]:
    """(total bytes, file count) of a file or a folder (symlinks not followed)."""
    st = os.lstat(path)
    if not stat_mod.S_ISDIR(st.st_mode):
        return st.st_size, 1
    size = count = 0
    for dirpath, _dirs, files in os.walk(path):
        for fn in files:
            try:
                size += os.lstat(os.path.join(dirpath, fn)).st_size
                count += 1
            except OSError:
                pass
    return size, count


class History:
    def __init__(self, data_dir: str, keep: int):
        self.base = os.path.join(data_dir, "history")
        self.keep = keep
        os.makedirs(self.base, mode=0o700, exist_ok=True)

    def _dir(self, path: str) -> str:
        return os.path.join(self.base, hashlib.sha256(path.encode("utf-8")).hexdigest())

    def save(self, path: str, src, reason: str) -> dict:
        """Copy the current bytes of `src` (an open binary file object for the file at
        root-relative `path`, opened without following symlinks) into history."""
        d = self._dir(path)
        os.makedirs(d, mode=0o700, exist_ok=True)
        vid = new_id()
        dst = os.path.join(d, vid)
        h = hashlib.sha256()
        size = 0
        try:
            src.seek(0)
            with open(dst, "xb") as fo:
                fi = src
                while chunk := fi.read(COPY_CHUNK):
                    h.update(chunk)
                    size += len(chunk)
                    fo.write(chunk)
                fo.flush()
                os.fsync(fo.fileno())
            man = {"id": vid, "path": path, "saved_at": time.time(), "size": size,
                   "sha256": h.hexdigest(), "reason": reason}
            _write_json(dst + ".json", man)
        except BaseException:
            for p in (dst, dst + ".json"):
                with contextlib.suppress(OSError):
                    os.unlink(p)
            raise
        self._prune(d)
        return man

    def _manifests(self, d: str) -> list[dict]:
        try:
            names = os.listdir(d)
        except OSError:
            return []
        out = []
        for n in names:
            if n.endswith(".json") and ID_RE.match(n[:-5]):
                m = _read_json(os.path.join(d, n))
                if m and m.get("id") == n[:-5] and os.path.isfile(os.path.join(d, n[:-5])):
                    out.append(m)
        out.sort(key=lambda m: m["id"], reverse=True)
        return out

    def _prune(self, d: str) -> None:
        for m in self._manifests(d)[self.keep:]:
            for p in (os.path.join(d, m["id"]), os.path.join(d, m["id"] + ".json")):
                with contextlib.suppress(OSError):
                    os.unlink(p)

    def list(self, path: str) -> list[dict]:
        return [m for m in self._manifests(self._dir(path)) if m.get("path") == path]

    def get(self, path: str, vid: str) -> tuple[dict, str]:
        check_id(vid)
        d = self._dir(path)
        man = _read_json(os.path.join(d, vid + ".json"))
        blob = os.path.join(d, vid)
        if not man or man.get("path") != path or not os.path.isfile(blob):
            raise RecoveryError(404, "version not found")
        return man, blob

    def rekey(self, old: str, new: str) -> None:
        """History follows moves: re-file every version of `old` (or of files below the folder
        `old`) under the corresponding new path."""
        try:
            keys = os.listdir(self.base)
        except OSError:
            return
        for k in keys:
            d = os.path.join(self.base, k)
            for m in self._manifests(d):
                p = m.get("path", "")
                if p != old and not p.startswith(old + "/"):
                    continue
                np = new + p[len(old):]
                nd = self._dir(np)
                os.makedirs(nd, mode=0o700, exist_ok=True)
                os.replace(os.path.join(d, m["id"]), os.path.join(nd, m["id"]))
                _write_json(os.path.join(nd, m["id"] + ".json"), {**m, "path": np})
                with contextlib.suppress(OSError):
                    os.unlink(os.path.join(d, m["id"] + ".json"))
                self._prune(nd)
            with contextlib.suppress(OSError):
                os.rmdir(d)  # only if now empty


class Trash:
    def __init__(self, data_dir: str):
        self.base = os.path.join(data_dir, "trash")
        os.makedirs(self.base, mode=0o700, exist_ok=True)

    def put(self, src_dir_fd: int, name: str, rel: str) -> dict:
        """Move the entry `name` of the folder `src_dir_fd` (root-relative path `rel`) to trash."""
        tid = new_id()
        d = os.path.join(self.base, tid)
        st = os.stat(name, dir_fd=src_dir_fd, follow_symlinks=False)
        if stat_mod.S_ISLNK(st.st_mode):
            raise RecoveryError(403, "symlinks cannot be deleted through the viewer")
        is_dir = stat_mod.S_ISDIR(st.st_mode)
        os.mkdir(d, 0o700)
        man = {"id": tid, "original_path": rel, "deleted_at": time.time(),
               "kind": "dir" if is_dir else "file", "size": 0, "file_count": 0,
               "name": os.path.basename(rel)}
        item = os.path.join(d, "item")
        try:
            # write the manifest first so an interrupted move is still restorable/purgeable
            _write_json(os.path.join(d, "manifest.json"), man)
            move_any(name, item, src_dir_fd=src_dir_fd)
        except BaseException:
            if not os.path.lexists(item):
                shutil.rmtree(d, ignore_errors=True)
            raise
        size, count = tree_stats(item)
        man.update(size=size, file_count=count)
        _write_json(os.path.join(d, "manifest.json"), man)
        fsync_dir(d)
        return man

    def get(self, tid: str) -> tuple[dict, str]:
        check_id(tid)
        d = os.path.join(self.base, tid)
        man = _read_json(os.path.join(d, "manifest.json"))
        item = os.path.join(d, "item")
        if not man or man.get("id") != tid or not os.path.lexists(item):
            raise RecoveryError(404, "trash item not found")
        return man, item

    def list(self) -> list[dict]:
        try:
            names = os.listdir(self.base)
        except OSError:
            return []
        out = []
        for n in names:
            if ID_RE.match(n):
                with contextlib.suppress(OSError):
                    out.append(self.get(n)[0])
        out.sort(key=lambda m: m["id"], reverse=True)
        return out

    def take(self, tid: str, dst_dir_fd: int, dst_name: str) -> dict:
        man, item = self.get(tid)
        move_any(item, dst_name, dst_dir_fd=dst_dir_fd, noreplace=True)
        shutil.rmtree(os.path.join(self.base, tid), ignore_errors=True)
        return man

    def purge(self, tid: str) -> dict:
        man, _item = self.get(tid)
        shutil.rmtree(os.path.join(self.base, tid))
        return man

    def purge_all(self) -> int:
        n = 0
        for m in self.list():
            shutil.rmtree(os.path.join(self.base, m["id"]), ignore_errors=True)
            n += 1
        return n


class Audit:
    def __init__(self, data_dir: str):
        self.path = os.path.join(data_dir, "audit.jsonl")
        self._lock = threading.Lock()

    def log(self, op: str, path: str, **extra) -> dict:
        rec = {"ts": time.time(), "op": op, "path": path}
        rec.update({k: v for k, v in extra.items() if v is not None})
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with self._lock:
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)
        return rec

    def recent(self, limit: int = 100) -> list[dict]:
        limit = max(1, min(int(limit), 1000))
        try:
            with open(self.path, "rb") as f:
                f.seek(0, os.SEEK_END)
                end = f.tell()
                # the tail is enough: lines are small (no contents)
                f.seek(max(0, end - limit * 2048))
                data = f.read()
        except OSError:
            return []
        lines = data.decode("utf-8", errors="replace").splitlines()
        if end > limit * 2048 and lines:
            lines = lines[1:]  # first line may be partial
        out = []
        for ln in reversed(lines):
            try:
                out.append(json.loads(ln))
            except ValueError:
                continue
            if len(out) >= limit:
                break
        return out
