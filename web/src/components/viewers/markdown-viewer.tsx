"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import { CheckIcon, CopyIcon, ImageOffIcon, LinkIcon, ShieldOffIcon } from "lucide-react";
import { TocInline, TocPanel, type TocHeading } from "@/components/toc";
import { useHighlight } from "@/hooks/use-highlight";
import { useRoute } from "@/hooks/use-route";
import { api, errorMessage, rawUrl } from "@/lib/api";
import { isExternal, isWebLink, resolveLink, viewerHref } from "@/lib/paths";
import { highlight, langForFence } from "@/lib/shiki";
import { stickyScroll } from "@/lib/sticky-scroll";
import { parseLineHash } from "./code-viewer";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { MermaidDiagram } from "./mermaid-viewer";

// ---------- helpers ----------

interface HastLike {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function codeLang(node: HastLike | undefined): string {
  const cls = node?.properties?.className;
  const list = Array.isArray(cls) ? cls.map(String) : typeof cls === "string" ? cls.split(/\s+/) : [];
  const l = list.find((c) => c.startsWith("language-"));
  return l ? l.slice("language-".length) : "";
}

// ---------- fenced code ----------

const LONG_CODE_LINES = 40;

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const shikiLang = langForFence(lang);
  const [html, setHtml] = useState<{ code: string; html: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const highlightable = Boolean(shikiLang) && code.length <= 300 * 1024;
  // The PDF print page waits until no element is marked pending.
  const pending = highlightable && html?.code !== code && failed !== code;
  const lines = code.split("\n");
  const long = lines.length > LONG_CODE_LINES;
  // Longest line (tabs as 4): the PDF layout shrinks the font so wide code fits instead of wrapping.
  const cols = Math.max(1, ...lines.map((l) => l.replace(/\t/g, "    ").length));

  useEffect(() => {
    if (!shikiLang || code.length > 300 * 1024) return;
    let cancelled = false;
    highlight(code, shikiLang)
      .then((h) => !cancelled && setHtml({ code, html: h }))
      .catch(() => !cancelled && setFailed(code));
    return () => {
      cancelled = true;
    };
  }, [code, shikiLang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={`code-block not-prose group relative my-4 overflow-hidden rounded-lg border bg-muted/40${long ? " code-long" : ""}`}
      data-pdf-pending={pending ? "code" : undefined}
      style={{ "--code-cols": Math.min(cols, 400) } as CSSProperties}
    >
      {lang ? (
        <div className="absolute left-3 top-1 select-none text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {lang}
        </div>
      ) : null}
      <button
        type="button"
        onClick={copy}
        className="no-print absolute right-2 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        aria-label="Copy code"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
      {html && html.code === code ? (
        <div className={lang ? "pt-3" : ""} dangerouslySetInnerHTML={{ __html: html.html }} />
      ) : (
        <pre className={`shiki ${lang ? "pt-3!" : ""}`}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

// ---------- images ----------

function MdImage({
  src,
  alt,
  title,
  docPath,
  print = false,
}: {
  src: string;
  alt: string;
  title?: string;
  docPath: string;
  print?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  if (isExternal(src)) {
    return (
      <span
        className="md-image-blocked not-prose inline-flex max-w-full items-center gap-1.5 rounded border border-dashed px-2 py-1 align-middle text-xs text-muted-foreground"
        title="External images are never loaded by this viewer"
      >
        <ShieldOffIcon className="size-3.5 shrink-0" />
        <span className="truncate">external image blocked: {src}</span>
      </span>
    );
  }
  const target = resolveLink(docPath, src);
  if (!target || !target.path || failed) {
    return (
      <span className="md-image-missing not-prose inline-flex items-center gap-1.5 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground">
        <ImageOffIcon className="size-3.5" /> image not available: {src}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={rawUrl(target.path)}
      alt={alt}
      title={title}
      loading={print ? "eager" : "lazy"}
      decoding={print ? "sync" : undefined}
      onError={() => setFailed(true)}
      className="md-image mx-auto max-w-full rounded"
    />
  );
}

// ---------- components ----------

export interface MarkdownComponentOptions {
  /** Print/PDF mode: no interactive chrome, eager images, in-repo links as plain text. */
  print?: boolean;
  selectHeading?: (id: string) => void;
  navigate?: (path: string, opts?: { hash?: string }) => void;
  scrollToId?: (id: string) => void;
}

export function markdownComponents(docPath: string, opts: MarkdownComponentOptions = {}): Components {
  const { print = false } = opts;
  const selectHeading = opts.selectHeading ?? (() => undefined);
  const navigate = opts.navigate ?? (() => undefined);
  const scrollToId = opts.scrollToId ?? (() => undefined);
  const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
    function Heading({ children, id, node: _node, ...rest }: ComponentProps<"h1"> & { node?: unknown }) {
      return (
      <Tag id={id} {...rest}>
        {children}
        {id && !print ? (
          <a
            href={`#${encodeURIComponent(id)}`}
            className="heading-anchor no-print"
            aria-label="Link to this heading"
            onClick={(e) => {
              e.preventDefault();
              selectHeading(id);
            }}
          >
            <LinkIcon className="inline size-4" />
          </a>
        ) : null}
      </Tag>
      );
    };

  return {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    a({ href, children, node: _node, ...rest }) {
      const h = typeof href === "string" ? href : "";
      if (!h) return <span>{children}</span>;
      if (h.startsWith("#")) {
        const id = decodeURIComponent(h.slice(1));
        return (
          <a
            {...rest}
            href={h}
            onClick={(e) => {
              e.preventDefault();
              selectHeading(id);
            }}
          >
            {children}
          </a>
        );
      }
      if (isExternal(h)) {
        if (isWebLink(h)) {
          return (
            <a {...rest} href={h} target="_blank" rel="noreferrer noopener" title={print ? undefined : h}>
              {children}
            </a>
          );
        }
        return (
          <span title={`Unsupported link: ${h}`} className="underline decoration-dotted">
            {children}
          </span>
        );
      }
      const target = resolveLink(docPath, h);
      if (!target) {
        return (
          <span title={`Link points outside the viewer root: ${h}`} className="underline decoration-dotted">
            {children}
          </span>
        );
      }
      const path = target.path || docPath;
      if (print) {
        if (path === docPath && target.hash) return <a href={`#${encodeURIComponent(target.hash)}`}>{children}</a>;
        // A viewer URL is useless inside a PDF: show the in-repo target instead.
        return (
          <span className="pdf-link">
            {children}
            {path !== docPath ? <span className="pdf-link-target"> ({path}{target.hash ? `#${target.hash}` : ""})</span> : null}
          </span>
        );
      }
      return (
        <a
          {...rest}
          href={viewerHref(path, target.hash || undefined)}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(path, { hash: target.hash || undefined });
            if (path === docPath && target.hash) scrollToId(target.hash);
            else window.scrollTo({ top: 0 });
          }}
        >
          {children}
        </a>
      );
    },
    img({ src, alt, title }) {
      return (
        <MdImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} title={title} docPath={docPath} print={print} />
      );
    },
    pre({ node, children }) {
      const n = node as unknown as HastLike | undefined;
      const codeEl = n?.children?.find((c) => c.type === "element" && c.tagName === "code");
      if (!codeEl) return <pre>{children as ReactNode}</pre>;
      const lang = codeLang(codeEl);
      const code = hastText(codeEl).replace(/\n$/, "");
      if (lang.toLowerCase() === "mermaid") return <MermaidDiagram source={code} theme={print ? "light" : undefined} print={print} />;
      return <CodeBlock code={code} lang={lang} />;
    },
    table({ children, node: _node, ...rest }) {
      return (
        <div className="my-4 w-full overflow-x-auto">
          <table {...rest} className="my-0">
            {children}
          </table>
        </div>
      );
    },
  };
}

export const ARTICLE_CLASS =
  "markdown-body prose prose-neutral max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-a:break-words prose-pre:bg-transparent prose-img:my-4 prose-table:text-sm prose-th:px-3 prose-td:px-3 prose-code:before:content-none prose-code:after:content-none [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:font-normal";

export function MarkdownMarkup({ text, components }: { text: string; components: Components }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, defaultSchema], rehypeSlug]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}

// ---------- viewer ----------

export function MarkdownViewer({ file, reloadKey }: ViewerProps) {
  const { data, error, loading } = useAsync(file.path, reloadKey, (signal) => api.content(file.path, signal));
  const { hash, hl, hll, navigate, setHash } = useRoute();
  const articleRef = useRef<HTMLElement>(null);
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const docPath = file.path;

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id) ?? document.getElementById(`user-content-${id}`);
    if (el) el.scrollIntoView({ block: "start" });
  }, []);

