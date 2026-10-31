"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowLeftIcon, CheckCheckIcon, CheckIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { FileKindIcon } from "@/components/file-icon";
import type { ChangeTracker } from "@/hooks/use-change-tracker";
import { api, ApiError, formatRelative, type FileKind, type TreeResponse } from "@/lib/api";
import { CONTENT_MAX, TEXT_KINDS } from "@/lib/change-rules";
import { diffVersions, summarizeChange, type ChangeSummary } from "@/lib/diff";
import { viewerHref } from "@/lib/paths";
import { cn } from "@/lib/utils";
import {
  changedItems,
  createSummaryLoader,
  loadFeedSummary,
  type FeedItem,
  type FeedModeId,
  type SummaryLoader,
} from "@/lib/whats-new";
import { SummaryText, summaryDetail, type SummaryDetail } from "./change-summary";

/**
 * One mode of the What's new panel: where the rows come from, how a row's summary is
 * computed, and what "mark as seen" means for it: "changes" (since viewed) and "uncommitted"
 * (git status, see components/git/uncommitted-source).
 */
export interface FeedSource {
  id: FeedModeId;
  /** mode name (shown when there is more than one) */
  label: string;
  /** newest first */
  items: FeedItem[];
  /** false while the list is still loading */
  ready: boolean;
  emptyText: string;
  /** lazily computed summaries (rows on screen); absent when `detail` gives them at once */
  loader?: SummaryLoader<ChangeSummary>;
  loadSummary?(item: FeedItem): Promise<ChangeSummary>;
  /** the row's summary, known without loading anything */
  detail?(item: FeedItem): SummaryDetail;
  /** a short tag before the name (e.g. the git status letter) */
  badge?(item: FeedItem): { text: string; title: string } | null;
  /** how a row opens (default: the panel's onOpen) */
  open?(path: string): void;
  /** a line under the list (e.g. the branch), or an error */
  note?: string | null;
  /** called when the mode is shown (refreshes a list that is not live) */
  onShow?(): void;
  /** per-row action; absent when the mode has none */
  markSeen?(paths: string[]): void;
  markAllSeen?(): void;
}

/** Summaries computed at once (each is a content fetch, a snapshot fetch and a diff). */
const CONCURRENCY = 3;
/**
 * Budget of each diff of a row (ms), well under the banner's: the diffs run on the main thread,
 * so a screenful of big rewrites must not freeze the page. Beyond it the row says "too many
 * changes to compare quickly"; the banner computes the full summary when the file is opened.
 */
const FEED_DIFF_TIMEOUT_MS = 200;

/** "Changed since you last looked": the files with a sidebar dot. */
export function useChangesSource(tree: TreeResponse | null, tracker: ChangeTracker | null): FeedSource | null {
  const [loader] = useState(() => createSummaryLoader<ChangeSummary>({ concurrency: CONCURRENCY }));
  const seen = tracker?.seen;
  const changed = tracker?.changed;
  const items = useMemo(
    () => (tree && changed && seen ? changedItems(tree.files, changed, seen) : []),
    [tree, changed, seen],
  );
  const latest = useRef(tracker);
  useEffect(() => {
    latest.current = tracker;
  });

  const loadSummary = useCallback(async (item: FeedItem): Promise<ChangeSummary> => {
    const t = latest.current;
    if (!t) throw new Error("changes: not ready"); // not cached: retried
    const base = t.seen.get(item.path);
    const markdown = item.kind === "markdown";
    const textKind = TEXT_KINDS.has(item.kind);
    const tooLarge = textKind && item.size > CONTENT_MAX;
    return loadFeedSummary({
      textKind,
      tooLarge,
      baseText: async () => (await t.getSnapshot(item.path, { throwOnError: true }))?.text ?? null,
      currentText: async () => {
        try {
          return (await api.content(item.path)).text;
        } catch (e) {
          // Network or server failure: rejected, so not cached and tried again later.
          if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) throw e;
          return null; // gone meanwhile, unreadable: the summary works from the size
        }
      },
      summarize: (baseText, currentText) => {
        const { lineDiff, markdownDiff } =
          baseText !== null && currentText !== null
            ? diffVersions(baseText, currentText, markdown, { timeoutMs: FEED_DIFF_TIMEOUT_MS })
            : { lineDiff: null, markdownDiff: null };
        return summarizeChange({
          markdown,
          textKind,
          baseText,
          currentText,
          lineDiff,
          markdownDiff,
          sizeDelta: base ? item.size - base.size : 0,
          tooLarge,
        });
      },
    });
  }, []);

  const markSeen = useCallback((paths: string[]) => {
    const t = latest.current;
    if (!t) return;
    // The records replaced: one per file actually marked (paths seen meanwhile are skipped).
    const prev = t.markSeen(paths);
    if (!prev.length) return;
    toast(prev.length === 1 ? "Marked as seen" : `Marked ${prev.length.toLocaleString()} files as seen`, {
      description: prev.length === 1 ? prev[0].path : undefined,
      action: { label: "Undo", onClick: () => latest.current?.restoreSeen(prev) },
    });
  }, []);
  const markAllSeen = useCallback(() => markSeen(items.map((i) => i.path)), [markSeen, items]);

  return useMemo<FeedSource | null>(
    () =>
      tracker
        ? {
            id: "changes",
            label: "Changed since viewed",
            items,
            ready: tracker.ready && tree !== null,
            emptyText: "Nothing new since you last looked",
            loader,
            loadSummary,
            markSeen,
            markAllSeen,
          }
        : null,
    [tracker, tree, items, loader, loadSummary, markSeen, markAllSeen],
  );
}

