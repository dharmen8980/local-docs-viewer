"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Return focus to where the user was after a dialog/sheet closes.
 *
 * Radix returns focus to the element that was focused when the dialog opened. When a dialog is
 * opened from a menu item, that element is the (now unmounted) menu item, so focus lands on
 * <body>. We track the last focused element outside menus/dialogs/popovers (the tree row, the
 * "..." trigger, the footer button) and focus it again in onCloseAutoFocus.
 */
const OVERLAY = "[role=menu], [role=dialog], [role=alertdialog], [data-radix-popper-content-wrapper], [data-sonner-toaster]";
let lastOutside: HTMLElement | null = null;
let installed = false;

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t !== document.body && !t.closest(OVERLAY)) lastOutside = t;
    },
    true,
  );
}

function openDialogs(): number {
  return document.querySelectorAll("[role=dialog][data-state=open], [role=alertdialog][data-state=open]").length;
}

export function useReturnFocus(open: boolean) {
  const target = useRef<HTMLElement | null>(null);
  useEffect(install, []);
  useEffect(() => {
    if (!open) return;
    // Nested inside another dialog (e.g. a confirm inside the Trash sheet): let Radix handle it.
    target.current = openDialogs() > 1 ? null : lastOutside;
  }, [open]);
  return useCallback((e: Event) => {
    const el = target.current;
    target.current = null;
    if (el && el.isConnected && openDialogs() === 0) {
      e.preventDefault();
      el.focus({ preventScroll: true });
    }
  }, []);
}
