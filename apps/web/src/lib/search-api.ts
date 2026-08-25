import { api } from "./api";
import type { SearchEntity, SearchResponse } from "@hmis/contracts";

/** The route answers the response shape plus the audit row's id (T5). */
export type PaletteResponse = SearchResponse & { auditId: string };

export async function runSearch(raw: string, limit = 5): Promise<PaletteResponse> {
  return api<PaletteResponse>("GET", `/search?q=${encodeURIComponent(raw)}&limit=${limit}`);
}

/**
 * PLAN 11h T5/T8 — record which result was actually taken.
 *
 * IT IS FIRE-AND-FORGET ON PURPOSE, and it is the one call in this feature that may be. The audit
 * ROW is written server-side before the response is returned and is never at risk; this second
 * call only annotates it with which hit was opened. Blocking a navigation on it would make the
 * palette feel slower to serve a record nobody reads in real time, and a failure here loses an
 * annotation rather than an access log.
 */
export function recordOpened(auditId: string, entity: SearchEntity, id: string): void {
  void api("POST", "/search/opened", { auditId, entity, id }).catch(() => {
    /* an annotation is not worth an error toast at a busy counter */
  });
}
