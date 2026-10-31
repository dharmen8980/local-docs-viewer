"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownAZIcon,
  ArrowUpDownIcon,
  CalendarClockIcon,
  CheckCheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  CopyPlusIcon,
  EraserIcon,
  FilePlusIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FunnelIcon,
  HistoryIcon,
  PencilLineIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DRAG_MIME, hasDrag, readDrag, useEditOps, type EditOps } from "@/components/edit/edit-context";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileKindIcon } from "@/components/file-icon";
import { useChanges } from "@/components/changes/changes-context";
import { useChangesSource, WhatsNewPanel } from "@/components/changes/whats-new";
import { useGit } from "@/components/git/git-context";
import { useUncommittedSource } from "@/components/git/uncommitted-source";
import { isTypingTarget } from "@/lib/keys";
import { formatRelative, type FileEntry, type FileKind, type TreeResponse } from "@/lib/api";
import { changedDirsOf } from "@/lib/change-rules";
import { dirname, viewerHref } from "@/lib/paths";
import { filterFiles, sortDirs, sortFiles, type DirNode, type SortMode } from "@/lib/tree";
import { cn } from "@/lib/utils";

interface TreeCtx {
  sort: SortMode;
  expanded: Set<string>;
  activePath: string;
  onToggle: (path: string, open: boolean) => void;
  onOpen: (path: string) => void;
  /** file-management actions; null when editing is disabled */
  ops: EditOps | null;
  /** files changed since they were last viewed (the open file included: it is seen when left) */
  changed: ReadonlySet<string>;
  /** folders containing such files -> how many */
  changedDirs: ReadonlyMap<string, number>;
  /** "Changed since viewed" filter on: folder counts are changed counts */
  changedOnly: boolean;
}

const DROP_CLASS = "data-[drop=true]:bg-primary/15 data-[drop=true]:ring-1 data-[drop=true]:ring-primary";
/** Menu order and labels for the file type filter. */
const KIND_LABELS: [FileKind, string][] = [
  ["markdown", "Markdown"],
  ["mermaid", "Mermaid"],
  ["image", "Images"],
  ["pdf", "PDF"],
  ["json", "JSON"],
  ["csv", "CSV"],
  ["xlsx", "Spreadsheets"],
  ["code", "Code"],
  ["text", "Text"],
  ["binary", "Other"],
];

const ACTIVE_CLASS =
  "data-active:bg-neutral-300 data-active:hover:bg-neutral-300 dark:data-active:bg-neutral-600 dark:data-active:hover:bg-neutral-600";

function FileMenu({ ops, path, children }: { ops: EditOps; path: string; children: ReactNode }) {
  const dir = dirname(path);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuLabel className="truncate text-xs text-muted-foreground">{path}</ContextMenuLabel>
        <ContextMenuItem onSelect={() => ops.rename(path, false)}>
          <PencilLineIcon /> Rename...
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.moveTo(path, false)}>
          <FolderInputIcon /> Move to...
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.duplicate(path)}>
          <CopyPlusIcon /> Duplicate...
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.copyPath(path)}>
          <CopyIcon /> Copy path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.openHistory(path)}>
          <HistoryIcon /> Version history
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => ops.newFile(dir)}>
          <FilePlusIcon /> New file here
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.newFolder(dir)}>
          <FolderPlusIcon /> New folder here
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.upload(dir)}>
          <UploadIcon /> Upload here...
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => ops.remove(path, false)}>
          <Trash2Icon /> Delete...
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FolderMenu({ ops, path, children }: { ops: EditOps; path: string; children: ReactNode }) {
  const isRoot = !path;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuLabel className="truncate text-xs text-muted-foreground">{path || "Root folder"}</ContextMenuLabel>
        <ContextMenuItem onSelect={() => ops.newFile(path)}>
          <FilePlusIcon /> New file
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.newFolder(path)}>
          <FolderPlusIcon /> New folder
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ops.upload(path)}>
          <UploadIcon /> Upload files...
        </ContextMenuItem>
        {isRoot ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => ops.rename(path, true)}>
              <PencilLineIcon /> Rename...
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => ops.moveTo(path, true)}>
              <FolderInputIcon /> Move to...
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => ops.copyPath(path)}>
              <CopyIcon /> Copy path
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => ops.remove(path, true)}>
              <Trash2Icon /> Delete...
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function startRowDrag(e: React.DragEvent, path: string, isDir: boolean) {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ path, isDir }));
  e.dataTransfer.setData("text/plain", path);
  e.dataTransfer.effectAllowed = "copyMove";
}

