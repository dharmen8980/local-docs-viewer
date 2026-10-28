"use client";

import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  ArrowDownAZIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  CopyPlusIcon,
  FilePlusIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HistoryIcon,
  PencilLineIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarRail,
} from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileKindIcon } from "@/components/file-icon";
import { formatRelative, type FileEntry, type TreeResponse } from "@/lib/api";
import { dirname, viewerHref } from "@/lib/paths";
import { sortDirs, sortFiles, type DirNode, type SortMode } from "@/lib/tree";
import { cn } from "@/lib/utils";

interface TreeCtx {
  sort: SortMode;
  expanded: Set<string>;
  activePath: string;
  onToggle: (path: string, open: boolean) => void;
  onOpen: (path: string) => void;
  /** file-management actions; null when editing is disabled */
  ops: EditOps | null;
}

const DROP_CLASS = "data-[drop=true]:bg-primary/15 data-[drop=true]:ring-1 data-[drop=true]:ring-primary";

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
}: {
  file: FileEntry;
  active: boolean;
  onOpen: (path: string) => void;
  label?: string;
  hint?: string;
  ops?: EditOps | null;
}) {
  const button = (
    <SidebarMenuButton
      asChild
      size="sm"
      isActive={active}
      data-path={file.path}
      className={cn("h-auto min-h-7 py-1", ops && DROP_CLASS)}
    >
      <a
        href={viewerHref(file.path)}
        title={file.path}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(file.path);
        }}
        onDragStart={ops ? (e) => startRowDrag(e, file.path, false) : undefined}
      >
        <FileKindIcon kind={file.kind} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label ?? file.name}</span>
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
  return (
    <Collapsible asChild open={open} onOpenChange={(o) => ctx.onToggle(node.path, o)}>
      <SidebarMenuItem>
        {ctx.ops ? (
          <FolderMenu ops={ctx.ops} path={node.path}>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                size="sm"
                data-dir={node.path}
                title={node.path}
                className={cn("h-7", DROP_CLASS)}
                draggable
                onDragStart={(e) => startRowDrag(e, node.path, true)}
              >
                <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
                {open ? <FolderOpenIcon className="text-muted-foreground" /> : <FolderIcon className="text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <span className="text-[10px] text-muted-foreground">{node.fileCount}</span>
              </SidebarMenuButton>
            </CollapsibleTrigger>
          </FolderMenu>
        ) : (
          <CollapsibleTrigger asChild>
            <SidebarMenuButton size="sm" data-dir={node.path} title={node.path} className="h-7">
              <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
              {open ? <FolderOpenIcon className="text-muted-foreground" /> : <FolderIcon className="text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="text-[10px] text-muted-foreground">{node.fileCount}</span>
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
        <FileLink key={f.path} file={f} active={f.path === ctx.activePath} onOpen={ctx.onOpen} ops={ctx.ops} />
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
  filter: string;
  onFilterChange: (s: string) => void;
  expanded: Set<string>;
  onToggle: (path: string, open: boolean) => void;
  activePath: string;
  onOpen: (path: string) => void;
}

export function FileTree(props: FileTreeProps) {
  const { tree, root, loading, error, sort, filter, expanded, activePath, onToggle, onOpen } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const ops = useEditOps();
  const dropEl = useRef<HTMLElement | null>(null);
  const expandTimer = useRef<{ dir: string; id: ReturnType<typeof setTimeout> } | null>(null);

  const ctx = useMemo<TreeCtx>(
    () => ({ sort, expanded, activePath, onToggle, onOpen, ops }),
    [sort, expanded, activePath, onToggle, onOpen, ops],
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
    () => (tree ? [...tree.files].sort((a, b) => b.mtime - a.mtime).slice(0, 10) : []),
    [tree],
  );

  const filtered = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tree || !terms.length) return null;
    return tree.files
      .filter((f) => {
        const p = f.path.toLowerCase();
        return terms.every((t) => p.includes(t));
      })
      .sort((a, b) => {
        const an = terms.every((t) => a.name.toLowerCase().includes(t)) ? 0 : 1;
        const bn = terms.every((t) => b.name.toLowerCase().includes(t)) ? 0 : 1;
        return an - bn || a.path.localeCompare(b.path);
      })
      .slice(0, 300);
  }, [tree, filter]);

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
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={sort}
            onValueChange={(v) => v && props.onSortChange(v as SortMode)}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroupItem value="name" aria-label="Sort by name">
                  <ArrowDownAZIcon />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>Sort by name</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroupItem value="mtime" aria-label="Sort by modified time">
                  <CalendarClockIcon />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>Sort by modified time</TooltipContent>
            </Tooltip>
          </ToggleGroup>
        </div>
        <div className="relative">
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

        {filtered ? (
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
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          <>
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
                    <DirChildren node={root} ctx={ctx} />
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
