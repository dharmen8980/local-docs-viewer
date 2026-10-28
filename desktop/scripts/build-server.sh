#!/usr/bin/env bash
# Freeze the Python viewer server (python -m viewer) with PyInstaller into a onedir build:
#   desktop/build/server/viewer-server/viewer-server
# - a uv-managed CPython (python-build-standalone; its sqlite3 has FTS5), in its own build venv
#   (desktop/build/pyenv) with runtime deps only (--no-dev: no pytest/httpx) plus the `build`
#   group (PyInstaller + hooks-contrib, exact pins with hashes in uv.lock; --locked: no re-resolve)
# - playwright (and its ~100 MB node driver) excluded: desktop mode renders PDFs in Electron
# - checked afterwards with the hidden `--self-check` (app imports, FTS5, no playwright)
# PyInstaller does not cross-compile: the build matches this machine's OS/arch.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DESKTOP/.." && pwd)"
OUT="$DESKTOP/build/server"
WORK="$DESKTOP/build/pyinstaller"
PY="${LDV_PYTHON:-3.13}"

rm -rf "$OUT" "$WORK"
mkdir -p "$OUT" "$WORK"
cd "$REPO"

export UV_PROJECT_ENVIRONMENT="$DESKTOP/build/pyenv"
uv run --managed-python --python "$PY" --no-dev --group build --locked \
  pyinstaller server/viewer/__main__.py \
    --name viewer-server --onedir --noconfirm --clean --console \
    --distpath "$OUT" --workpath "$WORK" --specpath "$WORK" \
    --paths server \
    --collect-submodules viewer \
    --collect-submodules uvicorn \
    --hidden-import sqlite3 --hidden-import _sqlite3 \
    --exclude-module playwright --exclude-module greenlet --exclude-module pyee \
    --exclude-module pytest --exclude-module _pytest --exclude-module httpx \
    --exclude-module tkinter --exclude-module _tkinter \
    --log-level WARN

BIN="$OUT/viewer-server/viewer-server"
[ -x "$BIN" ] || { echo "build-server: $BIN missing" >&2; exit 1; }
if find "$OUT/viewer-server" -ipath '*playwright*' | grep -q .; then
  echo "build-server: playwright ended up in the bundle" >&2; exit 1
fi
"$BIN" --self-check
du -sh "$OUT/viewer-server"
