"""In-memory tree of the root, change detection (watcher + reconcile), rename inference, pub/sub."""

from __future__ import annotations

import asyncio
import logging
import os
import posixpath
import threading
from dataclasses import dataclass, field

from .paths import PathGuard, ext_of, kind_of

log = logging.getLogger("viewer.store")


@dataclass(frozen=True)
class Entry:
    path: str
    name: str
    size: int
    mtime_ns: int
    kind: str
    ext: str

    @property
    def sig(self) -> tuple[int, int]:
        return (self.size, self.mtime_ns)

    def to_json(self) -> dict:
        return {
            "path": self.path, "name": self.name, "size": self.size,
            "mtime": self.mtime_ns / 1e9, "kind": self.kind, "ext": self.ext,
        }


@dataclass
class Change:
    version: int = 0
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    renames: list[dict] = field(default_factory=list)
    dirs_changed: bool = False

    def empty(self) -> bool:
        return not (self.added or self.modified or self.deleted or self.renames or self.dirs_changed)

    def to_json(self) -> dict:
        return {
            "version": self.version, "added": self.added, "modified": self.modified,
            "deleted": self.deleted, "renames": self.renames, "dirs_changed": self.dirs_changed,
        }


def _under(path: str, scope: str) -> bool:
    return scope == "" or path == scope or path.startswith(scope + "/")


def minimal_scopes(scopes) -> list[str]:
    """Drop scopes covered by an ancestor scope."""
    out: list[str] = []
    for s in sorted(set(scopes)):
        if out and _under(s, out[-1]):
            continue
        out.append(s)
    return out


