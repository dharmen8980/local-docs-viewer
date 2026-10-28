"use client";

import { DownloadIcon, FileQuestionIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes, formatTime, rawUrl } from "@/lib/api";
import type { ViewerProps } from "./common";

export function BinaryViewer({ file }: ViewerProps) {
  return (
    <div className="flex flex-col items-center gap-3 p-10 text-center">
      <FileQuestionIcon className="size-10 text-muted-foreground" />
      <div>
        <div className="font-medium">{file.name}</div>
        <div className="text-sm text-muted-foreground">
          Binary file ({file.mime || "unknown type"}), {formatBytes(file.size)}, modified {formatTime(file.mtime)}
        </div>
      </div>
      <p className="max-w-md text-sm text-muted-foreground">This file type cannot be previewed.</p>
      <Button asChild variant="outline">
        <a href={rawUrl(file.path)} download={file.name}>
          <DownloadIcon /> Download
        </a>
      </Button>
    </div>
  );
}
