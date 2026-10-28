"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderIcon, FolderOpenIcon, FolderSearchIcon, SettingsIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { rootsApi, type RootsInfo } from "@/lib/roots-api";
import { cn } from "@/lib/utils";

/** Full page load of "/": resets tree, SSE, edit token and route state for the new folder. */
export function reloadHome() {
  // A client-side navigation would keep the old folder's state alive.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/");
}

const base = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

export interface RootActionOpts {
  /** Return false to abort a switch (e.g. the user kept their unsaved edits). */
  beforeSwitch?: () => boolean;
  /** Called right before the page reloads into the new folder. */
  onLeave?: () => void;
}

/** Recent folders + pick/switch/forget. A successful switch reloads the page at "/". */
export function useRootActions({ beforeSwitch, onLeave }: RootActionOpts = {}) {
  const [info, setInfo] = useState<RootsInfo | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const r = await rootsApi.get(ctrl.signal);
      if (!ctrl.signal.aborted) setInfo(r);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Could not list recent folders", { description: errorMessage(e) });
    }
  }, []);
  useEffect(() => () => inflight.current?.abort(), []);

  const enter = useCallback(
    (path: string) => {
      onLeave?.();
      toast.success(`Opening ${base(path)}`, { description: path });
      reloadHome();
    },
    [onLeave],
  );

  const pick = useCallback(async () => {
    if (picking || (beforeSwitch && !beforeSwitch())) return;
    setPicking(true);
    const id = toast.loading("Waiting for the folder dialog...", {
      description: "Choose a folder in the system dialog. It may have opened behind this browser window.",
      duration: Infinity,
    });
    try {
      const r = await rootsApi.pick();
      if (r.cancelled) toast.dismiss(id);
      else {
        toast.dismiss(id);
        enter(r.current);
      }
    } catch (e) {
      toast.error("Could not choose a folder", { id, description: errorMessage(e), duration: 6000 });
    } finally {
      setPicking(false);
    }
  }, [picking, beforeSwitch, enter]);

  const switchTo = useCallback(
    async (path: string) => {
      if (busy || (beforeSwitch && !beforeSwitch())) return;
      setBusy(true);
      try {
        const r = await rootsApi.switch(path);
        enter(r.current ?? path);
      } catch (e) {
        toast.error("Could not open that folder", { description: errorMessage(e) });
        void load();
      } finally {
        setBusy(false);
      }
    },
    [busy, beforeSwitch, enter, load],
  );

  const forget = useCallback(async (path: string) => {
    try {
      await rootsApi.forget(path);
      setInfo((i) => (i ? { ...i, recent: i.recent.filter((p) => p !== path) } : i));
    } catch (e) {
      toast.error("Could not remove that folder", { description: errorMessage(e) });
    }
  }, []);

  return { info, load, picking, busy, pick, switchTo, forget };
}

/** Folder switcher next to the root name in the sidebar header. */
export function RootSwitcher({ rootPath, ...opts }: RootActionOpts & { rootPath: string | null }) {
  const { info, load, picking, busy, pick, switchTo, forget } = useRootActions(opts);
  const current = info?.current ?? rootPath;
  const recent = (info?.recent ?? []).filter((p) => p !== current);
  return (
    <DropdownMenu onOpenChange={(o) => o && void load()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Folder settings" disabled={picking}>
              <SettingsIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Folder settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Current folder</DropdownMenuLabel>
        <div className="flex items-center gap-1.5 px-1.5 pb-1.5 text-sm" title={current ?? undefined}>
          <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-xs" dir="rtl">
            {/* rtl keeps the end of a long path visible; the bdi stops it reordering */}
            <bdi>{current ?? "none"}</bdi>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Recent folders</DropdownMenuLabel>
        {!info ? (
          <div className="px-1.5 py-1 text-xs text-muted-foreground">Loading...</div>
        ) : recent.length === 0 ? (
          <div className="px-1.5 py-1 text-xs text-muted-foreground">No other recent folders.</div>
        ) : (
          recent.map((p) => (
            // The remove button is a sibling of the item, not a child: Radix MenuItem turns a
            // pointerup it did not see the pointerdown for into a click (= select = switch).
            <div key={p} className="group/recent relative flex items-center">
              <DropdownMenuItem
                title={p}
                disabled={busy || picking}
                className="min-w-0 flex-1 pr-7"
                onSelect={() => void switchTo(p)}
                onKeyDown={(e) => {
                  if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    void forget(p);
                  }
                }}
              >
                <FolderIcon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{base(p)}</span>
                  <span className="truncate text-xs text-muted-foreground">{p}</span>
                </span>
              </DropdownMenuItem>
              <button
                type="button"
                tabIndex={-1}
                disabled={busy || picking}
                aria-label={`Remove ${base(p)} from recent folders`}
                title="Remove from recent folders"
                className="absolute right-1.5 rounded p-0.5 text-muted-foreground opacity-0 group-hover/recent:opacity-100 group-focus-within/recent:opacity-100 hover:bg-muted hover:text-foreground disabled:pointer-events-none"
                onClick={() => void forget(p)}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))
        )}
        {info?.picker_available ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={picking || busy} onSelect={() => void pick()}>
              <FolderSearchIcon /> {picking ? "Waiting for the folder dialog..." : "Choose folder..."}
            </DropdownMenuItem>
          </>
        ) : info ? (
          <div className="px-1.5 pt-2 pb-1 text-xs text-muted-foreground">
            No folder dialog on this system; start the viewer with <code>--root</code> to add folders.
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shown instead of the tree and content when the server has no folder selected. */
export function NoRootView({ switchEnabled }: { switchEnabled: boolean }) {
  const { info, load, picking, busy, pick, switchTo, forget } = useRootActions();
  useEffect(() => {
    if (switchEnabled) void load();
  }, [switchEnabled, load]);
  const recent = info?.recent ?? [];
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-2">
          <FolderOpenIcon className="mx-auto size-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold">No folder selected</h1>
          <p className="text-sm text-muted-foreground">
            {!switchEnabled
              ? "Restart the viewer with --root <folder> to choose what to view."
              : info && !info.picker_available
                ? "There is no folder dialog on this system. Open a recent folder or restart the viewer with --root <folder>."
                : "Choose a folder on this computer to browse its documents."}
          </p>
        </div>
        {switchEnabled && info?.picker_available ? (
          <Button onClick={() => void pick()} disabled={picking || busy}>
            <FolderSearchIcon /> {picking ? "Waiting for the folder dialog..." : "Choose folder..."}
          </Button>
        ) : null}
        {picking ? (
          <p className="text-xs text-muted-foreground">The dialog may have opened behind this browser window.</p>
        ) : null}
        {recent.length ? (
          <div className="space-y-2 text-left">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent folders</h2>
            <ul className="divide-y rounded-lg border">
              {recent.map((p) => (
                <li key={p} className="group/recent flex items-center gap-1 pr-1">
                  <button
                    type="button"
                    title={p}
                    disabled={busy || picking}
                    onClick={() => void switchTo(p)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm outline-none",
                      "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                    )}
                  >
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{base(p)}</span>
                      <span className="truncate text-xs text-muted-foreground">{p}</span>
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${base(p)} from recent folders`}
                    title="Remove from recent folders"
                    onClick={() => void forget(p)}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
