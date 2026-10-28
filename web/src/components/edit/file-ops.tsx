"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { FolderIcon } from "lucide-react";
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
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, errorMessage, type AppConfig, type TreeResponse } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { editApi, foldName, nameRules, uploadProblem, validateName } from "@/lib/edit-api";
import { basename, dirname } from "@/lib/paths";
import { useReturnFocus } from "@/lib/return-focus";
import { EditOpsContext, ownMoves, type EditOps } from "./edit-context";
import { HistorySheet } from "./history-sheet";
import { TrashSheet } from "./trash-sheet";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

type NameMode = "newFile" | "newFolder" | "rename" | "duplicate";

interface NameState {
  mode: NameMode;
  /** folder the new name lives in */
  dir: string;
  /** existing item (rename / duplicate) */
  path?: string;
  isDir?: boolean;
  value: string;
}

interface ConfirmState {
  title: string;
  description: ReactNode;
  label: string;
  destructive?: boolean;
  run: () => void;
}

export interface FileOpsProviderProps {
  /** false: provide no actions and render nothing extra (read-only viewer) */
  enabled: boolean;
  config: AppConfig | null;
  tree: TreeResponse | null;
  repoPrefix: string;
  refresh: () => Promise<void>;
  /** `from` was moved to `to` (follow the open document / editor) */
  onMoved: (from: string, to: string) => void;
  /** `path` went to the trash */
  onRemoved: (path: string) => void;
  /** a file or folder was created through the UI */
  onCreated: (path: string, isDir: boolean) => void;
  /** open a path in the viewer */
  onOpen: (path: string) => void;
  /** does the editor hold unsaved changes for this path (or anything under it)? */
  hasUnsaved: (path: string) => boolean;
  /** the editor's current text for `path`, if it is open */
  editorText: (path: string) => string | null;
  children: ReactNode;
}