class Store:
    def __init__(self, guard: PathGuard):
        self.guard = guard
        self.root = guard.root
        self.entries: dict[str, Entry] = {}
        self.dirs: set[str] = set()
        self.version = 0
        self._state_lock = threading.Lock()
        self._scan_lock = threading.Lock()
        self._kind_cache: dict[tuple[str, int, int], str] = {}
        # in-root file symlinks: link rel path -> target rel path. The watcher only reports
        # the target when it changes, so rescans of a target scope also re-stat its links.
        self._links: dict[str, str] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    # --- reading ----------------------------------------------------------
    def snapshot(self) -> dict:
        with self._state_lock:
            files = [e.to_json() for _, e in sorted(self.entries.items())]
            return {"files": files, "dirs": sorted(self.dirs), "version": self.version}

    def get(self, path: str) -> Entry | None:
        with self._state_lock:
            return self.entries.get(path)

    def all_entries(self) -> list[Entry]:
        with self._state_lock:
            return list(self.entries.values())

    # --- scanning ---------------------------------------------------------
    def _entry(self, rel: str, abs_path: str, st: os.stat_result) -> Entry:
        name = posixpath.basename(rel)
        key = (rel, st.st_size, st.st_mtime_ns)
        kind = self._kind_cache.get(key)
        if kind is None:
            kind = kind_of(name, abs_path)
            self._kind_cache[key] = kind
        return Entry(rel, name, st.st_size, st.st_mtime_ns, kind, ext_of(name))

    def _scan_scope(self, scope: str) -> tuple[dict[str, Entry], set[str]] | None:
        """Current on-disk state under scope, or None if the scope must be ignored."""
        files: dict[str, Entry] = {}
        dirs: set[str] = set()
        if scope:
            if self.guard.rel_hidden(scope):
                return None
            abs_path = os.path.join(self.root, *scope.split("/"))
            if self.guard.excluded and self.guard.is_excluded(abs_path):
                return None
            parent = os.path.dirname(abs_path)
            if os.path.lexists(parent) and os.path.realpath(parent) != parent:
                return None  # inside a symlinked dir: never descended
            if os.path.isdir(abs_path) and not os.path.islink(abs_path):
                dirs.add(scope)
                start = abs_path
            else:
                if os.path.lexists(abs_path):
                    st = self.guard.file_ok(abs_path)
                    if st is not None:
                        files[scope] = self._entry(scope, abs_path, st)
                return files, dirs
        else:
            start = self.root
        for item in self.guard.walk(start):
            if item[0] == "dir":
                dirs.add(item[1])
            else:
                _, rel, abs_path, st = item
                files[rel] = self._entry(rel, abs_path, st)
        return files, dirs

    def apply_scopes(self, scopes, renames=None) -> Change | None:
        """Rescan the given root-relative scopes ('' = everything), commit, return the diff.

        renames: optional known (from, to) moves (files or folder prefixes), used before the
        size/mtime inference so explicit moves are always reported as renames."""
        with self._scan_lock:
            return self._apply_scopes_locked(scopes, renames)

    def mutate(self, fn):
        """Run fn() -> (result, scopes, renames) while holding the scan lock (so the watcher and
        reconcile cannot observe a half-done mutation), then commit those scopes. Returns
        (result, Change | None). A later watcher rescan of the same paths finds no diff."""
        with self._scan_lock:
            result, scopes, renames = fn()
            ch = self._apply_scopes_locked(scopes, renames) if scopes else None
            return result, ch

    def _apply_scopes_locked(self, scopes, renames=None) -> Change | None:
        scopes = list(scopes)
        with self._state_lock:
            scopes += [link for link, target in self._links.items()
                       if any(_under(target, s) for s in scopes)]
        scopes = minimal_scopes(scopes)
        new_files: dict[str, Entry] = {}
        new_dirs: set[str] = set()
        used: list[str] = []
        for scope in scopes:
            res = self._scan_scope(scope)
            if res is None:
                continue
            used.append(scope)
            new_files.update(res[0])
            new_dirs |= res[1]
            # make sure existing ancestor dirs are known (missed dir events)
            parent = posixpath.dirname(scope)
            while parent:
                if os.path.isdir(os.path.join(self.root, *parent.split("/"))):
                    new_dirs.add(parent)
                parent = posixpath.dirname(parent)
        if not used:
            return None
        new_links: dict[str, str] = {}
        for p in new_files:
            ap = os.path.join(self.root, *p.split("/"))
            if os.path.islink(ap):
                new_links[p] = self.guard.rel_of(os.path.realpath(ap))
        with self._state_lock:
            old_files = {p: e for p, e in self.entries.items() if any(_under(p, s) for s in used)}
            old_dirs = {d for d in self.dirs if any(_under(d, s) for s in used)}
            ancestors = {d for d in new_dirs if not any(_under(d, s) for s in used)}
            ch = Change()
            deleted = [p for p in old_files if p not in new_files]
            added = [p for p in new_files if p not in old_files]
            ch.modified = sorted(p for p in new_files if p in old_files and old_files[p].sig != new_files[p].sig)
            # rename inference: same (size, mtime_ns, basename)
            pool: dict[tuple, list[str]] = {}
            for p in sorted(deleted):
                e = old_files[p]
                pool.setdefault((e.size, e.mtime_ns, e.name), []).append(p)
            renamed_from: set[str] = set()
            renamed_to: set[str] = set()
            added_set = set(added)
            for src_root, dst_root in renames or ():
                for p in sorted(deleted):
                    if p in renamed_from or not _under(p, src_root):
                        continue
                    q = dst_root + p[len(src_root):]
                    if q in renamed_to:
                        continue
                    if q in added_set:
                        ch.renames.append({"from": p, "to": q})
                        renamed_from.add(p)
                        renamed_to.add(q)
                    elif q in new_files and q in old_files:  # moved over an existing file
                        ch.renames.append({"from": p, "to": q})
                        renamed_from.add(p)
                        renamed_to.add(q)
                        if q in ch.modified:
                            ch.modified.remove(q)
            for p in sorted(added):
                if p in renamed_to:
                    continue
                e = new_files[p]
                key = (e.size, e.mtime_ns, e.name)
                cands = [c for c in pool.get(key, ()) if c not in renamed_from]
                if cands:
                    src = cands[0]
                    pool[key].remove(src)
                    ch.renames.append({"from": src, "to": p})
                    renamed_from.add(src)
                    renamed_to.add(p)
            # second pass: an in-place file rename keeps size, mtime_ns and
            # the parent dir but changes the basename. Only pair when the
            # (dir, size, mtime_ns) key is unambiguous on both sides.
            left_del: dict[tuple, list[str]] = {}
            for p in deleted:
                if p not in renamed_from:
                    e = old_files[p]
                    left_del.setdefault((posixpath.dirname(p), e.size, e.mtime_ns), []).append(p)
            left_add: dict[tuple, list[str]] = {}
            for p in added:
                if p not in renamed_to:
                    e = new_files[p]
                    left_add.setdefault((posixpath.dirname(p), e.size, e.mtime_ns), []).append(p)
            for key, dsts in sorted(left_add.items()):
                srcs = left_del.get(key)
                if srcs and len(srcs) == 1 and len(dsts) == 1:
                    ch.renames.append({"from": srcs[0], "to": dsts[0]})
                    renamed_from.add(srcs[0])
                    renamed_to.add(dsts[0])
            ch.added = sorted(p for p in added if p not in renamed_to)
            ch.deleted = sorted(p for p in deleted if p not in renamed_from)
            ch.dirs_changed = old_dirs != (new_dirs - ancestors) or not ancestors <= self.dirs
            if ch.empty():
                return None
            for p in old_files:
                if p not in new_files:
                    del self.entries[p]
            self.entries.update(new_files)
            for p in old_files:
                self._links.pop(p, None)
            self._links.update(new_links)
            self.dirs -= old_dirs
            self.dirs |= new_dirs
            self.version += 1
            ch.version = self.version
            if len(self._kind_cache) > 20000:
                self._kind_cache.clear()
            return ch

    def full_scan(self) -> Change | None:
        return self.apply_scopes([""])

    def scopes_for_paths(self, abs_paths) -> list[str]:
        """Map watcher-reported absolute paths to root-relative scopes."""
        scopes: list[str] = []
        for p in abs_paths:
            p = os.path.normpath(p)
            if not self.guard.inside(p):
                # FSEvents may report a differently spelled prefix (/private/var vs /var)
                parent = os.path.dirname(p)
                alt = os.path.join(os.path.realpath(parent), os.path.basename(p)) if os.path.exists(parent) else p
                if not self.guard.inside(alt):
                    scopes.append("")  # unknown: fall back to a full rescan
                    continue
                p = alt
            rel = self.guard.rel_of(p)
            if rel.startswith(".."):
                continue
            scopes.append(rel)
        return scopes

    # --- pub/sub ----------------------------------------------------------
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def publish(self, change: Change) -> None:
        """Must be called on the event loop thread."""
        self._put(change.to_json())

    def publish_event(self, event: str, data: dict) -> None:
        """Another SSE event type on the same stream (e.g. "seen"); event loop thread only."""
        self._put((event, data))

    def _put(self, data) -> None:
        for q in list(self._subscribers):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(data)


async def watch_loop(store: Store, on_change, stop: asyncio.Event) -> None:
    """watchfiles-based watcher; on_change(Change) is awaited for each non-empty diff."""
    from watchfiles import awatch

    try:
        async for batch in awatch(store.root, recursive=True, watch_filter=None,
                                  stop_event=stop, debounce=400, step=50):
            scopes = store.scopes_for_paths(p for _, p in batch)
            ch = await asyncio.to_thread(store.apply_scopes, scopes)
            if ch is not None:
                await on_change(ch)
    except asyncio.CancelledError:
        raise
    except Exception:  # pragma: no cover - watcher failure is not fatal; reconcile still runs
        log.exception("file watcher stopped; relying on periodic reconcile")


async def reconcile_loop(store: Store, on_change, interval: float, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
            return
        except TimeoutError:
            pass
        try:
            ch = await asyncio.to_thread(store.full_scan)
            if ch is not None:
                await on_change(ch)
        except Exception:  # pragma: no cover
            log.exception("reconcile failed")