/** Rows on screen (summaries are only computed for those), by path. */
function useVisibleRows(): { visible: ReadonlySet<string>; observe: (el: HTMLElement | null) => (() => void) | undefined } {
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const io = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      setVisible((prev) => {
        let next: Set<string> | null = null;
        for (const e of entries) {
          const p = (e.target as HTMLElement).dataset.feedPath;
          if (p === undefined || e.isIntersecting === prev.has(p)) continue;
          next ??= new Set(prev);
          if (e.isIntersecting) next.add(p);
          else next.delete(p);
        }
        return next ?? prev;
      });
    });
    io.current = obs;
    for (const el of document.querySelectorAll<HTMLElement>("[data-feed-path]")) obs.observe(el);
    return () => {
      obs.disconnect();
      io.current = null;
    };
  }, []);
  // A ref callback with a cleanup (React 19): rows that go away stop being observed and no
  // longer count as on screen (the observer does not report them again).
  const observe = useCallback((el: HTMLElement | null) => {
    const obs = io.current;
    if (!el || !obs) return undefined;
    obs.observe(el);
    const p = el.dataset.feedPath;
    return () => {
      obs.unobserve(el);
      if (p === undefined) return;
      setVisible((prev) => {
        if (!prev.has(p)) return prev;
        const next = new Set(prev);
        next.delete(p);
        return next;
      });
    };
  }, []);
  return { visible, observe };
}

