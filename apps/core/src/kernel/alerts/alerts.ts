import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { withTx } from "../db/client";
import { alerts } from "../db/schema";
import { appendEvent } from "../events/append";
import { alertRead } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * BOUNDED BY CONSTRUCTION (D6). The bell reads the newest page and the badge is a separate
 * COUNT, so an unbounded list route never exists here — the carried-forward unpaginated-route
 * complaint does not get a fourth specimen.
 */
export const ALERTS_PAGE_LIMIT = 50;

export type AlertsErrorCode = "unknown_alert";

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
