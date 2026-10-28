// Which files can be edited, and with which CodeMirror language. Kept apart
// from the (lazily loaded) editor so the viewer bundle does not pull it in.

import type { FileKind } from "@/lib/api";
import { EDIT_MAX_BYTES } from "@/lib/edit-api";

export const EDITABLE_KINDS: FileKind[] = ["markdown", "mermaid", "code", "json", "csv", "text"];

export function isEditable(file: { kind: FileKind; size: number } | null | undefined): boolean {
  return !!file && EDITABLE_KINDS.includes(file.kind) && file.size <= EDIT_MAX_BYTES;
}

export type EditorLang =
  | "markdown"
  | "json"
  | "python"
  | "yaml"
  | "shell"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "css"
  | "html"
  | "xml"
  | "toml"
  | "sql"
  | "dockerfile"
  | "go"
  | "rust"
  | "diff"
  | "ini"
  | "plain";

const EXT_LANG: Record<string, EditorLang> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  json: "json",
  jsonl: "json",
  ipynb: "json",
  py: "python",
  pyi: "python",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  env: "shell",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  toml: "toml",
  sql: "sql",
  go: "go",
  rs: "rust",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
};

export function editorLangFor(name: string, ext: string, kind: string): EditorLang {
  if (kind === "markdown") return "markdown";
  if (kind === "json") return "json";
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower === "makefile") return "shell";
  return EXT_LANG[ext.toLowerCase()] ?? "plain";
}
