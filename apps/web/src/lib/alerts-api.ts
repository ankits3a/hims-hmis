import { api } from "./api";

/**
 * The alerts wire contract (Plan 08.5 D6/D9), transcribed from the route contract T4's gate
 * measured over HTTP (plan-08.5-findings-inbox.md, "T4 coder … for T5"): `GET /alerts` returns
 * `{ items, unreadCount }` with `items` capped at 50 server-side and `unreadCount` a SEPARATE,
 * uncapped count — this file describes the shape, it does not re-derive it. `AlertRow` carries
 * no `userId` on the wire (identity-scoped by the auth token, D6) and no patient identity (L8).
 */
export type AlertAckKind = "seen" | "owned" | "handed_over";

export type WireAlert = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  readAt: string | null;
  /**
   * PHASE O T3 — the answer, if one was given. `readAt` says this browser rendered the row;
   * these say a human took a position on it, which is the only thing that stops the obligation
   * spine's respond clock. Optional on the wire: a tab left open across a deploy can briefly
   * talk to an API that does not send them yet.
   */
  ackKind?: AlertAckKind | null;
  acknowledgedAt?: string | null;
  ownedUntil?: string | null;
  ackNote?: string | null;
  handedToUserId?: string | null;
  ackExtensions?: number;
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

/** `POST /alerts/:id/ack`'s body. `untilMinutes` is required for `owned` and refused above a day. */
export type WireAckInput = {
  kind: AlertAckKind;
  untilMinutes?: number;
  note?: string;
  /** Exactly one of the two for `handed_over`. The bell sends the badge number (T9 ships a picker). */
  handedToUserId?: string;
  handedToStaffCode?: string;
};

/**
 * `changed: false` is a real answer, not a failure: a second `seen`, or a glance over somebody's
 * standing promise, reports the state that stands and writes nothing (R8).
 */
export type WireAckResult = {
  alertId: string;
  kind: AlertAckKind;
  acknowledgedAt: string;
  ownedUntil: string | null;
  handedToUserId: string | null;
  ackExtensions: number;
  changed: boolean;
};

export function acknowledgeAlert(id: string, input: WireAckInput, idempotencyKey: string): Promise<WireAckResult> {
  return api("POST", `/alerts/${id}/ack`, input, idempotencyKey);
}