function FeedRow({
  item,
  detail,
  badge,
  active,
  activeClassName,
  onOpen,
  onMarkSeen,
  observe,
}: {
  item: FeedItem;
  detail: SummaryDetail | null;
  badge: { text: string; title: string } | null;
  active: boolean;
  activeClassName?: string;
  onOpen: (path: string) => void;
  onMarkSeen?: (path: string) => void;
  observe: (el: HTMLElement | null) => (() => void) | undefined;
}) {
  const when = item.mtime ? formatRelative(item.mtime) : null;
  return (
    <SidebarMenuItem ref={observe} data-feed-path={item.path}>
      <SidebarMenuButton
        asChild
        size="sm"
        isActive={active}
        className={cn("h-auto items-start py-1.5", onMarkSeen && "pr-7", activeClassName)}
      >
        <a
          href={viewerHref(item.path)}
          title={`${item.path}${when ? ` · changed ${when}` : ""}${detail ? `: ${detail.text}` : ""}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onOpen(item.path);
          }}
        >
          <FileKindIcon kind={item.kind as FileKind} className="mt-0.5 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-2">
              {badge ? (
                <span className="shrink-0 font-mono text-[10px] font-semibold text-amber-700 dark:text-amber-400" title={badge.title}>
                  {badge.text}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
              {when ? <span className="shrink-0 text-[10px] text-muted-foreground">{when}</span> : null}
            </span>
            {item.dir ? <span className="truncate text-[11px] text-muted-foreground">{item.dir}</span> : null}
            <span className="text-[11px] text-sky-800/80 dark:text-sky-300/80">
              {detail ? <SummaryText detail={detail} /> : <Skeleton className="mt-0.5 h-3 w-28" />}
            </span>
          </span>
        </a>
      </SidebarMenuButton>
      {onMarkSeen ? (
        <SidebarMenuAction
          showOnHover
          className="top-1.5"
          onClick={() => onMarkSeen(item.path)}
          aria-label={`Mark ${item.name} as seen`}
          title="Mark as seen"
        >
          <CheckIcon />
        </SidebarMenuAction>
      ) : null}
    </SidebarMenuItem>
  );
}

/**
 * The What's new panel (a view of the sidebar): one list per source, newest first, with the
 * banner's summary per row, computed lazily for the rows on screen.
 */
export function WhatsNewPanel({
  sources,
  activePath,
  activeClassName,
  onOpen,
  onClose,
}: {
  sources: FeedSource[];
  activePath: string;
  activeClassName?: string;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [modeId, setModeId] = useState<FeedModeId | null>(null);
  const source = sources.find((s) => s.id === modeId) ?? sources[0] ?? null;
  const { visible, observe } = useVisibleRows();
  const loader = source?.loader ?? null;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => loader?.subscribe(rerender), [loader]);

  // A mode that is not live (git status) refreshes when it is shown.
  const onShow = source?.onShow;
  const shownId = source?.id;
  useEffect(() => {
    if (shownId) onShow?.();
  }, [shownId, onShow]);

  // Queue the summaries of the rows on screen, top first; cached ones are skipped.
  const items = source?.items;
  const loadSummary = source?.loadSummary;
  useEffect(() => {
    if (!loader || !items || !loadSummary) return;
    loader.want(items.filter((i) => visible.has(i.path)).map((i) => ({ key: i.key, run: () => loadSummary(i) })));
  }, [loader, items, loadSummary, visible]);

  if (!source) return null;
  const open = source.open ?? onOpen;
  const rowDetail = (item: FeedItem): SummaryDetail | null => {
    if (source.detail) return source.detail(item);
    const summary = source.loader?.get(item.key);
    return summary ? summaryDetail(summary) : null;
  };
  const markOne = source.markSeen ? (p: string) => source.markSeen?.([p]) : undefined;
  const count = source.items.length;
  return (
    <SidebarGroup className="pt-1">
      <div className="flex items-center gap-1 pb-1">
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Back to the files" title="Back to the files (w)">
          <ArrowLeftIcon />
        </Button>
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
          <SparklesIcon className="size-3.5 text-sky-600 dark:text-sky-400" aria-hidden />
          What&apos;s new
          {count ? <span className="text-xs font-normal text-muted-foreground">{count.toLocaleString()}</span> : null}
        </h2>
        {source.markAllSeen ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={!count}
            onClick={() => source.markAllSeen?.()}
            title="Accept the current version of every file in this list"
          >
            <CheckCheckIcon /> Mark all as seen
          </Button>
        ) : null}
      </div>
      {sources.length > 1 ? (
        <div role="tablist" aria-label="List" className="mb-1 flex gap-1">
          {sources.map((s) => (
            <Button
              key={s.id}
              role="tab"
              aria-selected={s.id === source.id}
              variant={s.id === source.id ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setModeId(s.id)}
            >
              {s.label}
              <span className="text-muted-foreground">{s.items.length}</span>
            </Button>
          ))}
        </div>
      ) : null}
      <SidebarGroupContent>
        {!source.ready ? (
          <div className="space-y-2 px-2 py-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : count ? (
          <SidebarMenu className="gap-0.5">
            {source.items.map((item) => (
              <FeedRow
                key={item.path}
                item={item}
                detail={rowDetail(item)}
                badge={source.badge?.(item) ?? null}
                active={item.path === activePath}
                activeClassName={activeClassName}
                onOpen={open}
                onMarkSeen={markOne}
                observe={observe}
              />
            ))}
          </SidebarMenu>
        ) : (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">{source.emptyText}</p>
        )}
        {source.ready && source.note ? <p className="px-2 pt-2 text-[11px] text-muted-foreground">{source.note}</p> : null}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
