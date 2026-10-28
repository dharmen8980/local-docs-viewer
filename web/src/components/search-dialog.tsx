"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FileKindIcon } from "@/components/file-icon";
import { api, errorMessage, type ContentHit, type ContentMatch, type FileKind, type SearchResponse } from "@/lib/api";
import { dirname } from "@/lib/paths";

const TYPE_CHIPS = ["md", "mmd", "py", "sh", "json", "jsonl", "log", "out", "txt", "csv"];
const ALL = "__all__";

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  // Server ranges are code-point offsets (Python str indices).
  const chars = Array.from(text);
  const sorted = [...ranges].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let pos = 0;
  sorted.forEach(([s, e], i) => {
    const start = Math.max(s, pos);
    const end = Math.min(e, chars.length);
    if (start >= end) return;
    if (start > pos) out.push(chars.slice(pos, start).join(""));
    out.push(
      <mark key={i} className="hl">
        {chars.slice(start, end).join("")}
      </mark>,
    );
    pos = end;
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(""));
  return <>{out}</>;
}

export interface SearchTarget {
  path: string;
  kind: FileKind;
  match?: ContentMatch;
  query: string;
}

export function SearchDialog({
  open,
  onOpenChange,
  folders,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  folders: string[];
  onSelect: (t: SearchTarget) => void;
}) {
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState(ALL);
  const [types, setTypes] = useState<string[]>([]);
  const [result, setResult] = useState<{ key: string; data: SearchResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = q.trim();
  const key = `${query}|${folder}|${types.join(",")}`;

  useEffect(() => {
    if (!open || !query) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      api
        .search({ q: query, folder: folder === ALL ? "" : folder, types, limit: 50 }, ctrl.signal)
        .then((data) => {
          setResult({ key, data });
          setError(null);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setError(errorMessage(e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setBusy(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, query, folder, types, key, retryTick]);

  // While the index is still building, poll so results fill in.
  useEffect(() => {
    if (!open || !result?.data.indexing) return;
    const t = setTimeout(() => setRetryTick((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [open, result]);

  const data = query && result ? result.data : null;
  const stale = result?.key !== key;
  const contentHits: ContentHit[] = useMemo(() => data?.content ?? [], [data]);

  const choose = (t: SearchTarget) => {
    onSelect(t);
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Search file names and contents"
      className="top-[12%] sm:max-w-3xl"
    >
      <Command shouldFilter={false} className="rounded-xl!">
        <CommandInput
          ref={inputRef}
          value={q}
          onValueChange={setQ}
          placeholder="Search files and contents..."
          autoFocus
        />
        <div className="flex flex-wrap items-center gap-2 border-b px-2 py-2">
          <Select value={folder} onValueChange={setFolder}>
            <SelectTrigger size="sm" className="h-7 w-44 text-xs" aria-label="Folder filter">
              <SelectValue placeholder="All folders" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All folders</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}/
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToggleGroup
            type="multiple"
            size="sm"
            variant="outline"
            value={types}
            onValueChange={setTypes}
            className="flex-wrap"
            aria-label="File type filter"
          >
            {TYPE_CHIPS.map((t) => (
              <ToggleGroupItem key={t} value={t} className="h-7 px-2 font-mono text-[11px]">
                {t}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            {busy || (stale && query) ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {data?.indexing ? <span>indexing...</span> : null}
          </div>
        </div>
        <CommandList className="max-h-[min(65vh,40rem)]">
          {!query ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Type to search file names and contents. Use the chips to filter by type.
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-sm text-destructive">Search failed: {error}</div>
          ) : data ? (
            <>
              <CommandEmpty>{busy || stale ? "Searching..." : "No results."}</CommandEmpty>
              {data.names.length ? (
                <CommandGroup heading="Files">
                  {data.names.map((n) => (
                    <CommandItem
                      key={`n:${n.path}`}
                      value={`n:${n.path}`}
                      onSelect={() => choose({ path: n.path, kind: n.kind, query })}
                    >
                      <FileKindIcon kind={n.kind} className="text-muted-foreground" />
                      <span className="truncate font-medium">{n.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{dirname(n.path)}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {data.names.length && contentHits.length ? <CommandSeparator /> : null}
              {contentHits.length ? (
                <CommandGroup heading="Content">
                  {contentHits.map((hit) => (
                    <div key={`c:${hit.path}`} className="mb-1">
                      <CommandItem
                        value={`c:${hit.path}`}
                        onSelect={() => choose({ path: hit.path, kind: hit.kind, match: hit.matches[0], query })}
                      >
                        <FileKindIcon kind={hit.kind} className="text-muted-foreground" />
                        <span className="truncate font-medium">{hit.path}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {hit.match_count} match{hit.match_count === 1 ? "" : "es"}
                        </span>
                      </CommandItem>
                      {hit.matches.map((m) => (
                        <CommandItem
                          key={`m:${hit.path}:${m.line}:${m.offset}`}
                          value={`m:${hit.path}:${m.line}:${m.offset}`}
                          onSelect={() => choose({ path: hit.path, kind: hit.kind, match: m, query })}
                          className="py-0.5 pl-8"
                        >
                          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                            {m.line}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            <Highlighted text={m.text} ranges={m.ranges} />
                          </span>
                        </CommandItem>
                      ))}
                    </div>
                  ))}
                </CommandGroup>
              ) : null}
            </>
          ) : (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Searching...
            </div>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
