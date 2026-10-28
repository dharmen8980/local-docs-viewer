"""In-memory SQLite FTS5 full-text index plus file-name search."""

from __future__ import annotations

import logging
import os
import posixpath
import re
import sqlite3
import threading

from .store import Entry, Store

log = logging.getLogger("viewer.search")

INDEXED_KINDS = {"markdown", "mermaid", "code", "json", "csv", "text"}
MAX_FILES = 50
MAX_NAMES = 20
MAX_LINES = 5
LINE_CHARS = 300
_SUBTOKEN = re.compile(r"[^\W_]+", re.UNICODE)


def build_match_query(q: str) -> str | None:
    """Turn user input into a safe FTS5 query: quoted terms ANDed, last one a prefix."""
    terms = [t for t in q.split() if t]
    if not terms:
        return None
    parts = ['"' + t.replace('"', '""') + '"' for t in terms]
    parts[-1] += "*"
    return " AND ".join(parts)


def needles_for(q: str) -> list[str]:
    out: set[str] = set()
    for t in q.split():
        t = t.strip()
        if t:
            out.add(t.lower())
            out.update(s.lower() for s in _SUBTOKEN.findall(t))
    return sorted(out, key=len, reverse=True)


def _types_filter(types: str | None) -> set[str] | None:
    if not types:
        return None
    out = set()
    for t in types.split(","):
        t = t.strip().lower().lstrip(".")
        if t:
            out.add("" if t == "(none)" else t)
    return out or None


def _folder_ok(path: str, folder: str) -> bool:
    folder = folder.strip("/")
    return not folder or path == folder or path.startswith(folder + "/")


