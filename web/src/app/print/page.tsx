import type { Metadata } from "next";
import { Suspense } from "react";
import { PrintDocument } from "@/components/print-document";

// Print layout used by the server-side PDF export (/api/pdf drives headless Chrome
// to this page). It renders only the document, always in the light theme.
export const metadata: Metadata = { title: "Print" };

export default function PrintPage() {
  return (
    <Suspense fallback={null}>
      <PrintDocument />
    </Suspense>
  );
}