  const selectHeading = useCallback(
    (id: string) => {
      setHash(id);
      scrollToId(id);
    },
    [setHash, scrollToId],
  );

  const components = useMemo<Components>(
    () => markdownComponents(docPath, { selectHeading, navigate, scrollToId }),
    [docPath, navigate, selectHeading, scrollToId],
  );

  // Collect headings (ids come from rehype-slug) for the table of contents.
  useEffect(() => {
    const root = articleRef.current;
    if (!root || !data) return;
    const hs = Array.from(root.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id]")).map((el) => ({
      id: el.id,
      text: (el.textContent ?? "").trim(),
      level: Number(el.tagName.slice(1)),
    }));
    setHeadings(hs);
  }, [data]);

  // Scroll to the heading named in the URL hash (initial load and back/forward).
  const scrolledFor = useRef<string>("");
  useEffect(() => {
    if (!data || !hash || parseLineHash(hash) !== null) return;
    const key = `${file.path}#${hash}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const root = articleRef.current;
    if (!root) return;
    // Diagrams and images render after the text and shift the layout: keep the
    // heading in view until things settle (or the user scrolls).
    const find = () => document.getElementById(hash) ?? document.getElementById(`user-content-${hash}`);
    let done = false;
    const stop = stickyScroll(root, () => find()?.getBoundingClientRect() ?? null, {
      onDone: () => {
        done = true;
      },
    });
    return () => {
      // Interrupted before it finished (unmount, StrictMode re-run, reload): allow a retry.
      if (!done) scrolledFor.current = "";
      stop();
    };
  }, [data, hash, file.path]);

  useHighlight(articleRef, hl, data, hll);

  if (!data) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return loading ? <ViewerLoading lines={14} /> : null;
  }

  return (
    <div className="flex justify-center gap-8 px-4 py-6 md:px-8">
      <div className="print-area min-w-0 max-w-4xl flex-1">
        <TocInline headings={headings} onSelect={selectHeading} />
        <article ref={articleRef} className={ARTICLE_CLASS}>
          <MarkdownMarkup text={data.text} components={components} />
        </article>
      </div>
      <TocPanel headings={headings} onSelect={selectHeading} />
    </div>
  );
}
