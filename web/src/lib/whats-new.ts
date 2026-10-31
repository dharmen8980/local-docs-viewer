// Pure parts of the What's new feed: the list of rows, and the lazy summary loader (bounded
// concurrency, cached by version). No `@/` or relative value imports: unit tested with node --test.

/** A mode of the feed panel: changed since viewed, or uncommitted (git status against the last commit). */
export type FeedModeId = "changes" | "uncommitted";

/** One row: a file and the version the summary is about. */
export interface FeedItem {
  path: string;
  name: string;
  /** folder, "" at the root */
  dir: string;
  kind: string;
  mtime: number;
  size: number;
  /** identifies the compared versions: a new key means the summary is stale */
  key: string;
}

/** The base a row is compared with (the seen record). */
export interface FeedBase {
  mtime: number;
  size: number;
}

/** Cache key of a summary: the current version and the base it is compared with. */
export function summaryKey(path: string, cur: { mtime: number; size: number }, base: FeedBase | undefined): string {
  return `${path}\u0000${cur.mtime}:${cur.size}\u0000${base ? `${base.mtime}:${base.size}` : "-"}`;
}

/**
 * The files in `changed`, newest change (mtime) first, then by path. `changed` is the same set the
 * sidebar dots use; paths missing from `files` (deleted meanwhile) are skipped.
 */
export function changedItems(
  files: readonly { path: string; name: string; kind: string; mtime: number; size: number }[],
  changed: ReadonlySet<string>,
  seen: ReadonlyMap<string, FeedBase>,
): FeedItem[] {
  if (!changed.size) return [];
  const out: FeedItem[] = [];
  for (const f of files) {
    if (!changed.has(f.path)) continue;
    const i = f.path.lastIndexOf("/");
    out.push({
      path: f.path,
      name: f.name,
      dir: i < 0 ? "" : f.path.slice(0, i),
      kind: f.kind,
      mtime: f.mtime,
      size: f.size,
      key: summaryKey(f.path, f, seen.get(f.path)),
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The inputs of one row's summary (injected: the app's fetches and diff). */
export interface FeedSummaryInputs<S> {
  /** the kind's text is fetched and snapshotted (change-rules TEXT_KINDS) */
  textKind: boolean;
  /** over the fetch limit: nothing is fetched, the summary says so */
  tooLarge: boolean;
  /** the saved copy's text, null when there is none; rejects when the request failed */
  baseText(): Promise<string | null>;
  /** the current text, null when it cannot be read; rejects on a failure worth retrying */
  currentText(): Promise<string | null>;
  summarize(baseText: string | null, currentText: string | null): S;
}

/**
 * One row's summary: the same inputs as the banner (the saved copy against the current text).
 * A failed fetch rejects, so the loader retries it instead of caching a wrong "no copy".
 */
export async function loadFeedSummary<S>(i: FeedSummaryInputs<S>): Promise<S> {
  let baseText: string | null = null;
  let currentText: string | null = null;
  if (i.textKind && !i.tooLarge) {
    baseText = await i.baseText();
    // No copy: nothing to compare, the current text is not needed.
    if (baseText !== null) currentText = await i.currentText();
  }
  return i.summarize(baseText, currentText);
}

export interface SummaryLoader<T> {
  /** the cached result, if any (marks it as recently used) */
  get(key: string): T | undefined;
  /**
   * The keys wanted now, most wanted first (the visible rows). Replaces the queue: keys no
   * longer wanted are dropped unless already running; cached and running keys are skipped.
   */
  want(jobs: { key: string; run: () => Promise<T> }[]): void;
  /** called after each result lands; returns the unsubscribe function */
  subscribe(fn: () => void): () => void;
  /** jobs running and queued (tests, diagnostics) */
  pending(): { running: number; queued: number };
}

export interface LoaderOptions {
  /** jobs running at once (fetches + diffs) */
  concurrency?: number;
  /** cached results kept, least recently used dropped first */
  maxEntries?: number;
  /** waits before each job, so a run of diffs leaves the UI room to breathe */
  yieldFn?: () => Promise<void>;
  /** a failed job runs again after this long (ms) while its key is still wanted */
  retryMs?: number;
}

/**
 * A failed job is not cached: it is tried again after `retryMs` while its key is still wanted
 * (in the last want()), or on the next want() of its key.
 */
export function createSummaryLoader<T>(opts: LoaderOptions = {}): SummaryLoader<T> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const maxEntries = Math.max(1, opts.maxEntries ?? 500);
  const pause = opts.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const retryMs = Math.max(0, opts.retryMs ?? 3000);
  const cache = new Map<string, T>();
  const running = new Set<string>();
  let queue: { key: string; run: () => Promise<T> }[] = [];
  /** the keys of the last want(), with their latest job (a retry runs the fresh one) */
  let wanted = new Map<string, { key: string; run: () => Promise<T> }>();
  const listeners = new Set<() => void>();

  const retry = (key: string) => {
    setTimeout(() => {
      const job = wanted.get(key);
      if (!job || cache.has(key) || running.has(key) || queue.some((j) => j.key === key)) return;
      queue.push(job);
      pump();
    }, retryMs);
  };

  const put = (key: string, v: T) => {
    cache.delete(key);
    cache.set(key, v);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
  };

  const pump = () => {
    while (running.size < concurrency && queue.length) {
      const job = queue.shift()!;
      if (cache.has(job.key) || running.has(job.key)) continue;
      running.add(job.key);
      void (async () => {
        let ok = false;
        let v: T | undefined;
        try {
          await pause();
          v = await job.run();
          ok = true;
        } catch {
          // not cached: retried later (see retry)
        }
        running.delete(job.key);
        if (ok) put(job.key, v as T);
        else retry(job.key);
        pump();
        if (ok) for (const fn of listeners) fn();
      })();
    }
  };

  return {
    get(key) {
      if (!cache.has(key)) return undefined;
      const v = cache.get(key) as T;
      put(key, v);
      return v;
    },
    want(jobs) {
      const seen = new Set<string>();
      wanted = new Map(jobs.map((j) => [j.key, j]));
      queue = jobs.filter((j) => {
        if (seen.has(j.key) || cache.has(j.key) || running.has(j.key)) return false;
        seen.add(j.key);
        return true;
      });
      pump();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    pending: () => ({ running: running.size, queued: queue.length }),
  };
}
