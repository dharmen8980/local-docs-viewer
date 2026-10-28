"use client";

import { ClockIcon, FolderIcon } from "lucide-react";
import { FileKindIcon } from "@/components/file-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, formatRelative, formatTime, type FileEntry, type TreeResponse } from "@/lib/api";
import { viewerHref } from "@/lib/paths";
import { sortDirs, sortFiles, type DirNode, type SortMode } from "@/lib/tree";

function go(e: React.MouseEvent, path: string, onOpen: (p: string) => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  onOpen(path);
}

export function FolderView({ node, sort, onOpen }: { node: DirNode; sort: SortMode; onOpen: (p: string) => void }) {
  const dirs = sortDirs(node.dirs, sort);
  const files = sortFiles(node.files, sort);
  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <h1 className="mb-4 flex items-center gap-2 text-xl font-semibold">
        <FolderIcon className="size-5 text-muted-foreground" /> {node.path || node.name}
        <span className="text-sm font-normal text-muted-foreground">({node.fileCount} files)</span>
      </h1>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-28 text-right">Size</TableHead>
              <TableHead className="w-48">Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dirs.map((d) => (
              <TableRow key={d.path}>
                <TableCell>
                  <a href={viewerHref(d.path)} onClick={(e) => go(e, d.path, onOpen)} className="flex items-center gap-2 hover:underline">
                    <FolderIcon className="size-4 text-muted-foreground" /> {d.name}/
                  </a>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{d.fileCount} files</TableCell>
                <TableCell className="text-muted-foreground">{d.mtime ? formatTime(d.mtime) : ""}</TableCell>
              </TableRow>
            ))}
            {files.map((f) => (
              <TableRow key={f.path}>
                <TableCell>
                  <a href={viewerHref(f.path)} onClick={(e) => go(e, f.path, onOpen)} className="flex items-center gap-2 hover:underline">
                    <FileKindIcon kind={f.kind} className="size-4 text-muted-foreground" /> {f.name}
                  </a>
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{formatBytes(f.size)}</TableCell>
                <TableCell className="text-muted-foreground">{formatTime(f.mtime)}</TableCell>
              </TableRow>
            ))}
            {!dirs.length && !files.length ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">
                  This folder is empty.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function HomeView({
  tree,
  root,
  rootName,
  onOpen,
}: {
  tree: TreeResponse | null;
  root: DirNode | null;
  rootName: string;
  onOpen: (p: string) => void;
}) {
  if (!tree || !root) {
    return (
      <div className="mx-auto max-w-5xl space-y-3 p-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </div>
    );
  }
  const recent: FileEntry[] = [...tree.files].sort((a, b) => b.mtime - a.mtime).slice(0, 15);
  const total = tree.files.reduce((n, f) => n + f.size, 0);
  return (
    <div className="mx-auto max-w-5xl space-y-8 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold">{rootName}</h1>
        <p className="text-sm text-muted-foreground">
          {tree.files.length} files, {tree.dirs.length} folders, {formatBytes(total)}. Press{" "}
          <kbd className="rounded border bg-muted px-1 font-mono text-xs">/</kbd> or{" "}
          <kbd className="rounded border bg-muted px-1 font-mono text-xs">⌘K</kbd> to search.
        </p>
      </div>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Folders</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortDirs(root.dirs, "name").map((d) => (
            <a
              key={d.path}
              href={viewerHref(d.path)}
              onClick={(e) => go(e, d.path, onOpen)}
              className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted"
            >
              <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate font-medium">{d.name}</div>
                <div className="text-xs text-muted-foreground">
                  {d.fileCount} files{d.mtime ? ` · ${formatRelative(d.mtime)}` : ""}
                </div>
              </div>
            </a>
          ))}
          {sortFiles(root.files, "name").map((f) => (
            <a
              key={f.path}
              href={viewerHref(f.path)}
              onClick={(e) => go(e, f.path, onOpen)}
              className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted"
            >
              <FileKindIcon kind={f.kind} className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate font-medium">{f.name}</div>
                <div className="text-xs text-muted-foreground">{formatBytes(f.size)}</div>
              </div>
            </a>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <ClockIcon className="size-4" /> Recently changed
        </h2>
        <ul className="divide-y rounded-lg border">
          {recent.map((f) => (
            <li key={f.path}>
              <a
                href={viewerHref(f.path)}
                onClick={(e) => go(e, f.path, onOpen)}
                className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted"
              >
                <FileKindIcon kind={f.kind} className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="shrink-0 text-xs text-muted-foreground" title={formatTime(f.mtime)}>
                  {formatRelative(f.mtime)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
