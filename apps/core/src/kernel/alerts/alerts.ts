import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { withTx } from "../db/client";
import { alerts, users } from "../db/schema";
import { appendEvent } from "../events/append";
import { alertAcknowledged, alertRead } from "./events";
import type { AlertAckKind } from "../db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * BOUNDED BY CONSTRUCTION (D6). The bell reads the newest page and the badge is a separate
 * COUNT, so an unbounded list route never exists here — the carried-forward unpaginated-route
 * complaint does not get a fourth specimen.
 */
export const ALERTS_PAGE_LIMIT = 50;

export type AlertsErrorCode =
  | "unknown_alert"
  /** G5 — two re-owns, then the role ladder climbs whatever the owner promises next. */
  | "ack_limit"
  | "own_requires_until"
  | "handover_requires_user"
  | "handover_to_self"
  | "unknown_handover_user"
  | "already_handed_over";

/**
 * How many times one person may RE-DATE an alert they own. G5: *"acknowledge with an ETA and
 * extend forever"* is the oldest way to make a queue look attended, so the promise is bounded —
 * the first `owned` is free, two re-owns are recorded, and the third is refused. What happens
 * after the refusal is not this function's business: the respond timer simply runs out and T1's
 * ladder climbs, which is the behaviour the limit exists to restore.
 */
export const ALERT_OWN_EXTENSION_LIMIT = 2;

export class AlertsError extends Error {
  constructor(
    readonly code: AlertsErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AlertsError";
  }
}

export type AlertRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: Date;
  readAt: Date | null;
  /** T3 — the answer, if one was given. `null` here is the whole of "nobody has said anything". */
  ackKind: AlertAckKind | null;
  acknowledgedAt: Date | null;
  ownedUntil: Date | null;
  ackNote: string | null;
  handedToUserId: string | null;
  ackExtensions: number;
};

export type AcknowledgeInput = {
  kind: AlertAckKind;
  /** Required for `owned` and meaningless otherwise: how long the owner is claiming. */
  untilMinutes?: number;
  note?: string;
  /**
   * Required for `handed_over`: the person taking it on, named EITHER by id or by the staff code
   * on their badge. Never the acknowledger.
   *
   * DECIDED (phase O T3) — THE STAFF CODE IS RESOLVED HERE AND NOT IN THE BROWSER. A user picker
   * is T9's; until then the bell asks for a typed staff code, and the obvious shortcut — let the
   * bell search a staff directory and post an id — would hand every alert reader a roster of
   * everybody's name and id for a feature that needs neither. The code goes to the server, the
   * server answers yes or no, and a wrong code is `unknown_handover_user` either way.
   */
  handedToUserId?: string;
  handedToStaffCode?: string;
};

export type AcknowledgeResult = {
  alertId: string;
  kind: AlertAckKind;
  acknowledgedAt: Date;
  ownedUntil: Date | null;
  handedToUserId: string | null;
  ackExtensions: number;
  /** False when the call was a no-op — a repeat `seen`, or a `seen` over something stronger. */
  changed: boolean;
};

/**
 * Own alerts only, unread first then newest first, capped at ALERTS_PAGE_LIMIT. `unreadCount` is
 * a separate COUNT and is deliberately NOT capped by the page limit — the badge must be true
 * even when the page is full.
 *
 * The scoping is the `user_id` predicate and nothing else: access here is IDENTITY-scoped, not
 * permission-gated (D6), so this WHERE clause is the whole access model for reads.
 */
export async function listAlerts(
  db: Db,
  userId: string,
): Promise<{ items: AlertRow[]; unreadCount: number }> {
  const items = await db
    .select({
      id: alerts.id,
      kind: alerts.kind,
      title: alerts.title,
      body: alerts.body,
      refType: alerts.refType,
      refId: alerts.refId,
      createdAt: alerts.createdAt,
      readAt: alerts.readAt,
      ackKind: sql<AlertAckKind | null>`${alerts.ackKind}`,
      acknowledgedAt: alerts.acknowledgedAt,
      ownedUntil: alerts.ownedUntil,
      ackNote: alerts.ackNote,
      handedToUserId: alerts.handedToUserId,
      ackExtensions: alerts.ackExtensions,
    })
    .from(alerts)
    .where(eq(alerts.userId, userId))
    // `false` sorts before `true` in ASC, so unread (read_at is null) leads.
    .orderBy(sql`${alerts.readAt} is not null`, desc(alerts.createdAt))
    .limit(ALERTS_PAGE_LIMIT);

  const counted = await db
    .select({ unreadCount: sql<number>`count(*)::int` })
    .from(alerts)
    .where(and(eq(alerts.userId, userId), isNull(alerts.readAt)));

  return { items, unreadCount: counted[0]!.unreadCount };
}

