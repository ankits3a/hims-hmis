import { Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissionDeposits, ipdAdmissions, ipdDailyTotals, patientGuardians, patients } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { admissionAdvisoryLock, readAdmission } from "./admission-core";
import { dailyTotalsSkipped } from "./billdesk-events";
import { IPD_LADDER_STATES, depositPosition } from "./deposit-ladder";
import { IPD_GOAL_TEMPLATES } from "./goals/goal-events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

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
 * - THE CHANNEL (#761): the row is addressed to the attendant through the pump's recipient seam (`attendant-messages.ts`
 *   `ipdAttendantRecipient`: `attendantRef` resolved at send time, consent and stop honoured) and leaves only as an
 *   approved template named in config; until then the pump records it suppressed `template_pending` ("not sent: template
 *   not configured" on the bill desk). Sent at 09:00 IST (`scheduledFor`). Language: the patient's message language.
 * - DEDUPE (review 9): one `ipd_daily_totals` row per admission and IST day (unique key), decided under the admission's
 *   advisory lock; the outbox row and the record commit together.
 */
const SYSTEM: Actor = { type: "system", id: "ipd-daily-totals" };

/** DECIDED (#761): the day's message goes at 09:00 IST — after quiet hours end (08:00), before the day's bills move. */
export const IPD_DAILY_TOTALS_SEND_HOUR_IST = 9;

/** The send instant (09:00 IST) of the IST day `now` falls on: the nightly run queues just after midnight. */
export function dailyTotalsSendAt(now: Date): Date {
  return new Date(`${istDayString(now)}T${String(IPD_DAILY_TOTALS_SEND_HOUR_IST).padStart(2, "0")}:00:00+05:30`);
}
const DAY_MS = 24 * 3_600_000;
const log = new Logger("ipd.daily-totals");

export type DailyTotalsResult = {
  billDate: string; queued: number; already: number; skipped: { admissionId: string; reason: "no_attendant_phone" | "sealed" }[]; failed: string[];
};

type Attendant = { kind: "guardian" | "deposit_payer"; ref: string; phone: string };

/**
 * The registered attendant (the rule above) WITH the phone as it stands now. E3.3 (#731) reuses it for the family link:
 * the same person the daily totals go to is the only person a family-link OTP can reach.
 */
export async function attendantOf(db: Db | Tx, patientId: string, admissionId: string): Promise<Attendant | null> {
  const g = (await db.select({ id: patientGuardians.id, phone: patientGuardians.phone }).from(patientGuardians).where(and(
    eq(patientGuardians.patientId, patientId), eq(patientGuardians.status, "active"), eq(patientGuardians.authorityBills, true),
    isNotNull(patientGuardians.phone), sql`${patientGuardians.phone} <> ''`,
  )).orderBy(asc(patientGuardians.createdAt)).limit(1))[0];
  if (g?.phone != null) return { kind: "guardian", ref: g.id, phone: g.phone };
  const d = (await db.select({ id: ipdAdmissionDeposits.id, phone: ipdAdmissionDeposits.payerPhone }).from(ipdAdmissionDeposits).where(and(
    eq(ipdAdmissionDeposits.admissionId, admissionId), eq(ipdAdmissionDeposits.payerRelation, "relative"), isNotNull(ipdAdmissionDeposits.payerPhone),
    sql`${ipdAdmissionDeposits.payerPhone} <> ''`,
  )).orderBy(desc(ipdAdmissionDeposits.takenAt)).limit(1))[0];
  return d?.phone == null ? null : { kind: "deposit_payer", ref: d.id, phone: d.phone };
}

/** The phone a recorded attendant reference reaches NOW (contact truth at send time); null when it no longer qualifies. */
export async function attendantPhoneOf(db: Db | Tx, kind: "guardian" | "deposit_payer", ref: string): Promise<string | null> {
  if (kind === "guardian") {
    const g = (await db.select({ phone: patientGuardians.phone, status: patientGuardians.status, bills: patientGuardians.authorityBills })
      .from(patientGuardians).where(eq(patientGuardians.id, ref)))[0];
    return g === undefined || g.status !== "active" || !g.bills || g.phone == null || g.phone === "" ? null : g.phone;
  }
  const d = (await db.select({ phone: ipdAdmissionDeposits.payerPhone }).from(ipdAdmissionDeposits).where(eq(ipdAdmissionDeposits.id, ref)))[0];
  return d?.phone == null || d.phone === "" ? null : d.phone;
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

/** One admission's message for `billDate`: queued, already recorded, or skipped with its reason. */
export async function queueDailyTotals(
  db: Db, admissionId: string, billDate: string, now: Date,
): Promise<"queued" | "already" | "no_attendant_phone" | "sealed" | "not_in_bed"> {
  return withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, admissionId);
    const done = await tx.select({ id: ipdDailyTotals.id }).from(ipdDailyTotals)
      .where(and(eq(ipdDailyTotals.admissionId, admissionId), eq(ipdDailyTotals.billDate, billDate)));
    if (done.length > 0) return "already";
    const a = await readAdmission(tx, admissionId);
    if (a.admittedAt === null || !(IPD_LADDER_STATES as readonly string[]).includes(a.state)) return "not_in_bed";
    if (istDayString(a.admittedAt) > billDate) return "not_in_bed";
    const p = (await tx.select({
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, sealed: patients.sensitiveContext,
    }).from(patients).where(eq(patients.id, a.patientId)))[0];
    if (p === undefined) return "not_in_bed";
    const record = (outcome: "queued" | "no_attendant_phone" | "sealed", notificationId: string | null) => tx.insert(ipdDailyTotals)
      .values({ id: newId(), admissionId: a.id, billDate, outcome, notificationId, recordedAt: now });
    const skip = async (reason: "no_attendant_phone" | "sealed") => {
      await record(reason, null);
      await appendEvent(tx, dailyTotalsSkipped.make({
        actor: SYSTEM, occurredAt: now, correlationId: a.id, patientId: a.patientId,
        payload: { admissionId: a.id, billDate, reason, provenance: "system" },
      }));
      return reason;
    };
    if (p.sealed) return skip("sealed");
    const to = await attendantOf(tx, a.patientId, a.id);
    if (to === null) return skip("no_attendant_phone");
    const pos = await depositPosition(tx, a);
    const params = {
      name: messageNameOf(p), dayOfStay: dayOfStay(a.admittedAt, billDate), billDate,
      totalPaise: pos.billTotalPaise, depositPaise: pos.depositHeldPaise, balancePaise: pos.balancePaise,
      attendant: to.kind, attendantRef: to.ref,
    };
    const row = await enqueueNotification(tx, {
      templateKey: IPD_GOAL_TEMPLATES.dailyTotals, params, dedupeKey: `ipd.daily_totals:${a.id}:${billDate}`, occurredAt: now,
      patientId: a.patientId, refType: "admission", refId: a.id, scheduledFor: dailyTotalsSendAt(now),
    });
    await record("queued", row?.id ?? null);
    return row === null ? "already" : "queued";
  });
}

/** Every admission in a bed, for the day the nightly run just posted (yesterday, IST). */
export async function queueAllDailyTotals(db: Db, now: Date): Promise<DailyTotalsResult> {
  const billDate = istDayString(new Date(now.getTime() - DAY_MS));
  const out: DailyTotalsResult = { billDate, queued: 0, already: 0, skipped: [], failed: [] };
  const rows = await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions)
    .where(inArray(ipdAdmissions.state, [...IPD_LADDER_STATES])).orderBy(asc(ipdAdmissions.admittedAt));
  // Review 1: one admission's failure is logged and never skips the others.
  for (const r of rows) {
    try {
      const done = await queueDailyTotals(db, r.id, billDate, now);
      if (done === "queued") out.queued += 1;
      else if (done === "already") out.already += 1;
      else if (done !== "not_in_bed") out.skipped.push({ admissionId: r.id, reason: done });
    } catch (e) {
      out.failed.push(r.id);
      log.error(`daily totals failed for admission ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
