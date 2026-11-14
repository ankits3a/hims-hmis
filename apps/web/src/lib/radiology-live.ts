import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { useRealtime } from "./realtime";

/**
 * #1083 (IM6a) — the imaging lists go live. The three topics `apps/core` radiology `realtime.ts` routes
 * (one space, `imaging`, gated on `radiology.worklist.read`):
 *
 *   · `imaging:floor`   — the desk, the prep bay and the modality rooms;
 *   · `imaging:read`    — the reading room;
 *   · `imaging:release` — the hand-over desk.
 */
export const IMAGING_FLOOR_TOPIC = "imaging:floor";
export const IMAGING_READ_TOPIC = "imaging:read";
export const IMAGING_RELEASE_TOPIC = "imaging:release";
export type ImagingTopic = typeof IMAGING_FLOOR_TOPIC | typeof IMAGING_READ_TOPIC | typeof IMAGING_RELEASE_TOPIC;

/**
 * ═══ A NEW ORDER IS READ TWICE ═══
 *
 * `order.placed` reaches the socket before the study it orders exists: the study is created by
 * radiology's consumer in the worker, whose dispatcher runs every 2 s, while the gateway's tail reads
 * every 300 ms. A list read on that frame alone would usually come back without the new (often STAT)
 * row and leave it to the poll, which is the wait this slice exists to remove. So the list is read
 * now and once more after `ORDER_SETTLE_MS`, by which time the consumer has run.
 */
export const ORDER_SETTLE_MS = 4_000;

/**
 * Refetch a screen's LIST queries when a frame arrives on its topic. A frame is a hint, never the row:
 * the list is read again from the server, and the screen's own poll stays the fallback for a dropped
 * socket. Keys match EXACTLY, so the study in hand (a form someone is typing into) is never re-read
 * under them by a frame about somebody else.
 */
export function useImagingLive(topic: ImagingTopic, lists: readonly QueryKey[]): { connected: boolean } {
  const qc = useQueryClient();
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (again.current !== null) clearTimeout(again.current); }, []);
  return useRealtime([topic], (f) => {
    const read = (): void => { for (const queryKey of lists) void qc.invalidateQueries({ queryKey, exact: true }); };
    read();
    if (f.name === "order.placed") {
      if (again.current !== null) clearTimeout(again.current);
      again.current = setTimeout(() => { again.current = null; read(); }, ORDER_SETTLE_MS);
    }
  });
}
