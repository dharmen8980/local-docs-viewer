"""Console entry point: `uv run viewer`."""

from __future__ import annotations

import dataclasses
import logging
import os
import sys

import uvicorn

from .config import HOST, ConfigError, settings_from_args
from .roots import RootSwitcher


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = settings_from_args(argv)
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
    print(f"[viewer] open http://{HOST}:{settings.port}/", file=sys.stderr)
    app = RootSwitcher(settings)
    uvicorn.run(app, host=HOST, port=settings.port, log_level="info", lifespan="on",
                proxy_headers=False, server_header=False, timeout_graceful_shutdown=3)


if __name__ == "__main__":
    main()
