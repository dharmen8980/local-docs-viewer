"""PDF export: render the static `/print` page in the system Google Chrome (headless,
through Playwright) and return the PDF bytes.

Network lockdown:
- Chrome runs with a throw-away profile in the system temp dir (deleted on close) and
  with background networking, component updates, sync, default apps, domain reliability,
  metrics/crash reporting and first-run disabled.
- `--host-resolver-rules` makes every host except 127.0.0.1 unresolvable.
- A context-wide `route('**/*')` handler aborts every HTTP(S) request whose origin is not
  this server's own `http://127.0.0.1:<port>`; service workers are blocked so nothing bypasses it.
- Playwright's `route` does not see WebSockets, so a `route_web_socket('**/*')` handler
  closes every WebSocket whose origin is not this server (the server has none, so in
  practice all of them). The print page's CSP (`connect-src 'self'`) and the resolver rules
  above block external WebSockets as well.
- The PDF is returned from memory; nothing is written inside the docs root.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import html
import logging
import os
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit

log = logging.getLogger("viewer.pdf")

READY_TIMEOUT_MS = 45_000
NAV_TIMEOUT_MS = 20_000
IDLE_CLOSE_S = 60.0

PAPERS = {"a4", "letter"}
ORIENTATIONS = {"portrait", "landscape", "auto"}  # auto: landscape for wide diagrams
# Same values as the @page rule the /print page writes (see web/src/app/print).
MARGINS = {"top": "18mm", "bottom": "16mm", "left": "16mm", "right": "16mm"}

CHROME_ARGS = [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--metrics-recording-only",  # record nothing upstream: reporting stays disabled
    "--disable-client-side-phishing-detection",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,"
    "AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pings",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    # Belt and braces: nothing but loopback resolves, even for Chrome's own requests.
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
]


PROFILE_PREFIX = "ldv-chrome-"
STALE_PROFILE_S = 600.0


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _profile_in_use(path: str) -> bool:
    """Chrome keeps a `SingletonLock` symlink to `<host>-<pid>` while a profile is open."""
    try:
        target = os.readlink(os.path.join(path, "SingletonLock"))
    except OSError:
        return False
    pid = target.rsplit("-", 1)[-1]
    return pid.isdigit() and _pid_alive(int(pid))


def sweep_stale_profiles(tmpdir: str | None = None, *, max_age_s: float = STALE_PROFILE_S,
                         keep: str | None = None) -> list[str]:
    """Remove temporary Chrome profiles left behind by a crashed or SIGKILLed server:
    `ldv-chrome-*` directories in the temp dir older than `max_age_s` that no live Chrome uses."""
    base = tmpdir or tempfile.gettempdir()
    removed: list[str] = []
    now = time.time()
    try:
        entries = list(os.scandir(base))
    except OSError:
        return removed
    for e in entries:
        if not e.name.startswith(PROFILE_PREFIX) or e.path == keep:
            continue
        try:
            if not e.is_dir(follow_symlinks=False) or now - e.stat(follow_symlinks=False).st_mtime < max_age_s:
                continue
        except OSError:
            continue
        if _profile_in_use(e.path):
            continue
        shutil.rmtree(e.path, ignore_errors=True)
        removed.append(e.path)
    return removed


class PdfError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def find_chrome() -> str | None:
    """Path of the system Google Chrome, or None. `DOCS_VIEWER_CHROME` overrides."""
    env = os.environ.get("DOCS_VIEWER_CHROME")
    if env:
        return env if os.path.isfile(env) and os.access(env, os.X_OK) else None
    cands: list[str] = []
    if sys.platform == "darwin":
        app = "Google Chrome.app/Contents/MacOS/Google Chrome"
        cands += [f"/Applications/{app}", os.path.expanduser(f"~/Applications/{app}")]
    elif sys.platform.startswith("linux"):
        cands += ["/opt/google/chrome/chrome"]
        cands += [p for p in (shutil.which(n) for n in ("google-chrome", "google-chrome-stable")) if p]
    elif sys.platform == "win32":
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                     os.environ.get("LOCALAPPDATA")):
            if base:
                cands.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    for c in cands:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def same_origin(url: str, origin: str) -> bool:
    try:
        u, o = urlsplit(url), urlsplit(origin)
    except ValueError:
        return False
    return (u.scheme, (u.hostname or "").lower(), u.port) == (o.scheme, o.hostname, o.port)


def make_route_guard(origin: str, blocked=None):
    """Playwright route handler: continue requests to `origin`, abort everything else."""

    async def handler(route, request=None) -> None:
        url = (request or route.request).url
        if same_origin(url, origin):
            await route.continue_()
        else:
            if blocked is not None:
                blocked.append(url)
            log.warning("pdf: blocked request to %s", url[:200])
            await route.abort("blockedbyclient")

    return handler


def make_ws_guard(origin: str, blocked=None):
    """Playwright WebSocket route handler: the viewer serves no WebSockets, so every
    socket is closed before it connects (an own-origin one is passed through)."""

    ws_origin = "ws" + origin[len("http"):]

    async def handler(ws) -> None:
        url = ws.url
        if same_origin(url, ws_origin):
            ws.connect_to_server()
            return
        if blocked is not None:
            blocked.append(url)
        log.warning("pdf: blocked WebSocket to %s", url[:200])
        await ws.close(code=1008, reason="blocked")

    return handler


@dataclass
class PdfJob:
    path: str  # canonical root-relative path (from PathGuard)
    display_path: str  # repo_prefix + path, shown in the footer
    title: str
    paper: str = "a4"
    orientation: str = "portrait"
    toc: bool = False


def _templates(job: PdfJob) -> tuple[str, str]:
    style = ("font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 8px; "
             "color: #6b7280; width: 100%; padding: 0 16mm; display: flex; gap: 8px;")
    ell = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
    header = (f'<div style="{style}"><span style="{ell} flex: 1;">{html.escape(job.title)}</span></div>')
    footer = (f'<div style="{style}"><span style="{ell} flex: 1;">{html.escape(job.display_path)}</span>'
              '<span style="white-space: nowrap;">page <span class="pageNumber"></span> of '
              '<span class="totalPages"></span></span></div>')
    return header, footer


class PdfRenderer:
    """One headless Chrome at a time; jobs are serialised and the browser is reused
    while idle for less than IDLE_CLOSE_S."""

    def __init__(self, port: int, *, idle_close_s: float = IDLE_CLOSE_S):
        self.origin = f"http://127.0.0.1:{port}"
        self.idle_close_s = idle_close_s
        self._lock = asyncio.Lock()
        self._pw = None
        self._ctx = None
        self._profile: str | None = None
        self._last_used = 0.0
        self._idle_task: asyncio.Task | None = None
        self.blocked: collections.deque[str] = collections.deque(maxlen=200)  # recent blocked URLs

    async def _ensure(self):
        if self._ctx is not None:
            return self._ctx
        exe = find_chrome()
        if not exe:
            raise PdfError(503, "PDF export needs Google Chrome, which was not found "
                                "(looked in /Applications and ~/Applications; set DOCS_VIEWER_CHROME "
                                "to the Chrome executable to override).")
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise PdfError(503, "PDF export needs the 'playwright' Python package (uv sync).")
        await asyncio.to_thread(sweep_stale_profiles)
        self._profile = tempfile.mkdtemp(prefix=PROFILE_PREFIX)
        try:
            self._pw = await async_playwright().start()
            self._ctx = await self._pw.chromium.launch_persistent_context(
                self._profile, executable_path=exe, headless=True, args=CHROME_ARGS,
                color_scheme="light", service_workers="block", accept_downloads=False,
                viewport={"width": 900, "height": 1200}, locale="en-US",
                handle_sigint=False, handle_sigterm=False, handle_sighup=False,
            )
            await self._ctx.route("**/*", make_route_guard(self.origin, self.blocked))
            await self._ctx.route_web_socket("**/*", make_ws_guard(self.origin, self.blocked))
        except Exception as e:
            await self._shutdown()
            if isinstance(e, PdfError):
                raise
            raise PdfError(503, f"could not start Google Chrome for PDF export: {type(e).__name__}: "
                                f"{str(e).splitlines()[0][:300] if str(e) else ''}")
        log.info("pdf: started headless Chrome (%s)", exe)
        return self._ctx

    async def _shutdown(self) -> None:
        ctx, pw, profile = self._ctx, self._pw, self._profile
        self._ctx = self._pw = self._profile = None
        if ctx is not None:
            with contextlib.suppress(Exception):
                await ctx.close()
        if pw is not None:
            with contextlib.suppress(Exception):
                await pw.stop()
        if profile:
            await asyncio.to_thread(shutil.rmtree, profile, True)

    async def close(self) -> None:
        if self._idle_task is not None:
            self._idle_task.cancel()
            self._idle_task = None
        async with self._lock:
            await self._shutdown()

    async def _idle_closer(self) -> None:
        try:
            while True:
                # sleep only until the idle deadline of the most recent use
                await asyncio.sleep(max(0.5, self._last_used + self.idle_close_s - time.monotonic()))
                async with self._lock:
                    if self._ctx is None:
                        return
                    if time.monotonic() - self._last_used >= self.idle_close_s:
                        await self._shutdown()
                        log.info("pdf: closed idle Chrome")
                        return
        except asyncio.CancelledError:
            pass

    def print_url(self, job: PdfJob) -> str:
        q = {"p": job.path, "paper": job.paper, "orientation": job.orientation, "toc": "1" if job.toc else "0"}
        return f"{self.origin}/print?{urlencode(q)}"

    async def render(self, job: PdfJob) -> tuple[bytes, dict]:
        async with self._lock:
            try:
                return await self._render_locked(job)
            except PdfError:
                raise
            except Exception as e:
                log.exception("pdf: export failed")
                await self._shutdown()  # start from a fresh browser next time
                msg = str(e).splitlines()[0][:300] if str(e) else ""
                raise PdfError(500, f"PDF export failed: {type(e).__name__}: {msg}")
            finally:
                self._last_used = time.monotonic()
                if self._ctx is not None and (self._idle_task is None or self._idle_task.done()):
                    self._idle_task = asyncio.create_task(self._idle_closer())

    async def _render_locked(self, job: PdfJob) -> tuple[bytes, dict]:
        ctx = await self._ensure()
        try:
            page = await ctx.new_page()
        except Exception:
            # The browser died while idle: start a fresh one.
            await self._shutdown()
            ctx = await self._ensure()
            page = await ctx.new_page()
        try:
            from playwright.async_api import TimeoutError as PwTimeout

            try:
                resp = await page.goto(self.print_url(job), wait_until="load", timeout=NAV_TIMEOUT_MS)
            except PwTimeout:
                raise PdfError(504, "timed out loading the print page")
            if resp is None or resp.status != 200:
                raise PdfError(503, f"print page unavailable (HTTP {resp.status if resp else '?'}); "
                                    "run 'npm run build' in web/")
            try:
                # Function (not expression) predicates: string expressions would need eval, which the
                # page's CSP (no 'unsafe-eval') forbids.
                await page.wait_for_function("() => window.__PDF_READY__ === true", timeout=READY_TIMEOUT_MS,
                                             polling=100)
            except PwTimeout:
                raise PdfError(504, f"document did not finish rendering within {READY_TIMEOUT_MS // 1000}s "
                                    "(diagrams, images or fonts still loading)")
            errors = await page.evaluate("() => window.__PDF_ERRORS__ || {}") or {}
            if errors.get("fatal"):
                raise PdfError(502, f"print page could not render the document: {errors['fatal']}")
            title = (await page.evaluate("() => window.__PDF_TITLE__ || ''")) or job.title
            # orientation=auto: the page picks one from the diagram's aspect ratio
            chosen = await page.evaluate("() => window.__PDF_ORIENTATION__ || ''")
            landscape = (chosen or job.orientation) == "landscape"
            errors["orientation"] = "landscape" if landscape else "portrait"
            header, footer = _templates(PdfJob(**{**job.__dict__, "title": title}))
            data = await page.pdf(
                format="A4" if job.paper == "a4" else "Letter", landscape=landscape,
                print_background=True, prefer_css_page_size=True, margin=MARGINS,
                display_header_footer=True, header_template=header, footer_template=footer,
                outline=True, tagged=True,
            )
            return data, errors
        finally:
            with contextlib.suppress(Exception):
                await page.close()
