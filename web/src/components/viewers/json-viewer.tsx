"use client";

import { createContext, memo, useContext, useMemo, useState } from "react";
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRoute } from "@/hooks/use-route";
import { api, ApiError, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CodeLines, HIGHLIGHT_MAX_BYTES, parseLineHash } from "./code-viewer";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { TextViewer } from "./text-viewer";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const PAGE = 100;
const ExpandCtx = createContext<{ mode: "default" | "all" | "none" }>({ mode: "default" });

function Primitive({ value }: { value: Json }) {
  if (value === null) return <span className="text-muted-foreground italic">null</span>;
  if (typeof value === "boolean") return <span className="text-violet-600 dark:text-violet-400">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-sky-700 dark:text-sky-400">{String(value)}</span>;
  return (
    <span className="break-all whitespace-pre-wrap text-emerald-700 dark:text-emerald-400">
      &quot;{value as string}&quot;
    </span>
  );
}

const JsonNode = memo(function JsonNode({
  name,
  value,
  depth,
  last,
}: {
  name: string | number | null;
  value: Json;
  depth: number;
  last: boolean;
}) {
  const { mode } = useContext(ExpandCtx);
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(mode === "all" ? true : mode === "none" ? depth === 0 : depth < 2);
  const [shown, setShown] = useState(PAGE);

  const label =
    name === null ? null : (
      <span className="text-rose-700 dark:text-rose-300">
        {typeof name === "number" ? name : `"${name}"`}
        <span className="text-muted-foreground">: </span>
      </span>
    );

  if (!isObj) {
    return (
      <div className="pl-5">
        {label}
        <Primitive value={value} />
        {last ? null : <span className="text-muted-foreground">,</span>}
      </div>
    );
  }

  const isArr = Array.isArray(value);
  const entries: [string | number, Json][] = isArr
    ? (value as Json[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, Json>);
  const [openB, closeB] = isArr ? ["[", "]"] : ["{", "}"];

  return (
    <div className={depth === 0 ? "" : "pl-5"}>
      <div className="-ml-5 flex items-start">
        <button
          type="button"
          className="mt-0.5 mr-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse" : "Expand"}
          disabled={entries.length === 0}
        >
          {entries.length ? <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} /> : null}
        </button>
        <span>
          {label}
          <span className="text-muted-foreground">{openB}</span>
          {!open || entries.length === 0 ? (
            <>
              {entries.length ? (
                <button
                  type="button"
                  className="mx-1 rounded bg-muted px-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setOpen(true)}
                >
                  {entries.length} {isArr ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}
                </button>
              ) : null}
              <span className="text-muted-foreground">
                {closeB}
                {last ? "" : ","}
              </span>
            </>
          ) : null}
        </span>
      </div>
      {open && entries.length ? (
        <>
          {entries.slice(0, shown).map(([k, v], i) => (
            <JsonNode key={k} name={isArr ? (k as number) : k} value={v} depth={depth + 1} last={i === entries.length - 1} />
          ))}
          {entries.length > shown ? (
            <div className="pl-5">
              <Button size="xs" variant="outline" className="my-1" onClick={() => setShown((s) => s + PAGE)}>
                Show {Math.min(PAGE, entries.length - shown)} more ({entries.length - shown} hidden)
              </Button>
            </div>
          ) : null}
          <div className="text-muted-foreground">
            {closeB}
            {last ? "" : ","}
          </div>
        </>
      ) : null}
    </div>
  );
});

export function JsonViewer({ file, reloadKey }: ViewerProps) {
  const { hash } = useRoute();
  const lineTarget = parseLineHash(hash) !== null;
  const { data, error, loading } = useAsync(file.path, reloadKey, (signal) => api.content(file.path, signal));
  const [tab, setTab] = useState<string | null>(null);
  const [expand, setExpand] = useState<{ mode: "default" | "all" | "none"; gen: number }>({ mode: "default", gen: 0 });
  const [pretty, setPretty] = useState<boolean | null>(null);

  const parsed = useMemo(() => {
    if (!data) return null;
    try {
      return { ok: true as const, value: JSON.parse(data.text) as Json };
    } catch (e) {
      return { ok: false as const, error: errorMessage(e) };
    }
  }, [data]);

  const original = data?.text ?? "";
  const multiLine = original.trimEnd().includes("\n");
  const usePretty = pretty ?? (!multiLine && !lineTarget);
  const source = useMemo(() => {
    if (!parsed?.ok || !usePretty) return original;
    return JSON.stringify(parsed.value, null, 2);
  }, [parsed, usePretty, original]);

  if (error instanceof ApiError && error.status === 413) return <TextViewer file={file} reloadKey={reloadKey} />;
  if (!data) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return loading ? <ViewerLoading /> : null;
  }
  if (parsed && !parsed.ok) {
    return (
      <div>
        <div className="no-print border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          Not valid JSON ({parsed.error}); showing as text.
        </div>
        <TextViewer file={file} reloadKey={reloadKey} />
      </div>
    );
  }

  const activeTab = tab ?? (lineTarget ? "source" : "tree");

  return (
    <Tabs value={activeTab} onValueChange={setTab} className="gap-0">
      <div className="no-print sticky top-[var(--header-h,3.5rem)] z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-1.5 backdrop-blur">
        <TabsList>
          <TabsTrigger value="tree">Tree</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
        </TabsList>
        {activeTab === "tree" ? (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setExpand((e) => ({ mode: "all", gen: e.gen + 1 }))}>
              <ChevronsUpDownIcon /> Expand all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setExpand((e) => ({ mode: "none", gen: e.gen + 1 }))}>
              <ChevronsDownUpIcon /> Collapse all
            </Button>
          </div>
        ) : parsed?.ok ? (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant={usePretty ? "ghost" : "secondary"} onClick={() => setPretty(false)}>
              Original
            </Button>
            <Button size="sm" variant={usePretty ? "secondary" : "ghost"} onClick={() => setPretty(true)}>
              Pretty-printed
            </Button>
          </div>
        ) : null}
      </div>
      <TabsContent value="tree" className="overflow-x-auto px-6 py-4 font-mono text-[13px] leading-relaxed">
        {parsed?.ok ? (
          <ExpandCtx.Provider value={{ mode: expand.mode }}>
            <div className="pl-5">
              <JsonNode key={expand.gen} name={null} value={parsed.value} depth={0} last />
            </div>
          </ExpandCtx.Provider>
        ) : null}
      </TabsContent>
      <TabsContent value="source">
        <CodeLines code={source} lang={source.length <= HIGHLIGHT_MAX_BYTES ? "json" : null} />
      </TabsContent>
    </Tabs>
  );
}
