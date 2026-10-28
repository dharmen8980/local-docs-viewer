"use client";

import { useState } from "react";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rawUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ViewerError, type ViewerProps } from "./common";

export function ImageViewer({ file, reloadKey }: ViewerProps) {
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Cache-bust on live reloads so the browser fetches the new bytes.
  const src = `${rawUrl(file.path)}&v=${Math.round(file.mtime)}-${reloadKey}`;
  if (failed === src) return <ViewerError message="The image could not be loaded or decoded." file={file} />;
  return (
    <div className="print-area p-4 md:p-6">
      <div className="no-print mb-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setActual((a) => !a)}>
          {actual ? <Minimize2Icon /> : <Maximize2Icon />}
          {actual ? "Fit to width" : "Actual size"}
        </Button>
      </div>
      <div className={cn("rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-2", actual && "overflow-auto")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={file.name}
          onError={() => setFailed(src)}
          className={cn("mx-auto", actual ? "max-w-none" : "max-w-full h-auto")}
        />
      </div>
    </div>
  );
}
