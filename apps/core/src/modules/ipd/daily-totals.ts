import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { events, ipdAdmissionDeposits, ipdAdmissions, patientGuardians, patients } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { readAdmission } from "./admission-core";
import { dailyTotalsSkipped } from "./billdesk-events";
import { IPD_LADDER_STATES, depositPosition } from "./deposit-ladder";
import { IPD_GOAL_TEMPLATES } from "./goals/goal-events";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E2.3 (#727) — THE DAILY TOTALS TO THE REGISTERED ATTENDANT (spec SPEC-ipd-core §4.3: "totals only by WhatsApp to the
 * registered attendant daily (no line items by message: line items can reveal a diagnosis)").
 *
 * Once per admission in a bed per IST day, after the nightly charges: the bill through YESTERDAY (what the night just
 * posted). The message carries the patient's first name (the alias for a confidential patient), the day of stay, the
 * bill so far, the deposit held and the balance — never a line, a diagnosis, a ward, a bed or a doctor. Template
 * `ipd.daily_totals`, `ref_type 'admission'`, `ref_id` the admission (goal G10 counts it); dedupe key per admission and
 * day, so a rerun queues nothing new.
 *
 * DECIDED (#727):
 * - THE ATTENDANT is the patient's active registered guardian with a phone and authority over bills; else the payer of
 *   the latest deposit receipt recorded as a relative with a phone. Neither → no message, `ipd.daily_totals.skipped`
 *   `no_attendant_phone`. The recipient travels as a REFERENCE (guardian or deposit row id), never as a phone number:
 *   the sender reads contact truth at send time.
 * - SEALED (`patients.sensitive_context`, D-31) → no message (`sealed`); no opt-in path exists in this lane.
 * - THE CHANNEL: no approved WhatsApp template and no DLT registration exist, and the notify pump addresses a patient
 *   row to the patient's own phone — so the template is HELD: the row is queued and the pump records it suppressed
 *   `template_pending` (kernel/notify `heldReason`). Language: the patient's message language, as every patient message.
 */
const SYSTEM: Actor = { type: "system", id: "ipd-daily-totals" };
const DAY_MS = 24 * 3_600_000;

export type DailyTotalsResult = { billDate: string; queued: number; already: number; skipped: { admissionId: string; reason: "no_attendant_phone" | "sealed" }[] };

type Attendant = { kind: "guardian" | "deposit_payer"; ref: string };

async function attendantOf(db: Db, patientId: string, admissionId: string): Promise<Attendant | null> {
  const g = (await db.select({ id: patientGuardians.id }).from(patientGuardians).where(and(
    eq(patientGuardians.patientId, patientId), eq(patientGuardians.status, "active"), eq(patientGuardians.authorityBills, true),
    isNotNull(patientGuardians.phone), sql`${patientGuardians.phone} <> ''`,
  )).orderBy(asc(patientGuardians.createdAt)).limit(1))[0];
  if (g !== undefined) return { kind: "guardian", ref: g.id };
  const d = (await db.select({ id: ipdAdmissionDeposits.id }).from(ipdAdmissionDeposits).where(and(
    eq(ipdAdmissionDeposits.admissionId, admissionId), eq(ipdAdmissionDeposits.payerRelation, "relative"), isNotNull(ipdAdmissionDeposits.payerPhone),
  )).orderBy(desc(ipdAdmissionDeposits.takenAt)).limit(1))[0];
  return d === undefined ? null : { kind: "deposit_payer", ref: d.id };
}

/** The name the message may carry: the alias for a confidential patient, else the first word of the name. */
export function messageNameOf(p: { name: string; alias: string | null; isConfidential: boolean }): string {
  if (p.isConfidential) return p.alias?.trim() || "your patient";
  return p.name.trim().split(/\s+/)[0] ?? "your patient";
}

/** Day of stay on `billDate`: the admission's IST day is day 1. */
export function dayOfStay(admittedAt: Date, billDate: string): number {
  const from = Date.parse(`${istDayString(admittedAt)}T00:00:00Z`);
  const to = Date.parse(`${billDate}T00:00:00Z`);
  return Math.floor((to - from) / DAY_MS) + 1;
}

async function skipOnce(db: Db, a: { id: string; patientId: string }, billDate: string, reason: "no_attendant_phone" | "sealed", now: Date): Promise<void> {
  const seen = await db.select({ seq: events.seq }).from(events).where(and(
    eq(events.name, "ipd.daily_totals.skipped"), sql`${events.payload}->>'admissionId' = ${a.id}`, sql`${events.payload}->>'billDate' = ${billDate}`,
  )).limit(1);
  if (seen.length > 0) return;
  await withTx(db, (tx) => appendEvent(tx, dailyTotalsSkipped.make({
    actor: SYSTEM, occurredAt: now, correlationId: a.id, patientId: a.patientId,
    payload: { admissionId: a.id, billDate, reason, provenance: "system" },
  })));
}

/** One admission's message for `billDate`: queued (true), already queued (false), or skipped with its reason. */
export async function queueDailyTotals(
  db: Db, admissionId: string, billDate: string, now: Date,
): Promise<"queued" | "already" | "no_attendant_phone" | "sealed" | "not_in_bed"> {
  const a = await readAdmission(db, admissionId);
  if (a.admittedAt === null || !(IPD_LADDER_STATES as readonly string[]).includes(a.state)) return "not_in_bed";
  if (istDayString(a.admittedAt) > billDate) return "not_in_bed";
  const p = (await db.select({
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, sealed: patients.sensitiveContext,
  }).from(patients).where(eq(patients.id, a.patientId)))[0];
  if (p === undefined) return "not_in_bed";
  if (p.sealed) { await skipOnce(db, a, billDate, "sealed", now); return "sealed"; }
  const to = await attendantOf(db, a.patientId, a.id);
  if (to === null) { await skipOnce(db, a, billDate, "no_attendant_phone", now); return "no_attendant_phone"; }
  const pos = await depositPosition(db, a);
  const params = {
    name: messageNameOf(p), dayOfStay: dayOfStay(a.admittedAt, billDate), billDate,
    totalPaise: pos.billTotalPaise, depositPaise: pos.depositHeldPaise, balancePaise: pos.balancePaise,
    attendant: to.kind, attendantRef: to.ref,
  };
  const row = await withTx(db, (tx) => enqueueNotification(tx, {
    templateKey: IPD_GOAL_TEMPLATES.dailyTotals, params, dedupeKey: `ipd.daily_totals:${a.id}:${billDate}`, occurredAt: now,
    patientId: a.patientId, refType: "admission", refId: a.id,
  }));
  return row === null ? "already" : "queued";
}

/** Every admission in a bed, for the day the nightly run just posted (yesterday, IST). */
export async function queueAllDailyTotals(db: Db, now: Date): Promise<DailyTotalsResult> {
  const billDate = istDayString(new Date(now.getTime() - DAY_MS));
  const out: DailyTotalsResult = { billDate, queued: 0, already: 0, skipped: [] };
  const rows = await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions)
    .where(inArray(ipdAdmissions.state, [...IPD_LADDER_STATES])).orderBy(asc(ipdAdmissions.admittedAt));
  for (const r of rows) {
    const done = await queueDailyTotals(db, r.id, billDate, now);
    if (done === "queued") out.queued += 1;
    else if (done === "already") out.already += 1;
    else if (done !== "not_in_bed") out.skipped.push({ admissionId: r.id, reason: done });
  }
  return out;
}