/**
 * Naturally idempotent, so the route takes NO idempotency claim (D6): a conditional
 * `UPDATE … WHERE id AND user_id AND read_at IS NULL RETURNING`. A won update appends
 * `alert.read` in the SAME transaction; a repeat is a no-op that appends nothing.
 *
 * ANOTHER USER'S ALERT ID IS A 404, NOT A 403 — a 403 would confirm that the id exists, which
 * is an existence leak on another user's data. The empty RETURNING is ambiguous (mine and
 * already read vs not mine at all), so the ambiguity is resolved by an OWNED read, and only the
 * owned read can produce the no-op result.
 */
export async function markAlertRead(
  db: Db,
  actor: Actor,
  alertId: string,
  now: Date = new Date(),
): Promise<{ alertId: string; readAt: Date; alreadyRead: boolean }> {
  return withTx(db, async (tx) => {
    const claimed = await tx
      .update(alerts)
      .set({ readAt: now })
      .where(and(eq(alerts.id, alertId), eq(alerts.userId, actor.id), isNull(alerts.readAt)))
      .returning({ id: alerts.id, readAt: alerts.readAt });

    const won = claimed[0];
    if (won === undefined) {
      const owned = await tx
        .select({ readAt: alerts.readAt })
        .from(alerts)
        .where(and(eq(alerts.id, alertId), eq(alerts.userId, actor.id)));
      const mine = owned[0];
      if (mine === undefined) throw new AlertsError("unknown_alert", `unknown_alert ${alertId}`);
      return { alertId, readAt: mine.readAt!, alreadyRead: true };
    }

    await appendEvent(
      tx,
      alertRead.make({
        actor,
        occurredAt: now,
        payload: { alertId, userId: actor.id },
      }),
    );
    return { alertId, readAt: won.readAt!, alreadyRead: false };
  });
}

/**
 * ═══ T3 — READ IS NOT ANSWERED ═══
 *
 * `markAlertRead` above says a browser rendered the row. This says a human took a position on it,
 * and that is the only thing the obligation spine's respond clock may be stopped by (T1 cancels
 * the `respond` timer on `alert.acknowledged` with kind `seen` or `owned`; the RESOLVE budget is
 * untouched by any ack, because silence and lateness are two different failures).
 *
 * ═══ WHY A ROW LOCK AND NOT A CONDITIONAL UPDATE (R8) ═══
 *
 * `markAlertRead` gets its idempotence free from `WHERE read_at IS NULL` — one predicate decides
 * everything. An ack cannot: whether this call is a no-op, a promotion or a re-own depends on the
 * CURRENT kind, and `ack_extensions` is a counter read before it is written. Two taps racing on a
 * phone and a laptop would otherwise both read 1 and both write 2. `for update` makes the read
 * and the write one decision; R8's second ack then lands as the no-op it is meant to be.
 *
 * ═══ THE STATE RULES, ALL OF THEM ═══
 *
 *   seen         : from unanswered only. Over anything else it is a NO-OP — a glance must never
 *                  quietly demote an owner's promise or undo a handover.
 *   owned        : from unanswered or seen (free), or from owned (a re-own, counted, ≤ 2 — G5).
 *                  Refused once handed over: it is not yours to re-own.
 *   handed_over  : from unanswered, seen or owned. Refused once handed over — the next handover
 *                  is the new holder's act, and they are not this row's user.
 *
 * An ack also marks the alert read if it was not: you cannot answer what you have not seen, and
 * a badge that still counts an owned alert is a badge nobody believes.
 */
