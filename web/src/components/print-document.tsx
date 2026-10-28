"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, errorMessage, formatTime, type AppConfig, type ContentResponse, type FileInfo } from "@/lib/api";
import { basename } from "@/lib/paths";
import type { TocHeading } from "@/components/toc";
import { ARTICLE_CLASS, MarkdownMarkup, markdownComponents } from "@/components/viewers/markdown-viewer";
import { MermaidDiagram } from "@/components/viewers/mermaid-viewer";

declare global {
  interface Window {
    __PDF_READY__?: boolean;
    __PDF_ERRORS__?: { mermaid: number; images: number; blocked_images: number; fatal?: string };
    __PDF_TITLE__?: string;
    __PDF_ORIENTATION__?: "portrait" | "landscape";
  }
}

// Page geometry in mm. The margins match MARGINS in server/viewer/pdf.py.
const PAPER: Record<string, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };
const MARGIN = { top: 18, bottom: 16, left: 16, right: 16 };

const MM = 96 / 25.4; // CSS px per mm
// Space taken by a figure's own padding, border and margins (see --pdf-figure-max-h).
const FIGURE_CHROME_MM = 24;

const isHeading = (el: Element | null): boolean => !!el && /^H[1-6]$/.test(el.tagName);

/** Block-level figures of the article: a paragraph holding only images, or a diagram. */
function isFigureBlock(el: Element): boolean {
  if (el.matches(".mermaid-figure")) return true;
  if (el.tagName === "IMG") return true;
  return el.tagName === "P" && !!el.querySelector("img") && !(el.textContent ?? "").trim();
}

/**
 * Figures are capped at about the printable height, so a heading (or a heading and a short
 * lead-in line) right before a tall figure cannot share its page; Chrome then keeps the
 * figure whole and leaves the heading alone on a page. Shrink such figures by the height of
 * that lead so heading and figure fit on one page together.
 */
function fitFiguresAfterHeadings(article: HTMLElement, contentHmm: number) {
  for (const child of Array.from(article.children)) {
    if (!(child instanceof HTMLElement) || !isFigureBlock(child)) continue;
    child.style.removeProperty("--pdf-figure-max-h");
    let lead: HTMLElement | null = null;
    let prev = child.previousElementSibling;
    if (prev instanceof HTMLElement && !isHeading(prev) && prev.tagName === "P" &&
        prev.getBoundingClientRect().height < 20 * MM && isHeading(prev.previousElementSibling)) {
      lead = prev;
      prev = prev.previousElementSibling;
      lead.style.breakAfter = "avoid"; // the lead-in line travels with its figure
    }
    while (isHeading(prev)) {
      lead = prev as HTMLElement;
      prev = lead.previousElementSibling;
    }
    if (!lead) continue;
    const leadMm = (child.getBoundingClientRect().top - lead.getBoundingClientRect().top) / MM;
    if (leadMm <= 0 || leadMm > contentHmm / 3) continue;
    const maxMm = Math.floor(contentHmm - leadMm - FIGURE_CHROME_MM - 3);
    child.style.setProperty("--pdf-figure-max-h", `${maxMm}mm`);
  }
}

/** Natural size of a rendered mermaid SVG (viewBox), or null. */
function svgSize(svg: SVGSVGElement | null): [number, number] | null {
  if (!svg) return null;
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return [vb.width, vb.height];
  const r = svg.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? [r.width, r.height] : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** Plain text of the first ATX h1 outside code fences, and whether it is the first block. */
function firstHeading(md: string): { text: string; first: boolean } | null {
  let fence: string | null = null;
  let seenBlock = false;
  for (const line of md.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      seenBlock = true;
      continue;
    }
    if (fence) continue;
    const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const text = m[1]
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_~]/g, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      return text ? { text, first: !seenBlock } : null;
    }
    if (line.trim()) seenBlock = true;
  }
  return null;
}

interface Loaded {
  config: AppConfig;
  file: FileInfo;
  content: ContentResponse;
}

