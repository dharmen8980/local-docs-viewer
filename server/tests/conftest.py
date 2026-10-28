import contextlib
import time

import pytest
from fastapi.testclient import TestClient

from viewer.app import create_app
from viewer.config import Settings


@contextlib.contextmanager
def running(root, *, watch=False, reconcile_interval=0, **kw):
    settings = Settings.make(str(root), watch=watch, reconcile_interval=reconcile_interval,
                             ui_dir=str(root) + "-no-ui", **kw)
    app = create_app(settings)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        wait_until(lambda: not app.state.index.indexing, timeout=10)
        yield client


def wait_until(pred, timeout=15.0, interval=0.1):
    deadline = time.monotonic() + timeout
    while True:
        result = pred()
        if result:
            return result
        if time.monotonic() > deadline:
            raise AssertionError("condition not met within timeout")
        time.sleep(interval)


def write(path, text=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text)
    return path


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "root"
    r.mkdir()
    return r


@contextlib.contextmanager
def editing(root, data_dir, **kw):
    """A running app with editing enabled; the client sends the edit token on every request."""
    kw.setdefault("allow_edit", True)
    with running(root, data_dir=str(data_dir), **kw) as c:
        cfg = c.get("/api/config").json()
        c.token = cfg.get("edit_token")
        if c.token:
            c.headers["X-Edit-Token"] = c.token
        yield c


def snapshot_fs(path):
    """{relative path: (is_dir, bytes|None, mode)} for everything under path (links not followed)."""
    import os

    out = {}
    for dirpath, dirs, files in os.walk(path):
        for n in dirs + files:
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, path)
            st = os.lstat(p)
            if os.path.islink(p):
                out[rel] = ("link", os.readlink(p), st.st_mode)
            elif os.path.isdir(p):
                out[rel] = ("dir", None, st.st_mode)
            else:
                with open(p, "rb") as f:
                    out[rel] = ("file", f.read(), st.st_mode)
    return out


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "data"


def store_of(client):
    """The per-root recovery store (<data>/roots/<key>) of a running editing client."""
    from pathlib import Path

    return Path(client.app.state.settings.store_dir)
