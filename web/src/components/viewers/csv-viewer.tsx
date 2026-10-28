"use client";

import { Badge } from "@/components/ui/badge";
import { api, errorMessage } from "@/lib/api";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { DataTable } from "./data-table";

export function CsvViewer({ file, reloadKey }: ViewerProps) {
  const { data, error, loading } = useAsync(file.path, reloadKey, (signal) => api.csv(file.path, signal));
  if (!data) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return loading ? <ViewerLoading /> : null;
  }
  return (
    <div className="space-y-3 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>
          {data.total_rows.toLocaleString()} rows, {data.header.length} columns
        </span>
        {data.truncated ? (
          <Badge variant="secondary">showing first {data.rows.length.toLocaleString()} rows</Badge>
        ) : null}
        <span className="text-xs">Click a column header to sort.</span>
      </div>
      <DataTable header={data.header} rows={data.rows} />
    </div>
  );
}
