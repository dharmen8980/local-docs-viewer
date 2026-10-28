/**
 * Scroll to a target and keep it in place while the page layout settles
 * (mermaid diagrams and images render after the markdown and push content
 * down). Re-scrolls whenever the observed element resizes, until the user
 * scrolls/types/clicks, or the layout has been quiet for `quietMs`
 * (hard limit `maxMs`). Returns a cancel function.
 */
export function stickyScroll(
  observe: Element,
  getRect: () => DOMRect | null,
  opts: {
    offset?: (viewportHeight: number) => number;
    quietMs?: number;
    maxMs?: number;
    onDone?: () => void;
  } = {},
): () => void {
  const offset = opts.offset ?? (() => 72);
  const quietMs = opts.quietMs ?? 2500;
  const maxMs = opts.maxMs ?? 15000;
  let stopped = false;
  let raf = 0;
  let quiet: ReturnType<typeof setTimeout> | null = null;

  const scroll = () => {
    if (stopped) return;
    const rect = getRect();
    if (!rect) return;
    const top = Math.max(0, rect.top + window.scrollY - offset(window.innerHeight));
    if (Math.abs(window.scrollY - top) > 2) window.scrollTo({ top });
  };
  const armQuiet = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(stop, quietMs);
  };
  const onResize = () => {
    if (stopped) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(scroll);
    armQuiet();
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
  ro?.observe(observe);
  const userEvents = ["wheel", "touchstart", "keydown", "mousedown"] as const;
  const hard = setTimeout(stop, maxMs);

  function stop() {
    if (stopped) return;
    stopped = true;
    ro?.disconnect();
    cancelAnimationFrame(raf);
    if (quiet) clearTimeout(quiet);
    clearTimeout(hard);
    for (const ev of userEvents) window.removeEventListener(ev, stop, true);
    opts.onDone?.();
  }
  for (const ev of userEvents) window.addEventListener(ev, stop, { capture: true, passive: true });

  raf = requestAnimationFrame(scroll);
  armQuiet();
  return stop;
}
