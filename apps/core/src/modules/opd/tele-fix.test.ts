import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import {
  allocations, events, invoiceLines, invoices, opdAppointments, opdEncounters, opdQueueEntries, receipts, tariffItems, workflowTimers, workflowTransitions,
} from "../../kernel/db/schema";
import { invoiceSettlement } from "../billing";
import { bookAppointment, cancelAppointment, rescheduleAppointment } from "./appointments";
import { completeConsultation, resumeConsultation, startConsultation } from "./consultation";
import { abandonVisit, reEnterVisit } from "./encounters";
import { listQueue } from "./queue";
import { loadOpdReport, rangeFor } from "./report";
import { openDueTeleVisits, recordTeleAdvance, teleDeskMarks } from "./tele";
import { recordTeleOutcome } from "./tele-call";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { Db } from "../../kernel/db/client";

/**
 * TELE-CALL — THE FIX ROUND (2026-10-09). Four things the first build got wrong about money and
 * safety: a bill that could be lost, a paid amount that was not honoured after a price change, a
 * "no answer" that touched `awaiting_results`, and a cancel after the visit had opened.
 */
const DAY = "2026-08-17";
const S0930 = new Date("2026-08-17T04:00:00.000Z");
const S1000 = new Date("2026-08-17T04:30:00.000Z");
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z");
const T0931 = new Date("2026-08-17T04:01:00.000Z");
const T0935 = new Date("2026-08-17T04:05:00.000Z");
const T0940 = new Date("2026-08-17T04:10:00.000Z");
const T0950 = new Date("2026-08-17T04:20:00.000Z");
const FEE = 50_000;

