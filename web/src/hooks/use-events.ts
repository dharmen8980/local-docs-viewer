"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "@/lib/api";

export type EventsStatus = "connecting" | "open" | "reconnecting";

/**
 * Single EventSource on /api/events. Calls `onChange` for each `change` event
 * and `onReconnect` whenever the stream comes back after a drop (so the caller
 * can resync anything it may have missed). Reconnects with backoff when the
 * browser gives up on its own retry; `onClosed` runs each time it gives up (e.g. the
 * server answered 409 "no folder selected"), so the caller can re-check the config.
 */
export function useEvents(
  onChange: (ev: ChangeEvent) => void,
  onReconnect?: () => void,
  onClosed?: () => void,
): EventsStatus {
  const [status, setStatus] = useState<EventsStatus>("connecting");
  const changeRef = useRef(onChange);
  const reconnectRef = useRef(onReconnect);
  const closedRef = useRef(onClosed);
  useEffect(() => {
    changeRef.current = onChange;
    reconnectRef.current = onReconnect;
    closedRef.current = onClosed;
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
