"use client";

import { useEffect, useState } from "react";
import { FileIcon, FolderIcon, RotateCcwIcon, Trash2Icon, Undo2Icon } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, errorMessage, formatBytes } from "@/lib/api";
import { useReturnFocus } from "@/lib/return-focus";
import { editApi, formatWhen, validatePath, whenMs, type AuditEntry, type NameRules, type TrashItem } from "@/lib/edit-api";

type Confirm = { kind: "purge"; item: TrashItem } | { kind: "empty" };

export function TrashSheet({
  open,
  onOpenChange,
  rules,
  onRestored,
  onUndoMove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: NameRules;
  /** an item came back from the trash at `path` */
  onRestored: (path: string) => void;
  /** move `from` back to `to` (undo of an earlier move) */
  onUndoMove: (from: string, to: string) => Promise<void>;
}) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [restoreTo, setRestoreTo] = useState<{ item: TrashItem; value: string } | null>(null);
  const [tab, setTab] = useState("trash");
  const returnFocus = useReturnFocus(open);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    editApi
      .trash(ctrl.signal)
      .then((r) =>
        setItems([...(r.items ?? [])].sort((a, b) => (whenMs(b.deleted_at) || 0) - (whenMs(a.deleted_at) || 0))),
      )
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(errorMessage(e));
      });
    editApi
      .audit(100, ctrl.signal)
      .then((list) => setAudit([...list].sort((a, b) => (whenMs(b.ts) || 0) - (whenMs(a.ts) || 0))))
      .catch(() => setAudit([]));
    return () => ctrl.abort();
  }, [open, reload]);

  const restore = async (item: TrashItem, to?: string) => {
    try {
      const r = await editApi.restoreTrash(item.id, to);
      const path = r.path ?? r.to ?? to ?? item.original_path;
      onRestored(path);
      setReload((n) => n + 1);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !to) {
        toast.error("Something already exists at the original location", {
          description: "Use \"Restore to...\" to pick another path.",
        });
        setRestoreTo({ item, value: suggestAlt(item.original_path) });
      } else toast.error("Could not restore", { description: errorMessage(e) });
      return false;
    }
  };

  const purge = async (c: Confirm) => {
    try {
      await editApi.purgeTrash(c.kind === "empty" ? { all: true } : { id: c.item.id });
      toast.success(c.kind === "empty" ? "Trash emptied" : "Deleted permanently");
      setReload((n) => n + 1);
    } catch (e) {
      toast.error("Could not delete", { description: errorMessage(e) });
    }
  };

  const restoreToError = restoreTo ? validatePath(restoreTo.value.trim(), rules) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:sm:max-w-lg" onCloseAutoFocus={returnFocus}>
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <Trash2Icon className="size-4" /> Trash and activity
          </SheetTitle>
          <SheetDescription>
            Deleted files and folders are kept in the viewer&apos;s data folder until you delete them permanently.
          </SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0 p-3">
          <div className="flex items-center gap-2">
            <TabsList>
              <TabsTrigger value="trash">Trash{items?.length ? ` (${items.length})` : ""}</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <div className="flex-1" />
            {tab === "trash" && items?.length ? (
              <Button size="sm" variant="destructive" onClick={() => setConfirm({ kind: "empty" })}>
                <Trash2Icon /> Empty trash
              </Button>
            ) : null}
          </div>
          <TabsContent value="trash" className="mt-3 min-h-0 overflow-auto">
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : !items ? (
              <div className="space-y-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : items.length === 0 ? (
              <p className="text-xs text-muted-foreground">The trash is empty.</p>
            ) : (
              <ul className="space-y-1.5">
                {items.map((it) => (
                  <li key={it.id} className="rounded-md border p-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {it.kind === "dir" ? (
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={it.original_path}>
                        {it.original_path}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      deleted {formatWhen(it.deleted_at)} · {formatBytes(it.size)}
                      {it.kind === "dir" ? ` · ${it.file_count} file${it.file_count === 1 ? "" : "s"}` : ""}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Button size="xs" variant="outline" onClick={() => void restore(it)}>
                        <RotateCcwIcon /> Restore
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setRestoreTo({ item: it, value: it.original_path })}>
                        Restore to...
                      </Button>
                      <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setConfirm({ kind: "purge", item: it })}>
                        Delete permanently
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="activity" className="mt-3 min-h-0 overflow-auto">
            {!audit ? (
              <Skeleton className="h-12" />
            ) : audit.length === 0 ? (
              <p className="text-xs text-muted-foreground">No changes made through the viewer yet.</p>
            ) : (
              <ul className="space-y-1">
                {audit.map((a, i) => (
                  <li key={`${a.ts}-${i}`} className="flex items-start gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/50">
                    <span className="w-24 shrink-0 rounded bg-muted px-1 text-center font-mono">{a.op}</span>
                    <span className="min-w-0 flex-1 break-all">
                      <span className="font-mono">{a.path}</span>
                      {a.to ? (
                        <>
                          {" "}
                          → <span className="font-mono">{a.to}</span>
                        </>
                      ) : null}
                      <span className="block text-muted-foreground">{formatWhen(a.ts)}</span>
                    </span>
                    {(a.op === "move" || a.op === "rename") && a.to ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          const to = a.to as string;
                          void onUndoMove(to, a.path).then(() => setReload((n) => n + 1));
                        }}
                      >
                        <Undo2Icon /> Move back
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "empty" ? "Empty the trash?" : "Delete permanently?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "empty"
                ? `All ${items?.length ?? 0} item(s) in the trash will be deleted for good. This cannot be undone.`
                : `${confirm?.kind === "purge" ? confirm.item.original_path : ""} will be deleted for good. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => confirm && void purge(confirm)}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!restoreTo} onOpenChange={(o) => !o && setRestoreTo(null)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!restoreTo || restoreToError) return;
              void restore(restoreTo.item, restoreTo.value.trim()).then((ok) => ok && setRestoreTo(null));
            }}
          >
            <DialogHeader>
              <DialogTitle>Restore to...</DialogTitle>
              <DialogDescription>Path relative to the docs root. The parent folder must exist.</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={restoreTo?.value ?? ""}
              onChange={(e) => setRestoreTo((r) => (r ? { ...r, value: e.target.value } : r))}
              aria-invalid={!!restoreToError}
              aria-label="Restore to path"
              className="font-mono text-xs"
            />
            {restoreToError ? <p className="text-xs text-destructive">{restoreToError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRestoreTo(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!!restoreToError}>
                Restore
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

function suggestAlt(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${dir}${name.slice(0, dot)} (restored)${name.slice(dot)}` : `${dir}${name} (restored)`;
}