export async function acknowledgeAlert(
  db: Db,
  actor: Actor,
  alertId: string,
  input: AcknowledgeInput,
  now: Date = new Date(),
): Promise<AcknowledgeResult> {
  if (input.kind === "owned" && (input.untilMinutes === undefined || input.untilMinutes <= 0)) {
    throw new AlertsError("own_requires_until", "own_requires_until");
  }
  if (input.kind === "handed_over") {
    const named = [input.handedToUserId, input.handedToStaffCode].filter((v) => v !== undefined);
    // Exactly one. Two names for one person is a question about which the server should not
    // guess, and zero is the refusal below.
    if (named.length !== 1) throw new AlertsError("handover_requires_user", "handover_requires_user");
    if (input.handedToUserId === actor.id) throw new AlertsError("handover_to_self", "handover_to_self");
  }

  return withTx(db, async (tx) => {
    // Own row only, and locked. A 404 rather than a 403 for somebody else's id, exactly as
    // `markAlertRead` reasons: a 403 would confirm the id exists on another human's list.
    const held = await tx
      .select({
        ackKind: sql<AlertAckKind | null>`${alerts.ackKind}`,
        acknowledgedAt: alerts.acknowledgedAt,
        ownedUntil: alerts.ownedUntil,
        handedToUserId: alerts.handedToUserId,
        ackExtensions: alerts.ackExtensions,
        readAt: alerts.readAt,
        refType: alerts.refType,
        refId: alerts.refId,
      })
      .from(alerts)
      .where(and(eq(alerts.id, alertId), eq(alerts.userId, actor.id)))
      .for("update");

    const row = held[0];
    if (row === undefined) throw new AlertsError("unknown_alert", `unknown_alert ${alertId}`);

    // A repeat `seen`, or a `seen` over an owner's promise: report the state that stands and
    // append NOTHING. R8's "the second ack is a no-op" is this branch.
    if (input.kind === "seen" && row.ackKind !== null) {
      return {
        alertId,
        kind: row.ackKind,
        acknowledgedAt: row.acknowledgedAt!,
        ownedUntil: row.ownedUntil,
        handedToUserId: row.handedToUserId,
        ackExtensions: row.ackExtensions,
        changed: false,
      };
    }
    if (row.ackKind === "handed_over") throw new AlertsError("already_handed_over", "already_handed_over");

    let extensions = row.ackExtensions;
    if (input.kind === "owned" && row.ackKind === "owned") {
      if (extensions >= ALERT_OWN_EXTENSION_LIMIT) throw new AlertsError("ack_limit", "ack_limit");
      extensions += 1;
    }

    let resolvedHandoverId: string | null = null;
    if (input.kind === "handed_over") {
      const target = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          input.handedToUserId === undefined
            ? eq(users.staffCode, input.handedToStaffCode!)
            : eq(users.id, input.handedToUserId),
        );
      const found = target[0];
      if (found === undefined) throw new AlertsError("unknown_handover_user", "unknown_handover_user");
      // Checked AFTER resolution as well as before it: a staff code is a second name for the
      // same person, and handing to your own badge number is the same non-act as handing to
      // your own id.
      if (found.id === actor.id) throw new AlertsError("handover_to_self", "handover_to_self");
      resolvedHandoverId = found.id;
    }

    const ownedUntil = input.kind === "owned"
      ? new Date(now.getTime() + input.untilMinutes! * 60_000)
      : null;
    const handedToUserId = resolvedHandoverId;

    await tx
      .update(alerts)
      .set({
        ackKind: input.kind,
        acknowledgedAt: now,
        ownedUntil,
        handedToUserId,
        ackNote: input.note ?? null,
        ackExtensions: extensions,
        readAt: row.readAt ?? now,
      })
      .where(eq(alerts.id, alertId));

    await appendEvent(
      tx,
      alertAcknowledged.make({
        actor,
        occurredAt: now,
        payload: {
          alertId,
          userId: actor.id,
          kind: input.kind,
          ownedUntil: ownedUntil === null ? undefined : ownedUntil.toISOString(),
          handedToUserId: handedToUserId ?? undefined,
          refType: row.refType,
          refId: row.refId,
        },
      }),
    );

    return { alertId, kind: input.kind, acknowledgedAt: now, ownedUntil, handedToUserId, ackExtensions: extensions, changed: true };
  });
}
