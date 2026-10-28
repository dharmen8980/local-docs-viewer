"""Runtime settings: CLI flags > environment variables > defaults; the remembered root (state.json)."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import secrets
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

HOST = "127.0.0.1"  # hardcoded on purpose: never configurable
DEFAULT_PORT = 8765
DEFAULT_DENY = (".env", ".env*", "*token*", "*secret*", "*credential*", "*.pem", "*.key")
DEFAULT_IGNORE = ("__pycache__", "*.pyc", ".DS_Store", "node_modules", ".venv", ".git", ".ldv-tmp-*")
DEFAULT_SEARCH_MAX_MB = 2.0
# server/viewer/config.py -> <app>/web/out
DEFAULT_UI_DIR = str(Path(__file__).resolve().parents[2] / "web" / "out")
# editing (tier 3, opt-in)
DEFAULT_DATA_DIR = str(Path(__file__).resolve().parents[2] / ".data")
DEFAULT_HISTORY_KEEP = 50
DEFAULT_UPLOAD_MAX_MB = 25.0
DEFAULT_UPLOAD_EXT = ("png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "md", "mmd", "txt", "csv",
                      "json", "yaml", "yml", "py", "sh", "log")
EDIT_MAX_BYTES = 2 * 1024 * 1024  # text saves
STATE_FILE = "state.json"  # <data_dir>/state.json: {"last_root", "recent"}
RECENT_MAX = 10


class ConfigError(ValueError):
    pass


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKC", unicodedata.normalize("NFKC", s).casefold())


def canonical_path(path: str) -> str:
    """realpath, then (on macOS) the on-disk spelling of the longest existing prefix.

    os.path.realpath resolves symlinks but keeps the requested letter case and Unicode
    normalisation, while APFS treats 'ROOT' and 'root' (or NFD and NFC) as the same folder. The
    kernel's F_GETPATH on an open descriptor returns the name as stored on disk."""
    real = os.path.realpath(path)
    head, tail = real, []
    while not os.path.lexists(head):
        nh, t = os.path.split(head)
        if nh == head:
            break
        tail.append(t)
        head = nh
    if sys.platform == "darwin":
        try:
            import fcntl

            fd = os.open(head, os.O_RDONLY)
            try:
                buf = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024))
            finally:
                os.close(fd)
            got = os.fsdecode(buf.split(b"\0", 1)[0])
            if got and os.path.isabs(got):
                head = got
        except (OSError, AttributeError, ImportError):
            pass
    return os.path.join(head, *reversed(tail)) if tail else head


def _str_within(child: str, parent: str) -> bool:
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


def _id_within(child: str, parent: str) -> bool:
    """Identity check: is `parent` (by st_dev/st_ino) `child` itself or one of its existing
    ancestors? Independent of spelling, case and normalisation."""
    try:
        pst = os.stat(parent)
    except OSError:
        return False
    cur = os.path.realpath(child)
    while True:
        try:
            if os.path.samestat(os.stat(cur), pst):
                return True
        except OSError:
            pass
        nxt = os.path.dirname(cur)
        if nxt == cur:
            return False
        cur = nxt


def path_within(child: str, parent: str) -> bool:
    """True if child is parent or below it, robust to case/normalisation variants (APFS) and to
    symlinks. Errs towards True (folded string comparison) because it guards the recovery store."""
    c, p = canonical_path(child), canonical_path(parent)
    return _str_within(c, p) or _str_within(_fold(c), _fold(p)) or _id_within(c, p)


_within = path_within  # backwards-compatible name