function FileLink({
  file,
  active,
  onOpen,
  label,
  hint,
  ops,
  changed = false,
}: {
  file: FileEntry;
  active: boolean;
  onOpen: (path: string) => void;
  label?: string;
  hint?: string;
  ops?: EditOps | null;
  /** changed since the user last viewed it */
  changed?: boolean;
}) {
  const button = (
    <SidebarMenuButton
      asChild
      size="sm"
      isActive={active}
      data-path={file.path}
      className={cn("h-auto min-h-7 py-1", ACTIVE_CLASS, ops && DROP_CLASS)}
    >
      <a
        href={viewerHref(file.path)}
        title={
          changed
            ? `${file.path} · changed since you last viewed it${active ? " (counts as seen when you leave it)" : ""}`
            : file.path
        }
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(file.path);
        }}
        onDragStart={ops ? (e) => startRowDrag(e, file.path, false) : undefined}
      >
        <FileKindIcon kind={file.kind} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label ?? file.name}</span>
        {changed ? (
          <>
            {/* The open file: a ring until it counts as seen (on leave or Mark as seen). */}
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                active ? "border-2 border-sky-500 dark:border-sky-400" : "bg-sky-500 dark:bg-sky-400",
              )}
              aria-hidden
            />
            <span className="sr-only">changed since you last viewed it</span>
          </>
        ) : null}
        {hint ? <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">{hint}</span> : null}
      </a>
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem>
      {ops ? (
        <FileMenu ops={ops} path={file.path}>
          {button}
        </FileMenu>
      ) : (
        button
      )}
    </SidebarMenuItem>
  );
}

