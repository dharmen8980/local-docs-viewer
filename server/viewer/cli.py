"""Console entry point: `uv run viewer`."""

from __future__ import annotations

import dataclasses
import logging
import os
import sys

import uvicorn

from .config import HOST, ConfigError, settings_from_args
from .roots import RootSwitcher


def self_check() -> None:
    """Hidden `--self-check` (packaging): the frozen binary has the app, SQLite FTS5 and no playwright."""
    import importlib.util
    import sqlite3

    from . import app, desktop  # noqa: F401 - import errors are the check

    db = sqlite3.connect(":memory:")
    db.execute("CREATE VIRTUAL TABLE t USING fts5(body)")
    db.execute("INSERT INTO t VALUES ('hello frozen world')")
    assert db.execute("SELECT count(*) FROM t WHERE t MATCH 'frozen'").fetchone()[0] == 1
    frozen = getattr(sys, "frozen", False)
    if frozen and importlib.util.find_spec("playwright") is not None:
        sys.exit("[viewer] self-check: playwright is bundled")
    print(f"LDV_SELF_CHECK ok sqlite {sqlite3.sqlite_version} fts5 python {sys.version.split()[0]}"
          f"{' frozen' if frozen else ''}")


def main(argv: list[str] | None = None) -> None:
    if (sys.argv[1:] if argv is None else argv) == ["--self-check"]:
        return self_check()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = settings_from_args(argv)
    if settings.desktop:
        from .desktop import check_bridge

        if err := check_bridge(settings.bridge_url, settings.bridge_token):
            sys.exit(f"[viewer] {err}")
    if settings.root is not None and not os.path.isdir(settings.root):
        sys.exit(f"root folder not found: {settings.root}")
    if settings.root is not None and settings.root_source == "state":
        try:
            settings.validate()
        except ConfigError as e:  # the remembered folder was not asked for in this run: don't refuse to start
            print(f"[viewer] not reopening the last folder: {e}", file=sys.stderr)
            settings = dataclasses.replace(settings, root=None, root_source="")
    if settings.root is None and settings.lock_root:
        sys.exit("[viewer] --lock-root needs a folder: pass --root PATH or set DOCS_VIEWER_ROOT")
    if not os.path.isdir(settings.ui_dir):
        print(f"[viewer] UI not built ({settings.ui_dir} missing). "
              "Run 'npm run build' in web/ - serving the API only.", file=sys.stderr)
    if settings.root is None:
        print("[viewer] no folder selected — choose one in the browser", file=sys.stderr)
    else:
        src = {"state": " (last used)", "env": " (DOCS_VIEWER_ROOT)"}.get(settings.root_source, "")
        print(f"[viewer] root: {settings.root}{src}", file=sys.stderr)
        try:
            settings.validate()
        except ConfigError as e:
            sys.exit(f"[viewer] refusing to start: {e}")
    if settings.allow_edit:
        where = settings.store_dir if settings.root else f"{settings.data_dir}/roots/<key>"
        print(f"[viewer] EDITING ENABLED; history/trash/audit in {where}", file=sys.stderr)
    elif settings.root is not None and settings.data_dir_overlaps_root():
        print(f"[viewer] note: data dir {settings.data_dir} overlaps the root; it is hidden from the viewer", file=sys.stderr)
    if settings.lock_root:
        print("[viewer] folder switching disabled (--lock-root)", file=sys.stderr)
    if settings.desktop:
        return _run_desktop(settings)
    print(f"[viewer] open http://{HOST}:{settings.port}/", file=sys.stderr)
    app = RootSwitcher(settings)
    uvicorn.run(app, host=HOST, port=settings.port, log_level="info", lifespan="on",
                proxy_headers=False, server_header=False, timeout_graceful_shutdown=3)


def _run_desktop(settings) -> None:
    """Child of the Electron shell: bridge picker + renderer, ready line on stdout, exit on stdin EOF."""
    from .desktop import GRACEFUL_S, BridgeClient, bridge_picker, make_server, start_stdin_watchdog

    print(f"[viewer] desktop mode; bridge {settings.bridge_url}", file=sys.stderr)
    app = RootSwitcher(settings, picker=bridge_picker(BridgeClient(settings.bridge_url, settings.bridge_token)))
    config = uvicorn.Config(app, host=HOST, port=settings.port, log_level="info", lifespan="on",
                            proxy_headers=False, server_header=False, timeout_graceful_shutdown=GRACEFUL_S)
    server = make_server(config, settings.port)
    start_stdin_watchdog(server)
    server.run()
    if not server.started:
        sys.exit("[viewer] server did not start (see the log above)")


if __name__ == "__main__":
    main()
