import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { events, pharmacyDispenses, pharmacyRegH1 } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { isIsoDate } from "./config";
import { PharmacyError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P7 — THE COUNTER'S DAY, IN ONE READ ═══
 *
 * Doc 16 §8's KPIs and §14's 16f digest, first strip. Phase doc
 * `docs/superpowers/plans/2026-09-16-phase-pharmacy-p7-counter-summary.md`. For one IST day it
 * reports:
 *   - what was handed over, and the median minutes queue → hand-over and claim → hand-over (the
 *     patient's wait, and the counter's own);
 *   - what was billed (the `dispense.billed` events' net);
 *   - what is open NOW, by status (the backlog is a now-question, not a day-question);
 *   - declined lines, with the five commonest reasons. Doc 16 calls declines "the replenishment list
 *     nobody has yet", and P4's reorder list is its other half;
 *   - substitutions, cancellations (and how many came after the bill, i.e. P5's refunds), returns
 *     (P6), partly-checked lines (P3), and Schedule H1 hand-overs (the register's rows).
 *
 * Every figure is the counter's own. Rows are windowed on the columns the acts wrote with their
 * injected clock, and events on `occurred_at`, which the counter now stamps with that same clock.
 * `recorded_at` bounds the partition scan, because an event is never recorded before it occurred.
 */
export type CounterSummary = {
  day: string;
  handedOver: number;
  medianMinutes: { queueToHandover: number | null; claimToHandover: number | null };
  billedPaise: number;
  open: { queued: number; claimed: number; verified: number; picked: number; billed: number };
  declinedLines: number;
  declinedTop: { reason: string; lines: number }[];
  substitutions: number;
  cancelled: number;
  refundedAfterBilling: number;
  returns: number;
  partlyCheckedLines: number;
  scheduledHandovers: number;
};

const OPEN = ["queued", "claimed", "verified", "picked", "billed"] as const;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const minutes = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / 60_000);

export async function counterSummary(db: Db, day: string): Promise<CounterSummary> {
  if (!isIsoDate(day)) {
    throw new PharmacyError("invalid_day", `"${day}" is not a date (YYYY-MM-DD)`);
  }
  const { start, end } = istDayWindow(new Date(`${day}T12:00:00+05:30`));

  const done = await db.select({
    createdAt: pharmacyDispenses.createdAt, claimedAt: pharmacyDispenses.claimedAt, handedOverAt: pharmacyDispenses.handedOverAt,
  }).from(pharmacyDispenses).where(and(gte(pharmacyDispenses.handedOverAt, start), lt(pharmacyDispenses.handedOverAt, end)));

  const openRows = await db.select({ status: pharmacyDispenses.status, n: sql<number>`count(*)::int` })
    .from(pharmacyDispenses).where(inArray(pharmacyDispenses.status, [...OPEN])).groupBy(pharmacyDispenses.status);
  const open = { queued: 0, claimed: 0, verified: 0, picked: 0, billed: 0 };
  for (const r of openRows) open[r.status as (typeof OPEN)[number]] = r.n;

  const evs = await db.select({ name: events.name, payload: events.payload }).from(events).where(and(
    eq(events.module, "pharmacy"),
    inArray(events.name, ["dispense.billed", "dispense.line_declined", "substitution.recorded", "dispense.cancelled", "dispense.line_returned", "dispense.verified"]),
    gte(events.occurredAt, start), lt(events.occurredAt, end),
    gte(events.recordedAt, start),
  ));
  let billedPaise = 0;
  let declinedLines = 0;
  const reasons = new Map<string, number>();
  let substitutions = 0;
  let cancelled = 0;
  let refundedAfterBilling = 0;
  let returns = 0;
  let partlyCheckedLines = 0;
  for (const e of evs) {
    const p = e.payload as Record<string, unknown>;
    switch (e.name) {
      case "dispense.billed": billedPaise += Number(p.netPaise ?? 0); break;
      case "dispense.line_declined": {
        declinedLines += 1;
        const reason = String(p.reason ?? "").trim().toLowerCase();
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        break;
      }
      case "substitution.recorded": substitutions += 1; break;
      case "dispense.cancelled":
        cancelled += 1;
        if (typeof p.creditNoteId === "string") refundedAfterBilling += 1;
        break;
      case "dispense.line_returned": returns += 1; break;
      case "dispense.verified":
        partlyCheckedLines += Array.isArray(p.partlyCheckedLineIdxs) ? p.partlyCheckedLineIdxs.length : 0;
        break;
    }
  }
  const h1 = await db.select({ n: sql<number>`count(*)::int` }).from(pharmacyRegH1)
    .where(and(gte(pharmacyRegH1.dispensedAt, start), lt(pharmacyRegH1.dispensedAt, end)));

  return {
    day,
    handedOver: done.length,
    medianMinutes: {
      queueToHandover: median(done.filter((d) => d.handedOverAt !== null).map((d) => minutes(d.createdAt, d.handedOverAt!))),
      claimToHandover: median(done.filter((d) => d.handedOverAt !== null && d.claimedAt !== null).map((d) => minutes(d.claimedAt!, d.handedOverAt!))),
    },
    billedPaise,
    open,
    declinedLines,
    declinedTop: [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([reason, lines]) => ({ reason, lines })),
    substitutions,
    cancelled,
    refundedAfterBilling,
    returns,
    partlyCheckedLines,
    scheduledHandovers: h1[0]?.n ?? 0,
  };
}
