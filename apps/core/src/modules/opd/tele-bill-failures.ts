import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { events, opdAppointments, opdDoctors, opdEncounters } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { standingInvoiceFor } from "../billing";
import { getPatientSummaries } from "../patients";
import { OpdError } from "./errors";
import { teleBillFailed } from "./events";
import { billSpokenTeleVisit } from "./tele-call";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #647 — THE FAILED TELE-CALL BILLS, FOR THE BILLING OFFICE ═══
 *
 * When the doctor says "Spoke to patient", 'spoke' and the consultation invoice are written together
 * or not at all (tele-call.ts). A refused invoice leaves the doctor with "Could not save — try again"
 * and writes `tele.bill_failed`. This is the other half: the list of such visits still waiting, and a
 * retry of the invoice once the cause is fixed.
 *
 * A row is shown while the visit is still in consultation and 'spoke' has not been recorded:
 *   `open`    no standing invoice — the bill is still to be raised;
 *   `billed`  a retry raised it — the doctor's next "Spoke" finds it standing and goes through.
 * It leaves the list when 'spoke' is recorded or the visit closes another way.
 *
 * DECIDED (standard practice): the retry raises the invoice only. It never records 'spoke' — that is
 * the doctor's clinical act; the failure event is evidence the doctor tried it, the invoice is the
 * billing office's. A retry that is refused again writes its own `tele.bill_failed`, under the
 * retrying person, so the list counts the attempts and shows the latest reason.
 *
 * NEVER ON A DOCTOR'S SCREEN (owner 2026-10-09): these routes are guarded on the billing office's
 * permission, and the doctor's own answer stays the neutral sentence.
 */

/** How far back the list looks. A tele visit stuck in consultation for longer is a desk matter of its own. */
export const TELE_BILL_FAILURE_WINDOW_DAYS = 30;

export type TeleBillFailureRow = {
  encounterId: string; visitNo: string; appointmentId: string | null;
  patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean } | null;
  doctorName: string | null; slotStart: string | null; quotePaise: number | null;
  firstFailedAt: string; lastFailedAt: string; lastCode: string; attempts: number;
  state: "open" | "billed";
};

type FailurePayload = { encounterId: string; appointmentId: string | null; code: string };

export async function listTeleBillFailures(db: Db, actor: Actor, now: Date = new Date()): Promise<TeleBillFailureRow[]> {
  const since = new Date(now.getTime() - TELE_BILL_FAILURE_WINDOW_DAYS * 86_400_000);
  const failed = await db.select({ occurredAt: events.occurredAt, payload: events.payload }).from(events)
    .where(and(eq(events.name, teleBillFailed.name), gte(events.recordedAt, since)))
    .orderBy(desc(events.occurredAt));
  if (failed.length === 0) return [];
  const byVisit = new Map<string, { first: Date; last: Date; code: string; attempts: number }>();
  for (const f of failed) {
    const p = f.payload as FailurePayload;
    const seen = byVisit.get(p.encounterId);
    if (seen === undefined) byVisit.set(p.encounterId, { first: f.occurredAt, last: f.occurredAt, code: p.code, attempts: 1 });
    else { seen.attempts += 1; if (f.occurredAt < seen.first) seen.first = f.occurredAt; }
  }
  const encs = (await db.select().from(opdEncounters).where(inArray(opdEncounters.id, [...byVisit.keys()])))
    .filter((e) => e.status === "in_consultation" && e.teleOutcome !== "spoke");
  if (encs.length === 0) return [];
  const apptIds = encs.map((e) => e.appointmentId).filter((x): x is string => x !== null);
  const appts = new Map((apptIds.length === 0 ? [] : await db.select().from(opdAppointments).where(inArray(opdAppointments.id, apptIds))).map((a) => [a.id, a]));
  const doctorIds = [...new Set(encs.map((e) => e.doctorId).filter((x): x is string => x !== null))];
  const doctors = new Map((doctorIds.length === 0 ? [] : await db.select({ id: opdDoctors.id, name: opdDoctors.displayName }).from(opdDoctors).where(inArray(opdDoctors.id, doctorIds))).map((d) => [d.id, d.name]));
  const people = new Map((await getPatientSummaries(db, actor, [...new Set(encs.map((e) => e.patientId))])).map((p) => [p.requestedId, p]));
  const rows: TeleBillFailureRow[] = [];
  for (const e of encs) {
    const f = byVisit.get(e.id)!;
    const a = e.appointmentId === null ? undefined : appts.get(e.appointmentId);
    const who = people.get(e.patientId);
    rows.push({
      encounterId: e.id, visitNo: e.visitNo, appointmentId: e.appointmentId,
      patient: who === undefined ? null : { uhid: who.uhid, name: who.restricted ? null : who.name, alias: who.alias, restricted: who.restricted },
      doctorName: e.doctorId === null ? null : doctors.get(e.doctorId) ?? null,
      slotStart: a?.slotStart.toISOString() ?? null, quotePaise: a?.advanceQuotePaise ?? null,
      firstFailedAt: f.first.toISOString(), lastFailedAt: f.last.toISOString(), lastCode: f.code, attempts: f.attempts,
      state: (await standingInvoiceFor(db, e.id)) === null ? "open" : "billed",
    });
  }
  return rows.sort((x, y) => (x.lastFailedAt < y.lastFailedAt ? 1 : -1));
}

export type TeleBillRetry = { encounterId: string; state: "billed" };

/** The billing office raises the failed bill again. Refused unless the visit has a failure waiting. */
export async function retryTeleBill(db: Db, actor: Actor, encounterId: string, now: Date = new Date()): Promise<TeleBillRetry> {
  const failures = await db.select({ seq: events.seq }).from(events)
    .where(and(eq(events.name, teleBillFailed.name), eq(events.encounterId, encounterId))).limit(1);
  try {
    await withTx(db, async (tx) => {
      const enc = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update"))[0];
      if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
      if (failures.length === 0 || enc.consultMode !== "tele" || enc.status !== "in_consultation" || enc.teleOutcome === "spoke") {
        throw new OpdError("tele_bill_state_conflict", "this visit has no failed tele-call bill waiting");
      }
      const bill = await billSpokenTeleVisit(tx, enc, now, actor);
      if (bill === "none") throw new OpdError("tele_bill_state_conflict", "no bill is due on this visit");
    });
    return { encounterId, state: "billed" };
  } catch (e) {
    if (e instanceof OpdError) throw e;
    const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "error";
    const enc = (await db.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)))[0];
    if (enc) {
      await withTx(db, (tx) => appendEvent(tx, teleBillFailed.make({
        actor, patientId: enc.patientId, encounterId, correlationId: enc.workflowInstanceId, occurredAt: now,
        payload: { encounterId, appointmentId: enc.appointmentId, code },
      }))).catch(() => undefined);
    }
    throw new OpdError("tele_bill_retry_failed", e instanceof Error ? e.message : String(e), { code });
  }
}
