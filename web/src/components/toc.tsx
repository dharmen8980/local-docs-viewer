"use client";

import { useEffect, useState } from "react";
import { ChevronRightIcon, ListIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

function useActiveHeading(headings: TocHeading[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!headings.length) return;
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((e): e is HTMLElement => Boolean(e));
    const visible = new Map<string, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        if (visible.size) {
          const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0][0];
          setActive(top);
        }
      },
      { rootMargin: "-64px 0px -60% 0px" },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [headings]);
  return active;
}

function TocList({
  headings,
  active,
  onSelect,
}: {
  headings: TocHeading[];
  active: string | null;
  onSelect: (id: string) => void;
}) {
  const minLevel = Math.min(...headings.map((h) => h.level));
  return (
    <ul className="space-y-0.5 text-sm">
      {headings.map((h) => (
        <li key={h.id}>
          <a
            href={`#${encodeURIComponent(h.id)}`}
            onClick={(e) => {
              e.preventDefault();
              onSelect(h.id);
            }}
            className={cn(
              "block truncate rounded px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground",
              active === h.id && "bg-muted font-medium text-foreground",
            )}
            style={{ paddingLeft: `${0.5 + (h.level - minLevel) * 0.75}rem` }}
            title={h.text}
          >
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Sticky side panel on wide screens. */
export function TocPanel({ headings, onSelect }: { headings: TocHeading[]; onSelect: (id: string) => void }) {
  const active = useActiveHeading(headings);
  if (headings.length < 2) return null;
  return (
    <nav
      aria-label="Table of contents"
      className="no-print sticky top-20 hidden max-h-[calc(100svh-6rem)] w-60 shrink-0 overflow-y-auto pb-6 xl:block"
    >
      <div className="mb-2 flex items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ListIcon className="size-3.5" /> On this page
      </div>
      <TocList headings={headings} active={active} onSelect={onSelect} />
    </nav>
  );
}

/** Collapsible block shown above the article on narrower screens. */
export function TocInline({ headings, onSelect }: { headings: TocHeading[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (headings.length < 2) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="no-print mb-4 rounded-lg border xl:hidden">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium">
        <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        Contents
        <span className="text-muted-foreground">({headings.length})</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-80 overflow-y-auto border-t px-1 py-2">
        <TocList headings={headings} active={null} onSelect={(id) => onSelect(id)} />
      </CollapsibleContent>
    </Collapsible>
  );
}
