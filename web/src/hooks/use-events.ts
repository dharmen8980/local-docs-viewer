"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "@/lib/api";
import type { SeenEvent } from "@/lib/seen-store";

export type EventsStatus = "connecting" | "open" | "reconnecting";

/**
 * Single EventSource on /api/events. Calls `onChange` for each `change` event
 * and `onReconnect` whenever the stream comes back after a drop (so the caller
 * can resync anything it may have missed). Reconnects with backoff when the
 * browser gives up on its own retry; `onClosed` runs each time it gives up (e.g. the
 * server answered 409 "no folder selected"), so the caller can re-check the config.
 * `onSeen` gets the `seen` events (changes history written by any tab or browser).
 */
export function useEvents(
  onChange: (ev: ChangeEvent) => void,
  onReconnect?: () => void,
  onClosed?: () => void,
  onSeen?: (ev: SeenEvent) => void,
): EventsStatus {
  const [status, setStatus] = useState<EventsStatus>("connecting");
  const changeRef = useRef(onChange);
  const reconnectRef = useRef(onReconnect);
  const closedRef = useRef(onClosed);
  const seenRef = useRef(onSeen);
  useEffect(() => {
    changeRef.current = onChange;
    reconnectRef.current = onReconnect;
    closedRef.current = onClosed;
    seenRef.current = onSeen;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let hadConnection = false;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource("/api/events");
      es.addEventListener("open", () => {
        attempts = 0;
        setStatus("open");
        if (hadConnection) reconnectRef.current?.();
        hadConnection = true;
      });
      es.addEventListener("change", (msg) => {
        try {
          const data = JSON.parse((msg as MessageEvent<string>).data) as ChangeEvent;
          changeRef.current({
            version: data.version,
            added: data.added ?? [],
            modified: data.modified ?? [],
            deleted: data.deleted ?? [],
            renames: data.renames ?? [],
            dirs_changed: Boolean(data.dirs_changed),
          });
        } catch {
          /* ignore malformed event */
        }
      });
      es.addEventListener("seen", (msg) => {
        try {
          const data = JSON.parse((msg as MessageEvent<string>).data) as SeenEvent;
          if (Array.isArray(data.paths)) seenRef.current?.({ paths: data.paths, client: data.client ?? null, cleared: data.cleared === true });
        } catch {
          /* ignore malformed event */
        }
      });
      es.addEventListener("error", () => {
        setStatus("reconnecting");
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          const delay = Math.min(30000, 1000 * 2 ** attempts);
          attempts++;
          retryTimer = setTimeout(connect, delay);
          closedRef.current?.();
        }
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  return status;
}
