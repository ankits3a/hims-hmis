import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { events, pharmacyDispenses } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { cashierDay, collectionsBlind, listSessions, liveExpectedCashPaise, mayReadExpectedCash } from "../billing";
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
 *     formula (`liveExpectedCashPaise`, D5) — once counted, or to a drawer supervisor (blind count,
 *     OWNER RULING 2026-09-28). Null when I hold none.
 *
 * Read-only, and nothing new is stored: a figure on this strip that disagreed with the close would
 * be a figure nobody could defend.
 */
export type MyShift = {
  day: string;
  handedOver: number;
  /** Both ABSENT while my drawer is uncounted, unless I supervise drawers (blind count, below). */
  takenPaise?: number;
  byMode?: { cash: number; upi: number; card: number };
  receipts: number;
  returns: number;
  refunds: number;
  /** `expectedCashPaise` is ABSENT before the count unless the reader supervises drawers (blind count, below). */
  drawer: { status: string; openingFloatPaise: number; expectedCashPaise?: number } | null;
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
  /*
   * OWNER RULING 2026-09-28 — BLIND COUNT. A pharmacist's drawer is a cashier's drawer: before her
   * count is submitted the strip does not carry what it should hold — the key is left off the
   * response, so `GET /pharmacy/summary/mine` has nothing to read. `mayReadExpectedCash` (billing)
   * is the one rule: a `billing.session.read` holder, or any drawer already counted, still gets it.
   */
  const drawer = session === undefined ? null : {
    status: session.status, openingFloatPaise: session.openingFloatPaise,
    ...(await mayReadExpectedCash(db, actor, session) ? { expectedCashPaise: await liveExpectedCashPaise(db, session) } : {}),
  };
  /*
   * OWNER RULING 2026-09-28 — BLIND COUNT, "COLLECTED TODAY". Float + money taken is what her drawer
   * should hold, so while it is uncounted the money she took (total and by tender) is left off; the
   * receipt count and hand-overs stay. Billing's `collectionsBlind` is the one rule.
   */
  const blind = await collectionsBlind(db, actor, actor, day);
  return {
    day, handedOver: done?.n ?? 0, ...(blind ? {} : { takenPaise: money.totalPaise, byMode: { ...money.byMode } }), receipts: money.receipts,
    returns, refunds, drawer,
  };
}
