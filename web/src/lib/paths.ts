// POSIX-style relative path helpers. All paths are relative to the viewer root
// and never start with "/". Resolution that would escape the root yields null.

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function extname(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Ancestor directories of a path, outermost first: "a/b/c.md" -> ["a", "a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Normalise a list of segments, resolving "." and "..". Returns null when ".." would leave the root. */
export function normalize(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Join a root-relative directory with a relative reference ("./x", "../y/z.md", "z.md"). */
export function joinRelative(baseDir: string, rel: string): string | null {
  if (rel.startsWith("/")) return normalize(rel); // treat "/x" as root-relative
  return normalize(baseDir ? `${baseDir}/${rel}` : rel);
}

/** True for URLs with a scheme (http:, mailto:, data:, file:, ...) or protocol-relative "//host". */
export function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

export function isWebLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface ResolvedLink {
  /** Root-relative target path ("" means the current document). */
  path: string;
  hash: string;
}

/**
 * Resolve a link found inside the document `fromPath` (a file path).
 * Returns null for external links or links escaping the root.
 *   resolveLink("a/b/doc.md", "../c/x.md#h") -> { path: "a/c/x.md", hash: "h" }
 *   resolveLink("a/doc.md", "./img/p.png")   -> { path: "a/img/p.png", hash: "" }
 *   resolveLink("a/doc.md", "#top")           -> { path: "", hash: "top" }
 */
export function resolveLink(fromPath: string, href: string): ResolvedLink | null {
  if (!href || isExternal(href)) return null;
  let rest = href;
  let hash = "";
  const hi = rest.indexOf("#");
  if (hi >= 0) {
    hash = safeDecode(rest.slice(hi + 1));
    rest = rest.slice(0, hi);
  }
  const qi = rest.indexOf("?");
  if (qi >= 0) rest = rest.slice(0, qi);
  if (rest === "") return { path: "", hash };
  const target = joinRelative(dirname(fromPath), safeDecode(rest));
  if (target === null || target === "") return null;
  return { path: target, hash };
}

/** In-app URL for a root-relative path. */
export function viewerHref(path: string, hash?: string, extra?: Record<string, string>): string {
  const sp = new URLSearchParams();
  if (path) sp.set("p", path);
  for (const [k, v] of Object.entries(extra ?? {})) sp.set(k, v);
  const q = sp.toString();
  return `/${q ? `?${q}` : ""}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}
