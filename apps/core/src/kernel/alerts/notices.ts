import { and, desc, eq, gte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../db/client";
import { alerts } from "../db/schema";
import { appendEvent } from "../events/append";
import { alertRaised } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══ A NOTICE THE CLOCK RAISES (owner 2026-10-07, "now move ahead") ═══
 *
 * Every other bell row is the echo of an EVENT: `alertsConsumer` turns a fact somebody appended into
 * a row per recipient, and `(source_event_id, user_id)` is what makes a redelivery harmless. A duty
 * reminder and "patients are waiting and you are not in" have no such event — nothing HAPPENED at
 * 19:00, the clock simply reached it. So a sweep raises the row itself, and the key it passes here
 * stands where the event id stands: the SAME unique pair absorbs a second tick, a second worker and
 * a restart. `source_event_id` is plain text and was never a foreign key, for the reason the roster
 * flag's row gives.
 *
 * ONLY A WON INSERT APPENDS `alert.raised` — the rule `raiseAlerts` keeps, for the same reason: the
 * web bell's tail and the phone relay both hang off that event, and a tick that re-announced a
 * notice every minute would be a buzzer.
 *
 * GC6 HOLDS HERE TOO. Title and body are built by the caller from staff names, duty instants and
 * COUNTS. No patient's name, UHID or token belongs in one, and none is passed.
 */
const NOTICES_ACTOR: Actor = { type: "system", id: "kernel-alerts" };

export type Notice = {
  userId: string; kind: string; title: string; body: string; refType: string; refId: string;
  /** Stands where the event id stands. The same key for the same person raises nothing twice. */
  sourceKey: string;
  /** The sweep's own instant — the row is dated by the tick that raised it, so pacing reads one clock. */
  at: Date;
};

/** True when the row was written (and announced); false when this key had already been raised for this person. */
export async function raiseNotice(db: Db, n: Notice): Promise<boolean> {
  return withTx(db, async (tx) => {
    const inserted = await tx.insert(alerts).values({
      id: newId(), userId: n.userId, kind: n.kind, title: n.title, body: n.body,
      refType: n.refType, refId: n.refId, sourceEventId: n.sourceKey, createdAt: n.at,
    }).onConflictDoNothing({ target: [alerts.sourceEventId, alerts.userId] }).returning({ id: alerts.id });
    const row = inserted[0];
    if (row === undefined) return false;
    await appendEvent(tx, alertRaised.make({
      actor: NOTICES_ACTOR,
      payload: { alertId: row.id, userId: n.userId, kind: n.kind, refType: n.refType, refId: n.refId, sourceEventId: n.sourceKey },
    }));
    return true;
  });
}

/** How a repeating notice paces itself: the newest row of this kind about this subject, and how many since `since`. */
export async function noticeHistory(
  db: Db, userId: string, kind: string, refId: string, since: Date,
): Promise<{ lastAt: Date | null; count: number }> {
  const where = and(eq(alerts.userId, userId), eq(alerts.kind, kind), eq(alerts.refId, refId), gte(alerts.createdAt, since));
  const last = await db.select({ at: alerts.createdAt }).from(alerts).where(where).orderBy(desc(alerts.createdAt)).limit(1);
  const n = await db.select({ n: sql<number>`count(*)::int` }).from(alerts).where(where);
  return { lastAt: last[0]?.at ?? null, count: n[0]?.n ?? 0 };
}
