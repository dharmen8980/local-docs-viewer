"use client";

import { Fragment } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  CopyIcon,
  CopyPlusIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FilePlusIcon,
  FolderInputIcon,
  FolderPlusIcon,
  HistoryIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PencilLineIcon,
  PrinterIcon,
  SearchIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes, formatRelative, formatTime, rawUrl, type FileInfo } from "@/lib/api";
import { dirname, viewerHref } from "@/lib/paths";
import { useEditOps } from "@/components/edit/edit-context";
import { PdfMenu } from "@/components/pdf-menu";
import type { EventsStatus } from "@/hooks/use-events";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

function IconButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Theme">
              <SunIcon className="dark:hidden" />
              <MoonIcon className="hidden dark:block" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <SunIcon /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface FileHeaderProps {
  rootName: string;
  repoPrefix: string;
  path: string;
  file: FileInfo | null;
  isDir: boolean;
  liveStatus: EventsStatus;
  onFolder: (path: string) => void;
  onSearch: () => void;
  /** Tier 3 editing (all optional; absent means the read-only header). */
  editEnabled?: boolean;
  editing?: boolean;
  dirty?: boolean;
  /** start editing the open file (only passed when it is editable) */
  onEdit?: () => void;
  /** leave the editor (prompts when there are unsaved changes) */
  onDone?: () => void;
}

/** "..." menu with the file-management actions for the open file, folder or root. */
function FileActionsMenu({ path, isDir, isFile }: { path: string; isDir: boolean; isFile: boolean }) {
  const ops = useEditOps();
  if (!ops) return null;
  const folder = isDir || !path ? path : dirname(path);
  const isRoot = !path;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="File actions">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>File actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="truncate text-xs text-muted-foreground">
          {isRoot ? "Root folder" : isDir ? `Folder: ${path}` : path}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => ops.newFile(folder)}>
          <FilePlusIcon /> New file{isFile ? " here" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => ops.newFolder(folder)}>
          <FolderPlusIcon /> New folder{isFile ? " here" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => ops.upload(folder)}>
          <UploadIcon /> Upload files{isFile ? " here" : ""}...
        </DropdownMenuItem>
        {!isRoot && (isFile || isDir) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => ops.rename(path, isDir)}>
              <PencilLineIcon /> Rename...
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ops.moveTo(path, isDir)}>
              <FolderInputIcon /> Move to...
            </DropdownMenuItem>
            {isFile ? (
              <DropdownMenuItem onSelect={() => ops.duplicate(path)}>
                <CopyPlusIcon /> Duplicate...
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => ops.copyPath(path)}>
              <CopyIcon /> Copy path
            </DropdownMenuItem>
            {isFile ? (
              <DropdownMenuItem onSelect={() => ops.openHistory(path)}>
                <HistoryIcon /> Version history
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => ops.remove(path, isDir)}>
              <Trash2Icon /> Delete...
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => ops.openTrash()}>
          <Trash2Icon /> Open Trash
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FileHeader({
  rootName,
  repoPrefix,
  path,
  file,
  isDir,
  liveStatus,
  onFolder,
  onSearch,
  editEnabled = false,
  editing = false,
  dirty = false,
  onEdit,
  onDone,
}: FileHeaderProps) {
  const parts = path ? path.split("/") : [];
  const crumbs = parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
  const last = crumbs.length - 1;

  const copyPath = async () => {
    const text = `${repoPrefix}${path}`;
    if (await copyText(text)) toast.success("Path copied", { description: text });
    else toast.error("Could not copy to clipboard");
  };

  const inline = file && (file.kind === "image" || file.kind === "pdf");

  return (
    <header className="no-print sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-5!" />
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap overflow-hidden text-sm">
            <BreadcrumbItem className="shrink-0">
              {crumbs.length ? (
                <BreadcrumbLink asChild>
                  <a
                    href={viewerHref("")}
                    onClick={(e) => {
                      e.preventDefault();
                      onFolder("");
                    }}
                  >
                    {rootName || "root"}
                  </a>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{rootName || "root"}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {crumbs.map((c, i) => (
              <Fragment key={c.path}>
                <BreadcrumbSeparator />
                <BreadcrumbItem className={cn("min-w-0", i === last ? "shrink" : "shrink-[2]")}>
                  {i === last ? (
                    <BreadcrumbPage className="truncate font-medium" title={c.path}>
                      {c.name}
                      {editing && dirty ? (
                        <span className="ml-1.5 inline-block size-2 rounded-full bg-amber-500 align-middle" role="img" aria-label="Unsaved changes" />
                      ) : null}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <a
                        href={viewerHref(c.path)}
                        className="truncate"
                        title={`Show ${c.path} in the tree`}
                        onClick={(e) => {
                          e.preventDefault();
                          onFolder(c.path);
                        }}
                      >
                        {c.name}
                      </a>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        {file ? (
          <div className="truncate text-xs text-muted-foreground" title={formatTime(file.mtime)}>
            {formatBytes(file.size)} · modified {formatTime(file.mtime)} ({formatRelative(file.mtime)})
          </div>
        ) : isDir ? (
          <div className="text-xs text-muted-foreground">Folder</div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {editEnabled ? (
          <Badge
            variant="outline"
            className="mr-1 gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
            title="This server was started with --allow-edit: files can be changed from the browser."
          >
            <PencilIcon className="size-3" aria-hidden />
            <span className="sr-only lg:not-sr-only">Editing enabled</span>
          </Badge>
        ) : null}
        {editing ? (
          <Button size="sm" variant="outline" className="mr-1" onClick={onDone}>
            Done
          </Button>
        ) : onEdit ? (
          <Button size="sm" variant="outline" className="mr-1" onClick={onEdit}>
            <PencilIcon /> Edit
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "mx-1 inline-block size-2 rounded-full",
                liveStatus === "open" ? "bg-emerald-500" : liveStatus === "connecting" ? "bg-amber-400" : "bg-red-500",
              )}
              aria-label={`Live updates: ${liveStatus}`}
            />
          </TooltipTrigger>
          <TooltipContent>
            {liveStatus === "open" ? "Live updates connected" : liveStatus === "connecting" ? "Connecting..." : "Live updates disconnected, retrying"}
          </TooltipContent>
        </Tooltip>
        {path ? (
          <IconButton label="Copy path" onClick={copyPath}>
            <CopyIcon />
          </IconButton>
        ) : null}
        {file ? (
          <IconButton label={inline ? "Open raw file in a new tab" : "Download raw file"} asChild>
            {inline ? (
              <a href={rawUrl(file.path)} target="_blank" rel="noreferrer noopener">
                <ExternalLinkIcon />
              </a>
            ) : (
              <a href={rawUrl(file.path)} download={file.name}>
                <DownloadIcon />
              </a>
            )}
          </IconButton>
        ) : null}
        {file && (file.kind === "markdown" || file.kind === "mermaid") ? <PdfMenu key={file.path} file={file} /> : null}
        {file?.kind === "markdown" ? (
          <IconButton label="Print" onClick={() => window.print()}>
            <PrinterIcon />
          </IconButton>
        ) : null}
        {editEnabled ? <FileActionsMenu path={path} isDir={isDir} isFile={!!file} /> : null}
        <ThemeToggle />
        <Button variant="outline" size="sm" className="ml-1 gap-2 text-muted-foreground" onClick={onSearch}>
          <SearchIcon />
          <span className="hidden md:inline">Search</span>
          <kbd className="pointer-events-none hidden rounded border bg-muted px-1.5 font-mono text-[10px] md:inline">
            ⌘K
          </kbd>
        </Button>
      </div>
    </header>
  );
}
