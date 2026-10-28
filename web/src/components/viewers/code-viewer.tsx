"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "@/hooks/use-route";
import { api, ApiError, errorMessage } from "@/lib/api";
import { highlight, langForFile, type ShikiLang } from "@/lib/shiki";
import { cn } from "@/lib/utils";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { TextViewer } from "./text-viewer";

/** Above this size we do not syntax highlight; the plain/large-file viewer is used instead. */
export const HIGHLIGHT_MAX_BYTES = 300 * 1024;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function plainHtml(code: string): string {
  const lines = code.endsWith("\n") ? code.slice(0, -1).split("\n") : code.split("\n");
  const body = lines
    .map((l, i) => `<span class="line" data-line="${i + 1}" id="L${i + 1}">${escapeHtml(l)}</span>`)
    .join("\n");
  return `<pre class="shiki"><code>${body}</code></pre>`;
}

export function parseLineHash(hash: string): number | null {
  const m = /^L(\d+)$/.exec(hash);
  return m ? Number(m[1]) : null;
}

/**
 * Line-numbered, optionally highlighted code with `#L<n>` anchors.
 * Clicking a line number sets the hash.
 */
export function CodeLines({
  code,
  lang,
  wrap = false,
}: {
  code: string;
  lang: ShikiLang | null;
  wrap?: boolean;
}) {
  const { hash, setHash } = useRoute();
  const ref = useRef<HTMLDivElement>(null);
  const plain = useMemo(() => plainHtml(code), [code]);
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null);
  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) n++;
    return n;
  }, [code]);

  useEffect(() => {
    if (!lang || code.length > HIGHLIGHT_MAX_BYTES) return;
    let cancelled = false;
    highlight(code, lang, { lineNumbers: true })
      .then((html) => {
        if (!cancelled) setHighlighted({ code, html });
      })
      .catch(() => {
        /* keep plain rendering */
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const html = highlighted && highlighted.code === code ? highlighted.html : plain;
  const target = parseLineHash(hash);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll(".line.is-target").forEach((el) => el.classList.remove("is-target"));
    if (target === null) return;
    const el = root.querySelector<HTMLElement>(`[data-line="${target}"]`);
    if (el) {
      el.classList.add("is-target");
      el.scrollIntoView({ block: "center" });
    }
  }, [html, target]);

  const onClick = (e: React.MouseEvent) => {
    const line = (e.target as HTMLElement).closest<HTMLElement>(".line");
    if (!line) return;
    const gutter = parseFloat(getComputedStyle(line, "::before").width || "0") || 40;
    const x = e.clientX - line.getBoundingClientRect().left;
    if (x <= gutter + 4) {
      const n = line.dataset.line;
      if (n) setHash(`L${n}`, true);
    }
  };

  return (
    <div
      ref={ref}
      onClick={onClick}
      className={cn(
        "code-block code-lines overflow-x-auto font-mono text-[13px]",
        wrap && "[&_.line]:whitespace-pre-wrap [&_.line]:break-all",
      )}
      style={{ ["--gutter" as string]: `${String(lineCount).length + 1}ch` }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function CodeViewer({ file, reloadKey }: ViewerProps) {
  const tooBig = file.size > HIGHLIGHT_MAX_BYTES;
  const { data, error, loading } = useAsync(
    tooBig ? "" : file.path,
    reloadKey,
    (signal) => (tooBig ? Promise.resolve(null) : api.content(file.path, signal)),
  );
  if (tooBig) return <TextViewer file={file} reloadKey={reloadKey} />;
  if (error && error instanceof ApiError && error.status === 413)
    return <TextViewer file={file} reloadKey={reloadKey} />;
  if (data) return <CodeLines code={data.text} lang={langForFile(file.name, file.ext)} />;
  if (error) return <ViewerError message={errorMessage(error)} file={file} />;
  return loading ? <ViewerLoading /> : null;
}
