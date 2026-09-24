import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { events, pharmacyDispenses } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { cashierDay, listSessions, liveExpectedCashPaise } from "../billing";
import { istDateOf } from "./config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P1 — "SALES TODAY", THE PHARMACIST'S OWN SHIFT ═══
 *
 * The desk's idle rail carries the board's "your day". `GET /pharmacy/summary` answers for the
 * COUNTER (every pharmacist's hand-overs); this answers for the PERSON at the window, from the same
 * sources the rest of the hospital already trusts:
 *
 *   - hand-overs: `pharmacy_dispenses.handed_over_by` = me, inside today's IST window;
 *   - money taken, by tender: billing's `cashierDay` — the fold the billing desk card reads, over
 *     receipts this person received today, entered-in-error excluded;
 *   - returns and refunds: the counter's own events with me as the actor — a sealed pack taken back
 *     (`dispense.line_returned`, `retail.line_returned`) and a paid ticket refunded
 *     (`dispense.cancelled` carrying a credit note);
 *   - the drawer: my open (or closing) cash session, and what it should hold NOW by the close's own
 *     formula (`liveExpectedCashPaise`, D5). Null when I hold none.
 *
 * Read-only, and nothing new is stored: a figure on this strip that disagreed with the close would
 * be a figure nobody could defend.
 */
export type MyShift = {
  day: string;
  handedOver: number;
  takenPaise: number;
  byMode: { cash: number; upi: number; card: number };
  receipts: number;
  returns: number;
  refunds: number;
  drawer: { status: string; openingFloatPaise: number; expectedCashPaise: number } | null;
};

export async function myShift(db: Db, actor: Actor, now: Date): Promise<MyShift> {
  const day = istDateOf(now);
  const { start, end } = istDayWindow(now);
  const [done] = await db.select({ n: sql<number>`count(*)::int` }).from(pharmacyDispenses).where(and(
    eq(pharmacyDispenses.handedOverBy, actor.id), gte(pharmacyDispenses.handedOverAt, start), lt(pharmacyDispenses.handedOverAt, end),
  ));
  const money = await cashierDay(db, actor.id, day);
  const evs = await db.select({ name: events.name, payload: events.payload }).from(events).where(and(
    eq(events.module, "pharmacy"), eq(events.actorId, actor.id),
    inArray(events.name, ["dispense.line_returned", "retail.line_returned", "dispense.cancelled"]),
    gte(events.occurredAt, start), lt(events.occurredAt, end), gte(events.recordedAt, start),
  ));
  const returns = evs.filter((e) => e.name !== "dispense.cancelled").length;
  const refunds = evs.filter((e) => e.name === "dispense.cancelled" && typeof (e.payload as { creditNoteId?: unknown }).creditNoteId === "string").length;

  const session = (await listSessions(db, { cashierUserId: actor.id })).find((s) => s.status === "open" || s.status === "closing");
  const drawer = session === undefined ? null : {
    status: session.status, openingFloatPaise: session.openingFloatPaise, expectedCashPaise: await liveExpectedCashPaise(db, session),
  };
  return {
    day, handedOver: done?.n ?? 0, takenPaise: money.totalPaise, byMode: { ...money.byMode }, receipts: money.receipts,
    returns, refunds, drawer,
  };
}
