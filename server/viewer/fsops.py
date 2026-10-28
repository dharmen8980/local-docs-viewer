"""Directory-descriptor based file operations used by every mutation.

Path checks (WriteGuard.locate) run on path strings; the actual writes then happen relative to
directory descriptors opened component by component from the root with O_NOFOLLOW, so a folder
swapped for a symlink between the check and the write makes the operation fail instead of
writing outside the root."""

from __future__ import annotations

import contextlib
import ctypes
import ctypes.util
import errno
import os
import stat as stat_mod
import sys

O_DIR = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
O_NOFOLLOW = os.O_NOFOLLOW


class SymlinkError(OSError):
    """A path component turned out to be a symlink (or not a folder) while writing."""


def open_dir_chain(root: str, names: list[str]) -> int:
    """fd of root/names[0]/.../names[-1], never following a symlink below the root."""
    fd = os.open(root, O_DIR)
    try:
        for n in names:
            try:
                nfd = os.open(n, O_DIR | O_NOFOLLOW, dir_fd=fd)
            except OSError as e:
                if e.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
                    raise SymlinkError(e.errno, f"not a real folder: {n}") from None
                raise
            os.close(fd)
            fd = nfd
    except BaseException:
        os.close(fd)
        raise
    return fd


@contextlib.contextmanager
def parent_fd(root: str, rel: str):
    """(fd of the parent folder, last name) for a root-relative path."""
    parts = rel.split("/")
    fd = open_dir_chain(root, parts[:-1])
    try:
        yield fd, parts[-1]
    finally:
        os.close(fd)


def lstat_at(fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


@contextlib.contextmanager
def open_regular(root: str, rel: str):
    """Binary file object for a regular file at rel (no symlinks anywhere below the root)."""
    with parent_fd(root, rel) as (pfd, name):
        try:
            fd = os.open(name, os.O_RDONLY | O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=pfd)
        except OSError as e:
            if e.errno in (errno.ELOOP, errno.EMLINK):
                raise SymlinkError(e.errno, f"symlink: {name}") from None
            raise
        f = os.fdopen(fd, "rb")
        with f:
            if not stat_mod.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise SymlinkError(errno.EINVAL, "not a regular file")
            yield f


def fsync_fd(fd: int) -> None:
    with contextlib.suppress(OSError):
        os.fsync(fd)


def fd_path(fd: int) -> str:
    """Absolute path of an open directory descriptor (for the cross-device copy fallback)."""
    if sys.platform == "darwin":
        import fcntl

        buf = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024))
        return os.fsdecode(buf.split(b"\0", 1)[0])
    return os.readlink(f"/proc/self/fd/{fd}")


# --- rename without replacing ------------------------------------------------------------
_libc = None
_RENAME_EXCL_DARWIN = 0x4
_RENAME_NOREPLACE_LINUX = 0x1


def _load_libc():
    global _libc
    if _libc is None:
        try:
            _libc = ctypes.CDLL(ctypes.util.find_library("c") or None, use_errno=True)
        except OSError:
            _libc = False
    return _libc


def rename_noreplace(src: str, dst: str, *, src_dir_fd: int, dst_dir_fd: int) -> None:
    """Rename that fails with FileExistsError instead of replacing an existing destination
    (renameatx_np(RENAME_EXCL) on macOS, renameat2(RENAME_NOREPLACE) on Linux)."""
    libc = _load_libc()
    fn = None
    flags = 0
    if libc:
        if sys.platform == "darwin":
            fn, flags = getattr(libc, "renameatx_np", None), _RENAME_EXCL_DARWIN
        elif sys.platform.startswith("linux"):
            fn, flags = getattr(libc, "renameat2", None), _RENAME_NOREPLACE_LINUX
    if fn is not None:
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        rc = fn(src_dir_fd, os.fsencode(src), dst_dir_fd, os.fsencode(dst), flags)
        if rc == 0:
            return
        e = ctypes.get_errno()
        if e not in (errno.ENOSYS, errno.EINVAL, errno.ENOTSUP):
            raise OSError(e, os.strerror(e), dst)
    # fallback: check, then rename (small race window on platforms without the syscall)
    if lstat_at(dst_dir_fd, dst) is not None:
        raise FileExistsError(errno.EEXIST, "destination exists", dst)
    os.rename(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)


def open_dir_chain_from(fd: int, name: str) -> int:
    try:
        return os.open(name, O_DIR | O_NOFOLLOW, dir_fd=fd)
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
            raise SymlinkError(e.errno, f"not a real folder: {name}") from None
        raise
