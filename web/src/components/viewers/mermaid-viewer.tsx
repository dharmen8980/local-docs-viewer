"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { AlertTriangleIcon, CodeIcon, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DiagramPreviewDialog, registerPreview, svgNaturalSize, ZoomableSvg } from "@/components/zoomable-svg";
import { useHighlight } from "@/hooks/use-highlight";
import { useRoute } from "@/hooks/use-route";
import { api, errorMessage } from "@/lib/api";
import { CodeLines } from "./code-viewer";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let counter = 0;
// mermaid keeps global state (config, a scratch element per render), so renders are serialised.
let queue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
    mermaidPromise.catch(() => {
      mermaidPromise = null;
    });
  }
  return mermaidPromise;
}

// Placeholder used instead of external images (the app never loads remote resources).
const BLOCKED_IMG =
  "data:image/svg+xml;base64," +
  (typeof btoa === "function"
    ? btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">' +
          '<rect x="2" y="2" width="52" height="52" rx="8" fill="#e5e7eb" stroke="#9ca3af" stroke-width="2" stroke-dasharray="4 3"/>' +
          '<path d="M18 18 L38 38 M38 18 L18 38" stroke="#9ca3af" stroke-width="3" stroke-linecap="round"/></svg>',
      )
    : "");

const EXTERNAL = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function isExternal(url: string): boolean {
  const u = url.trim();
  if (/^(data|blob):/i.test(u)) return false;
  return EXTERNAL.test(u) || /^[a-z][a-z0-9+.-]*:/i.test(u);
}

/**
 * Replace external image references in mermaid source before rendering:
 * `node@{ img: "https://..." }` and `<img src="https://...">` in labels.
 * Returns the rewritten source and the list of blocked URLs.
 */
export function stripExternalImages(source: string): { source: string; blocked: string[] } {
  const blocked: string[] = [];
  let out = source.replace(
    /(\bimg\s*:\s*)(["'])([^"'\n]*)\2/g,
    (m, pre: string, q: string, url: string) => {
      if (!isExternal(url)) return m;
      blocked.push(url);
      return `${pre}${q}${BLOCKED_IMG}${q}`;
    },
  );
  out = out.replace(/(\bimg\s*:\s*)(https?:\/\/[^\s,}]+)/gi, (_m, pre: string, url: string) => {
    blocked.push(url);
    return `${pre}"${BLOCKED_IMG}"`;
  });
  out = out.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi, (m, pre: string, q: string, url: string) => {
    if (!isExternal(url)) return m;
    blocked.push(url);
    return `${pre}${q}${BLOCKED_IMG}${q}`;
  });
  return { source: out, blocked };
}

/** Last line of defence: neutralise any remote image/resource left in the rendered SVG. */
function scrubSvg(svg: string, blocked: string[]): string {
  if (typeof DOMParser === "undefined") return svg;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) return svg;
  let changed = false;
  doc.querySelectorAll("image, img, use, feImage").forEach((el) => {
    for (const attr of ["href", "xlink:href", "src"]) {
      const v = el.getAttribute(attr);
      if (v && isExternal(v)) {
        blocked.push(v);
        el.setAttribute(attr, BLOCKED_IMG);
        changed = true;
      }
    }
  });
  return changed ? new XMLSerializer().serializeToString(doc.documentElement) : svg;
}

type Rendered = { svg: string; blocked: string[] };

