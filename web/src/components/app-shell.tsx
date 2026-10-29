"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FileXIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { hasDrag, ownMoves, useEditOps } from "@/components/edit/edit-context";
import type { EditorPaneHandle } from "@/components/edit/editor-pane";
import { FileOpsProvider } from "@/components/edit/file-ops";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { FileHeader } from "@/components/file-header";
import { FileTree } from "@/components/file-tree";
import { FolderView, HomeView } from "@/components/folder-view";
import { MenuFolderPick, NoRootView, reloadHome, RootSwitcher } from "@/components/root-switcher";
import { SearchDialog, type SearchTarget } from "@/components/search-dialog";
import { BinaryViewer } from "@/components/viewers/binary-viewer";
import { CodeViewer } from "@/components/viewers/code-viewer";
import { useAsync, ViewerError, ViewerLoading, type AsyncState, type ViewerProps } from "@/components/viewers/common";
import { CsvViewer } from "@/components/viewers/csv-viewer";
import { ImageViewer } from "@/components/viewers/image-viewer";
import { JsonViewer } from "@/components/viewers/json-viewer";
import { MarkdownViewer } from "@/components/viewers/markdown-viewer";
import { MermaidViewer } from "@/components/viewers/mermaid-viewer";
import { PdfViewer } from "@/components/viewers/pdf-viewer";
import { TextViewer } from "@/components/viewers/text-viewer";
import { XlsxViewer } from "@/components/viewers/xlsx-viewer";
import { useEvents } from "@/hooks/use-events";
import { setNavigationGuard, useRoute } from "@/hooks/use-route";
import { useTree } from "@/hooks/use-tree";
import { api, ApiError, errorMessage, type AppConfig, type ChangeEvent, type FileInfo, type FileKind } from "@/lib/api";
import { configureEditClient } from "@/lib/edit-api";
import { isEditable } from "@/lib/editor-lang";
import { configureRootsClient } from "@/lib/roots-api";
import { ancestors, basename, dirname } from "@/lib/paths";
import { buildTree, findDir, type SortMode } from "@/lib/tree";

// The editor (and CodeMirror) is only downloaded when someone actually edits.
const EditorPane = lazy(() => import("@/components/edit/editor-pane").then((m) => ({ default: m.EditorPane })));

