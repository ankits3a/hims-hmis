import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { approvals } from "../db/schema";
import { ApprovalError } from "./types";
import type { Tx } from "../db/client";

/**
 * C-12 anti-structuring aggregation (owner decisions 2026-08-13): the window is the IST
 * CALENDAR DAY (spec text: "same-day"); pending + granted count, rejected is excluded
 * (a rejected-then-resubmitted request must not double-count); the helper REPORTS and
 * never blocks — threshold values are CA-configured data arriving with Plans 06/08.
 * IST is fixed UTC+05:30 with no DST — a design-law constant for this single-site Indian
 * hospital, deliberately not a config value (no-config-fallbacks rule).
 */
export const IST_UTC_OFFSET_MINUTES = 330;
const DAY_MS = 24 * 60 * 60_000;
const OFFSET_MS = IST_UTC_OFFSET_MINUTES * 60_000;

/**
 * PLAN 07c T8 — THE IST CALENDAR DAY OF AN INSTANT, as the 'YYYY-MM-DD' string every desk figure,
 * report and rollup row is cut on.
 *
 * It lives HERE, beside `IST_UTC_OFFSET_MINUTES` and `istDayWindow`, rather than in the two places
 * that wanted it — `kernel/desk/desk.controller.ts` had a private copy and `kernel/worker/jobs.ts`
 * was about to need one. `ist-clock-parity.test.ts` pins the census of files that write the
 * hospital's clock by hand and reddens on a new one (ledger §2.105); adding it to the file that
 * already OWNS the constant introduces no new site at all and removes the one the controller had.
 * An eleventh copy has to be argued for in writing, and this one had no argument.
 */
export function istDayString(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

export function istDayWindow(now: Date): { start: Date; end: Date } {
  const istMs = now.getTime() + OFFSET_MS;
  const istDayStartMs = Math.floor(istMs / DAY_MS) * DAY_MS;
  const start = new Date(istDayStartMs - OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export type CumulativeQuery = {
  typeKey: string;
  patientId?: string;
  payeeId?: string;
  window: { start: Date; end: Date };
};

export async function cumulativeAmount(tx: Tx, q: CumulativeQuery): Promise<number> {
  const byPatient = q.patientId !== undefined;
  const byPayee = q.payeeId !== undefined;
  if (byPatient === byPayee) {
    throw new ApprovalError("invalid_cumulative_query", "exactly one of patientId or payeeId is required");
  }
  const target = byPatient
    ? eq(approvals.patientId, q.patientId as string)
    : eq(approvals.payeeId, q.payeeId as string);
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${approvals.amountPaise}), 0)` })
    .from(approvals)
    .where(
      and(
        eq(approvals.typeKey, q.typeKey),
        inArray(approvals.status, ["pending", "granted"]), // C-12: rejected excluded (owner decision)
        target,
        gte(approvals.requestedAt, q.window.start), // start inclusive
        lt(approvals.requestedAt, q.window.end),    // end exclusive
      ),
    );
  // SQL sum() arrives as text through the pg driver — force a real number (Plan 01 seq trap).
  return Number(rows[0]!.total);
}
