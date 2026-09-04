import { and, eq, sql } from "drizzle-orm";
import { aerbLicences, aerbPersons, qaRecords } from "../../kernel/db/schema/aerb";
import { resources } from "../../kernel/db/schema/resources";
import { users } from "../../kernel/db/schema/auth";
import { istDayString } from "../../kernel/approvals/cumulative";
import { badgeGaps } from "./badges";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18c T5 / D12 — **THE COMPLIANCE CALENDAR: one read over four registers.**
 *
 * ═══ WHAT AN AERB INSPECTOR ACTUALLY ASKS FOR ═══
 *
 * Not "show me the licences" — *"what is out of date?"* Four registers answer a quarter of that
 * each: a licence has a `valid_to`, a QA record has a `next_due_on`, an appointment has a
 * `valid_to`, and a badge has a period nobody has read. This function is the other half — one
 * list, sorted by how late each thing is, which is the order the conversation goes in.
 *
 * ═══ IT IS A READ. IT BLOCKS NOTHING, AND THAT IS D4 RESTATED ═══
 *
 * An OVERDUE row here is a row for the RSO to act on, never a status the system sets. The one
 * automatic block in this phase is a FAILED QA (`recordQa`), because a physicist measured something
 * and said so; *"the annual test is nine days late"* is not that, and a machine that stopped itself
 * over it would strand the night trauma CT. The calendar tells the RSO; the RSO blocks.
 *
 * ═══ NO SCHEDULER JOB ═══
 *
 * The thirteen-job census stays thirteen. This list is computed when somebody opens the screen,
 * because a compliance calendar that emailed itself would be a notification feature (Plan 10's) and
 * an escalation ladder (18a-iii's), and neither of those is a register.
 */

export type CalendarState = "ok" | "due" | "overdue";

export interface CalendarRow {
  kind: "licence" | "qa" | "appointment" | "badge";
  /** What it is about, in the words an inspector uses: a machine, a person. */
  subject: string;
  detail: string;
  /** The date the thing is due, or null for a badge that simply has no reading at all. */
  dueOn: string | null;
  state: CalendarState;
  /** Negative while it is still in the future. */
  daysOverdue: number;
  /** So a screen can point at the row that produced this. */
  ref: string;
}

const DAY_MS = 86_400_000;

/**
 * `due` is the warning window; `overdue` is the breach. **Thirty days**, because an AERB renewal
 * needs an application, a fee and somebody's visit — a seven-day warning on a licence would be a
 * warning nobody could act on, which is the same failure as no warning at all.
 */
export const DUE_WINDOW_DAYS = 30;

function stateFor(dueOn: string, asOf: string): { state: CalendarState; daysOverdue: number } {
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / DAY_MS);
  if (days > 0) return { state: "overdue", daysOverdue: days };
  if (days >= -DUE_WINDOW_DAYS) return { state: "due", daysOverdue: days };
  return { state: "ok", daysOverdue: days };
}

/**
 * Everything with a date on it, across the four registers.
 *
 * `includeOk` defaults FALSE: the working view is what needs attention, and a calendar that listed
 * every licence valid until 2029 beside the one that lapsed on Friday would bury the second. The
 * inspector's print passes `true`, because there the whole file is the point.
 */
export async function complianceCalendar(
  db: Db, opts: { onDate?: string; includeOk?: boolean } = {},
): Promise<CalendarRow[]> {
  /**
   * CLOSE REVIEW — this defaulted to the UTC day. Between 18:30 and 24:00 UTC that is YESTERDAY in
   * IST, so a licence whose `valid_to` was yesterday-IST rendered `due today` rather than
   * `overdue`. The kernel has one helper for this and `ist-clock-parity.test.ts` exists to keep it
   * the only one.
   */
  const asOf = opts.onDate ?? istDayString(new Date());
  const rows: CalendarRow[] = [];

  /* ── 1. Equipment licences ── */
  const licences = await db.select({
    id: aerbLicences.id,
    licenceNo: aerbLicences.licenceNo,
    validTo: aerbLicences.validTo,
    code: resources.code,
    name: resources.name,
  })
    .from(aerbLicences)
    .innerJoin(resources, eq(resources.id, aerbLicences.deviceResourceId))
    .where(eq(aerbLicences.status, "active"));
  for (const l of licences) {
    rows.push({
      kind: "licence",
      subject: `${l.code} — ${l.name}`,
      detail: l.licenceNo,
      dueOn: l.validTo,
      ref: l.id,
      ...stateFor(l.validTo, asOf),
    });
  }

  /**
   * ── 2. Quality assurance ──
   *
   * The LATEST record per device and test type carries the live `next_due_on`. An older record's
   * date has been superseded, and listing it would show a machine as overdue for a test it has
   * since had — which is the one way a compliance calendar can be worse than none.
   *
   * ═══ CLOSE REVIEW — THE `next_due_on is not null` FILTER USED TO RUN BEFORE THE GROUPING ═══
   *
   * `next_due_on` is nullable and a FAILED or CONDITIONAL test legitimately has none until the
   * machine is repaired. Filtering first removed that record from the candidate set, so the
   * previous year's PASS became "latest" and the calendar showed the machine **overdue for a test
   * it had a fortnight ago** — the exact failure this grouping exists to prevent, through the one
   * door it did not cover. The filter now runs AFTER: a machine whose latest test carries no next
   * date has nothing scheduled and is simply absent, which is true (its FAILURE is what stopped it,
   * and that is the QA tab's row, not the calendar's).
   *
   * Ties on `performed_on` — a retest on the same day after a repair — break on `recorded_at`, so
   * the row that was entered last wins rather than whichever the unordered read returned first.
   */
  const qa = await db.select({
    id: qaRecords.id,
    deviceResourceId: qaRecords.deviceResourceId,
    qaType: qaRecords.qaType,
    nextDueOn: qaRecords.nextDueOn,
    performedOn: qaRecords.performedOn,
    recordedAt: qaRecords.recordedAt,
    code: resources.code,
    name: resources.name,
  })
    .from(qaRecords)
    .innerJoin(resources, eq(resources.id, qaRecords.deviceResourceId));

  const latestQa = new Map<string, (typeof qa)[number]>();
  for (const r of qa) {
    const key = `${r.deviceResourceId} ${r.qaType}`;
    const seen = latestQa.get(key);
    const newer = seen === undefined
      || r.performedOn > seen.performedOn
      || (r.performedOn === seen.performedOn && r.recordedAt > seen.recordedAt);
    if (newer) latestQa.set(key, r);
  }
  for (const r of latestQa.values()) {
    const dueOn = r.nextDueOn;
    if (dueOn === null) continue;
    rows.push({
      kind: "qa",
      subject: `${r.code} — ${r.name}`,
      detail: r.qaType,
      dueOn,
      ref: r.id,
      ...stateFor(dueOn, asOf),
    });
  }

  /* ── 3. Appointments — the RSO and the medical physicist ── */
  const people = await db.select({
    id: aerbPersons.id,
    personRole: aerbPersons.personRole,
    validTo: aerbPersons.validTo,
    userName: users.fullName,
  })
    .from(aerbPersons)
    .innerJoin(users, eq(users.id, aerbPersons.userId))
    .where(and(eq(aerbPersons.active, true), sql`${aerbPersons.validTo} is not null`));
  for (const p of people) {
    const dueOn = p.validTo;
    if (dueOn === null) continue;
    rows.push({
      kind: "appointment",
      subject: p.userName,
      detail: p.personRole,
      dueOn,
      ref: p.id,
      ...stateFor(dueOn, asOf),
    });
  }

  /**
   * ── 4. Badges nobody is reading ──
   *
   * These have NO due date — nothing was ever scheduled, which is exactly why they are invisible to
   * a date-driven view and why the register has to go looking for them. They are always `overdue`,
   * and `daysOverdue` is how long the person has been wearing a dosimeter nobody has read.
   */
  for (const g of await badgeGaps(db, { onDate: asOf })) {
    rows.push({
      kind: "badge",
      subject: g.userName,
      detail: g.badgeNo,
      dueOn: g.lastPeriodEnd,
      state: "overdue",
      daysOverdue: g.daysSince,
      ref: g.badgeId,
    });
  }

  const filtered = opts.includeOk === true ? rows : rows.filter((r) => r.state !== "ok");
  /** Latest first — the order the conversation with an inspector actually goes in. */
  return filtered.sort((a, b) => b.daysOverdue - a.daysOverdue);
}
