"use client";

import { rawUrl } from "@/lib/api";
import type { ViewerProps } from "./common";

export function PdfViewer({ file, reloadKey }: ViewerProps) {
  return (
    <iframe
      key={`${file.path}:${reloadKey}`}
      title={file.name}
      src={rawUrl(file.path)}
      className="block h-[calc(100svh-3.5rem)] w-full border-0 bg-muted"
    />
  );
}
