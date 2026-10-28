"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangleIcon, DownloadIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, rawUrl, type FileInfo } from "@/lib/api";

export interface ViewerProps {
  file: FileInfo;
  /** Increments when the file changed on disk; viewers refetch in place. */
  reloadKey: number;
}

export function ViewerError({
  title = "Could not display this file",
  message,
  file,
  children,
}: {
  title?: string;
  message: string;
  file?: FileInfo;
  children?: ReactNode;
}) {
  return (
    <div className="p-6">
      <Alert variant="destructive">
        <AlertTriangleIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <p className="break-words">{message}</p>
          {children}
          {file ? (
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href={rawUrl(file.path)} download={file.name}>
                <DownloadIcon /> Download raw file
              </a>
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function ViewerLoading({ lines = 10 }: { lines?: number }) {
  return (
    <div className="space-y-2 p-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 37) % 45)}%` }} />
      ))}
    </div>
  );
}

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

/**
 * Fetch helper that keeps the previous data while a reload is in flight (so a
 * live re-render does not flash a skeleton or lose the scroll position).
 * `key` identifies the resource; data is cleared only when the key changes.
 */
export function useAsync<T>(
  key: string,
  reloadKey: number,
  fn: (signal: AbortSignal) => Promise<T>,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T> & { key: string }>({
    data: null,
    error: null,
    loading: true,
    key,
  });
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) =>
      s.key === key ? { ...s, loading: true } : { data: null, error: null, loading: true, key },
    );
    fnRef
      .current(ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ data, error: null, loading: false, key });
      })
      .catch((error) => {
        if (ctrl.signal.aborted || (error as Error)?.name === "AbortError") return;
        setState((s) => ({ data: s.key === key ? s.data : null, error, loading: false, key }));
      });
    return () => ctrl.abort();
  }, [key, reloadKey]);

  if (state.key !== key) return { data: null, error: null, loading: true };
  return state;
}

export { errorMessage };