const VIEWERS: Record<FileKind, React.ComponentType<ViewerProps>> = {
  markdown: MarkdownViewer,
  mermaid: MermaidViewer,
  image: ImageViewer,
  pdf: PdfViewer,
  json: JsonViewer,
  csv: CsvViewer,
  xlsx: XlsxViewer,
  code: CodeViewer,
  text: TextViewer,
  binary: BinaryViewer,
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function FileView({
  path,
  reloadKey,
  deleted,
  state,
}: {
  path: string;
  reloadKey: number;
  deleted: boolean;
  state: AsyncState<FileInfo | null>;
}) {
  const { data: file, error, loading } = state;
  if (deleted) {
    return (
      <div className="p-6">
        <Alert>
          <FileXIcon />
          <AlertTitle>This file was deleted or moved</AlertTitle>
          <AlertDescription>
            <code className="text-xs">{path}</code> no longer exists on disk. Pick another file from the tree or search.
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!file) {
    if (error) {
      const status = error instanceof ApiError ? error.status : 0;
      return (
        <ViewerError
          title={status === 403 ? "Access refused" : status === 404 ? "Not found" : "Could not open this file"}
          message={
            status === 403
              ? "This path is outside the viewer root or matches the deny list, so the server refuses to serve it."
              : errorMessage(error)
          }
        />
      );
    }
    return loading ? <ViewerLoading /> : null;
  }
  const Viewer = VIEWERS[file.kind] ?? TextViewer;
  return <Viewer key={file.path} file={file} reloadKey={reloadKey} />;
}

/** Main content area; with editing enabled, OS files dropped here are uploaded to `dropDir`. */
function MainArea({ dropDir, acceptDrops, children }: { dropDir: string; acceptDrops: boolean; children: React.ReactNode }) {
  const ops = useEditOps();
  const [over, setOver] = useState(false);
  if (!ops || !acceptDrops) return <div className="min-w-0 flex-1">{children}</div>;
  return (
    <div
      className="relative min-w-0 flex-1"
      onDragOver={(e) => {
        if (hasDrag(e.dataTransfer) !== "files") return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        if (hasDrag(e.dataTransfer) !== "files") return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) ops.upload(dropDir, files);
      }}
    >
      {children}
      {over ? (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UploadIcon className="size-4" /> Drop to upload to {dropDir || "the root folder"}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The editor, wired to the History sheet of the file-ops provider. */
function EditorSlot(props: Omit<React.ComponentProps<typeof EditorPane>, "onOpenHistory">) {
  const ops = useEditOps();
  return (
    <Suspense fallback={<ViewerLoading />}>
      <EditorPane {...props} onOpenHistory={(p) => ops?.openHistory(p)} />
    </Suspense>
  );
}

function Shell({ initialConfig }: { initialConfig: AppConfig | null }) {
  const route = useRoute();
  const { navigate } = route;
  const { tree, loading, error, refresh } = useTree();
  const { setOpen, setOpenMobile, isMobile } = useSidebar();
  const [config, setConfig] = useState<AppConfig | null>(initialConfig);
  const [sort, setSort] = useState<SortMode>("name");
  const [kinds, setKinds] = useState<FileKind[]>([]);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [deletedPath, setDeletedPath] = useState<string | null>(null);
  // ---------- editing (tier 3, only when the server says so) ----------
  const editEnabled = Boolean(config?.edit_enabled && config.edit_token);
  /** The open edit session. `from` is the previous path while following a rename. */
  const [edit, setEdit] = useState<{ path: string; from?: string; session: number; file: FileInfo } | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const editRef = useRef(edit);
  const editorRef = useRef<EditorPaneHandle>(null);
  const sessionSeq = useRef(0);
  const [unsaved, setUnsaved] = useState<{ proceed: () => void; leaving: string } | null>(null);
  const [savingForExit, setSavingForExit] = useState(false);
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  const pathRef = useRef(route.path);
  const hashRef = useRef(route.hash);
  const configRef = useRef(config);
  /** set right before a deliberate reload into another folder (skips the beforeunload prompt) */
  const leavingRef = useRef(false);
  useEffect(() => {
    pathRef.current = route.path;
    hashRef.current = route.hash;
    editRef.current = edit;
    configRef.current = config;
  });

  useEffect(() => {
    if (initialConfig) return; // the gate already loaded it; only retry after a failed load
    const ctrl = new AbortController();
    api
      .config(ctrl.signal)
      .then((c) => {
        if (c.no_root) reloadHome(); // the server came back with no folder: show the chooser
        else setConfig(c);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [initialConfig]);

  useEffect(() => {
    configureRootsClient(config?.root_token);
    if (!config?.edit_enabled || !config.edit_token) return;
    const rootPath = config.root_path ?? null;
    configureEditClient(config.edit_token, async () => {
      // The server may have restarted with a fresh token. Never adopt the token
      // of another folder: the same relative path would be written there.
      const c = await api.config();
      if (c.no_root || (c.root_path ?? null) !== rootPath) return null;
      return c.edit_enabled ? (c.edit_token ?? null) : null;
    });
  }, [config]);

  /** Unsaved edits are lost on a folder switch: ask first. */
  const confirmLeave = useCallback(() => {
    const e = editRef.current;
    if (!e || !dirtyRef.current) return true;
    return window.confirm(`${basename(e.path)} has unsaved changes. Switch folders and discard them?`);
  }, []);
  const onLeave = useCallback(() => {
    leavingRef.current = true;
  }, []);
  const reloadIntoNewRoot = useCallback(() => {
    leavingRef.current = true;
    reloadHome();
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("viewer.sort");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved === "name" || saved === "mtime") setSort(saved);
    try {
      const k: unknown = JSON.parse(window.localStorage.getItem("viewer.kinds") ?? "[]");
      if (Array.isArray(k)) setKinds(k.filter((x): x is FileKind => typeof x === "string"));
    } catch {
      // ignore a corrupt saved value
    }
  }, []);
  const changeKinds = useCallback((k: FileKind[]) => {
    setKinds(k);
    window.localStorage.setItem("viewer.kinds", JSON.stringify(k));
  }, []);
  const changeSort = useCallback((s: SortMode) => {
    setSort(s);
    window.localStorage.setItem("viewer.sort", s);
  }, []);

  const root = useMemo(() => (tree ? buildTree(tree) : null), [tree]);
  const rootName = config?.root_name ?? "viewer";

  useEffect(() => {
    const name = route.path ? `${route.path.split("/").pop()} · ${rootName} viewer` : `${rootName} viewer`;
    document.title = edit && dirty ? `● ${name}` : name;
  }, [route.path, rootName, edit, dirty]);

  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
  }, []);

  const exitEdit = useCallback(() => {
    setEdit(null);
    setDirty(false);
    setReloadKey((k) => k + 1);
  }, [setDirty]);

  // While editing: guard in-app navigation, and the tab itself when there are unsaved changes.
  const isEditing = edit !== null;
  useEffect(() => {
    if (!isEditing) return;
    return setNavigationGuard((proceed) => {
      if (!dirtyRef.current) {
        exitEdit();
        return true;
      }
      setUnsaved({ proceed, leaving: editRef.current?.path ?? "" });
      return false;
    });
  }, [isEditing, exitEdit]);
  useEffect(() => {
    if (!edit || !dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [edit, dirty]);

  // If the route moved away from the edited file without the guard (forced), drop the session.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (edit && route.path !== edit.path && route.path !== edit.from) exitEdit();
  }, [edit, route.path, exitEdit]);

  const requestExit = useCallback(() => {
    if (!editRef.current) return;
    if (!dirtyRef.current) exitEdit();
    else setUnsaved({ proceed: () => undefined, leaving: editRef.current.path });
  }, [exitEdit]);

  const resolveUnsaved = async (choice: "save" | "discard") => {
    const u = unsaved;
    if (!u) return;
    if (choice === "save") {
      setSavingForExit(true);
      const ok = (await editorRef.current?.save()) ?? false;
      setSavingForExit(false);
      if (!ok) {
        // The editor shows why (conflict, invalid JSON, ...); stay here.
        setUnsaved(null);
        return;
      }
    }
    setUnsaved(null);
    exitEdit();
    u.proceed();
  };

  // Auto-expand the folders leading to the open file (adjusting state during render).
  const [autoFor, setAutoFor] = useState<string | null>(null);
  if (autoFor !== route.path) {
    setAutoFor(route.path);
    const anc = ancestors(route.path);
    if (anc.some((a) => !expanded.has(a))) setExpanded((prev) => new Set([...prev, ...anc]));
  }

  // Scroll to the top when switching files (unless a hash/hl target will scroll for us).
  const lastPath = useRef(route.path);
  useEffect(() => {
    if (lastPath.current !== route.path) {
      lastPath.current = route.path;
      if (!hashRef.current && !route.hl) window.scrollTo({ top: 0 });
    }
  }, [route.path, route.hl]);

  const onToggle = useCallback((path: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const onOpen = useCallback(
    (path: string) => {
      navigate(path);
      if (isMobile) setOpenMobile(false);
    },
    [navigate, isMobile, setOpenMobile],
  );

  const onFolder = useCallback(
    (path: string) => {
      setFilter("");
      if (path) setExpanded((prev) => new Set([...prev, ...ancestors(path), path]));
      if (isMobile) setOpenMobile(true);
      else setOpen(true);
      navigate(path);
      requestAnimationFrame(() => {
        document.querySelector(`[data-dir="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
      });
    },
    [isMobile, setOpen, setOpenMobile, navigate],
  );

  // Live updates.
  const onChange = useCallback(
    (ev: ChangeEvent) => {
      refresh();
      const cur = pathRef.current;
      if (!cur) return;
      const editing = editRef.current && editRef.current.path === cur ? editorRef.current : null;
      // Renames are inferred server-side (same size, mtime and name); no client guessing.
      const rename = ev.renames.find((r) => r.from === cur);
      if (rename) {
        if (!ownMoves.has(rename.from)) {
          toast.info("The open file was moved", { description: `${rename.from} → ${rename.to}` });
        }
        // Commit the editor's new path before the route changes so the session survives.
        if (editRef.current?.path === cur) flushSync(() => setEdit((e) => (e ? { ...e, path: rename.to, from: cur } : e)));
        navigate(rename.to, { replace: true, hash: hashRef.current || undefined, force: true });
        return;
      }
      if (ev.added.includes(cur)) {
        setDeletedPath(null);
        setReloadKey((k) => k + 1);
        editing?.externalChange("added");
        return;
      }
      if (ev.deleted.some((d) => d === cur || cur.startsWith(`${d}/`))) {
        if (editing) editing.externalChange("deleted");
        else setDeletedPath(cur);
        return;
      }
      if (ev.modified.includes(cur)) {
        setReloadKey((k) => k + 1);
        editing?.externalChange("modified");
      }
    },
    [refresh, navigate],
  );
  /** Follow a folder switch from another tab, or a restart with another / no folder. */
  const checkRoot = useCallback(() => {
    api
      .config()
      .then((c) => {
        const prev = configRef.current;
        if (!prev) {
          if (c.no_root) reloadIntoNewRoot();
          else setConfig(c);
          return;
        }
        if (!c.no_root && (c.root_path ?? null) === (prev.root_path ?? null)) return;
        if (editRef.current && dirtyRef.current) {
          toast.warning("The folder was switched in another window", {
            id: "root-switched", // checked on every reconnect attempt: show it once
            description: "Your unsaved edits can no longer be saved here. Copy them, then reload.",
            duration: Infinity,
            action: { label: "Reload", onClick: reloadIntoNewRoot },
          });
        } else reloadIntoNewRoot();
      })
      .catch(() => undefined);
  }, [reloadIntoNewRoot]);
  const onReconnect = useCallback(() => {
    refresh();
    setReloadKey((k) => k + 1);
    // Changes may have been missed while disconnected: let the editor compare with the disk.
    if (editRef.current) editorRef.current?.externalChange("modified");
    // The stream also drops when the folder is switched (from another tab): follow it.
    checkRoot();
  }, [refresh, checkRoot]);
  // A stream that keeps failing (409 with no folder selected) never reopens: re-check there too.
  const liveStatus = useEvents(onChange, onReconnect, checkRoot);

  // Keyboard: "/" and Cmd/Ctrl-K open search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSearchSelect = useCallback(
    (t: SearchTarget) => {
      if (t.match && (t.kind === "text" || t.kind === "code" || t.kind === "json")) {
        navigate(t.path, { hash: `L${t.match.line}` });
      } else if (t.match && (t.kind === "markdown" || t.kind === "mermaid")) {
        navigate(t.path, { hl: t.query, hll: t.match.text.trim().slice(0, 200) });
      } else {
        navigate(t.path);
      }
    },
    [navigate],
  );

  const folders = useMemo(() => (tree ? tree.dirs.filter((d) => d && !d.includes("/")).sort() : []), [tree]);
  const dirNode = root && route.path ? findDir(root, route.path) : null;
  const isDir = Boolean(dirNode);
  const deleted = deletedPath !== null && deletedPath === route.path;
  const fileKey = route.path && tree && !isDir ? route.path : "";
  const fileState = useAsync<FileInfo | null>(fileKey, reloadKey, (signal) =>
    fileKey ? api.file(fileKey, signal) : Promise.resolve(null),
  );

  const showEditor = edit !== null && (route.path === edit.path || route.path === edit.from);

  const startEdit = useCallback(() => {
    const f = fileState.data;
    if (!editEnabled || !f || !isEditable(f) || f.path !== pathRef.current) return;
    sessionSeq.current += 1;
    setDirty(false);
    setEdit({ path: f.path, session: sessionSeq.current, file: f });
  }, [editEnabled, fileState.data, setDirty]);

  // A file created from the UI opens straight in the editor once its info has loaded.
  useEffect(() => {
    if (!pendingEdit || route.path !== pendingEdit || fileState.data?.path !== pendingEdit) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingEdit(null);
    if (!edit) startEdit();
  }, [pendingEdit, route.path, fileState.data, edit, startEdit]);

  // ---------- callbacks for the file operations ----------

  const onMoved = useCallback(
    (from: string, to: string) => {
      const remap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : null);
      setExpanded((prev) => {
        let changed = false;
        const next = new Set<string>();
        for (const p of prev) {
          const m = remap(p);
          if (m !== null) changed = true;
          next.add(m ?? p);
        }
        return changed ? next : prev;
      });
      const cur = pathRef.current;
      const next = remap(cur);
      if (next === null) return;
      const e = editRef.current;
      if (e) {
        const np = remap(e.path) ?? e.path;
        flushSync(() => setEdit((x) => (x ? { ...x, path: np, from: x.path } : x)));
      }
      navigate(next, { replace: true, force: true, hash: hashRef.current || undefined });
    },
    [navigate],
  );
  const onRemoved = useCallback(
    (path: string) => {
      const cur = pathRef.current;
      if (cur !== path && !cur.startsWith(`${path}/`)) return;
      if (editRef.current) {
        setEdit(null);
        setDirty(false);
      }
      navigate(dirname(path), { force: true });
    },
    [navigate, setDirty],
  );
  const onCreated = useCallback(
    (path: string, isDir: boolean) => {
      if (isDir) {
        setExpanded((prev) => new Set([...prev, ...ancestors(path), path]));
        navigate(path);
        return;
      }
      setPendingEdit(path);
      navigate(path);
    },
    [navigate],
  );
  const hasUnsaved = useCallback((path: string) => {
    const e = editRef.current;
    return !!e && dirtyRef.current && (e.path === path || e.path.startsWith(`${path}/`));
  }, []);
  const editorText = useCallback(
    (path: string) => (editRef.current?.path === path ? (editorRef.current?.getText() ?? null) : null),
    [],
  );

  let body: React.ReactNode;
  if (showEditor && edit) {
    body = (
      <EditorSlot
        key={edit.session}
        path={edit.path}
        file={edit.file}
        handleRef={editorRef}
        onDirtyChange={setDirty}
        onExit={requestExit}
      />
    );
  } else if (!route.path) {
    body = error && !tree ? <ViewerError title="Cannot reach the viewer API" message={error} /> : (
      <HomeView tree={tree} root={root} rootName={rootName} onOpen={onOpen} />
    );
  } else if (dirNode) {
    body = <FolderView node={dirNode} sort={sort} onOpen={onOpen} />;
  } else if (!tree && loading) {
    body = <ViewerLoading />;
  } else {
    body = <FileView key={route.path} path={route.path} reloadKey={reloadKey} deleted={deleted} state={fileState} />;
  }

  const dropDir = isDir ? route.path : route.path ? dirname(route.path) : "";

  return (
    <FileOpsProvider
      enabled={editEnabled}
      config={config}
      tree={tree}
      repoPrefix={config?.repo_prefix ?? ""}
      refresh={refresh}
      onMoved={onMoved}
      onRemoved={onRemoved}
      onCreated={onCreated}
      onOpen={onOpen}
      hasUnsaved={hasUnsaved}
      editorText={editorText}
    >
      <MenuFolderPick beforeSwitch={confirmLeave} onLeave={onLeave} />
      <FileTree
        tree={tree}
        root={root}
        loading={loading}
        error={error}
        rootName={rootName}
        rootPath={config?.root_path}
        rootSwitcher={
          config?.root_switch_enabled ? (
            <RootSwitcher rootPath={config.root_path ?? null} beforeSwitch={confirmLeave} onLeave={onLeave} />
          ) : null
        }
        sort={sort}
        onSortChange={changeSort}
        kinds={kinds}
        onKindsChange={changeKinds}
        filter={filter}
        onFilterChange={setFilter}
        expanded={expanded}
        onToggle={onToggle}
        activePath={route.path}
        onOpen={onOpen}
      />
      <SidebarInset className="min-w-0">
        <FileHeader
          rootName={rootName}
          repoPrefix={config?.repo_prefix ?? ""}
          path={route.path}
          file={fileKey && !deleted ? fileState.data : null}
          isDir={isDir}
          liveStatus={liveStatus}
          onFolder={onFolder}
          onSearch={() => setSearchOpen(true)}
          editEnabled={editEnabled}
          editing={showEditor}
          dirty={dirty}
          onEdit={editEnabled && !showEditor && !deleted && isEditable(fileState.data) && fileState.data?.path === route.path ? startEdit : undefined}
          onDone={requestExit}
        />
        <MainArea dropDir={dropDir} acceptDrops={!showEditor}>
          {body}
        </MainArea>
      </SidebarInset>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} folders={folders} onSelect={onSearchSelect} />
      {editEnabled ? (
        <AlertDialog open={!!unsaved} onOpenChange={(o) => !o && !savingForExit && (setUnsaved(null), setPendingEdit(null))}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Save changes to {basename(unsaved?.leaving ?? "") || "this file"}?</AlertDialogTitle>
              <AlertDialogDescription>Your edits are not saved yet. If you discard them they are lost.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={savingForExit}>Cancel</AlertDialogCancel>
              <Button variant="destructive" disabled={savingForExit} onClick={() => void resolveUnsaved("discard")}>
                Discard
              </Button>
              <AlertDialogAction
                disabled={savingForExit}
                onClick={(e) => {
                  e.preventDefault();
                  void resolveUnsaved("save");
                }}
              >
                {savingForExit ? "Saving..." : "Save"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </FileOpsProvider>
  );
}

/** Loads the config first: with no folder selected the tree/content APIs answer 409, so don't mount them. */
export function AppShell() {
  const [loaded, setLoaded] = useState<{ config: AppConfig | null } | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api.config(ctrl.signal).then(
      (config) => {
        configureRootsClient(config.root_token);
        setLoaded({ config });
      },
      () => {
        // Unreachable server: the shell shows the usual errors and reconnects.
        if (!ctrl.signal.aborted) setLoaded({ config: null });
      },
    );
    return () => ctrl.abort();
  }, []);
  if (!loaded) {
    return (
      <div className="flex h-svh">
        <div className="w-64 space-y-2 border-r p-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
        <div className="flex-1 space-y-3 p-6">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }
  if (loaded.config?.no_root) return <NoRootView switchEnabled={loaded.config.root_switch_enabled ?? false} />;
  return (
    <SidebarProvider style={{ ["--sidebar-width" as string]: "20rem", ["--header-h" as string]: "3.5rem" }}>
      <Shell initialConfig={loaded.config} />
    </SidebarProvider>
  );
}
