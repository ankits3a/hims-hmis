import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import type { WireOwedRow } from "@hmis/contracts";
import { alerts, doctorDeskNudges } from "../../kernel/db/schema";
import { openCriticalsForClinician } from "../lab";
import { openVisitsForDoctor } from "../opd";
import { addIstDays, istDateOfInstant, istMidnightUtc } from "../roster";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD-0.6 — CLOCKS RUNNING v0: `owedByUnit` — what a unit owes, held by whom, due when.
 *
 * Owner 2026-09-18 (R7): *"Clocks Running is a CRITICAL module"* — the first card of the right column.
 * The union of three things a unit member holds, each a row in its own module, none copied here:
 *
 *   · an open bell row of an obligation kind (`OWED_ALERT_KINDS`) addressed to a member — the spine's
 *     "no answer" and escalation rows, the imaging chaser, an approval waiting;
 *   · a lab critical call still open on a member's order;
 *   · a member's visit from an earlier day still not completed.
 *
 * Every row is deterministic (D1: obligations ignore the copilot toggles) and every clock is the
 * SERVER's instant. The due rules are DECIDED, standard Indian corporate-hospital practice:
 */
/** A critical value is communicated and acted on within 15 minutes (NABH critical-results practice). */
export const LAB_CRITICAL_DUE_MINUTES = 15;
/** A bell row of an obligation kind is answered within 15 minutes of reaching the person. */
export const ALERT_DUE_MINUTES = 15;
/** A visit's notes are finished within 24 hours of the end of the visit day (plan DD-0.6). */
export const VISIT_DUE_HOURS_AFTER_DAY = 24;
/** Bell rows older than this are history, not a clock — the bell itself still lists them (`WAITING_ALERT_DAYS`). */
export const OWED_ALERT_DAYS = 7;

export const OWED_ALERT_KINDS = ["respond_overdue", "escalation", "imaging_chase", "approval_requested"] as const;

export type OwedRowInternal = Omit<WireOwedRow, "nudgedByMe">;

export async function owedByUnit(
  exec: Db | Tx, members: readonly { userId: string; name: string }[], at: Date,
): Promise<OwedRowInternal[]> {
  const ids = members.map((m) => m.userId);
  if (ids.length === 0) return [];
  const nameOf = new Map(members.map((m) => [m.userId, m.name] as const));
  const holder = (userId: string): WireOwedRow["holder"] => ({ userId, name: nameOf.get(userId) ?? "" });

  const bell = await (exec as Db).select({ id: alerts.id, userId: alerts.userId, kind: alerts.kind, createdAt: alerts.createdAt })
    .from(alerts)
    .where(and(
      inArray(alerts.userId, ids), isNull(alerts.ackKind), inArray(alerts.kind, [...OWED_ALERT_KINDS]),
      gte(alerts.createdAt, new Date(at.getTime() - OWED_ALERT_DAYS * 86_400_000)),
    ));
  const crit = await openCriticalsForClinician(exec, ids);
  const visits = (await Promise.all(ids.map(async (id) => (await openVisitsForDoctor(exec, id, istDateOfInstant(at))).map((v) => ({ ...v, userId: id }))))).flat();

  const rows: OwedRowInternal[] = [
    ...bell.map((a): OwedRowInternal => ({
      key: `alert:${a.id}`, kind: "alert", what: a.kind, holder: holder(a.userId),
      since: a.createdAt.toISOString(), dueAt: new Date(a.createdAt.getTime() + ALERT_DUE_MINUTES * 60_000).toISOString(),
    })),
    ...crit.map((c): OwedRowInternal => ({
      key: `lab_critical:${c.id}`, kind: "lab_critical", what: "lab_critical", holder: holder(c.orderingClinicianId),
      since: c.at.toISOString(), dueAt: new Date(c.at.getTime() + LAB_CRITICAL_DUE_MINUTES * 60_000).toISOString(),
    })),
    ...visits.map((v): OwedRowInternal => ({
      key: `visit:${v.encounterId}`, kind: "visit_open", what: "visit_open", holder: holder(v.userId),
      since: istMidnightUtc(addIstDays(v.serviceDate, 1)).toISOString(),
      dueAt: new Date(istMidnightUtc(addIstDays(v.serviceDate, 1)).getTime() + VISIT_DUE_HOURS_AFTER_DAY * 3_600_000).toISOString(),
    })),
  ];
  return rows.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/** Marks the rows this sender has already nudged. */
export async function withNudgedBy(exec: Db | Tx, rows: OwedRowInternal[], senderId: string): Promise<WireOwedRow[]> {
  if (rows.length === 0) return [];
  const done = await (exec as Db).select({ rowKey: doctorDeskNudges.rowKey }).from(doctorDeskNudges)
    .where(and(eq(doctorDeskNudges.senderId, senderId), inArray(doctorDeskNudges.rowKey, rows.map((r) => r.key))));
  const keys = new Set(done.map((d) => d.rowKey));
  return rows.map((r) => ({ ...r, nudgedByMe: keys.has(r.key) }));
}
