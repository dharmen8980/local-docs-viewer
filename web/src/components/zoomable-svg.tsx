"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileCodeIcon,
  ImageDownIcon,
  MaximizeIcon,
  ShrinkIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanZoom, type PanZoom, type View } from "@/hooks/use-pan-zoom";
import { useRoute } from "@/hooks/use-route";
import { basename } from "@/lib/paths";

/** Natural size of an SVG from its markup (viewBox, else width/height), or null. */
export function svgNaturalSize(svg: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return null;
  const vb = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(tag);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { width: p[2], height: p[3] };
  }
  const w = /\swidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag);
  const h = /\sheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag);
  return w && h && +w[1] > 0 && +h[1] > 0 ? { width: +w[1], height: +h[1] } : null;
}

// ---------- controls ----------

function ToolButton({
  label,
  keys,
  size = "icon-xs",
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; keys?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size={size} aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keys ? <span className="opacity-60">{keys}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function ZoomControls({ pz, large = false, shortcuts = false }: { pz: PanZoom; large?: boolean; shortcuts?: boolean }) {
  const s = pz.view?.s ?? 1;
  const size = large ? "icon-sm" : "icon-xs";
  return (
    <>
      <ToolButton label="Zoom out" keys={shortcuts ? "-" : undefined} size={size} onClick={pz.zoomOut} disabled={!pz.view || s <= pz.minScale + 1e-6}>
        <ZoomOutIcon />
      </ToolButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size={large ? "sm" : "xs"}
            className="min-w-12 px-1 font-mono tabular-nums"
            aria-label={`Zoom ${Math.round(s * 100)}%, reset to 100%`}
            onClick={() => pz.zoomTo(1)}
            disabled={!pz.view}
          >
            {Math.round(s * 100)}%
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reset to 100%</TooltipContent>
      </Tooltip>
      <ToolButton label="Zoom in" keys={shortcuts ? "+" : undefined} size={size} onClick={pz.zoomIn} disabled={!pz.view || s >= pz.maxScale - 1e-6}>
        <ZoomInIcon />
      </ToolButton>
      <ToolButton label="Fit to view" keys={shortcuts ? "0" : undefined} size={size} onClick={pz.reset} disabled={!pz.view || pz.fitted}>
        <ShrinkIcon />
      </ToolButton>
    </>
  );
}

function ZoomContent({ svg, width, height, view, animate }: { svg: string; width: number; height: number; view: View | null; animate: boolean }) {
  return (
    <div
      className="mermaid-zoom-content"
      style={
        {
          "--zw": `${width}px`,
          "--zh": `${height}px`,
          transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.s})` : undefined,
          visibility: view ? undefined : "hidden",
          transition: animate ? "transform 160ms ease-out" : undefined,
        } as CSSProperties
      }
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * An SVG shown in a fixed box with zoom and pan. Inline the box has the size the plain SVG
 * had (width up to the column, aspect ratio kept), so the page does not move; the "file"
 * variant is 60vh to 80vh tall. Render inside a `relative group` parent: the toolbar is
 * positioned at its top-right. Key it on the SVG so new content starts fitted.
 */
export function ZoomableSvg({
  svg,
  width,
  height,
  variant = "inline",
  className,
  toolbarExtra,
  onOpenFullscreen,
}: {
  svg: string;
  width: number;
  height: number;
  variant?: "inline" | "file";
  className?: string;
  toolbarExtra?: ReactNode;
  /** called with the button, which gets the focus back when the preview closes */
  onOpenFullscreen?: (opener: HTMLElement) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(layerRef, { width, height, padding: 16, maxFit: variant === "file" ? 1.5 : 1, wheel: "modifier" });
  return (
    <>
      <div
        role="toolbar"
        aria-label="Diagram controls"
        className={cn(
          "no-print absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-md border bg-background/90 p-0.5 opacity-0 shadow-xs backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
          !pz.fitted && "opacity-100",
        )}
      >
        <ZoomControls pz={pz} />
        {onOpenFullscreen ? (
          <ToolButton label="Open full screen" onClick={(e) => onOpenFullscreen(e.currentTarget)}>
            <MaximizeIcon />
          </ToolButton>
        ) : null}
        {toolbarExtra}
      </div>
      <div className={cn("mermaid-zoom relative overflow-hidden rounded-lg border bg-card p-4", variant === "file" && "min-h-[60vh] max-h-[80vh]", className)}>
        <div className="mermaid-zoom-sizer" style={{ maxWidth: width, aspectRatio: `${width} / ${height}` }} />
        <div
          ref={layerRef}
          className={cn("mermaid-zoom-layer", pz.canPan && (pz.dragging ? "cursor-grabbing" : "cursor-grab"))}
          style={{ touchAction: pz.canPan ? "none" : undefined }}
          {...pz.handlers}
        >
          <ZoomContent svg={svg} width={width} height={height} view={pz.view} animate={pz.animate && !pz.dragging} />
        </div>
      </div>
    </>
  );
}

// ---------- the diagrams of a page, for the full-screen preview's previous/next ----------

export interface PreviewItem {
  id: string;
  /** element in the page (document order and scope) */
  el: HTMLElement;
  svg: string;
  /** the mermaid source `svg` was rendered from */
  source: string;
  width: number;
  height: number;
  title: string;
  dark: boolean;
}

const previews = new Map<string, PreviewItem>();
const previewListeners = new Set<() => void>();
let previewVersion = 0;

function bumpPreviews() {
  previewVersion++;
  for (const l of previewListeners) l();
}

export function registerPreview(item: PreviewItem): () => void {
  previews.set(item.id, item);
  bumpPreviews();
  return () => {
    if (previews.get(item.id) !== item) return;
    previews.delete(item.id);
    bumpPreviews();
  };
}

function subscribePreviews(cb: () => void) {
  previewListeners.add(cb);
  return () => {
    previewListeners.delete(cb);
  };
}

const getPreviewVersion = () => previewVersion;

/** Registered previews in the same view as `id`, in document order. */
function previewSiblings(id: string): PreviewItem[] {
  const start = previews.get(id);
  if (!start) return [];
  const scope = start.el.closest(".print-area") ?? document.body;
  return Array.from(previews.values())
    .filter((p) => p.el.isConnected && scope.contains(p.el))
    .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// ---------- export ----------

const EXPORT_BG = { light: "#ffffff", dark: "#171717" };

/**
 * Background a diagram asks for in its `%%{init}%%` directive or front-matter config:
 * `themeVariables.background`, else light for any theme other than "dark". Null: none set.
 */
export function diagramBackground(source: string): string | null {
  const fm = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---/.exec(source)?.[1] ?? "";
  const directives = Array.from(source.matchAll(/%%\{\s*init(?:ialize)?\s*:([\s\S]*?)\}%%/g), (m) => m[1]).join("\n");
  const config = `${fm}\n${directives}`;
  const bg = /["']?\bbackground["']?\s*:\s*(["'])([^"'\n]+)\1/.exec(config)?.[2] ?? /["']?\bbackground["']?\s*:\s*([a-z]+)\s*$/im.exec(config)?.[1];
  if (bg && CSS.supports("color", bg.trim())) return bg.trim();
  const theme = /["']?\btheme["']?\s*:\s*["']?([a-z]+)/i.exec(config)?.[1];
  if (!theme) return null;
  return theme.toLowerCase() === "dark" ? EXPORT_BG.dark : EXPORT_BG.light;
}

/**
 * A standalone SVG document: explicit size, a background (the diagram's own: an inline one,
 * else `ownBg` from its `%%{init}%%` / front-matter config, else `fallbackBg`), XML serialisation.
 */
function standaloneSvg(
  svg: string,
  width: number,
  height: number,
  ownBg: string | null,
  fallbackBg: string,
): { xml: string; background: string } {
  // mermaid output is HTML-serialised (e.g. <br> in labels): parse as HTML, write XML.
  const tpl = document.createElement("template");
  tpl.innerHTML = svg;
  const root = tpl.content.querySelector("svg");
  if (!root) return { xml: svg, background: ownBg ?? fallbackBg };
  const background = root.style.backgroundColor || ownBg || fallbackBg;
  root.setAttribute("width", String(Math.ceil(width)));
  root.setAttribute("height", String(Math.ceil(height)));
  root.style.removeProperty("max-width");
  root.style.backgroundColor = background;
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}`, background };
}

/** Rasterise an SVG document via canvas. Null when the canvas is tainted or the browser refuses. */
async function svgToPng(xml: string, width: number, height: number, scale: number, background: string): Promise<Blob | null> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null; // SecurityError: tainted canvas
  }
}