function renderMermaid(raw: string, dark: boolean): Promise<Rendered> {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
    });
    const { source, blocked } = stripExternalImages(raw);
    const id = `mermaid-${Date.now().toString(36)}-${counter++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return { svg: scrubSvg(svg, blocked), blocked };
    } catch (e) {
      const msg = errorMessage(e) || "Unknown mermaid error";
      if (blocked.length || /cannot be decoded|image/i.test(msg)) {
        throw new Error(
          `${msg}${blocked.length ? `\n(external images were blocked: ${Array.from(new Set(blocked)).join(", ")})` : "\n(an external image may have been blocked)"}`,
        );
      }
      throw e;
    } finally {
      // On failure mermaid can leave its scratch container behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

type Result = { key: string; source: string; svg?: string; printSvg?: string; blocked?: string[]; error?: string };

const unquote = (t: string) => t.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** Title of a diagram: front-matter `title:`, `accTitle:`, or a `title ...` line (gantt, pie, ...). */
export function diagramTitle(source: string): string {
  const fm = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---/.exec(source);
  const fmTitle = fm ? /^\s*title\s*:\s*(.+?)\s*$/m.exec(fm[1]) : null;
  if (fmTitle) return unquote(fmTitle[1]);
  const body = fm ? source.slice(fm[0].length) : source;
  const m = /^\s*accTitle\s*:\s*(.+?)\s*$/m.exec(body) ?? /^\s*(?:pie\s+)?title\s+(.+?)\s*$/m.exec(body);
  return m ? unquote(m[1]) : "";
}

export function MermaidDiagram({
  source,
  theme,
  print = false,
  variant = "inline",
}: {
  source: string;
  theme?: "light" | "dark";
  /** the PDF print page: plain static SVG, no zoom controls */
  print?: boolean;
  /** "file": a standalone .mmd file, shown in a larger box */
  variant?: "inline" | "file";
}) {
  const { resolvedTheme: systemTheme } = useTheme();
  // `theme` forces a theme (the PDF print page is always light).
  const resolvedTheme = theme ?? systemTheme;
  const dark = resolvedTheme === "dark";
  const [result, setResult] = useState<Result | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const figureRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const previewId = useId();
  const key = `${dark ? "d" : "l"}:${source}`;

  useEffect(() => {
    if (resolvedTheme === undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const main = await renderMermaid(source, dark);
        if (cancelled) return;
        setResult({ key, source, svg: main.svg, blocked: main.blocked });
        if (dark) {
          // Printing always uses light colours: keep a light-theme copy for @media print.
          const light = await renderMermaid(source, false).catch(() => null);
          if (!cancelled && light) setResult({ key, source, svg: main.svg, printSvg: light.svg, blocked: main.blocked });
        }
      } catch (e) {
        if (!cancelled) setResult({ key, source, error: errorMessage(e) || "Unknown mermaid error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, dark, key, resolvedTheme]);

  // The previous result stays visible while a re-render (e.g. theme change) is in flight.
  const current = result;
  const blocked = Array.from(new Set(current?.blocked ?? []));
  const svg = current?.svg;
  const svgDark = !!current?.key.startsWith("d:");
  const svgSource = current?.source ?? source;
  const size = useMemo(() => (svg && !print ? svgNaturalSize(svg) : null), [svg, print]);
  const title = useMemo(() => diagramTitle(svgSource), [svgSource]);

  // Make the diagram reachable from the full-screen preview (previous/next).
  useEffect(() => {
    const el = figureRef.current;
    if (!el || !svg || !size) return;
    return registerPreview({ id: previewId, el, svg, source: svgSource, width: size.width, height: size.height, title, dark: svgDark });
  }, [previewId, svg, svgSource, size, title, svgDark]);

  if (current?.error) {
    return (
      <div data-pdf-state="error" className="mermaid-error my-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm not-prose">
        <div className="mb-2 flex items-center gap-2 font-medium text-destructive">
          <AlertTriangleIcon className="size-4" /> Mermaid diagram failed to render
        </div>
        <pre className="mb-2 whitespace-pre-wrap break-words text-xs text-destructive/90">{current.error}</pre>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{source}</pre>
      </div>
    );
  }

  const sourceToggle = (
    <Button size="xs" variant={size ? "ghost" : "outline"} onClick={() => setShowSource((s) => !s)}>
      {showSource ? <ImageIcon /> : <CodeIcon />} {showSource ? "Diagram" : "Source"}
    </Button>
  );
  const zoomable = !!(size && svg && !showSource);

  return (
    <figure
      ref={figureRef}
      className="mermaid-figure group relative my-4 min-h-48 not-prose"
      data-pdf-pending={current?.svg && current.key === key ? undefined : "mermaid"}
    >
      {zoomable ? null : (
        <div className="no-print absolute right-1 top-1 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {sourceToggle}
        </div>
      )}
      {showSource ? (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{source}</pre>
      ) : current?.svg ? (
        <>
          {zoomable && size ? (
            <ZoomableSvg
              key={current.svg}
              svg={current.svg}
              width={size.width}
              height={size.height}
              variant={variant}
              className={`mermaid-diagram${current.printSvg ? " mermaid-screen" : ""}`}
              toolbarExtra={sourceToggle}
              onOpenFullscreen={(opener) => {
                openerRef.current = opener;
                setFullscreen(true);
              }}
            />
          ) : (
            <div
              className={`mermaid-diagram overflow-x-auto rounded-lg border bg-card p-4${current.printSvg ? " mermaid-screen" : ""}`}
              dangerouslySetInnerHTML={{ __html: current.svg }}
            />
          )}
          {current.printSvg && (
            <div
              className="mermaid-diagram mermaid-print overflow-x-auto rounded-lg border bg-card p-4"
              dangerouslySetInnerHTML={{ __html: current.printSvg }}
            />
          )}
          {blocked.length > 0 && (
            <figcaption className="no-print mt-1 text-xs text-muted-foreground" title={blocked.join("\n")}>
              {blocked.length} external image{blocked.length === 1 ? "" : "s"} blocked (shown as placeholders)
            </figcaption>
          )}
        </>
      ) : (
        <Skeleton className="h-48 w-full" />
      )}
      {size && !print ? <DiagramPreviewDialog open={fullscreen} onOpenChange={setFullscreen} startId={previewId} returnFocus={openerRef} owner={figureRef} /> : null}
    </figure>
  );
}

export function MermaidViewer({ file, reloadKey }: ViewerProps) {
  const { data, error, loading } = useAsync(file.path, reloadKey, (signal) => api.content(file.path, signal));
  const [tab, setTab] = useState<"diagram" | "source">("diagram");
  const { hl, hll } = useRoute();
  const hlRef = useRef<HTMLDivElement>(null);
  useHighlight(hlRef, hl, `${tab}:${data?.text ?? ""}`, hll);
  if (!data) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return loading ? <ViewerLoading /> : null;
  }
  return (
    <div className="print-area p-4 md:p-6">
      <div className="no-print mb-3 flex gap-1">
        <Button size="sm" variant={tab === "diagram" ? "secondary" : "ghost"} onClick={() => setTab("diagram")}>
          <ImageIcon /> Diagram
        </Button>
        <Button size="sm" variant={tab === "source" ? "secondary" : "ghost"} onClick={() => setTab("source")}>
          <CodeIcon /> Source
        </Button>
      </div>
      {tab === "diagram" ? (
        <div ref={hlRef}>
          <MermaidDiagram source={data.text} variant="file" />
        </div>
      ) : (
        <div ref={hlRef} className="rounded-lg border">
          <CodeLines code={data.text} lang={null} />
        </div>
      )}
    </div>
  );
}
