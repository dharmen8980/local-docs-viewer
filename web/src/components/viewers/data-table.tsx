"use client";

import { useMemo } from "react";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Row = string[];

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
const helper = createColumnHelper<typeof features, Row>();

/** Sortable table of string cells (CSV / xlsx preview). */
export function DataTable({ header, rows }: { header: string[]; rows: Row[] }) {
  const width = Math.max(header.length, ...rows.slice(0, 200).map((r) => r.length));
  const columns = useMemo(
    () =>
      helper.columns(
        Array.from({ length: width }, (_, i) =>
          helper.accessor((row: Row) => row[i] ?? "", {
            id: `c${i}`,
            header: header[i] || `Column ${i + 1}`,
            sortFn: "alphanumeric",
          }),
        ),
      ),
    [header, width],
  );
  const table = useTable({ features, columns, data: rows });

  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-[13px]">
        <TableHeader className="sticky top-0 z-[1] bg-muted/80 backdrop-blur">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              <TableHead className="w-10 text-right text-muted-foreground">#</TableHead>
              {group.headers.map((h) => {
                const sorted = h.column.getIsSorted();
                return (
                  <TableHead key={h.id} className="whitespace-nowrap">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                      onClick={h.column.getToggleSortingHandler()}
                    >
                      <table.FlexRender header={h} />
                      {sorted === "asc" ? (
                        <ArrowUpIcon className="size-3.5" />
                      ) : sorted === "desc" ? (
                        <ArrowDownIcon className="size-3.5" />
                      ) : (
                        <ArrowUpDownIcon className="size-3.5 opacity-40" />
                      )}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-right text-muted-foreground tabular-nums">{row.index + 1}</TableCell>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className={cn("max-w-[32rem] truncate align-top")} title={String(cell.getValue() ?? "")}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