/** Up to 2x, within canvas limits (16384 px a side, ~120 Mpx). */
function pngScale(width: number, height: number): number {
  return Math.max(0.05, Math.min(2, 16384 / width, 16384 / height, Math.sqrt(1.2e8 / (width * height))));
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- full-screen preview ----------

/** Full-screen preview of a registered diagram, with previous/next through the page's diagrams. */
export function DiagramPreviewDialog({
  open,
  onOpenChange,
  startId,
  returnFocus,
  owner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  startId: string;
  /** There is no DialogTrigger: the element that gets the focus back on close. */
  returnFocus?: React.RefObject<HTMLElement | null>;
  /** The opener's container: when the opener was re-rendered away, its new "Open full screen" button gets the focus. */
  owner?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[92vh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-zoom-stage]")?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          let el = returnFocus?.current;
          if (!el?.isConnected) el = owner?.current?.querySelector<HTMLElement>('[aria-label="Open full screen"]') ?? owner?.current;
          if (el?.isConnected) el.focus({ preventScroll: true });
        }}
      >
        <PreviewBody startId={startId} />
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ startId }: { startId: string }) {
  useSyncExternalStore(subscribePreviews, getPreviewVersion, getPreviewVersion);
  // The diagram on show, by id and by source. A live reload can hand a component another
  // diagram (diagrams above added/removed): the source then finds the one the user was viewing.
  const [cur, setCur] = useState<{ id: string; source: string | null; index: number }>({ id: startId, source: null, index: 0 });
  const all = previewSiblings(startId);
  const byId = all.findIndex((p) => p.id === cur.id);
  let idx = byId;
  if (cur.source !== null && (byId < 0 || all[byId].source !== cur.source)) {
    let best = -1;
    all.forEach((p, i) => {
      if (p.source === cur.source && (best < 0 || Math.abs(i - cur.index) < Math.abs(best - cur.index))) best = i;
    });
    if (best >= 0) idx = best;
  }
  if (idx < 0) idx = Math.min(cur.index, all.length - 1);
  const item = all[idx];
  if (item && (item.id !== cur.id || item.source !== cur.source || idx !== cur.index)) {
    setCur({ id: item.id, source: item.source, index: idx }); // derived state: React re-renders right away
  }
  if (!item) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-muted-foreground">
        <DialogTitle>Diagram</DialogTitle>
        <DialogDescription>This diagram is no longer available.</DialogDescription>
      </div>
    );
  }
  const step =
    all.length > 1
      ? (d: number) => {
          const i = (idx + d + all.length) % all.length;
          setCur({ id: all[i].id, source: all[i].source, index: i });
        }
      : undefined;
  return <PreviewPane key={`${item.id}:${item.svg}`} item={item} index={idx} count={all.length} onStep={step} />;
}

