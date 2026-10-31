"use client";

import { useMemo } from "react";
import type { FeedSource } from "@/components/changes/whats-new";
import type { FeedItem } from "@/lib/whats-new";
import { GIT_STATUS_WORDS, gitDetail, uncommittedItems, type GitFeedItem } from "@/lib/git";
import type { GitState } from "./git-context";

/**
 * "Uncommitted": the files git status reports in this folder (modified, staged, untracked,
 * deleted, renamed), with +/- lines against the last commit. Rows open the file's diff against
 * the last commit. Denied and ignored files never reach the list (filtered by the server).
 */
export function useUncommittedSource(git: GitState | null, openGit: (path: string) => void): FeedSource | null {
  const status = git?.status ?? null;
  const items = useMemo(() => (status ? uncommittedItems(status.files) : []), [status]);
  const byPath = useMemo(() => new Map<string, GitFeedItem>(items.map((i) => [i.path, i])), [items]);
  const error = git?.error ?? null;
  const refresh = git?.refresh;
  return useMemo<FeedSource | null>(() => {
    if (!git) return null;
    const where = status?.branch ? `on ${status.branch}` : status?.head ? `at ${status.head}` : "before the first commit";
    const note = error
      ? `Could not read git status: ${error}`
      : status
        ? `Compared with the last commit (${where}).${status.truncated ? " Only the first files are listed." : ""}`
        : null;
    return {
      id: "uncommitted",
      label: "Uncommitted",
      items,
      ready: status !== null || error !== null,
      emptyText: "No uncommitted changes in this folder",
      detail: (item: FeedItem) => {
        const g = byPath.get(item.path);
        return { text: g ? gitDetail(g.entry) : "" };
      },
      badge: (item: FeedItem) => {
        const g = byPath.get(item.path);
        return g ? { text: g.status, title: GIT_STATUS_WORDS[g.status] } : null;
      },
      open: openGit,
      note,
      onShow: refresh,
    };
  }, [git, status, error, items, byPath, openGit, refresh]);
}