@dataclass
class Settings:
    root: str | None  # None: no folder selected yet (the UI offers the folder picker)
    port: int = DEFAULT_PORT
    deny: tuple[str, ...] = DEFAULT_DENY
    ignore: tuple[str, ...] = DEFAULT_IGNORE
    search_max_bytes: int = int(DEFAULT_SEARCH_MAX_MB * 1024 * 1024)
    ui_dir: str = DEFAULT_UI_DIR
    reconcile_interval: float = 10.0
    watch: bool = True
    allow_edit: bool = False
    data_dir: str = DEFAULT_DATA_DIR
    history_keep: int = DEFAULT_HISTORY_KEEP
    upload_max_bytes: int = int(DEFAULT_UPLOAD_MAX_MB * 1024 * 1024)
    upload_ext: tuple[str, ...] = DEFAULT_UPLOAD_EXT
    edit_max_bytes: int = EDIT_MAX_BYTES
    lock_root: bool = False  # --lock-root: the browser cannot switch folders
    root_source: str = ""  # "cli" | "env" | "state" | "" (none)
    # --desktop: run under the Electron shell; folder dialog + PDF go through its loopback bridge
    desktop: bool = False
    bridge_url: str = ""  # DOCS_VIEWER_BRIDGE_URL, http://127.0.0.1:<port>
    bridge_token: str = field(default="", repr=False)  # DOCS_VIEWER_BRIDGE_TOKEN (never logged)

    def __post_init__(self) -> None:
        self.root = canonical_path(self.root) if self.root is not None else None
        self.data_dir = canonical_path(self.data_dir)
        self.upload_ext = tuple(sorted({e.strip().lower().lstrip(".") for e in self.upload_ext if e.strip()}))
        self.history_keep = max(1, int(self.history_keep))
        from .paths import fold  # local import: paths imports config

        self.deny = tuple(fold(p) for p in self.deny)
        self.ignore = tuple(fold(p) for p in self.ignore)

    def data_dir_overlaps_root(self) -> bool:
        return path_within(self.data_dir, self.root) or path_within(self.root, self.data_dir)

    def data_dir_inside_root(self) -> bool:
        return path_within(self.data_dir, self.root)

    @property
    def root_key(self) -> str:
        return hashlib.sha256(self.root.encode("utf-8")).hexdigest()[:24]

    @property
    def store_dir(self) -> str:
        """Per-root recovery store: history, trash and audit of one root never mix with another
        root's (several viewers may share the default data dir)."""
        return os.path.join(self.data_dir, "roots", self.root_key)

    def validate(self) -> None:
        """Refuse configurations that would let the recovery store leak into the browsed tree."""
        if self.allow_edit and self.data_dir_overlaps_root():
            raise ConfigError(f"data dir {self.data_dir} must not be inside the root {self.root} "
                              "(nor the root inside the data dir)")

    @classmethod
    def make(
        cls,
        root: str | None,
        *,
        deny: list[str] | None = None,
        ignore: list[str] | None = None,
        no_default_deny: bool = False,
        **kw,
    ) -> "Settings":
        d = [] if no_default_deny else list(DEFAULT_DENY)
        d += list(deny or [])
        i = list(DEFAULT_IGNORE) + list(ignore or [])
        return cls(root=root, deny=tuple(d), ignore=tuple(i), **kw)


def _split_env(value: str | None) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="viewer",
        description="Local docs viewer: read-only unless --allow-edit (always binds 127.0.0.1).",
    )
    p.add_argument("--root", help="folder to browse (env DOCS_VIEWER_ROOT; default: the last folder chosen "
                                  "in the browser, else none - choose one in the browser)")
    p.add_argument("--port", type=int, help=f"port (env DOCS_VIEWER_PORT, default {DEFAULT_PORT})")
    p.add_argument("--deny", action="append", default=[], metavar="PATTERN",
                   help="extra deny pattern (repeatable; env DOCS_VIEWER_DENY comma-separated)")
    p.add_argument("--no-default-deny", action="store_true", help="drop the built-in deny patterns")
    p.add_argument("--ignore", action="append", default=[], metavar="PATTERN",
                   help="extra ignore pattern (repeatable; env DOCS_VIEWER_IGNORE comma-separated)")
    p.add_argument("--search-max-mb", type=float,
                   help="max file size indexed for search, MB (env DOCS_VIEWER_SEARCH_MAX_MB, default 2)")
    p.add_argument("--ui-dir", help=f"built UI directory (default {DEFAULT_UI_DIR})")
    p.add_argument("--allow-edit", action="store_true", default=None,
                   help="enable editing and file management (env DOCS_VIEWER_ALLOW_EDIT=1; default off)")
    p.add_argument("--data-dir", help=f"history/trash/audit store (env DOCS_VIEWER_DATA_DIR, default {DEFAULT_DATA_DIR})")
    p.add_argument("--history-keep", type=int, help=f"versions kept per file (default {DEFAULT_HISTORY_KEEP})")
    p.add_argument("--upload-max-mb", type=float, help=f"max upload size per file, MB (default {DEFAULT_UPLOAD_MAX_MB:g})")
    p.add_argument("--upload-ext", action="append", default=None, metavar="EXT",
                   help="allowed upload extension (repeatable or comma-separated; replaces the default list)")
    p.add_argument("--lock-root", action="store_true", default=None,
                   help="do not let the browser switch folders (env DOCS_VIEWER_LOCK_ROOT=1; needs a root)")
    p.add_argument("--desktop", action="store_true", default=None,
                   help="run as the desktop app's server (env DOCS_VIEWER_DESKTOP=1; needs DOCS_VIEWER_BRIDGE_URL "
                        "and DOCS_VIEWER_BRIDGE_TOKEN; prints LDV_READY <url> and exits when stdin closes)")
    return p


