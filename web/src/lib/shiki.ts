// Fine-grained shiki bundle: core + JavaScript regex engine (no WASM, so no
// 'wasm-unsafe-eval' in the CSP) + only the grammars we need.
import type { HighlighterCore, ShikiTransformer } from "shiki/core";

export type ShikiLang =
  | "python"
  | "shellscript"
  | "json"
  | "yaml"
  | "toml"
  | "typescript"
  | "javascript"
  | "tsx"
  | "sql"
  | "ini"
  | "html"
  | "css"
  | "dockerfile"
  | "markdown";

const EXT_LANG: Record<string, ShikiLang> = {
  py: "python",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  tsx: "tsx",
  sql: "sql",
  ini: "ini",
  cfg: "ini",
  html: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
};

const FENCE_ALIASES: Record<string, ShikiLang> = {
  ...EXT_LANG,
  python: "python",
  python3: "python",
  shell: "shellscript",
  shellscript: "shellscript",
  console: "shellscript",
  jsonc: "json",
  json5: "json",
  typescript: "typescript",
  javascript: "javascript",
  jsx: "javascript",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  htm: "html",
  xml: "html",
  toml: "toml",
};

export function langForFile(name: string, ext: string): ShikiLang | null {
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return "dockerfile";
  return EXT_LANG[ext.toLowerCase()] ?? null;
}

export function langForFence(lang: string): ShikiLang | null {
  return FENCE_ALIASES[lang.toLowerCase()] ?? null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
      return createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [
          import("shiki/langs/python.mjs"),
          import("shiki/langs/shellscript.mjs"),
          import("shiki/langs/json.mjs"),
          import("shiki/langs/yaml.mjs"),
          import("shiki/langs/toml.mjs"),
          import("shiki/langs/typescript.mjs"),
          import("shiki/langs/javascript.mjs"),
          import("shiki/langs/tsx.mjs"),
          import("shiki/langs/sql.mjs"),
          import("shiki/langs/ini.mjs"),
          import("shiki/langs/html.mjs"),
          import("shiki/langs/css.mjs"),
          import("shiki/langs/dockerfile.mjs"),
          import("shiki/langs/markdown.mjs"),
        ],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
    highlighterPromise.catch(() => {
      highlighterPromise = null;
    });
  }
  return highlighterPromise;
}

const lineNumbers: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.properties["data-line"] = String(line);
    node.properties["id"] = `L${line}`;
  },
};

export async function highlight(
  code: string,
  lang: ShikiLang,
  opts: { lineNumbers?: boolean } = {},
): Promise<string> {
  const hl = await getHighlighter();
  return hl.codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    transformers: opts.lineNumbers ? [lineNumbers] : [],
  });
}
