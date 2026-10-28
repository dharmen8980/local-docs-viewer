"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronDownIcon, FileDownIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pdfUrl, type FileInfo, type PdfOptions } from "@/lib/api";

const STORE_KEY = "ldv.pdf-options";
// "auto": portrait, but landscape for a standalone diagram that prints larger that way
const DEFAULTS: PdfOptions = { paper: "a4", orientation: "auto", toc: false };
const ORIENTATIONS: PdfOptions["orientation"][] = ["auto", "portrait", "landscape"];

function loadOptions(): PdfOptions {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Partial<PdfOptions> | null;
    return {
      paper: v?.paper === "letter" ? "letter" : "a4",
      orientation: ORIENTATIONS.includes(v?.orientation as PdfOptions["orientation"])
        ? (v?.orientation as PdfOptions["orientation"])
        : DEFAULTS.orientation,
      toc: v?.toc === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(cd);
  return plain ? plain[1] : fallback;
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === "string") return body.detail;
  } catch {
    /* not JSON */
  }
  return `${res.status} ${res.statusText}`;
}

/** "PDF" dropdown: server-side, paginated PDF export of a markdown/mermaid file. */
export function PdfMenu({ file }: { file: FileInfo }) {
  const [opts, setOpts] = useState<PdfOptions>(() => (typeof window === "undefined" ? DEFAULTS : loadOptions()));
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<PdfOptions>) => {
    setOpts((o) => {
      const next = { ...o, ...patch };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const download = async (o: PdfOptions) => {
    if (busy) return;
    setBusy(true);
    const id = toast.loading("Generating PDF...", { description: file.name });
    try {
      let res: Response;
      try {
        res = await fetch(pdfUrl(file.path, o), { cache: "no-store", credentials: "same-origin" });
      } catch {
        throw new Error("Cannot reach the viewer server.");
      }
      if (!res.ok) throw new Error(await errorDetail(res));
      const blob = await res.blob();
      if (blob.type !== "application/pdf") throw new Error("The server did not return a PDF.");
      const stem = file.name.replace(/\.[^.]+$/, "") || file.name;
      const name = filenameFrom(res, `${stem}.pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      const mErr = Number(res.headers.get("x-pdf-mermaid-errors") ?? 0);
      const iErr = Number(res.headers.get("x-pdf-image-errors") ?? 0);
      const warn = [
        mErr ? `${mErr} diagram${mErr === 1 ? "" : "s"} failed to render` : "",
        iErr ? `${iErr} image${iErr === 1 ? "" : "s"} missing` : "",
      ].filter(Boolean);
      if (warn.length) toast.warning(`Downloaded ${name}`, { id, description: warn.join(", ") });
      else toast.success(`Downloaded ${name}`, { id, description: undefined });
    } catch (e) {
      toast.error("PDF export failed", { id, description: (e as Error).message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const keepOpen = (e: Event) => e.preventDefault();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1 px-2" aria-label="Download PDF" disabled={busy}>
              {busy ? <Loader2Icon className="animate-spin" /> : <FileDownIcon />}
              <span className="hidden text-xs sm:inline">PDF</span>
              <ChevronDownIcon className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{busy ? "Generating PDF..." : "Download as PDF"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem disabled={busy} onSelect={() => download(opts)}>
          {busy ? <Loader2Icon className="animate-spin" /> : <FileDownIcon />} Download PDF
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Paper</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={opts.paper} onValueChange={(v) => update({ paper: v as PdfOptions["paper"] })}>
          <DropdownMenuRadioItem value="a4" onSelect={keepOpen}>
            A4
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="letter" onSelect={keepOpen}>
            Letter
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Orientation</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={opts.orientation}
          onValueChange={(v) => update({ orientation: v as PdfOptions["orientation"] })}
        >
          <DropdownMenuRadioItem value="auto" onSelect={keepOpen}>
            Auto (fit diagrams)
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="portrait" onSelect={keepOpen}>
            Portrait
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="landscape" onSelect={keepOpen}>
            Landscape
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={opts.toc}
          onCheckedChange={(c) => update({ toc: c === true })}
          onSelect={keepOpen}
        >
          Include table of contents
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
