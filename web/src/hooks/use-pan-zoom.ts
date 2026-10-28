"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/** Content transform: translate(x, y) then scale(s), transform-origin 0 0 (viewport px). */
export interface View {
  s: number;
  x: number;
  y: number;
}

interface Size {
  w: number;
  h: number;
}

export interface PanZoomOptions {
  /** natural content size (px at 100%) */
  width: number;
  height: number;
  /** space kept free around the content when fitting (px) */
  padding?: number;
  /** largest scale "fit" may pick (1 = never enlarge) */
  maxFit?: number;
  /** "modifier": only ctrl/cmd + wheel (and pinch) zooms, a plain wheel scrolls the page */
  wheel?: "modifier" | "always";
  /** allow drag-to-pan while fitted (otherwise only once the content outgrows the viewport) */
  panAtFit?: boolean;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.25;

function fitView(size: Size, w: number, h: number, pad: number, maxFit: number): View {
  const s = Math.max(Math.min((size.w - 2 * pad) / w, (size.h - 2 * pad) / h, maxFit), 0.01);
  return { s, x: (size.w - w * s) / 2, y: (size.h - h * s) / 2 };
}

/**
 * Keep content inside the padded viewport when it is smaller, and the viewport covered when
 * larger. With `from` (the current position), positions between `from` and the allowed range
 * are kept too: a pan never jumps, it can only move towards the allowed range.
 */
function clampAxis(pos: number, len: number, avail: number, pad: number, from?: number): number {
  const inside = len <= avail - 2 * pad;
  let lo = inside ? pad : avail - pad - len;
  let hi = inside ? avail - pad - len : pad;
  if (from !== undefined) {
    lo = Math.min(lo, from);
    hi = Math.max(hi, from);
  }
  return Math.min(Math.max(pos, lo), hi);
}

/** Loose limit (zooming in, resizes): only keep part of the content visible, so zoom stays anchored. */
function looseAxis(pos: number, len: number, avail: number): number {
  const keep = Math.min(len, Math.max(48, avail * 0.25));
  return Math.min(Math.max(pos, keep - len), avail - keep);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Pan and zoom for a fixed-size content box inside a viewport element (`ref`, which must be
 * attached on mount and receive `handlers`).
 * The view is "fitted" until the user zooms or pans; a fitted view follows viewport
 * resizes. Remount (change the key) to reset it when the content changes.
 */
export function usePanZoom(ref: RefObject<HTMLElement | null>, opts: PanZoomOptions) {
  const { width: W, height: H, padding = 0, maxFit = 1, wheel = "modifier", panAtFit = false } = opts;
  const [size, setSize] = useState<Size | null>(null);
  const [free, setFree] = useState<View | null>(null);
  const [animate, setAnimate] = useState(false);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Layout sizes, unaffected by CSS transforms (e.g. the dialog's open animation). The first
    // measure is synchronous (no unfitted paint); the observer then reports fractional sizes.
    const set = (w: number, h: number) => setSize((p) => (p && p.w === w && p.h === h ? p : { w, h }));
    set(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r) set(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  const fit = size && W > 0 && H > 0 ? fitView(size, W, H, padding, maxFit) : null;
  const minS = Math.min(MIN_ZOOM, fit?.s ?? MIN_ZOOM);
  const maxS = Math.max(MAX_ZOOM, fit?.s ?? MAX_ZOOM);

  type Mode = "loose" | "strict" | "pan";

  const clampView = useCallback(
    (v: View, sz: Size, mode: Mode, from?: View): View => {
      if (mode === "loose") return { s: v.s, x: looseAxis(v.x, W * v.s, sz.w), y: looseAxis(v.y, H * v.s, sz.h) };
      const f = mode === "pan" ? from : undefined;
      return {
        s: v.s,
        x: clampAxis(v.x, W * v.s, sz.w, padding, f?.x),
        y: clampAxis(v.y, H * v.s, sz.h, padding, f?.y),
      };
    },
    [W, H, padding],
  );

  const view: View | null = size && fit ? (free ? clampView(free, size, "loose") : fit) : null;
  const fitted = free === null;
  // content outside the padded viewport on some axis (larger than it, or moved past its edge)
  const overflows =
    !!view &&
    !!size &&
    (view.x < padding - 0.5 ||
      view.y < padding - 0.5 ||
      view.x + W * view.s > size.w - padding + 0.5 ||
      view.y + H * view.s > size.h - padding + 0.5);
  const canPan = !!view && (panAtFit || (!fitted && overflows));

  const apply = useCallback(
    (next: View, anim: boolean, mode: Mode) => {
      if (!size || !fit) return;
      setAnimate(anim);
      // landing back on the fitted scale snaps to "fitted" (follows resizes again)
      if (Math.abs(next.s - fit.s) < 1e-4 && Math.abs(next.x - fit.x) < 1 && Math.abs(next.y - fit.y) < 1) setFree(null);
      else setFree(clampView(next, size, mode, view ?? undefined));
    },
    [size, fit, view, clampView],
  );

  /** Scale to `s`, keeping viewport point (px, py) fixed (default: the centre). */
  const zoomTo = useCallback(
    (s: number, px?: number, py?: number, anim = true) => {
      if (!view || !size) return;
      const s2 = clamp(s, minS, maxS);
      const cx = px ?? size.w / 2;
      const cy = py ?? size.h / 2;
      const k = s2 / view.s;
      // zooming in stays anchored on the point; zooming out pulls the content back into view
      apply({ s: s2, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k }, anim, k > 1 ? "loose" : "strict");
    },
    [view, size, minS, maxS, apply],
  );

  const zoomBy = useCallback(
    (factor: number, px?: number, py?: number, anim = true) => {
      if (view) zoomTo(view.s * factor, px, py, anim);
    },
    [view, zoomTo],
  );

  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const reset = useCallback(() => {
    setAnimate(true);
    setFree(null);
  }, []);
  const panBy = useCallback(
    (dx: number, dy: number, anim = true) => {
      if (view) apply({ s: view.s, x: view.x + dx, y: view.y + dy }, anim, "pan");
    },
    [view, apply],
  );

  // Latest actions for the native (non-passive) wheel listener.
  const latest = useRef({ zoomBy, view });
  useEffect(() => {
    latest.current = { zoomBy, view };
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const zoomGesture = e.ctrlKey || e.metaKey; // trackpad pinch arrives as ctrl+wheel
      if (wheel === "modifier" && !zoomGesture) return; // plain wheel keeps scrolling the page
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= el.clientHeight;
      if (!zoomGesture && Math.abs(e.deltaX) > Math.abs(dy)) dy = e.deltaX;
      dy = clamp(dy, -60, 60);
      const r = el.getBoundingClientRect();
      latest.current.zoomBy(Math.exp(-dy * (zoomGesture ? 0.01 : 0.005)), e.clientX - r.left, e.clientY - r.top, false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, wheel]);

  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!canPan || !view || e.button !== 0 || drag.current) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault(); // no text selection while panning
      setDragging(true);
    },
    [canPan, view],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId || !view) return;
      apply({ s: view.s, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }, false, "pan");
    },
    [view, apply],
  );
  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  }, []);
  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!fit) return;
      e.preventDefault();
      if (!fitted) return reset();
      const r = e.currentTarget.getBoundingClientRect();
      zoomTo(fit.s * 2, e.clientX - r.left, e.clientY - r.top);
    },
    [fit, fitted, reset, zoomTo],
  );

  return {
    view,
    fitScale: fit?.s ?? null,
    fitted,
    canPan,
    dragging,
    animate,
    minScale: minS,
    maxScale: maxS,
    zoomIn,
    zoomOut,
    zoomTo,
    zoomBy,
    reset,
    panBy,
    handlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onDoubleClick },
  };
}

export type PanZoom = ReturnType<typeof usePanZoom>;