def merge_ranges(spans: list[tuple[int, int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for s, e in sorted(spans):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def match_lines(body: str, needles: list[str], terms: list[str] | None = None) -> tuple[list[dict], int]:
    """Up to MAX_LINES matching lines (1-based line, byte offset of line start) and the total
    number of matching lines.

    Lines are ranked so that the ones the user most likely wants come first: the whole query
    as a phrase, then the number of distinct query terms present, then whole-word/prefix hits,
    then document order."""
    if not needles:
        return [], 0
    pat = re.compile("|".join(re.escape(n) for n in needles), re.IGNORECASE)
    terms = [t.lower() for t in (terms or needles) if t]
    phrase = " ".join(terms) if len(terms) > 1 else None
    word_pats = [re.compile(r"(?<![^\W_])" + re.escape(t) + ("" if i == len(terms) - 1 else r"(?![^\W_])"),
                            re.IGNORECASE) for i, t in enumerate(terms)]
    n = len(body)
    cands: list[tuple[tuple, int, int, int]] = []  # (rank, ls, le, line_no)
    count = 0
    pos = 0
    line_no = 1
    counted_to = 0
    while pos <= n:
        m = pat.search(body, pos)
        if not m:
            break
        ls = body.rfind("\n", 0, m.start()) + 1
        le = body.find("\n", m.start())
        if le == -1:
            le = n
        count += 1
        line_no += body.count("\n", counted_to, ls)
        counted_to = ls
        low = body[ls:le].lower()
        distinct = sum(1 for t in terms if t in low)
        words = sum(1 for wp in word_pats if wp.search(low))
        rank = (1 if phrase and phrase in low else 0, distinct, words)
        cands.append((rank, ls, le, line_no))
        pos = le + 1
    # best first; ties keep document order (sort is stable)
    best = sorted(cands, key=lambda c: c[0], reverse=True)[:MAX_LINES]
    results: list[dict] = []
    for _rank, ls, le, ln in best:
        line = body[ls:le].rstrip("\r")
        spans = [(x.start(), x.end()) for x in pat.finditer(line)]
        start = 0
        if len(line) > LINE_CHARS and spans and spans[0][1] > LINE_CHARS:
            start = max(0, spans[0][0] - LINE_CHARS // 3)
        text = line[start:start + LINE_CHARS]
        ranges = [(max(s - start, 0), min(e - start, len(text)))
                  for s, e in spans if e > start and s < start + len(text)]
        results.append({"line": ln, "offset": len(body[:ls].encode("utf-8")), "text": text,
                        "ranges": merge_ranges(ranges)})
    return results, count


class SearchIndex:
    def __init__(self, store: Store, max_bytes: int):
        self.store = store
        self.root = store.root
        self.max_bytes = max_bytes
        self.indexing = True
        self._stopped = threading.Event()  # set when the owning app shuts down (root switch): ends a build
        self._lock = threading.Lock()
        self._db = self._new_db()
        self._rows: dict[str, tuple[int, tuple[int, int]]] = {}  # path -> (rowid, sig)

    # --- maintenance --------------------------------------------------------
    def _read(self, e: Entry) -> str | None:
        if e.kind not in INDEXED_KINDS or e.size > self.max_bytes:
            return None
        # Entries come from the store, which only holds vetted in-root paths.
        try:
            with open(os.path.join(self.root, *e.path.split("/")), "rb") as f:
                data = f.read(self.max_bytes + 1)
        except OSError:
            return None
        if len(data) > self.max_bytes:
            return None
        return data.decode("utf-8", errors="replace")

    def remove(self, path: str) -> None:
        with self._lock:
            row = self._rows.pop(path, None)
            if row is not None:
                self._db.execute("DELETE FROM docs WHERE rowid = ?", (row[0],))

    def upsert(self, e: Entry) -> None:
        cur = self._rows.get(e.path)
        if cur is not None and cur[1] == e.sig:
            return
        body = self._read(e)
        with self._lock:
            if self._stopped.is_set():
                return
            # the file may have been removed/changed while reading
            live = self.store.get(e.path)
            if live is not None and live.sig != e.sig:
                return  # we hold a stale Entry; the upsert for the live version owns the row
            row = self._rows.get(e.path)
            if row is not None and live is not None and row[1] == live.sig:
                return  # someone already indexed exactly this version
            self._rows.pop(e.path, None)
            if row is not None:
                self._db.execute("DELETE FROM docs WHERE rowid = ?", (row[0],))
            if body is None or live is None:
                return
            c = self._db.execute(
                "INSERT INTO docs(path, folder, ext, body) VALUES (?, ?, ?, ?)",
                (e.path, posixpath.dirname(e.path), e.ext, body))
            self._rows[e.path] = (c.lastrowid, e.sig)

    def apply_change(self, change_json: dict) -> None:
        for p in change_json["deleted"]:
            self.remove(p)
        for r in change_json["renames"]:
            self.remove(r["from"])
        for p in [*change_json["added"], *change_json["modified"], *(r["to"] for r in change_json["renames"])]:
            e = self.store.get(p)
            if e is not None:
                self.upsert(e)

    def _new_db(self) -> sqlite3.Connection:
        db = sqlite3.connect(":memory:", check_same_thread=False)
        db.execute(
            "CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, folder UNINDEXED, ext UNINDEXED,"
            " body, tokenize='unicode61 remove_diacritics 2')")
        return db

    def stop(self) -> None:
        """App shut down (root switch): abandon any background build (the thread cannot be killed;
        it checks the flag) and free the indexed bodies - the stopped app object may linger."""
        self._stopped.set()
        with self._lock:
            old, self._db = self._db, self._new_db()
            self._rows.clear()
        old.close()

    def sync_with_store(self) -> None:
        live = {e.path: e for e in self.store.all_entries()}
        for p in [p for p in list(self._rows) if p not in live]:
            if self._stopped.is_set():
                return
            self.remove(p)
        for e in live.values():
            if self._stopped.is_set():
                return
            self.upsert(e)

    def build(self) -> None:
        try:
            self.sync_with_store()
            self.sync_with_store()  # catch anything that changed during the first pass
        except Exception:  # pragma: no cover
            log.exception("search index build failed")
        finally:
            self.indexing = False

    def start_background_build(self) -> threading.Thread:
        t = threading.Thread(target=self.build, name="search-index", daemon=True)
        t.start()
        return t

    # --- querying -----------------------------------------------------------
    def search(self, q: str, folder: str = "", types: str | None = None, limit: int = MAX_FILES) -> dict:
        q = (q or "").strip()
        out = {"indexing": self.indexing, "names": [], "content": []}
        if not q:
            return out
        tset = _types_filter(types)
        folder = (folder or "").strip("/")
        limit = max(1, min(int(limit or MAX_FILES), MAX_FILES))

        # file names
        terms = [t.lower() for t in q.split()]
        hits = []
        for e in self.store.all_entries():
            lp = e.path.lower()
            if not all(t in lp for t in terms):
                continue
            if not _folder_ok(e.path, folder) or (tset is not None and e.ext not in tset):
                continue
            ln = e.name.lower()
            hits.append((0 if all(t in ln for t in terms) else 1, len(e.path), e.path, e))
        hits.sort(key=lambda h: h[:3])
        out["names"] = [{"path": e.path, "name": e.name, "kind": e.kind} for *_, e in hits[:MAX_NAMES]]

        # content
        mq = build_match_query(q)
        if mq is None:
            return out
        sql = "SELECT path, ext, bm25(docs), body FROM docs WHERE docs MATCH ?"
        args: list = [mq]
        if folder:
            sql += " AND (path = ? OR substr(path, 1, ?) = ?)"
            args += [folder, len(folder) + 1, folder + "/"]
        if tset is not None:
            sql += f" AND ext IN ({','.join('?' * len(tset))})"
            args += sorted(tset)
        sql += " ORDER BY bm25(docs) LIMIT ?"
        args.append(limit)
        try:
            with self._lock:
                rows = self._db.execute(sql, args).fetchall()
        except sqlite3.Error:
            return out
        needles = needles_for(q)
        for path, _ext, score, body in rows:
            e = self.store.get(path)
            if e is None:
                continue
            matches, count = match_lines(body, needles, q.split())
            out["content"].append({"path": path, "kind": e.kind, "score": -score,
                                   "matches": matches, "match_count": count})
        return out