function stemSplit(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

export function FileOpsProvider(props: FileOpsProviderProps) {
  const { enabled, tree, repoPrefix, refresh, onMoved, onRemoved, onCreated, onOpen, hasUnsaved, editorText } = props;
  const config = useMemo<AppConfig>(
    () => props.config ?? { root_name: "", repo_prefix: "", search_max_bytes: 0, version: 0 },
    [props.config],
  );
  const rules = useMemo(() => nameRules(props.config), [props.config]);
  const [nameState, setNameState] = useState<NameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [moveState, setMoveState] = useState<{ path: string; isDir: boolean; target: string | null } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef("");
  const nameFocus = useReturnFocus(!!nameState);
  const moveFocus = useReturnFocus(!!moveState);
  const confirmFocus = useReturnFocus(!!confirm);
  const getCurrentText = useCallback(() => (historyPath ? editorText(historyPath) : null), [historyPath, editorText]);

  // Existing names (folded) for collision hints; the server stays authoritative.
  const existing = useMemo(() => {
    const s = new Set<string>();
    for (const f of tree?.files ?? []) s.add(foldName(f.path));
    for (const d of tree?.dirs ?? []) if (d) s.add(foldName(d));
    return s;
  }, [tree]);
  const allDirs = useMemo(() => ["", ...(tree?.dirs ?? []).filter(Boolean)].sort((a, b) => a.localeCompare(b)), [tree]);

  // ---------- operations ----------

  const doMove = useCallback(
    async function move(from: string, to: string, opts: { undo?: boolean; overwrite?: boolean; isDir?: boolean } = {}): Promise<void> {
      ownMoves.add(from);
      const verb = dirname(from) === dirname(to) ? "Renamed" : "Moved";
      try {
        await editApi.move(from, to, { overwrite: opts.overwrite });
        onMoved(from, to);
        refresh();
        toast.success(opts.undo ? "Moved back" : verb, {
          description: `${from} → ${to}`,
          action: opts.undo
            ? undefined
            : {
                label: "Undo",
                onClick: () => void move(to, from, { undo: true, isDir: opts.isDir }),
              },
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && !opts.overwrite && !opts.isDir) {
          toast.error("Something already exists there", {
            description: `${to}: ${errorMessage(e)}`,
            action: {
              label: "Replace",
              onClick: () =>
                setConfirm({
                  title: "Replace the existing file?",
                  description: `${to} will be replaced by ${from}. The replaced file is kept in its version history.`,
                  label: "Replace",
                  destructive: true,
                  run: () => void move(from, to, { ...opts, overwrite: true }),
                }),
            },
          });
        } else {
          toast.error(`Could not move ${basename(from)}`, { description: errorMessage(e) });
        }
      } finally {
        setTimeout(() => ownMoves.delete(from), 10000);
      }
    },
    [onMoved, refresh],
  );

  const doUpload = useCallback(
    async (dir: string, files: File[]) => {
      const problems: string[] = [];
      const ok: File[] = [];
      for (const f of files) {
        const p = uploadProblem(f, config);
        if (p) problems.push(p);
        else ok.push(f);
      }
      if (problems.length) toast.error(`${problems.length} file(s) not uploaded`, { description: problems.join("\n") });
      if (!ok.length) return;
      const id = toast.loading(`Uploading ${ok.length} file${ok.length === 1 ? "" : "s"}...`);
      try {
        const r = await editApi.upload(dir, ok);
        refresh();
        const paths = r.paths ?? [];
        toast.success(`Uploaded ${paths.length} file${paths.length === 1 ? "" : "s"} to ${dir || "the root"}`, {
          id,
          description: paths.join("\n"),
          action: paths.length === 1 ? { label: "Open", onClick: () => onOpen(paths[0]) } : undefined,
        });
      } catch (e) {
        toast.error("Upload failed", { id, description: errorMessage(e) });
      }
    },
    [config, refresh, onOpen],
  );

  const doRemove = useCallback(
    async (path: string) => {
      try {
        const r = await editApi.remove(path);
        onRemoved(path);
        refresh();
        toast.success("Moved to Trash", {
          description: path,
          action: r.trash_id
            ? {
                label: "Undo",
                onClick: () => {
                  editApi
                    .restoreTrash(r.trash_id)
                    .then(() => {
                      refresh();
                      toast.success("Restored", { description: path, action: { label: "Open", onClick: () => onOpen(path) } });
                    })
                    .catch((e) => toast.error("Could not restore", { description: errorMessage(e) }));
                },
              }
            : undefined,
        });
      } catch (e) {
        toast.error(`Could not delete ${basename(path)}`, { description: errorMessage(e) });
      }
    },
    [onRemoved, refresh, onOpen],
  );

  const submitName = async () => {
    const st = nameState;
    if (!st) return;
    const name = st.value.trim() === st.value ? st.value : st.value.trim();
    const err = validateName(name, rules);
    if (err) return;
    const target = join(st.dir, name);
    setBusy(true);
    try {
      if (st.mode === "newFile") {
        await editApi.saveFile({ path: target, content: "", base_sha256: null, create: true });
        await refresh();
        setNameState(null);
        toast.success("File created", { description: target });
        onCreated(target, false);
      } else if (st.mode === "newFolder") {
        await editApi.mkdir(target);
        // The new folder must be in the tree before navigating to it, or the route is taken for a file.
        await refresh();
        setNameState(null);
        toast.success("Folder created", { description: target });
        onCreated(target, true);
      } else if (st.mode === "duplicate" && st.path) {
        await editApi.copy(st.path, target);
        refresh();
        setNameState(null);
        toast.success("Duplicated", { description: `${st.path} → ${target}`, action: { label: "Open", onClick: () => onOpen(target) } });
      } else if (st.mode === "rename" && st.path) {
        setNameState(null);
        if (target !== st.path) await doMove(st.path, target, { isDir: st.isDir });
      }
    } catch (e) {
      toast.error(
        st.mode === "newFolder" ? "Could not create the folder" : st.mode === "newFile" ? "Could not create the file" : "Could not duplicate",
        { description: errorMessage(e) },
      );
    } finally {
      setBusy(false);
    }
  };

  const openPicker = useCallback((dir: string) => {
    uploadDir.current = dir;
    fileInput.current?.click();
  }, []);

  const ops = useMemo<EditOps>(
    () => ({
      config,
      rules,
      newFile: (dir) => setNameState({ mode: "newFile", dir, value: "untitled.md" }),
      newFolder: (dir) => setNameState({ mode: "newFolder", dir, value: "new-folder" }),
      upload: (dir, files) => {
        if (files && files.length) void doUpload(dir, files);
        else openPicker(dir);
      },
      rename: (path, isDir) => setNameState({ mode: "rename", dir: dirname(path), path, isDir, value: basename(path) }),
      moveTo: (path, isDir) => setMoveState({ path, isDir, target: null }),
      dropMove: (from, toDir, isDir) => {
        if (dirname(from) === toDir) return;
        if (isDir && (toDir === from || toDir.startsWith(`${from}/`))) {
          toast.error("A folder cannot be moved into itself");
          return;
        }
        const to = join(toDir, basename(from));
        setConfirm({
          title: `Move ${basename(from)}?`,
          description: (
            <>
              Move <code className="text-xs">{from}</code> into <code className="text-xs">{toDir || "the root folder"}</code>? Links
              inside other documents are not updated.
            </>
          ),
          label: "Move",
          run: () => void doMove(from, to, { isDir }),
        });
      },
      duplicate: (path) => {
        const [stem, ext] = stemSplit(basename(path));
        let candidate = `${stem} copy${ext}`;
        for (let i = 2; existing.has(foldName(join(dirname(path), candidate))) && i < 100; i++) candidate = `${stem} copy ${i}${ext}`;
        setNameState({ mode: "duplicate", dir: dirname(path), path, value: candidate });
      },
      copyPath: (path) => {
        const text = `${repoPrefix}${path}`;
        void copyText(text).then((ok) =>
          ok ? toast.success("Path copied", { description: text }) : toast.error("Could not copy to clipboard"),
        );
      },
      remove: (path, isDir) => {
        const unsaved = hasUnsaved(path);
        setConfirm({
          title: `Delete ${basename(path)}?`,
          description: (
            <>
              {isDir ? "The folder and everything in it" : <code className="text-xs">{path}</code>} will be moved to the Trash. You can
              restore it from Trash (sidebar, bottom).
              {unsaved ? <strong className="mt-2 block text-destructive">Unsaved changes in the editor will be lost.</strong> : null}
            </>
          ),
          label: "Move to Trash",
          destructive: true,
          run: () => void doRemove(path),
        });
      },
      openHistory: (path) => setHistoryPath(path),
      openTrash: () => setTrashOpen(true),
    }),
    [config, rules, doUpload, openPicker, doMove, doRemove, existing, repoPrefix, hasUnsaved],
  );

  // ---------- name dialog ----------

  const nameError = (() => {
    if (!nameState) return null;
    const v = nameState.value;
    const err = validateName(v.trim(), rules);
    if (err) return err;
    const target = join(nameState.dir, v.trim());
    if (nameState.mode === "rename" && nameState.path && foldName(target) === foldName(nameState.path)) {
      return target === nameState.path ? null : null; // a case-only rename of the same item is fine
    }
    if (existing.has(foldName(target))) return "Something with that name already exists here.";
    return null;
  })();

  const nameTitle =
    nameState?.mode === "newFile"
      ? "New file"
      : nameState?.mode === "newFolder"
        ? "New folder"
        : nameState?.mode === "duplicate"
          ? "Duplicate file"
          : `Rename ${nameState?.isDir ? "folder" : "file"}`;

  // ---------- move dialog ----------

  const moveInvalid = (dir: string): string | null => {
    if (!moveState) return null;
    if (dir === dirname(moveState.path)) return "already here";
    if (moveState.isDir && (dir === moveState.path || dir.startsWith(`${moveState.path}/`))) return "inside itself";
    return null;
  };

  if (!enabled) return <EditOpsContext.Provider value={null}>{props.children}</EditOpsContext.Provider>;

  return (
    <EditOpsContext.Provider value={ops}>
      {props.children}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={config.upload_ext?.length ? config.upload_ext.map((e) => `.${e.replace(/^\./, "")}`).join(",") : undefined}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void doUpload(uploadDir.current, files);
        }}
      />

      <Dialog open={!!nameState} onOpenChange={(o) => !o && !busy && setNameState(null)}>
        <DialogContent onCloseAutoFocus={nameFocus}>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!nameError) void submitName();
            }}
          >
            <DialogHeader>
              <DialogTitle>{nameTitle}</DialogTitle>
              <DialogDescription>
                In <code className="text-xs">{nameState?.dir || "the root folder"}</code>.
                {nameState?.mode === "rename" ? " Links inside other documents are not updated." : null}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={nameState?.value ?? ""}
              onChange={(e) => setNameState((s) => (s ? { ...s, value: e.target.value } : s))}
              onFocus={(e) => {
                // Select the stem so typing replaces the name but keeps the extension.
                const v = e.target.value;
                const i = nameState?.mode === "newFolder" || nameState?.isDir ? -1 : v.lastIndexOf(".");
                e.target.setSelectionRange(0, i > 0 ? i : v.length);
              }}
              aria-label="Name"
              aria-invalid={!!nameError}
              aria-describedby="name-error"
              spellCheck={false}
              autoComplete="off"
            />
            <p id="name-error" className="min-h-4 text-xs text-destructive" aria-live="polite">
              {nameError ?? ""}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNameState(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={!!nameError || busy}>
                {nameState?.mode === "rename" ? "Rename" : nameState?.mode === "duplicate" ? "Duplicate" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!moveState} onOpenChange={(o) => !o && setMoveState(null)}>
        <DialogContent className="sm:max-w-lg" onCloseAutoFocus={moveFocus}>
          <DialogHeader>
            <DialogTitle>Move {moveState ? basename(moveState.path) : ""} to...</DialogTitle>
            <DialogDescription>Pick the destination folder. Links inside other documents are not updated.</DialogDescription>
          </DialogHeader>
          <Command className="rounded-lg border">
            <CommandInput placeholder="Search folders..." />
            <CommandList className="max-h-72">
              <CommandEmpty>No matching folder.</CommandEmpty>
              {allDirs.map((d) => {
                const bad = moveInvalid(d);
                return (
                  <CommandItem
                    key={d || "/"}
                    value={d || "/ (root)"}
                    disabled={!!bad}
                    data-checked={moveState?.target === d}
                    onSelect={() => setMoveState((s) => (s ? { ...s, target: d } : s))}
                  >
                    <FolderIcon className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{d || "/ (root)"}</span>
                    {bad ? <span className="text-[10px] text-muted-foreground">{bad}</span> : null}
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveState(null)}>
              Cancel
            </Button>
            <Button
              disabled={!moveState || moveState.target === null || !!moveInvalid(moveState.target)}
              onClick={() => {
                const st = moveState;
                if (!st || st.target === null) return;
                setMoveState(null);
                void doMove(st.path, join(st.target, basename(st.path)), { isDir: st.isDir });
              }}
            >
              Move{moveState?.target !== null && moveState?.target !== undefined ? ` to ${moveState.target || "root"}` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent onCloseAutoFocus={confirmFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>{confirm?.description}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm?.destructive ? "destructive" : "default"} onClick={() => confirm?.run()}>
              {confirm?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <HistorySheet
        path={historyPath ?? ""}
        open={historyPath !== null}
        onOpenChange={(o) => !o && setHistoryPath(null)}
        getCurrentText={getCurrentText}
        hasUnsaved={() => (historyPath ? hasUnsaved(historyPath) : false)}
      />
      <TrashSheet
        open={trashOpen}
        onOpenChange={setTrashOpen}
        rules={rules}
        onRestored={(path) => {
          refresh();
          toast.success("Restored from Trash", { description: path, action: { label: "Open", onClick: () => onOpen(path) } });
        }}
        onUndoMove={(from, to) => doMove(from, to, { undo: true })}
      />
    </EditOpsContext.Provider>
  );
}
