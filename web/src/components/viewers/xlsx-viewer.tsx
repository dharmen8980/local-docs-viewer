"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorMessage, rawUrl } from "@/lib/api";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { DataTable } from "./data-table";

export function XlsxViewer({ file, reloadKey }: ViewerProps) {
  const { data, error, loading } = useAsync(file.path, reloadKey, (signal) => api.xlsx(file.path, signal));
  const [tab, setTab] = useState<string | null>(null);
  if (!data) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return loading ? <ViewerLoading /> : null;
  }
  const download = (
    <Button asChild size="sm" variant="outline">
      <a href={rawUrl(file.path)} download={file.name}>
        <DownloadIcon /> Download .xlsx
      </a>
    </Button>
  );
  if (!data.sheets.length) {
    return (
      <div className="space-y-3 p-6 text-sm text-muted-foreground">
        <p>This workbook has no sheets.</p>
        {download}
      </div>
    );
  }
  const active = tab && data.sheets.some((s) => s.name === tab) ? tab : data.sheets[0].name;
  return (
    <Tabs value={active} onValueChange={setTab} className="space-y-3 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <TabsList>
          {data.sheets.map((s) => (
            <TabsTrigger key={s.name} value={s.name}>
              {s.name}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="ml-auto">{download}</div>
      </div>
      {data.sheets.map((s) => (
        <TabsContent key={s.name} value={s.name} className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{s.total_rows.toLocaleString()} rows</span>
            {s.truncated ? <Badge variant="secondary">showing first {s.rows.length.toLocaleString()} rows</Badge> : null}
          </div>
          {s.rows.length ? (
            <DataTable header={s.rows[0]} rows={s.rows.slice(1)} />
          ) : (
            <p className="text-sm text-muted-foreground">Empty sheet.</p>
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}
