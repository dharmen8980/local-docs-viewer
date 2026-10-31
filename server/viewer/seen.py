"""History for "Changed since you last looked": seen records and text snapshots in
<data_dir>/seen.sqlite3, namespaced by the canonical root path.

The UI does all the diffing; this module only stores what the UI last showed (a commit may name
that text by its SHA-256 instead: the file is then read and kept only if it matches). It never writes
inside a browsed folder: callers must not use it when the data dir overlaps the root
(`seen_disabled_reason`). Limits and pruning mirror the former browser-side store: snapshots
(all roots together) drop oldest first beyond SNAPSHOTS_MAX copies or SNAPSHOTS_TOTAL_CHARS,
seen records beyond SEEN_MAX_PER_ROOT per root; when the disk is full, older snapshots go and
the seen record is kept without its text."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import posixpath
import sqlite3
import threading
import time
from collections.abc import Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .app import SEEN_PREFIX
from .paths import PathError
from .readers import CONTENT_MAX

log = logging.getLogger("viewer")

SEEN_FILE = "seen.sqlite3"
# Text sizes are counted in UTF-16 code units, like the UI (JavaScript string length).
SNAPSHOT_MAX_CHARS = CONTENT_MAX  # /api/content serves at most this, so a fetched text always fits
SNAPSHOTS_TOTAL_CHARS = 64 * 1024 * 1024
SNAPSHOTS_MAX = 1000
SEEN_MAX_PER_ROOT = 20000
PATH_MAX = 4096
SHA256_HEX = r"^[0-9a-f]{64}$"
# a 2M-char snapshot JSON-encodes to at most 6 bytes per UTF-16 unit (\u00XX); plus mark entries
SEEN_JSON_MAX = SNAPSHOT_MAX_CHARS * 6 + 4 * 1024 * 1024
CLIENT_ID_MAX = 64

SCHEMA = """
CREATE TABLE IF NOT EXISTS seen (
    root TEXT NOT NULL, path TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL,
    viewed_at REAL NOT NULL, PRIMARY KEY (root, path));
CREATE INDEX IF NOT EXISTS seen_root_viewed ON seen (root, viewed_at);
CREATE TABLE IF NOT EXISTS snaps (
    root TEXT NOT NULL, path TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL,
    viewed_at REAL NOT NULL, chars INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (root, path));