def _truthy(v: str | None) -> bool:
    return (v or "").strip().lower() in ("1", "true", "yes", "on")


def _state_path(data_dir: str) -> str:
    return os.path.join(data_dir, STATE_FILE)


def load_state(data_dir: str) -> dict:
    """{"last_root": str|None, "recent": [str]} from <data_dir>/state.json; anything malformed
    reads as empty (the file only holds conveniences, never permissions beyond 'recent')."""
    try:
        with open(_state_path(data_dir), encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    last = raw.get("last_root")
    recent = [p for p in raw.get("recent") or [] if isinstance(p, str) and os.path.isabs(p)]
    return {"last_root": last if isinstance(last, str) and os.path.isabs(last) else None,
            "recent": list(dict.fromkeys(recent))[:RECENT_MAX]}


def save_state(data_dir: str, state: dict) -> None:
    """Atomic write (tmp + os.replace), mode 0600, data dir 0700."""
    os.makedirs(data_dir, mode=0o700, exist_ok=True)
    path = _state_path(data_dir)
    tmp = f"{path}.tmp-{secrets.token_hex(4)}"
    data = {"last_root": state.get("last_root"), "recent": list(state.get("recent") or [])[:RECENT_MAX]}
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with open(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def settings_from_args(argv: list[str] | None = None, env: dict | None = None) -> Settings:
    """Root: --root > DOCS_VIEWER_ROOT > last_root of state.json (if still a folder) > None."""
    env = os.environ if env is None else env
    a = build_parser().parse_args(argv)
    data_dir = a.data_dir or env.get("DOCS_VIEWER_DATA_DIR") or DEFAULT_DATA_DIR
    root, source = a.root, "cli"
    if not root:
        root, source = env.get("DOCS_VIEWER_ROOT") or None, "env"
    if not root:
        last = load_state(canonical_path(data_dir))["last_root"]
        root, source = (last, "state") if last and os.path.isdir(last) else (None, "")
    port = a.port if a.port is not None else int(env.get("DOCS_VIEWER_PORT") or DEFAULT_PORT)
    desktop = bool(a.desktop) or _truthy(env.get("DOCS_VIEWER_DESKTOP"))
    mb = a.search_max_mb if a.search_max_mb is not None else float(
        env.get("DOCS_VIEWER_SEARCH_MAX_MB") or DEFAULT_SEARCH_MAX_MB)
    return Settings.make(
        root,
        port=port,
        deny=list(a.deny) + _split_env(env.get("DOCS_VIEWER_DENY")),
        ignore=list(a.ignore) + _split_env(env.get("DOCS_VIEWER_IGNORE")),
        no_default_deny=a.no_default_deny,
        search_max_bytes=int(mb * 1024 * 1024),
        ui_dir=a.ui_dir or DEFAULT_UI_DIR,
        allow_edit=bool(a.allow_edit) or _truthy(env.get("DOCS_VIEWER_ALLOW_EDIT")),
        data_dir=data_dir,
        history_keep=a.history_keep if a.history_keep is not None else DEFAULT_HISTORY_KEEP,
        upload_max_bytes=int((a.upload_max_mb if a.upload_max_mb is not None else DEFAULT_UPLOAD_MAX_MB)
                             * 1024 * 1024),
        upload_ext=tuple(e for v in a.upload_ext for e in _split_env(v)) if a.upload_ext else DEFAULT_UPLOAD_EXT,
        lock_root=bool(a.lock_root) or _truthy(env.get("DOCS_VIEWER_LOCK_ROOT")),
        root_source=source,
        desktop=desktop,
        bridge_url=(env.get("DOCS_VIEWER_BRIDGE_URL") or "").strip() if desktop else "",
        bridge_token=(env.get("DOCS_VIEWER_BRIDGE_TOKEN") or "").strip() if desktop else "",
    )
