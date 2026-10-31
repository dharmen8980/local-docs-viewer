"use client";

import { useEffect, useState } from "react";
import { HistoryIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, formatBytes } from "@/lib/api";
import { editApi, formatWhen, loadEditable, whenMs, type HistoryVersion } from "@/lib/edit-api";
import { useReturnFocus } from "@/lib/return-focus";
import { cn } from "@/lib/utils";
import { DiffView } from "@/components/diff/diff-view";

export function HistorySheet({
  path,
  open,
  onOpenChange,
  getCurrentText,
  hasUnsaved,
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the editor's text when this file is open in the editor */
  getCurrentText: () => string | null;
  /** does the open editor hold unsaved changes for this file? */
  hasUnsaved?: () => boolean;
}) {
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ id: string; text: string } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<"diff" | "preview">("diff");
  const [confirm, setConfirm] = useState<HistoryVersion | null>(null);
  const [reload, setReload] = useState(0);
  const returnFocus = useReturnFocus(open);

  useEffect(() => {
    if (!open || !path) return;
    const ctrl = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setError(null);
    setVersions(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    editApi
      .history(path, ctrl.signal)
      .then((r) => {
        const list = [...(r.versions ?? [])].sort((a, b) => (whenMs(b.saved_at) || 0) - (whenMs(a.saved_at) || 0));
        setVersions(list);
        setSelected((s) => (s && list.some((v) => v.id === s) ? s : (list[0]?.id ?? null)));
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(errorMessage(e));
      });
    const fromEditor = getCurrentText();
    if (fromEditor !== null) setCurrent(fromEditor);
    else
      loadEditable(path, ctrl.signal)
        .then((t) => setCurrent(t.text))
        .catch(() => setCurrent(null));
    return () => ctrl.abort();
  }, [open, path, reload, getCurrentText]);

  useEffect(() => {
    if (!open || !selected) return;
    const ctrl = new AbortController();
    editApi
      .historyContent(selected, path, ctrl.signal)
      .then((text) => setContent({ id: selected, text }))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") toast.error("Could not load that version", { description: errorMessage(e) });
      });
    return () => ctrl.abort();
  }, [open, selected, path]);

  const restore = async (v: HistoryVersion) => {
    try {
      const r = await editApi.restoreHistory(path, v.id);
      if (r.unchanged) {
        toast.info("Nothing to restore", { description: "That version is identical to the current file." });
        return;
      }
      toast.success("Version restored", {
        description: `${path} is back to the version from ${formatWhen(v.saved_at)}. The replaced content is in the history.`,
      });
      setReload((n) => n + 1);
    } catch (e) {
      toast.error("Could not restore", { description: errorMessage(e) });
    }
  };

  const shown = content && content.id === selected ? content.text : null;
  const sel = versions?.find((v) => v.id === selected) ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:sm:max-w-3xl" onCloseAutoFocus={returnFocus}>
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4" /> Version history
          </SheetTitle>
          <SheetDescription className="truncate" title={path}>
            {path}. Earlier versions are kept in the viewer&apos;s data folder, never inside the docs folder.
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] md:grid-cols-[16rem_1fr] md:grid-rows-1">
          <div className="max-h-56 overflow-auto border-b md:max-h-none md:border-r md:border-b-0">
            {error ? (
              <p className="p-3 text-xs text-destructive">{error}</p>
            ) : !versions ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : versions.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No earlier versions yet. One is kept every time the file is overwritten.</p>
            ) : (
              <ul className="p-1" role="listbox" aria-label="Versions">
                {versions.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={v.id === selected}
                      onClick={() => setSelected(v.id)}
                      className={cn(
                        "w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                        v.id === selected && "bg-muted",
                      )}
                    >
                      <div className="font-medium">{formatWhen(v.saved_at)}</div>
                      <div className="text-muted-foreground">
                        {formatBytes(v.size)}
                        {v.reason ? ` · ${v.reason}` : ""}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex min-h-0 flex-col gap-2 overflow-auto p-3">
            {sel ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant={view === "diff" ? "secondary" : "ghost"} onClick={() => setView("diff")}>
                    Diff vs current
                  </Button>
                  <Button size="sm" variant={view === "preview" ? "secondary" : "ghost"} onClick={() => setView("preview")}>
                    Content
                  </Button>
                  <div className="flex-1" />
                  <Button size="sm" variant="outline" onClick={() => setConfirm(sel)}>
                    <RotateCcwIcon /> Restore this version
                  </Button>
                </div>
                {shown === null ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2Icon className="size-3.5 animate-spin" /> Loading...
                  </div>
                ) : view === "diff" ? (
                  current === null ? (
                    <p className="text-xs text-muted-foreground">The current file could not be read (it may have been deleted).</p>
                  ) : (
                    <DiffView oldText={shown} newText={current} oldLabel={`version from ${formatWhen(sel.saved_at)}`} newLabel="current" />
                  )
                ) : (
                  <pre className="max-h-[70vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {shown}
                  </pre>
                )}
              </>
            ) : null}
          </div>
        </div>
      </SheetContent>
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              {path} will be replaced with the version from {formatWhen(confirm?.saved_at)}. The current content is saved to the history
              first, so this can be undone.
              {confirm && hasUnsaved?.() ? " Unsaved changes in the editor will conflict with the restored version." : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void restore(confirm)}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