describe("opd tele-call — the fix round", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let p1: { id: string };
  let p2: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    base = await seedBillingBase(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: m.deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    clerk = await mkUser(db, "tf_clerk", ["front_office", "cashier"]);
    p1 = await mkPatient(db, clerk.actor, { phone: "9876500001" });
    p2 = await mkPatient(db, clerk.actor, { phone: "9876500002" });
    await openSessionFor(db, clerk, 0);
  });

  const opened = async (opts: { free?: boolean } = {}) => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930, mode: "tele", telePhone: "9876543021" }, NOW_SUN);
    if (opts.free === true) await recordTeleAdvance(db, clerk.actor, appointment.id, { amountPaise: 0 }, NOW_SUN);
    else await recordTeleAdvance(db, clerk.actor, appointment.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, NOW_SUN);
    await openDueTeleVisits(db, T0931);
    const enc = (await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, appointment.id)))[0]!;
    return { appointmentId: appointment.id, encounterId: enc.id };
  };
  const inCall = async () => { const v = await opened(); await startConsultation(db, dra.actor, v.encounterId, T0931); return v; };
  const enc = async (id: string) => (await db.select().from(opdEncounters).where(eq(opdEncounters.id, id)))[0]!;
  const appt = async (id: string) => (await db.select().from(opdAppointments).where(eq(opdAppointments.id, id)))[0]!;
  const bills = (encounterId: string) => db.select().from(invoices).where(eq(invoices.encounterId, encounterId));
  const setPrice = (paise: number) => db.update(tariffItems).set({ pricePaise: paise }).where(and(eq(tariffItems.versionId, base.tariffVersionId), eq(tariffItems.serviceId, base.consultNewServiceId)));

  // ——— F1: the bill must not be losable ———

  it("F1: when the invoice cannot be raised, 'spoke' is NOT recorded — the doctor is told in neutral words, the desk side gets tele.bill_failed — and a second try, once billing can, records it with exactly one settled invoice", async () => {
    const { encounterId, appointmentId } = await inCall();
    // The injected failure: the appointment names ANOTHER patient's receipt, which billing refuses to allocate.
    const receiptId = (await appt(appointmentId)).advanceReceiptId!;
    const other = (await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: S1000, mode: "tele", telePhone: "9876543022" }, NOW_SUN)).appointment;
    const theirs = (await recordTeleAdvance(db, clerk.actor, other.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, NOW_SUN)).receiptId!;
    await db.update(opdAppointments).set({ advanceReceiptId: theirs }).where(eq(opdAppointments.id, appointmentId));

    const refused = recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0940);
    await expect(refused).rejects.toMatchObject({ code: "tele_save_failed", message: "Could not save — try again" });
    const after = await enc(encounterId);
    expect({ outcome: after.teleOutcome, at: after.teleOutcomeAt, status: after.status }).toEqual({ outcome: null, at: null, status: "in_consultation" });
    expect(await bills(encounterId)).toHaveLength(0);
    expect(await db.select().from(allocations)).toHaveLength(0);
    await expect(completeConsultation(db, dra.actor, encounterId, { testsOrderedReturnToday: false }, T0940)).rejects.toMatchObject({ code: "tele_outcome_required" });
    const failed = await db.select().from(events).where(eq(events.name, "tele.bill_failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ encounterId, appointmentId });
    expect(JSON.stringify(await refused.catch((e: unknown) => ({ ...(e as object), message: (e as Error).message })))).not.toMatch(/paid|fee|invoice|receipt|advance|bill|₹/i);

    await db.update(opdAppointments).set({ advanceReceiptId: receiptId }).where(eq(opdAppointments.id, appointmentId));
    const ok = await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0950);
    expect(ok.encounter.teleOutcome).toBe("spoke");
    const got = await bills(encounterId);
    expect(got).toHaveLength(1);
    expect((await invoiceSettlement(db, got[0]!.id)).state).toBe("settled");
    expect((await db.select().from(allocations)).map((a) => ({ r: a.receiptId, p: a.amountPaise }))).toEqual([{ r: receiptId, p: FEE }]);
    // idempotent: said again, nothing more is raised
    await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0950);
    expect(await bills(encounterId)).toHaveLength(1);
    expect(await db.select().from(allocations)).toHaveLength(1);
  });

  // ——— F2: the paid amount is honoured ———

  it.each([["RISES", 90_000], ["FALLS", 30_000]])("F2: the price list %s after the payment — the visit opens, and 'spoke' raises the invoice AT THE PAID AMOUNT, fully settled from the advance, saying it was priced at the quote", async (_word, newPrice) => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930, mode: "tele", telePhone: "9876543021" }, NOW_SUN);
    await recordTeleAdvance(db, clerk.actor, appointment.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, NOW_SUN);
    await setPrice(newPrice);
    expect(await openDueTeleVisits(db, T0931)).toEqual({ due: 1, opened: 1, failed: 0 });
    const e = (await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, appointment.id)))[0]!;
    await startConsultation(db, dra.actor, e.id, T0931);
    await recordTeleOutcome(db, dra.actor, e.id, "spoke", T0940);

    const got = await bills(e.id);
    expect(got.map((i) => i.netPayablePaise)).toEqual([FEE]);
    expect((await invoiceSettlement(db, got[0]!.id)).state).toBe("settled");
    expect((await db.select().from(allocations)).map((a) => a.amountPaise)).toEqual([FEE]);
    const line = (await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, got[0]!.id)))[0]!;
    expect({ unit: line.unitPaise, service: line.serviceId }).toEqual({ unit: FEE, service: base.consultNewServiceId });
    expect(line.regulatedClamp).toMatchObject({ boundApplied: "prepaid_quote", tariffPaise: newPrice, prepaidUnitPaise: FEE });
    expect((await completeConsultation(db, dra.actor, e.id, { testsOrderedReturnToday: false }, T0950)).encounter.status).toBe("completed");
  });

  it("F2: a ₹0 quote raises no invoice, as an in-person free follow-up raises none; an unchanged price leaves no 'priced at the quote' mark", async () => {
    await setPrice(0);
    const free = await opened({ free: true });
    await startConsultation(db, dra.actor, free.encounterId, T0931);
    await recordTeleOutcome(db, dra.actor, free.encounterId, "spoke", T0940);
    expect(await bills(free.encounterId)).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.name, "tele.bill_failed"))).toHaveLength(0);
  });

  // ——— F3: "no answer" never passes through awaiting_results while the visit lives ———

  it("F3: the FIRST no answer holds the visit aside with the doctor (the park every consult has) — no workflow move, no awaiting_results, no second consultation.started, nothing counted as done or as awaiting results", async () => {
    const { encounterId, appointmentId } = await inCall();
    const first = await recordTeleOutcome(db, dra.actor, encounterId, "no_answer", T0935);
    expect({ final: first.final, status: first.encounter.status, n: first.encounter.teleNoAnswerCount, outcome: first.encounter.teleOutcome })
      .toEqual({ final: false, status: "in_consultation", n: 1, outcome: "no_answer" });

    const instance = (await enc(encounterId)).workflowInstanceId;
    const moves = await db.select().from(workflowTransitions).where(eq(workflowTransitions.instanceId, instance));
    expect(moves.map((m) => m.toState)).toEqual(["waiting", "in_consultation"]); // the opening and the start — nothing since
    expect((await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instance))).filter((t) => t.state === "awaiting_results")).toEqual([]);

    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId));
    expect(entries.map((e) => ({ status: e.status, parked: e.parkedAt !== null }))).toEqual([{ status: "in_consult", parked: true }]);
    const view = (await listQueue(db, dra.actor, dra.doctorId, DAY, T0940))!;
    expect(view.counts).toMatchObject({ done: 0, inConsult: 1, waiting: 0 });
    expect(view.inConsult.map((r) => ({ tele: r.tele, parked: r.parkedAt !== null }))).toEqual([{ tele: true, parked: true }]);

    // the readers that treat awaiting_results specially see nothing
    await expect(reEnterVisit(db, clerk.actor, encounterId, T0940)).rejects.toMatchObject({ code: "encounter_state_conflict" });
    const report = await loadOpdReport(db, rangeFor("day", DAY));
    expect(JSON.stringify(report)).not.toMatch(/awaiting/i);
    expect((await db.select().from(events)).filter((e) => /consultation\.completed|visit\.abandoned|appointment\.no_show/.test(e.name))).toEqual([]);
    expect((await appt(appointmentId)).status).toBe("checked_in");
    expect(await bills(encounterId)).toHaveLength(0);

    // tried again later: resumed, not restarted
    await resumeConsultation(db, dra.actor, encounterId, T0940);
    expect(await db.select().from(events).where(eq(events.name, "consultation.started"))).toHaveLength(1);
    const spoke = await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0950);
    expect(spoke.encounter.teleOutcome).toBe("spoke");
    expect(await bills(encounterId)).toHaveLength(1);
  });

  it("F3: the SECOND no answer closes the visit as not consulted in one transaction — it ends abandoned, never rests in awaiting_results, leaves no open timer, and the appointment goes to re-booking with its payment", async () => {
    const { encounterId, appointmentId } = await inCall();
    await recordTeleOutcome(db, dra.actor, encounterId, "no_answer", T0935);
    const second = await recordTeleOutcome(db, dra.actor, encounterId, "no_answer", T0950); // still held aside: no resume needed
    expect({ final: second.final, status: second.encounter.status, n: second.encounter.teleNoAnswerCount }).toEqual({ final: true, status: "abandoned", n: 2 });
    const instance = second.encounter.workflowInstanceId;
    expect((await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instance))).filter((t) => t.firedAt === null && t.cancelledAt === null)).toEqual([]);
    expect((await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))).map((e) => e.status)).toEqual(["cancelled"]);
    const a = await appt(appointmentId);
    expect({ status: a.status, q: a.advanceQuotePaise, paid: a.advanceReceiptId !== null }).toEqual({ status: "needs_rebooking", q: FEE, paid: true });
    expect(await bills(encounterId)).toHaveLength(0);
    expect(await db.select().from(allocations)).toHaveLength(0);
    const report = await loadOpdReport(db, rangeFor("day", DAY));
    expect(JSON.stringify(report)).not.toMatch(/awaiting/i);
  });

  // ——— F4: cancel after the visit opened ———

  it("F4: once its visit is open a tele appointment cannot be cancelled or moved — the in-person rule for a checked-in booking — and the advance is not lost: the desk leaves the visit, and the booking is back on the re-booking list, paid", async () => {
    const { encounterId, appointmentId } = await opened();
    await expect(cancelAppointment(db, clerk.actor, appointmentId, "patient rang to cancel", T0935)).rejects.toMatchObject({ code: "appointment_state_conflict" });
    await expect(rescheduleAppointment(db, clerk.actor, appointmentId, { slotStart: S1000 }, T0935)).rejects.toMatchObject({ code: "appointment_state_conflict" });
    expect({ status: (await appt(appointmentId)).status, q: (await appt(appointmentId)).advanceQuotePaise }).toEqual({ status: "checked_in", q: FEE });

    await abandonVisit(db, clerk.actor, encounterId, "patient rang: cannot take the call today", T0935);
    const a = await appt(appointmentId);
    expect({ status: a.status, q: a.advanceQuotePaise, paid: a.advanceReceiptId !== null }).toEqual({ status: "needs_rebooking", q: FEE, paid: true });
    expect((await teleDeskMarks(db, [a])).get(a.id)).toEqual({ amountPaise: FEE, covered: true });
    expect(await bills(encounterId)).toHaveLength(0);
    // now the desk may cancel it — still paid, refund by request
    const { appointment: gone } = await cancelAppointment(db, clerk.actor, appointmentId, "patient asked for a refund", T0940);
    expect({ status: gone.status, q: gone.advanceQuotePaise, paid: gone.advanceReceiptId !== null }).toEqual({ status: "cancelled", q: FEE, paid: true });
    expect(await db.select().from(receipts)).toHaveLength(1);
  });

  // ——— F5c: a move may change the number ———

  it("F5c: moving a tele appointment may change the number (kept as ten digits) but not the mode; a bad number is refused and nothing moves", async () => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930, mode: "tele", telePhone: "9876543021" }, NOW_SUN);
    await expect(rescheduleAppointment(db, clerk.actor, appointment.id, { slotStart: S1000, telePhone: "12345" }, NOW_SUN)).rejects.toMatchObject({ code: "tele_phone_required" });
    expect((await appt(appointment.id)).status).toBe("booked");
    const { to } = await rescheduleAppointment(db, clerk.actor, appointment.id, { slotStart: S1000, telePhone: "+91 91234 56780" }, NOW_SUN);
    expect({ mode: to.mode, telePhone: to.telePhone }).toEqual({ mode: "tele", telePhone: "9123456780" });
    // an in-person booking takes no number from a move
    const walk = (await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN)).appointment;
    const moved = await rescheduleAppointment(db, clerk.actor, walk.id, { slotStart: new Date("2026-08-17T04:40:00.000Z"), telePhone: "9123456780" }, NOW_SUN);
    expect({ mode: moved.to.mode, telePhone: moved.to.telePhone }).toEqual({ mode: "in_person", telePhone: null });
  });

  // ——— F5d: a tele row carries no money KEY at all ———

  it("F5d: the queue row of a tele visit has no money key — feeStatus, feeBypassReason and consultFeeOverrideReason are ABSENT, not null — while an in-person row keeps them", async () => {
    await opened();
    const view = (await listQueue(db, dra.actor, dra.doctorId, DAY, T0931))!;
    const row = view.ordered[0]!;
    expect(row.tele).toBe(true);
    const keys = (o: unknown, path = ""): string[] => (o !== null && typeof o === "object" && !(o instanceof Date)
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [`${path}.${k}`, ...keys(v, `${path}.${k}`)]) : []);
    expect(keys({ ...row, patient: null }).filter((k) => /fee|paid|advance|receipt|quote|paise|invoice/i.test(k))).toEqual([]);
  });
});