function PreviewPane({
  item,
  index,
  count,
  onStep,
}: {
  item: PreviewItem;
  index: number;
  count: number;
  onStep?: (delta: number) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(stageRef, { width: item.width, height: item.height, padding: 24, maxFit: 2, wheel: "always", panAtFit: true });
  const { path } = useRoute();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // The inline copy stays in the page: give this copy's ids (styles, markers) their own names.
  const svg = useMemo(() => {
    const id = /<svg\b[^>]*?\sid="([^"]+)"/.exec(item.svg)?.[1];
    return id ? item.svg.split(id).join(`${id}-pv${uid}`) : item.svg;
  }, [item.svg, uid]);
  const { xml, background } = useMemo(
    () => standaloneSvg(item.svg, item.width, item.height, diagramBackground(item.source), item.dark ? EXPORT_BG.dark : EXPORT_BG.light),
    [item],
  );
  const [pngOk, setPngOk] = useState<boolean | null>(null);

  useEffect(() => {
    // A tiny test render tells whether the canvas would be tainted (e.g. by foreignObject labels).
    let cancelled = false;
    svgToPng(xml, item.width, item.height, Math.min(1, 64 / Math.max(item.width, item.height)), background)
      .then((b) => !cancelled && setPngOk(!!b))
      .catch(() => !cancelled && setPngOk(false));
    return () => {
      cancelled = true;
    };
  }, [xml, item.width, item.height, background]);

  useEffect(() => {
    // previous/next remounts this pane: keep the keyboard focus on the stage
    const stage = stageRef.current;
    if (stage && !stage.contains(document.activeElement)) stage.focus({ preventScroll: true });
  }, []);

  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path);
  const base = (basename(path) || "diagram").replace(/\.[^.]+$/, "");
  const fileBase = isMarkdown ? `${base}-diagram-${index + 1}` : base;
  const counter = count > 1 ? `Diagram ${index + 1} of ${count}` : "";
  const title = item.title || counter || (path ? basename(path) : "Diagram");

  const downloadSvg = () => saveBlob(new Blob([xml], { type: "image/svg+xml" }), `${fileBase}.svg`);
  const downloadPng = async () => {
    const blob = await svgToPng(xml, item.width, item.height, pngScale(item.width, item.height), background).catch(() => null);
    if (blob) saveBlob(blob, `${fileBase}.png`);
    else {
      setPngOk(false);
      toast.error("Could not create a PNG of this diagram");
    }
  };
  const copySvg = async () => {
    try {
      await navigator.clipboard.writeText(xml);
      toast.success("SVG copied to the clipboard");
    } catch (e) {
      toast.error("Could not copy the SVG", { description: (e as Error).message || String(e) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pan = e.shiftKey ? 240 : 60;
    switch (e.key) {
      case "+":
      case "=":
        pz.zoomIn();
        break;
      case "-":
      case "_":
        pz.zoomOut();
        break;
      case "0":
        pz.reset();
        break;
      case "ArrowLeft":
        pz.panBy(pan, 0);
        break;
      case "ArrowRight":
        pz.panBy(-pan, 0);
        break;
      case "ArrowUp":
        pz.panBy(0, pan);
        break;
      case "ArrowDown":
        pz.panBy(0, -pan);
        break;
      case "PageUp":
        if (!onStep) return;
        onStep(-1);
        break;
      case "PageDown":
        if (!onStep) return;
        onStep(1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2 pr-2">
          <DialogTitle className="truncate">{title}</DialogTitle>
          {item.title && counter ? <span className="shrink-0 text-xs text-muted-foreground">{counter}</span> : null}
        </div>
        <div role="toolbar" aria-label="Diagram controls" className="flex flex-wrap items-center gap-0.5">
          {onStep ? (
            <>
              <ToolButton label="Previous diagram" keys="PgUp" size="icon-sm" onClick={() => onStep(-1)}>
                <ChevronLeftIcon />
              </ToolButton>
              <ToolButton label="Next diagram" keys="PgDn" size="icon-sm" onClick={() => onStep(1)}>
                <ChevronRightIcon />
              </ToolButton>
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            </>
          ) : null}
          <ZoomControls pz={pz} large shortcuts />
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <ToolButton label="Copy SVG" size="icon-sm" onClick={copySvg}>
            <CopyIcon />
          </ToolButton>
          <ToolButton label="Download SVG" size="icon-sm" onClick={downloadSvg}>
            <FileCodeIcon />
          </ToolButton>
          {pngOk ? (
            <ToolButton label="Download PNG" size="icon-sm" onClick={downloadPng}>
              <ImageDownIcon />
            </ToolButton>
          ) : null}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <DialogClose asChild>
            <ToolButton label="Close" keys="Esc" size="icon-sm">
              <XIcon />
            </ToolButton>
          </DialogClose>
        </div>
      </div>
      <div
        ref={stageRef}
        data-zoom-stage=""
        tabIndex={0}
        role="group"
        aria-roledescription="zoomable diagram"
        aria-label={title}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          pz.dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{ touchAction: "none" }}
        {...pz.handlers}
      >
        <ZoomContent svg={svg} width={item.width} height={item.height} view={pz.view} animate={pz.animate && !pz.dragging} />
      </div>
      <DialogDescription className="border-t px-3 py-1.5 text-xs">
        Scroll or pinch to zoom, drag or use the arrow keys to pan, + / - to zoom, 0 to fit, Esc to close.
      </DialogDescription>
    </div>
  );
}
