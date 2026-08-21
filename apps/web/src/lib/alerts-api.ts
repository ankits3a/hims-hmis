import { api } from "./api";

/**
 * The alerts wire contract (Plan 08.5 D6/D9), transcribed from the route contract T4's gate
 * measured over HTTP (plan-08.5-findings-inbox.md, "T4 coder … for T5"): `GET /alerts` returns
 * `{ items, unreadCount }` with `items` capped at 50 server-side and `unreadCount` a SEPARATE,
 * uncapped count — this file describes the shape, it does not re-derive it. `AlertRow` carries
 * no `userId` on the wire (identity-scoped by the auth token, D6) and no patient identity (L8).
 */
export type WireAlert = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  readAt: string | null;
};

export type WireAlertsList = { items: WireAlert[]; unreadCount: number };

/** `POST /alerts/:id/read`'s body. A repeat is a no-op that still reports `alreadyRead: true`. */
export type WireMarkReadResult = { alertId: string; readAt: string; alreadyRead: boolean };

export function listAlerts(): Promise<WireAlertsList> {
  return api("GET", "/alerts");
}

/**
 * `idempotencyKey` is `SubmitButton`'s minted attempt key. The server ignores it on this route —
 * the conditional `UPDATE … WHERE read_at IS NULL` is already idempotent (D6) — carried anyway
 * because `SubmitButton` is a write-lane convention, not a per-route judgement call (D11).
 */
export function markAlertRead(id: string, idempotencyKey: string): Promise<WireMarkReadResult> {
  return api("POST", `/alerts/${id}/read`, undefined, idempotencyKey);
}