CREATE INDEX IF NOT EXISTS snaps_viewed ON snaps (viewed_at);
"""

_UNSET = object()  # commit(text=_UNSET): leave the snapshot alone


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def check_rel(rel: object, hidden) -> str | None:
    """Lexical path check for stored paths (the file may no longer exist: deleted or renamed).
    The path must be a normalised root-relative POSIX path with no denied/ignored component
    (`hidden(rel)`, PathGuard.rel_hidden). Returns the path, or None if it is refused."""
    if not isinstance(rel, str) or not rel or len(rel) > PATH_MAX or "\0" in rel or "\\" in rel:
        return None
    if rel.startswith("/") or os.path.isabs(rel) or posixpath.normpath(rel) != rel:
        return None
    if any(c in ("", ".", "..") for c in rel.split("/")):
        return None
    try:
        rel.encode("utf-8")
    except UnicodeEncodeError:  # lone surrogates
        return None
    if hidden(rel):
        return None
    return rel


def _is_full(e: sqlite3.Error) -> bool:
    return isinstance(e, sqlite3.OperationalError) and "full" in str(e).lower()


@contextlib.contextmanager
def _tx(db: sqlite3.Connection):
    db.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        with contextlib.suppress(sqlite3.Error):
            db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")


def _rec(root: str, path: str, mtime: float, size: int, viewed_at: float) -> dict:
    return {"root": root, "path": path, "mtime": mtime, "size": size, "viewedAt": viewed_at}


class SeenDB:
    """One SQLite file shared by every root (and every viewer process using this data dir).
    Thread-safe (one connection behind a lock); callers run methods in a worker thread."""

    def __init__(self, data_dir: str, *, snapshot_max_chars: int = SNAPSHOT_MAX_CHARS,
                 snapshots_total_chars: int = SNAPSHOTS_TOTAL_CHARS, snapshots_max: int = SNAPSHOTS_MAX,
                 seen_max_per_root: int = SEEN_MAX_PER_ROOT):
        self.data_dir = data_dir
        self.path = os.path.join(data_dir, SEEN_FILE)
        self.snapshot_max_chars = snapshot_max_chars
        self.snapshots_total_chars = snapshots_total_chars
        self.snapshots_max = snapshots_max
        self.seen_max_per_root = seen_max_per_root
        self._lock = threading.Lock()
        self._db: sqlite3.Connection | None = None
        self._failed_at = 0.0

    # -- connection ------------------------------------------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        if self._db is not None:
            return self._db
        os.makedirs(self.data_dir, mode=0o700, exist_ok=True)
        if not os.path.exists(self.path):  # create it 0600 (and never through a symlink)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        db = sqlite3.connect(self.path, timeout=5.0, check_same_thread=False, isolation_level=None)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.executescript(SCHEMA)
        except BaseException:
            db.close()
            raise
        self._db = db
        return db

    def available(self) -> bool:
        """Opens the database (creating it) if needed. A failure is retried after 30 s."""
        with self._lock:
            if self._db is not None:
                return True
            if self._failed_at and time.monotonic() - self._failed_at < 30:
                return False
            try:
                self._conn()
                return True
            except (OSError, sqlite3.Error) as e:
                self._failed_at = time.monotonic()
                log.warning("changes history unavailable (%s): %s", self.path, e)
                return False

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    # -- reads -----------------------------------------------------------------------------------

    def load(self, root: str) -> list[dict]:
        with self._lock:
            rows = self._conn().execute(
                "SELECT path, mtime, size, viewed_at FROM seen WHERE root = ?", (root,)).fetchall()
        return [_rec(root, *r) for r in rows]

    def get(self, root: str, paths: list[str]) -> list[dict]:
        out = []
        with self._lock:
            db = self._conn()
            for p in dict.fromkeys(paths):
                r = db.execute("SELECT mtime, size, viewed_at FROM seen WHERE root = ? AND path = ?",
                               (root, p)).fetchone()
                if r is not None:
                    out.append(_rec(root, p, *r))
        return out

    def snapshot(self, root: str, path: str) -> dict | None:
        with self._lock:
            r = self._conn().execute(
                "SELECT mtime, size, viewed_at, text FROM snaps WHERE root = ? AND path = ?",
                (root, path)).fetchone()
        if r is None:
            return None
        return {"path": path, "mtime": r[0], "size": r[1], "viewedAt": r[2], "text": r[3]}

    # -- writes ----------------------------------------------------------------------------------

    def _write_commit(self, db, root: str, path: str, mtime: float, size: int, text, now: float) -> None:
        with _tx(db):
            db.execute("INSERT OR REPLACE INTO seen VALUES (?, ?, ?, ?, ?)", (root, path, mtime, size, now))
            if isinstance(text, str) and (n := utf16_len(text)) <= self.snapshot_max_chars:
                db.execute("INSERT OR REPLACE INTO snaps VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (root, path, mtime, size, now, n, text))
            elif text is not _UNSET:  # null, or too long: no text for this version
                db.execute("DELETE FROM snaps WHERE root = ? AND path = ?", (root, path))

    def commit(self, root: str, path: str, mtime: float, size: int, text=_UNSET) -> dict:
        """Record `path` at (mtime, size) as viewed now. text: str = snapshot it; None = drop a
        stale snapshot; _UNSET = leave the snapshot alone."""
        now = time.time() * 1000
        with self._lock:
            db = self._conn()
            try:
                self._write_commit(db, root, path, mtime, size, text, now)
            except sqlite3.Error as e:
                if not _is_full(e):
                    raise
                # Out of space: make room, then keep at least the seen record.
                self._prune(db, root, 0.5)
                self._write_commit(db, root, path, mtime, size, _UNSET if text is _UNSET else None, now)
            self._prune(db, root, 1)
        return _rec(root, path, mtime, size, now)

    def mark(self, root: str, entries: list[tuple[str, float, int]]) -> list[dict]:
        """Seen records only; snapshots are kept."""
        now = time.time() * 1000
        with self._lock:
            db = self._conn()
            with _tx(db):
                db.executemany("INSERT OR REPLACE INTO seen VALUES (?, ?, ?, ?, ?)",
                               [(root, p, m, s, now) for p, m, s in entries])
            self._prune(db, root, 1)
        return [_rec(root, p, m, s, now) for p, m, s in entries]

    def rename(self, root: str, src: str, dst: str) -> int:
        """Move the records of `src` and of everything below `src/` to `dst` (replacing any
        records already there). Returns the number of seen records moved."""
        if not src or src == dst:
            return 0
        prefix = src + "/"
        moved = 0
        with self._lock:
            db = self._conn()
            with _tx(db):
                for table in ("seen", "snaps"):
                    cur = db.execute(
                        f"UPDATE OR REPLACE {table} SET path = ? || substr(path, ?) "  # noqa: S608 - fixed names
                        "WHERE root = ? AND (path = ? OR substr(path, 1, ?) = ?)",
                        (dst, len(src) + 1, root, src, len(prefix), prefix))
                    if table == "seen":
                        moved = cur.rowcount
        return moved

    def clear(self, root: str) -> list[str]:
        """Forget every seen record and snapshot of `root`. Returns the paths that had a record."""
        with self._lock:
            db = self._conn()
            with _tx(db):
                paths = [p for (p,) in db.execute("SELECT path FROM seen WHERE root = ?", (root,))]
                db.execute("DELETE FROM seen WHERE root = ?", (root,))
                db.execute("DELETE FROM snaps WHERE root = ?", (root,))
        return paths

    def _prune(self, db, root: str, factor: float) -> None:
        """LRU: oldest snapshots (all roots) and oldest seen records (this root) go first."""
        max_chars = self.snapshots_total_chars * factor
        max_count = int(self.snapshots_max * factor)
        max_seen = int(self.seen_max_per_root * factor)
        with _tx(db):
            self._prune_locked(db, root, max_chars, max_count, max_seen)

    @staticmethod
    def _prune_locked(db, root: str, max_chars: float, max_count: int, max_seen: int) -> None:
        chars, count = db.execute("SELECT coalesce(sum(chars), 0), count(*) FROM snaps").fetchone()
        if chars > max_chars or count > max_count:
            drop = []
            for r, p, n in db.execute("SELECT root, path, chars FROM snaps ORDER BY viewed_at, rowid"):
                if chars <= max_chars and count <= max_count:
                    break
                drop.append((r, p))
                chars -= n
                count -= 1
            db.executemany("DELETE FROM snaps WHERE root = ? AND path = ?", drop)
        (n,) = db.execute("SELECT count(*) FROM seen WHERE root = ?", (root,)).fetchone()
        if n > max_seen:
            db.execute("DELETE FROM seen WHERE rowid IN (SELECT rowid FROM seen WHERE root = ? "
                       "ORDER BY viewed_at, rowid LIMIT ?)", (root, n - max_seen))


def text_if_digest(real: str, digest: str) -> str | None:
    """The file's text as /api/content serves it (UTF-8, invalid bytes replaced), but only if the
    SHA-256 of its UTF-8 encoding is `digest`, i.e. it is exactly the text the UI showed. None if
    it differs (changed again since), is over the /api/content limit or cannot be read."""
    try:
        with open(real, "rb") as f:
            data = f.read(CONTENT_MAX + 1)
    except OSError:
        return None
    if len(data) > CONTENT_MAX:
        return None
    text = data.decode("utf-8", errors="replace")
    return text if hashlib.sha256(text.encode("utf-8")).hexdigest() == digest else None


def seen_disabled_reason(settings) -> str | None:
    """Read-only mode never writes inside the browsed folder: no history if the data dir overlaps it."""
    if settings.root is None:
        return "no folder selected"
    if settings.data_dir_overlaps_root():
        return "changes history disabled: the data dir overlaps the folder"
    return None


# -- HTTP ----------------------------------------------------------------------------------------

class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore")
    root: str
    client: str | None = Field(None, max_length=CLIENT_ID_MAX)  # echoed in the SSE event


class GetBody(_Body):
    paths: list[str] = Field(max_length=SEEN_MAX_PER_ROOT)


class CommitBody(_Body):
    path: str
    mtime: float = Field(allow_inf_nan=False)
    size: int = Field(ge=0)
    text: str | None = None  # absent: leave the snapshot alone (see model_fields_set)
    # instead of `text` (page unload, body over the keepalive cap): the server reads the file
    # and stores it only if it still hashes to this; otherwise the snapshot is dropped
    text_sha256: str | None = Field(None, alias="textSha256", pattern=SHA256_HEX)


class MarkEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str
    mtime: float = Field(allow_inf_nan=False)
    size: int = Field(ge=0)


class MarkBody(_Body):
    entries: list[MarkEntry] = Field(max_length=SEEN_MAX_PER_ROOT)


class RenameBody(_Body):
    from_: str = Field(alias="from")
    to: str


NO_STORE = {"Cache-Control": "no-store"}


def register_seen_routes(app: FastAPI, db: SeenDB, current: Callable[[], object | None]) -> None:
    """/api/seen* on the RootSwitcher's control app. `current()` -> the inner app wrapper
    (`.app.state.store`, `.settings`) or None. Every request names the root it was made for; a
    mismatch (the folder was switched since) is a 409, so a stale tab never writes into another
    root's history. Writes are guarded by RootGate (token, Origin, Sec-Fetch-Site, JSON)."""
    def j(data: dict, status: int = 200) -> JSONResponse:
        return JSONResponse(data, status_code=status, headers=NO_STORE)

    @app.exception_handler(RequestValidationError)
    async def invalid_body(request: Request, exc: RequestValidationError):
        # without the offending input: it may be large, or not JSON-encodable (NaN)
        return j({"detail": [{"loc": list(e.get("loc", ())), "msg": e.get("msg", "")} for e in exc.errors()]}, 422)

    def ctx(root: str | None):
        inner = current()
        if inner is None:
            return j({"detail": "no folder selected"}, 409)
        reason = seen_disabled_reason(inner.settings)
        if reason is not None:
            return j({"detail": reason}, 403)
        if root != inner.settings.root:
            return j({"detail": "the folder was switched; reload"}, 409)
        if not db.available():
            return j({"detail": "changes history unavailable"}, 503)
        return inner

    def hidden_of(inner):
        return inner.app.state.store.guard.rel_hidden

    def notify(inner, paths: list[str], client: str | None) -> None:
        if paths:
            inner.app.state.store.publish_event("seen", {"paths": paths, "client": client})

    async def run(fn, *a):
        try:
            return await asyncio.to_thread(fn, *a)
        except sqlite3.Error as e:
            log.warning("changes history: %s", e)
            return j({"detail": "changes history error"}, 500)

    @app.api_route(SEEN_PREFIX, methods=["GET", "HEAD"])
    async def seen_load(root: str | None = None):
        inner = ctx(root)
        if isinstance(inner, JSONResponse):
            return inner
        recs = await run(db.load, inner.settings.root)
        if isinstance(recs, JSONResponse):
            return recs
        hidden = hidden_of(inner)  # never hand out records of names denied since
        return j({"records": [r for r in recs if check_rel(r["path"], hidden)]})

    @app.api_route(SEEN_PREFIX + "/snapshot", methods=["GET", "HEAD"])
    async def seen_snapshot(root: str | None = None, path: str | None = None):
        inner = ctx(root)
        if isinstance(inner, JSONResponse):
            return inner
        p = check_rel(path, hidden_of(inner))
        if p is None:
            return j({"detail": "path is not allowed"}, 403)
        snap = await run(db.snapshot, inner.settings.root, p)
        return snap if isinstance(snap, JSONResponse) else j({"snapshot": snap})

    @app.post(SEEN_PREFIX + "/get")
    async def seen_get(b: GetBody):
        inner = ctx(b.root)
        if isinstance(inner, JSONResponse):
            return inner
        hidden = hidden_of(inner)
        paths = [p for p in b.paths if check_rel(p, hidden)]
        recs = await run(db.get, inner.settings.root, paths)
        return recs if isinstance(recs, JSONResponse) else j({"records": recs})

    @app.post(SEEN_PREFIX + "/commit")
    async def seen_commit(b: CommitBody):
        inner = ctx(b.root)
        if isinstance(inner, JSONResponse):
            return inner
        if check_rel(b.path, hidden_of(inner)) is None:
            return j({"detail": "path is not allowed"}, 403)
        guard = inner.app.state.store.guard
        try:
            r, st = await asyncio.to_thread(guard.resolve_file, b.path)  # a real, visible file
        except PathError as e:
            return j({"detail": e.detail}, e.status)
        text = _UNSET
        if "text" in b.model_fields_set:
            text = b.text
            if isinstance(text, str):
                try:
                    text.encode("utf-8")
                except UnicodeEncodeError:
                    text = None
        elif b.text_sha256 is not None:
            # never store a text other than the one the user saw: no match drops the stale copy
            text = None if st.st_size > CONTENT_MAX else await asyncio.to_thread(text_if_digest, r.real, b.text_sha256)
        rec = await run(db.commit, inner.settings.root, r.rel, b.mtime, b.size, text)
        if isinstance(rec, JSONResponse):
            return rec
        notify(inner, [r.rel], b.client)
        return j({"record": rec})

    @app.post(SEEN_PREFIX + "/mark")
    async def seen_mark(b: MarkBody):
        inner = ctx(b.root)
        if isinstance(inner, JSONResponse):
            return inner
        store = inner.app.state.store
        hidden = store.guard.rel_hidden
        # only files the tree shows (the walker applies every path rule)
        entries = list({e.path: (e.path, e.mtime, e.size) for e in b.entries
                        if check_rel(e.path, hidden) and store.get(e.path) is not None}.values())
        recs = await run(db.mark, inner.settings.root, entries) if entries else []
        if isinstance(recs, JSONResponse):
            return recs
        notify(inner, [r["path"] for r in recs], b.client)
        return j({"records": recs})

    @app.post(SEEN_PREFIX + "/rename")
    async def seen_rename(b: RenameBody):
        inner = ctx(b.root)
        if isinstance(inner, JSONResponse):
            return inner
        hidden = hidden_of(inner)
        if check_rel(b.from_, hidden) is None or check_rel(b.to, hidden) is None:
            return j({"detail": "path is not allowed"}, 403)
        moved = await run(db.rename, inner.settings.root, b.from_, b.to)
        return moved if isinstance(moved, JSONResponse) else j({"moved": moved})

    @app.post(SEEN_PREFIX + "/clear")
    async def seen_clear(b: _Body):
        inner = ctx(b.root)
        if isinstance(inner, JSONResponse):
            return inner
        paths = await run(db.clear, inner.settings.root)
        if isinstance(paths, JSONResponse):
            return paths
        # always announced (another tab may hold records not yet written here); no path list
        inner.app.state.store.publish_event("seen", {"paths": [], "client": b.client, "cleared": True})
        return j({"cleared": len(paths)})

    @app.api_route(SEEN_PREFIX + "/{rest:path}", methods=["GET", "HEAD", "POST"])
    async def seen_not_found(rest: str):
        return j({"detail": "Not Found"}, 404)