const DirItem = memo(function DirItem({ node, ctx }: { node: DirNode; ctx: TreeCtx }) {
  const open = ctx.expanded.has(node.path);
  const nChanged = ctx.changedDirs.get(node.path) ?? 0;
  const changedLabel = `${nChanged} changed file${nChanged === 1 ? "" : "s"}`;
  const title = nChanged ? `${node.path} · ${changedLabel} since you last viewed them` : node.path;
  const FolderGlyph = open ? FolderOpenIcon : FolderIcon;
  const inner = (
    <>
      <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
      {/* The change dot sits on the folder icon, away from the file count. */}
      <span className="relative flex shrink-0">
        <FolderGlyph className="size-4 text-muted-foreground" />
        {nChanged ? (
          <span
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sky-500 ring-2 ring-sidebar dark:bg-sky-400"
            aria-hidden
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {nChanged ? <span className="sr-only">{changedLabel}</span> : null}
      <span className={cn("text-[10px]", ctx.changedOnly ? "text-sky-700 dark:text-sky-300" : "text-muted-foreground")}>
        {ctx.changedOnly ? nChanged : node.fileCount}
      </span>
    </>
  );
  return (
    <Collapsible asChild open={open} onOpenChange={(o) => ctx.onToggle(node.path, o)}>
      <SidebarMenuItem>
        {ctx.ops ? (
          <FolderMenu ops={ctx.ops} path={node.path}>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                size="sm"
                data-dir={node.path}
                title={title}
                className={cn("h-7", DROP_CLASS)}
                draggable
                onDragStart={(e) => startRowDrag(e, node.path, true)}
              >
                {inner}
              </SidebarMenuButton>
            </CollapsibleTrigger>
          </FolderMenu>
        ) : (
          <CollapsibleTrigger asChild>
            <SidebarMenuButton size="sm" data-dir={node.path} title={title} className="h-7">
              {inner}
            </SidebarMenuButton>
          </CollapsibleTrigger>
        )}
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 ml-3 gap-0.5 pr-0 pl-1.5">
            <DirChildren node={node} ctx={ctx} />
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
});

function DirChildren({ node, ctx }: { node: DirNode; ctx: TreeCtx }) {
  const dirs = sortDirs(node.dirs, ctx.sort);
  const files = sortFiles(node.files, ctx.sort);
  return (
    <>
      {dirs.map((d) => (
        <DirItem key={d.path} node={d} ctx={ctx} />
      ))}
      {files.map((f) => (
        <FileLink
          key={f.path}
          file={f}
          active={f.path === ctx.activePath}
          onOpen={ctx.onOpen}
          ops={ctx.ops}
          changed={ctx.changed.has(f.path)}
        />
      ))}
      {dirs.length === 0 && files.length === 0 ? (
        <li className="px-2 py-1 text-xs text-muted-foreground italic">empty</li>
      ) : null}
    </>
  );
}

export interface FileTreeProps {
  tree: TreeResponse | null;
  root: DirNode | null;
  loading: boolean;
  error: string | null;
  rootName: string;
  /** full root path, shown as the name's tooltip */
  rootPath?: string | null;
  /** folder switcher rendered next to the root name */
  rootSwitcher?: ReactNode;
  sort: SortMode;
  onSortChange: (s: SortMode) => void;
  /** file kinds to show; empty shows everything */
  kinds: FileKind[];
  onKindsChange: (k: FileKind[]) => void;
  filter: string;
  onFilterChange: (s: string) => void;
  expanded: Set<string>;
  onToggle: (path: string, open: boolean) => void;
  activePath: string;
  onOpen: (path: string) => void;
  /** files changed since they were last viewed (all of them, the open file included) */
  changed: ReadonlySet<string>;
  /** the change history is available (kept by the server) */
  changesEnabled: boolean;
  /** show only files changed since viewed */
  changedOnly: boolean;
  onChangedOnlyChange: (on: boolean) => void;
  onMarkAllSeen: () => void;
  /** forget the folder's whole history; false if it failed */
  onClearHistory: () => Promise<boolean>;
  /** open a file showing its changes since the last commit (Uncommitted list) */
  onOpenGit: (path: string) => void;
}

/** Confirm step of "Clear history…" (filter menu > Changes); outside the menu so focus returns properly. */
function ClearHistoryDialog({ open, onOpenChange, onClear }: { open: boolean; onOpenChange: (o: boolean) => void; onClear: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const ok = await onClear();
    setBusy(false);
    onOpenChange(false);
    if (ok) toast("Changes history cleared");
    else toast.error("Could not clear the changes history");
  };
  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear the changes history?</AlertDialogTitle>
          <AlertDialogDescription>
            The viewer forgets which version of each file in this folder you last viewed, and the saved copies used for
            the highlights and diffs. Every dot and banner goes away, in every tab. Files count as never opened: they
            get a dot again only after you view them and they change. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            {busy ? "Clearing..." : "Clear history"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function FileTree(props: FileTreeProps) {
  const { tree, loading, error, sort, filter, kinds, expanded, activePath, onToggle, onOpen, changed } = props;
  const changedOnly = props.changesEnabled && props.changedOnly;
  const [confirmClear, setConfirmClear] = useState(false);
  // ---------- What's new (a view of the sidebar, in place of the tree) ----------
  const changesSource = useChangesSource(tree, useChanges());
  const gitSource = useUncommittedSource(useGit(), props.onOpenGit);
  const feedSources = useMemo(
    () => [changesSource, gitSource].filter((s): s is NonNullable<typeof s> => s !== null),
    [changesSource, gitSource],
  );
  /** the What's new entry's count: changed since viewed, else (git only) the uncommitted files */
  const feedCount = changesSource ? changed.size : (gitSource?.items.length ?? 0);
  const [feedOpen, setFeedOpen] = useState(false);
  const showFeed = feedOpen && feedSources.length > 0;
  const { open: sidebarOpen, openMobile, setOpen: setSidebarOpen, setOpenMobile, isMobile } = useSidebar();
  // w: open / close What's new (ignored while typing; n / p are the banner's, / is search).
  // With the sidebar hidden it always shows the feed, so one press is enough.
  useEffect(() => {
    if (!feedSources.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "w" || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      const shown = isMobile ? openMobile : sidebarOpen;
      if (!shown) {
        if (isMobile) setOpenMobile(true);
        else setSidebarOpen(true);
        setFeedOpen(true);
      } else setFeedOpen(!feedOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feedSources.length, feedOpen, isMobile, openMobile, sidebarOpen, setOpenMobile, setSidebarOpen]);
  const kindSet = useMemo(() => new Set(kinds), [kinds]);
  const changedDirs = useMemo(() => changedDirsOf(changed), [changed]);
  /** File type and "changed since viewed" filters; the open file stays visible after a click. */
  const keep = useCallback(
    (f: FileEntry) =>
      (!kindSet.size || kindSet.has(f.kind)) && (!changedOnly || changed.has(f.path) || f.path === activePath),
    [kindSet, changedOnly, changed, activePath],
  );
  const root = useMemo(
    () => (props.root && (kindSet.size || changedOnly) ? filterFiles(props.root, keep) : props.root),
    [props.root, kindSet, changedOnly, keep],
  );
  const kindCounts = useMemo(() => {
    const m = new Map<FileKind, number>();
    for (const f of tree?.files ?? []) m.set(f.kind, (m.get(f.kind) ?? 0) + 1);
    return m;
  }, [tree]);
  const activeFilters = kinds.length + (changedOnly ? 1 : 0);
  const filterParts = [
    ...(kinds.length ? [`${kinds.length} file type${kinds.length === 1 ? "" : "s"}`] : []),
    ...(changedOnly ? ["changed since viewed"] : []),
  ];
  const filterLabel = filterParts.length ? `Filter: ${filterParts.join(", ")}` : "Filter files";
  const contentRef = useRef<HTMLDivElement>(null);
  const ops = useEditOps();
  const dropEl = useRef<HTMLElement | null>(null);
  const expandTimer = useRef<{ dir: string; id: ReturnType<typeof setTimeout> } | null>(null);

  const ctx = useMemo<TreeCtx>(
    () => ({ sort, expanded, activePath, onToggle, onOpen, ops, changed, changedDirs, changedOnly }),
    [sort, expanded, activePath, onToggle, onOpen, ops, changed, changedDirs, changedOnly],
  );

  // ---------- drag and drop (editing only) ----------

  const setDropEl = (el: HTMLElement | null) => {
    if (dropEl.current === el) return;
    if (dropEl.current) delete dropEl.current.dataset.drop;
    dropEl.current = el;
    if (el) el.dataset.drop = "true";
  };
  const clearExpandTimer = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current.id);
    expandTimer.current = null;
  };
  /** The folder a drop at this element goes to, plus the element to highlight. */
  const dropTarget = (target: EventTarget | null, group: HTMLElement): { dir: string; el: HTMLElement } => {
    const t = target instanceof Element ? target : null;
    const dirEl = t?.closest<HTMLElement>("[data-dir]");
    if (dirEl && group.contains(dirEl)) return { dir: dirEl.dataset.dir ?? "", el: dirEl };
    const fileEl = t?.closest<HTMLElement>("[data-path]");
    if (fileEl && group.contains(fileEl)) {
      const dir = dirname(fileEl.dataset.path ?? "");
      const parent = dir ? group.querySelector<HTMLElement>(`[data-dir="${CSS.escape(dir)}"]`) : null;
      return { dir, el: parent ?? group };
    }
    return { dir: "", el: group };
  };
  const dropHandlers = ops
    ? {
        onDragOver: (e: React.DragEvent<HTMLElement>) => {
          const kind = hasDrag(e.dataTransfer);
          if (!kind) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = kind === "row" ? "move" : "copy";
          const { dir, el } = dropTarget(e.target, e.currentTarget);
          setDropEl(el);
          // Hovering a closed folder for a moment opens it.
          if (dir && !expanded.has(dir)) {
            if (expandTimer.current?.dir !== dir) {
              clearExpandTimer();
              expandTimer.current = { dir, id: setTimeout(() => onToggle(dir, true), 700) };
            }
          } else clearExpandTimer();
        },
        onDragLeave: (e: React.DragEvent<HTMLElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropEl(null);
            clearExpandTimer();
          }
        },
        onDrop: (e: React.DragEvent<HTMLElement>) => {
          const kind = hasDrag(e.dataTransfer);
          setDropEl(null);
          clearExpandTimer();
          if (!kind) return;
          e.preventDefault();
          const { dir } = dropTarget(e.target, e.currentTarget);
          if (kind === "row") {
            const p = readDrag(e.dataTransfer);
            if (p) ops.dropMove(p.path, dir, p.isDir);
          } else {
            const files = Array.from(e.dataTransfer.files ?? []);
            if (files.length) ops.upload(dir, files);
          }
        },
      }
    : {};

  const recent = useMemo(
    () =>
      tree
        ? tree.files
            .filter(keep)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10)
        : [],
    [tree, keep],
  );

  const filtered = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tree || !terms.length) return null;
    return tree.files
      .filter((f) => {
        if (!keep(f)) return false;
        const p = f.path.toLowerCase();
        return terms.every((t) => p.includes(t));
      })
      .sort((a, b) => {
        const an = terms.every((t) => a.name.toLowerCase().includes(t)) ? 0 : 1;
        const bn = terms.every((t) => b.name.toLowerCase().includes(t)) ? 0 : 1;
        return an - bn || a.path.localeCompare(b.path);
      })
      .slice(0, 300);
  }, [tree, filter, keep]);

  // Keep the open file visible in the tree.
  useEffect(() => {
    if (!activePath) return;
    const id = requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector<HTMLElement>(
        `[data-tree-main] [data-path="${CSS.escape(activePath)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, [activePath, expanded, root]);

  return (
    <Sidebar className="no-print">
      <SidebarHeader className="gap-2 border-b">
        <div className="flex items-center gap-2 px-1">
          <a
            href={viewerHref("")}
            onClick={(e) => {
              e.preventDefault();
              onOpen("");
            }}
            className="min-w-0 flex-1 truncate font-semibold"
            title={props.rootPath || props.rootName}
          >
            {props.rootName || "viewer"}
          </a>
          {props.rootSwitcher}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Sort">
                    {sort === "mtime" ? <CalendarClockIcon /> : <ArrowDownAZIcon />}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Sort: {sort === "mtime" ? "modified time" : "name"}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <ArrowUpDownIcon className="size-3.5" /> Sort by
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(v) => props.onSortChange(v as SortMode)}>
                <DropdownMenuRadioItem value="name">
                  <ArrowDownAZIcon /> Name
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="mtime">
                  <CalendarClockIcon /> Modified time
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={activeFilters ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Filter files"
                    className="relative"
                  >
                    <FunnelIcon />
                    {activeFilters ? (
                      <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground">
                        {activeFilters}
                      </span>
                    ) : null}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{filterLabel}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel>File types</DropdownMenuLabel>
              {KIND_LABELS.filter(([k]) => kindCounts.has(k) || kindSet.has(k)).map(([k, label]) => (
                <DropdownMenuCheckboxItem
                  key={k}
                  checked={kindSet.has(k)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) =>
                    props.onKindsChange(on ? [...kinds, k] : kinds.filter((x) => x !== k))
                  }
                >
                  <FileKindIcon kind={k} className="text-muted-foreground" />
                  <span className="flex-1">{label}</span>
                  <span className="text-xs text-muted-foreground">{kindCounts.get(k) ?? 0}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              {props.changesEnabled ? (
                <>
                  <DropdownMenuLabel className="flex items-center gap-1.5">
                    <HistoryIcon className="size-3.5" /> Changes
                  </DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={changedOnly}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(on) => props.onChangedOnlyChange(on === true)}
                  >
                    <span className="flex-1 whitespace-nowrap">Changed since viewed</span>
                    <span className="size-2 shrink-0 rounded-full bg-sky-500 dark:bg-sky-400" aria-hidden />
                    <span className="text-xs text-muted-foreground">{changed.size}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuItem disabled={!changed.size} onSelect={() => props.onMarkAllSeen()}>
                    <CheckCheckIcon /> Mark all as seen
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setConfirmClear(true)}>
                    <EraserIcon /> Clear history…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem disabled={!kinds.length} onSelect={() => props.onKindsChange([])}>
                <XIcon /> Show all types
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {props.changesEnabled ? (
            <ClearHistoryDialog open={confirmClear} onOpenChange={setConfirmClear} onClear={props.onClearHistory} />
          ) : null}
        </div>
        <div className="relative" hidden={showFeed}>
          <SidebarInput
            placeholder="Filter files..."
            value={filter}
            onChange={(e) => props.onFilterChange(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && props.onFilterChange("")}
            aria-label="Filter files"
          />
          {filter ? (
            <button
              type="button"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => props.onFilterChange("")}
              aria-label="Clear filter"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </SidebarHeader>
      <SidebarContent ref={contentRef}>
        {error && !tree ? (
          <div className="m-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            Could not load the file tree: {error}
          </div>
        ) : null}
        {loading && !tree ? (
          <SidebarGroup>
            <SidebarMenu>
              {Array.from({ length: 14 }).map((_, i) => (
                <SidebarMenuItem key={i}>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}

        {showFeed ? (
          <WhatsNewPanel
            sources={feedSources}
            activePath={activePath}
            activeClassName={ACTIVE_CLASS}
            onOpen={onOpen}
            onClose={() => setFeedOpen(false)}
          />
        ) : filtered ? (
          <SidebarGroup>
            <SidebarGroupLabel>
              {filtered.length} match{filtered.length === 1 ? "" : "es"}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {filtered.map((f) => (
                  <FileLink
                    key={f.path}
                    file={f}
                    active={f.path === activePath}
                    onOpen={onOpen}
                    label={f.name}
                    hint={dirname(f.path) || undefined}
                    ops={ops}
                    changed={changed.has(f.path)}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          <>
            {feedSources.length && tree ? (
              <SidebarGroup className="pb-0">
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      size="sm"
                      onClick={() => setFeedOpen(true)}
                      title={
                        changesSource
                          ? `Files changed since you last viewed them${gitSource ? ", and uncommitted files" : ""} (w)`
                          : "Files with uncommitted changes (w)"
                      }
                    >
                      <SparklesIcon className="text-sky-600 dark:text-sky-400" />
                      <span>What&apos;s new</span>
                    </SidebarMenuButton>
                    {feedCount ? (
                      <SidebarMenuBadge className="text-sky-700 dark:text-sky-300">{feedCount.toLocaleString()}</SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
            ) : null}
            {recent.length ? (
              <SidebarGroup>
                <SidebarGroupLabel className="gap-1.5">
                  <ClockIcon /> Recently changed
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu className="gap-0.5">
                    {recent.map((f) => (
                      <FileLink
                        key={f.path}
                        file={f}
                        active={false}
                        onOpen={onOpen}
                        hint={formatRelative(f.mtime)}
                        ops={ops}
                        changed={changed.has(f.path)}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ) : null}
            {root ? (
              <SidebarGroup data-tree-main className={ops ? cn("rounded-md", DROP_CLASS) : undefined} {...dropHandlers}>
                {ops ? (
                  <FolderMenu ops={ops} path="">
                    <SidebarGroupLabel>Files</SidebarGroupLabel>
                  </FolderMenu>
                ) : (
                  <SidebarGroupLabel>Files</SidebarGroupLabel>
                )}
                <SidebarGroupContent>
                  <SidebarMenu className="gap-0.5">
                    {changedOnly && root.fileCount === 0 ? (
                      <li className="px-2 py-1 text-xs text-muted-foreground italic">
                        No files changed since you last viewed them.
                      </li>
                    ) : (
                      <DirChildren node={root} ctx={ctx} />
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ) : null}
          </>
        )}
      </SidebarContent>
      {ops ? (
        <SidebarFooter className="border-t p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" onClick={() => ops.openTrash()}>
                <Trash2Icon className="text-muted-foreground" />
                <span>Trash and activity</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  );
}
