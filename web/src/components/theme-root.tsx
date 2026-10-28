"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ThemeProvider } from "next-themes";

/** The PDF print route is always rendered in the light theme. */
export function ThemeRoot({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const print = pathname === "/print" || pathname?.startsWith("/print/");
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      forcedTheme={print ? "light" : undefined}
    >
      {children}
    </ThemeProvider>
  );
}
