import { ApiError, api } from "./api";
import type { LinenActResult, LinenBoardView, LinenHandlerView } from "@hmis/contracts";

/* ═══ E2.4 LINEN (issue #728) — `apps/core/src/modules/linen/linen.controller.ts`'s `/linen…`. The web imports only
 * TYPES from `@hmis/contracts`; refusals come back as `{ code }` and the screen shows `linen.refusal.<code>`. ═══ */

export type LinenLine = { itemCode: string; qty: number };

export const fetchLinenBoard = () => api<LinenBoardView>("GET", "/linen/board");
export const fetchLinenHandler = () => api<LinenHandlerView>("GET", "/linen/handler");

/** A fresh key per Save tap: a double tap or a retried request is one act on the server. */
export const newTapKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `tap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const ward = (id: string, verb: "top-up" | "soiled" | "infected" | "count", lines: LinenLine[], idempotencyKey: string) =>
  api<LinenActResult>("POST", `/linen/wards/${encodeURIComponent(id)}/${verb}`, { lines, idempotencyKey });
export const topUpApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "top-up", lines, key);
export const soiledApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "soiled", lines, key);
export const infectedApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "infected", lines, key);
export const countApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "count", lines, key);
export const borrowApi = (fromWardId: string, toWardId: string, lines: LinenLine[], idempotencyKey: string) =>
  api<LinenActResult>("POST", "/linen/borrow", { fromWardId, toWardId, lines, idempotencyKey });
export const sendLaundryApi = (infected: boolean, lines: LinenLine[], idempotencyKey: string) =>
  api<LinenActResult>("POST", "/linen/laundry/batches", { infected, lines, idempotencyKey });
export const receiveLaundryApi = (batchId: string, lines: LinenLine[]) =>
  api<LinenActResult>("POST", `/linen/laundry/batches/${encodeURIComponent(batchId)}/receive`, { lines });
export const requestCondemnApi = (wardId: string, itemCode: string, qty: number, reason: string) =>
  api<{ id: string; state: string }>("POST", "/linen/condemn", { wardId, itemCode, qty, reason });
export const decideCondemnApi = (id: string, verb: "approve" | "reject") =>
  api<{ id: string; state: string }>("POST", `/linen/condemn/${encodeURIComponent(id)}/${verb}`, {});

/** The refusal code a linen door answered with, or null. */
export function linenRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}
