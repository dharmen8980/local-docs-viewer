import type { FileEntry, FileKind, TreeResponse } from "@/lib/api";
import { basename, dirname } from "@/lib/paths";

export interface DirNode {
  path: string;
  name: string;
  dirs: DirNode[];
  files: FileEntry[];
  /** Max mtime of all descendants (0 if empty). */
  mtime: number;
  fileCount: number;
}

export type SortMode = "name" | "mtime";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function buildTree(tree: TreeResponse): DirNode {
  const root: DirNode = { path: "", name: "", dirs: [], files: [], mtime: 0, fileCount: 0 };
  const byPath = new Map<string, DirNode>([["", root]]);
  const ensure = (path: string): DirNode => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const parent = ensure(dirname(path));
    const node: DirNode = { path, name: basename(path), dirs: [], files: [], mtime: 0, fileCount: 0 };
    parent.dirs.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const d of tree.dirs) if (d) ensure(d);
  for (const f of tree.files) ensure(dirname(f.path)).files.push(f);
  const finish = (n: DirNode) => {
    let m = 0;
    let c = n.files.length;
    for (const f of n.files) m = Math.max(m, f.mtime);
    for (const d of n.dirs) {
      finish(d);
      m = Math.max(m, d.mtime);
      c += d.fileCount;
    }
    n.mtime = m;
    n.fileCount = c;
  };
  finish(root);
  return root;
}

export function sortDirs(dirs: DirNode[], mode: SortMode): DirNode[] {
  return [...dirs].sort((a, b) =>
    mode === "mtime" ? b.mtime - a.mtime || collator.compare(a.name, b.name) : collator.compare(a.name, b.name),
  );
}

export function sortFiles(files: FileEntry[], mode: SortMode): FileEntry[] {
  return [...files].sort((a, b) =>
    mode === "mtime" ? b.mtime - a.mtime || collator.compare(a.name, b.name) : collator.compare(a.name, b.name),
  );
}

export function findDir(root: DirNode, path: string): DirNode | null {
  if (!path) return root;
  let node: DirNode | undefined = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length && node; i++) {
    const p = parts.slice(0, i + 1).join("/");
    node = node.dirs.find((d) => d.path === p);
  }
  return node ?? null;
}

/** The tree with only files of the given kinds; folders left without files are dropped. Empty set: no filter. */
export function filterKinds(root: DirNode, kinds: ReadonlySet<FileKind>): DirNode {
  if (!kinds.size) return root;
  const walk = (n: DirNode): DirNode | null => {
    const files = n.files.filter((f) => kinds.has(f.kind));
    const dirs = n.dirs.map(walk).filter((d): d is DirNode => d !== null);
    if (n.path && !files.length && !dirs.length) return null;
    let mtime = 0;
    let fileCount = files.length;
    for (const f of files) mtime = Math.max(mtime, f.mtime);
    for (const d of dirs) {
      mtime = Math.max(mtime, d.mtime);
      fileCount += d.fileCount;
    }
    return { ...n, files, dirs, mtime, fileCount };
  };
  return walk(root) ?? root;
}