export function PrintDocument() {
  const sp = useSearchParams();
  const path = sp.get("p") ?? "";
  const paperKey = sp.get("paper") === "letter" ? "letter" : "a4";
  const orientationParam = sp.get("orientation");
  const autoOrientation = orientationParam === "auto";
  // orientation=auto: portrait, except a standalone diagram that prints larger in landscape
  const [autoLandscape, setAutoLandscape] = useState<boolean | null>(null);
  const landscape = orientationParam === "landscape" || (autoOrientation && autoLandscape === true);
  const withToc = sp.get("toc") === "1" || sp.get("toc") === "true";

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [headings, setHeadings] = useState<TocHeading[] | null>(null);
  const docRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!path) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFatal("no document path given");
      return;
    }
    const ctrl = new AbortController();
    Promise.all([api.config(ctrl.signal), api.file(path, ctrl.signal), api.content(path, ctrl.signal)])
      .then(([config, file, content]) => setLoaded({ config, file, content }))
      .catch((e) => {
        if (!ctrl.signal.aborted) setFatal(errorMessage(e) || "could not load the document");
      });
    return () => ctrl.abort();
  }, [path]);

  const isMermaid = loaded?.file.kind === "mermaid";
  const heading = useMemo(
    () => (loaded && !isMermaid ? firstHeading(loaded.content.text) : null),
    [loaded, isMermaid],
  );
  const title = heading?.text || (loaded ? loaded.file.name : basename(path));
  const components = useMemo(() => markdownComponents(loaded?.file.path ?? path, { print: true }), [loaded, path]);

  // Page box: @page size/margins and the printable height used to scale figures.
  const [pw, ph] = PAPER[paperKey];
  const [pageW, pageH] = landscape ? [ph, pw] : [pw, ph];
  const contentW = pageW - MARGIN.left - MARGIN.right;
  const contentH = pageH - MARGIN.top - MARGIN.bottom;
  const pageCss =
    `@page { size: ${paperKey === "a4" ? "A4" : "letter"} ${landscape ? "landscape" : "portrait"}; ` +
    `margin: ${MARGIN.top}mm ${MARGIN.right}mm ${MARGIN.bottom}mm ${MARGIN.left}mm; }\n` +
    `:root { --pdf-content-w: ${contentW}mm; --pdf-content-h: ${contentH}mm; }`;

  useEffect(() => {
    document.title = title;
    window.__PDF_TITLE__ = title;
  }, [title]);

  // Collect headings for the table of contents (ids come from rehype-slug).
  useLayoutEffect(() => {
    if (!loaded) return;
    // A standalone diagram shares page 1 with the cover: size it to the space left.
    const cover = docRef.current?.querySelector<HTMLElement>(".pdf-cover");
    if (cover) {
      const mb = parseFloat(getComputedStyle(cover).marginBottom) || 0;
      docRef.current?.style.setProperty("--pdf-cover-h", `${Math.ceil(cover.getBoundingClientRect().height + mb)}px`);
    }
    const root = docRef.current?.querySelector("article");
    const hs = Array.from(root?.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id]") ?? []).map((el) => ({
      id: el.id,
      text: (el.textContent ?? "").trim(),
      level: Number(el.tagName.slice(1)),
    }));
    setHeadings(hs);
  }, [loaded, landscape]);

  // Readiness signal for the PDF exporter.
  useEffect(() => {
    if (fatal) {
      window.__PDF_ERRORS__ = { mermaid: 0, images: 0, blocked_images: 0, fatal };
      window.__PDF_READY__ = true;
      return;
    }
    if (!loaded || headings === null) return;
    let cancelled = false;
    (async () => {
      const root = docRef.current;
      if (!root) return;
      // Diagrams and highlighted code mark themselves data-pdf-pending until done.
      for (;;) {
        if (cancelled) return;
        const pending = root.querySelectorAll("[data-pdf-pending]").length;
        const loadingImgs = Array.from(root.querySelectorAll("img")).filter((i) => !i.complete).length;
        if (!pending && !loadingImgs) break;
        await sleep(100);
      }
      await document.fonts.ready;
      // orientation=auto for a standalone diagram: pick the orientation that prints it larger.
      if (autoOrientation && autoLandscape === null) {
        let pick = false;
        const size = isMermaid ? svgSize(root.querySelector<SVGSVGElement>(".pdf-mermaid-file .mermaid-diagram svg")) : null;
        if (size) {
          const cover = root.querySelector<HTMLElement>(".pdf-cover");
          const coverMm = cover ? (cover.getBoundingClientRect().height + 16) / MM : 25;
          const [w, h] = size;
          const fit = (cw: number, ch: number) => Math.min(cw / w, Math.max(ch - coverMm, 10) / h);
          const [aw, ah] = PAPER[paperKey];
          const portrait = fit(aw - MARGIN.left - MARGIN.right, ah - MARGIN.top - MARGIN.bottom);
          const land = fit(ah - MARGIN.left - MARGIN.right, aw - MARGIN.top - MARGIN.bottom);
          pick = land > portrait * 1.15;
        }
        if (cancelled) return;
        setAutoLandscape(pick); // re-runs this effect with the final page size
        return;
      }
      await Promise.all(Array.from(root.querySelectorAll("img")).map((i) => i.decode().catch(() => undefined)));
      // Let failed images swap to their placeholders and layout settle.
      await frame();
      await frame();
      await sleep(50);
      if (cancelled) return;
      const article = root.querySelector<HTMLElement>("article");
      if (article) {
        fitFiguresAfterHeadings(article, contentH);
        await frame();
        await frame();
      }
      if (cancelled) return;
      window.__PDF_ORIENTATION__ = landscape ? "landscape" : "portrait";
      const brokenImgs = Array.from(root.querySelectorAll("img")).filter((i) => i.complete && i.naturalWidth === 0);
      window.__PDF_ERRORS__ = {
        mermaid: root.querySelectorAll(".mermaid-error").length,
        images: root.querySelectorAll(".md-image-missing").length + brokenImgs.length,
        blocked_images: root.querySelectorAll(".md-image-blocked").length,
      };
      window.__PDF_READY__ = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, headings, fatal, autoOrientation, autoLandscape, isMermaid, paperKey, landscape, contentH]);

  const tocItems = (headings ?? []).filter((h) => !(heading?.first && h.level === 1 && h === headings?.[0]));
  const tocMin = Math.min(...tocItems.map((h) => h.level));

  return (
    <div ref={docRef} className="pdf-doc">
      <style>{pageCss}</style>
      {fatal ? (
        <div className="pdf-fatal">
          <h1>Could not export {path || "document"}</h1>
          <p>{fatal}</p>
        </div>
      ) : !loaded ? null : (
        <>
          <header className={`pdf-cover${isMermaid ? " pdf-cover-compact" : ""}`}>
            <h1 className="pdf-title">{title}</h1>
            <dl>
              <div>
                <dt>Path</dt>
                <dd>
                  <code>{`${loaded.config.repo_prefix}${loaded.file.path}`}</code>
                </dd>
              </div>
              <div>
                <dt>Modified</dt>
                <dd>{formatTime(loaded.file.mtime)}</dd>
              </div>
            </dl>
          </header>
          {withToc && tocItems.length > 0 ? (
            <nav className="pdf-toc" aria-label="Table of contents">
              <h2>Contents</h2>
              <ol>
                {tocItems.map((h) => (
                  <li key={h.id} className={`pdf-toc-l${Math.min(h.level - tocMin, 2)}`}>
                    <a href={`#${encodeURIComponent(h.id)}`}>{h.text}</a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          {isMermaid ? (
            <div className="pdf-mermaid-file">
              <MermaidDiagram source={loaded.content.text} theme="light" print />
            </div>
          ) : (
            <article className={`${ARTICLE_CLASS} pdf-article${heading?.first ? " pdf-hide-first-h1" : ""}`}>
              <MarkdownMarkup text={loaded.content.text} components={components} />
            </article>
          )}
        </>
      )}
    </div>
  );
}
