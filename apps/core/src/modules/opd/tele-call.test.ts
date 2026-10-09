import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { withTx } from "../../kernel/db/client";
import { events, invoiceLines, invoices, opdAppointments, opdEncounters, opdQueueEntries, allocations, receipts, tariffItems } from "../../kernel/db/schema";
import { invoiceSettlement } from "../billing";
import { bookAppointment, rescheduleAppointment } from "./appointments";
import { completeConsultation, startConsultation } from "./consultation";
import { openVisit, visitTypeIn } from "./encounters";
import { markConsultedOnPaper } from "./paper-consult";
import { issuePrescription } from "./prescriptions";
import { listQueue, queueFeeStatusHook } from "./queue";
import { openDueTeleVisits, recordTeleAdvance, teleDeskMarks } from "./tele";
import { recordTeleOutcome, startTeleCall } from "./tele-call";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { RxLine } from "./fhir";
import type { Db } from "../../kernel/db/client";

/**
 * TELE-CALL, SLICE 4 (owner 2026-10-09): the call, its outcome, the guards, and the automatic bill.
 * *"'No answer' by patient: carried to a re-booked slot. … Bill at slot time: automatic; receipt
 * already names the cashier."*
 */
const DAY = "2026-08-17";
const S0930 = new Date("2026-08-17T04:00:00.000Z");
const S1000 = new Date("2026-08-17T04:30:00.000Z");
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z");
const T0931 = new Date("2026-08-17T04:01:00.000Z");
const T0935 = new Date("2026-08-17T04:05:00.000Z");
const T0940 = new Date("2026-08-17T04:10:00.000Z");
const T0950 = new Date("2026-08-17T04:20:00.000Z");
const T1001 = new Date("2026-08-17T04:31:00.000Z");
const FEE = 50_000;
const LINES: RxLine[] = [{ drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false }];

describe("opd tele-call — the call, the outcome, the guards and the bill (slice 4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let slipDesk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let p1: { id: string };
  let p2: { id: string };
  let deptId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    base = await seedBillingBase(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: m.deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    drb = await mkDoctor(db, { username: "drb", departmentId: m.deptId, roomId: m.room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    clerk = await mkUser(db, "tc_clerk", ["front_office", "cashier"]);
    const registry = new ModuleRegistry();
    registry.install({ key: "opd", title: "OPD", menu: [], subscriptions: [], permissions: ["opd.consult.paper"] });
    await syncPermissions(db, registry);
    await ensureRole(db, "opd_slip_desk");
    await grantPermissionToRole(db, registry, "opd_slip_desk", "opd.consult.paper");
    slipDesk = await mkUser(db, "tc_slip", ["opd_slip_desk"]);
    p1 = await mkPatient(db, clerk.actor, { phone: "9876500001" });
    p2 = await mkPatient(db, clerk.actor, { phone: "9876500002" });
    await openSessionFor(db, clerk, 0);
  });

  /** A paid tele-call, opened at its slot and started by its doctor. */
  const inCall = async (opts: { pay?: boolean } = {}) => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930, mode: "tele", telePhone: "+91 98765 43021" }, NOW_SUN);
    if (opts.pay !== false) await recordTeleAdvance(db, clerk.actor, appointment.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, NOW_SUN);
    await openDueTeleVisits(db, T0931);
    const enc = (await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, appointment.id)))[0]!;
    await startConsultation(db, dra.actor, enc.id, T0931);
    return { appointmentId: appointment.id, encounterId: enc.id };
  };
  const enc = async (id: string) => (await db.select().from(opdEncounters).where(eq(opdEncounters.id, id)))[0]!;
  const appt = async (id: string) => (await db.select().from(opdAppointments).where(eq(opdAppointments.id, id)))[0]!;
  const bills = (encounterId: string) => db.select().from(invoices).where(eq(invoices.encounterId, encounterId));

  it("SERVER GUARD: complete and issue are refused before 'spoke' — and the desk's paper road too — and allowed after", async () => {
    const { encounterId } = await inCall();
    await expect(completeConsultation(db, dra.actor, encounterId, { testsOrderedReturnToday: false }, T0935)).rejects.toMatchObject({ code: "tele_outcome_required" });
    await expect(completeConsultation(db, dra.actor, encounterId, { testsOrderedReturnToday: true }, T0935)).rejects.toMatchObject({ code: "tele_outcome_required" });
    await expect(issuePrescription(db, dra.actor, testCfg, encounterId, { lines: LINES }, T0935)).rejects.toMatchObject({ code: "tele_outcome_required" });
    const paper = await markConsultedOnPaper(db, slipDesk.actor, encounterId, { kind: "slip_photo", id: "doc-1" }, T0935);
    expect({ outcome: paper.outcome, consulted: paper.consulted }).toEqual({ outcome: "not_a_consultation", consulted: false });
    expect((await enc(encounterId)).status).toBe("in_consultation");

    await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0940);
    const issued = await issuePrescription(db, dra.actor, testCfg, encounterId, { lines: LINES }, T0940);
    expect(issued.prescriptionId).toMatch(/\S/);
    const done = await completeConsultation(db, dra.actor, encounterId, { testsOrderedReturnToday: false }, T0950);
    expect(done.encounter.status).toBe("completed");
    // …and the free follow-up window starts as a normal visit's does
    expect(await visitTypeIn(db, [p1.id], deptId, new Date("2026-08-19T05:00:00.000Z"))).toBe("revisit");
  });

  it("an in-person visit is never asked about a call: it completes as it always did, and the tele routes refuse it", async () => {
    const walk = await openVisit(db, clerk.actor, { patientId: p2.id, departmentId: deptId, doctorId: dra.doctorId }, T0931);
    await db.update(opdEncounters).set({ status: "waiting" }).where(eq(opdEncounters.id, walk.encounter.id));
    await expect(startTeleCall(db, dra.actor, walk.encounter.id, T0935)).rejects.toMatchObject({ code: "not_a_tele_visit" });
    await expect(recordTeleOutcome(db, dra.actor, walk.encounter.id, "spoke", T0935)).rejects.toMatchObject({ code: "not_a_tele_visit" });
  });

  it("CALL: the treating doctor is handed the number — only here — and the first call is stamped once; another doctor is refused", async () => {
    const { encounterId } = await inCall();
    await expect(startTeleCall(db, drb.actor, encounterId, T0935)).rejects.toMatchObject({ code: "not_your_patient" });
    const first = await startTeleCall(db, dra.actor, encounterId, T0935);
    expect(first).toEqual({ encounterId, telePhone: "9876543021", callStartedAt: T0935 });
    const again = await startTeleCall(db, dra.actor, encounterId, T0940);
    expect(again.callStartedAt).toEqual(T0935);
    // the queue row and the encounter row carry no number
    const view = (await listQueue(db, dra.actor, dra.doctorId, DAY, T0940))!;
    expect(JSON.stringify(view.inConsult)).not.toContain("9876543021");
    expect(JSON.stringify(await enc(encounterId))).not.toContain("9876543021");
  });

  it("'SPOKE' raises ONE consultation invoice on the visit, settled from the desk's advance, issued by the system — once", async () => {
    const { encounterId, appointmentId } = await inCall();
    const r1 = await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0940);
    expect({ outcome: r1.encounter.teleOutcome, at: r1.encounter.teleOutcomeAt, by: r1.encounter.teleOutcomeBy, status: r1.encounter.status })
      .toEqual({ outcome: "spoke", at: T0940, by: dra.userId, status: "in_consultation" });
    const got = await bills(encounterId);
    expect(got).toHaveLength(1);
    expect({ patientId: got[0]!.patientId, net: got[0]!.netPayablePaise, by: got[0]!.issuedBy, credit: got[0]!.creditExtended })
      .toEqual({ patientId: p1.id, net: FEE, by: "opd-tele-bill", credit: false });
    expect((await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, got[0]!.id))).map((l) => l.serviceId)).toEqual([base.consultNewServiceId]);
    expect((await invoiceSettlement(db, got[0]!.id)).state).toBe("settled");
    const receipt = (await db.select().from(receipts))[0]!;
    expect(receipt.receivedBy).toBe(clerk.id); // the receipt still names the cashier
    expect((await db.select().from(allocations)).map((a) => ({ r: a.receiptId, i: a.invoiceId, p: a.amountPaise })))
      .toEqual([{ r: (await appt(appointmentId)).advanceReceiptId, i: got[0]!.id, p: FEE }]);

    // said again: nothing changes, nothing is billed twice
    const r2 = await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0950);
    expect(r2.encounter.teleOutcomeAt).toEqual(T0940);
    expect(await bills(encounterId)).toHaveLength(1);
    expect(await db.select().from(receipts)).toHaveLength(1);
    await expect(recordTeleOutcome(db, dra.actor, encounterId, "no_answer", T0950)).rejects.toMatchObject({ code: "encounter_state_conflict" });
    // no board or rail is told anything about its money — asked the way billing's settle hook asks
    await withTx(db, (tx) => queueFeeStatusHook(tx, dra.actor, { encounterId, invoiceId: got[0]!.id, via: "invoice" }, T0940));
    expect(await db.select().from(events).where(eq(events.name, "queue.fee_status_changed"))).toHaveLength(0);
  });

  it("FIRST 'no answer': back to the doctor's line to be tried again, nothing billed; SECOND: the visit is closed as not consulted and the appointment goes to re-booking WITH its payment", async () => {
    const { encounterId, appointmentId } = await inCall();
    const first = await recordTeleOutcome(db, dra.actor, encounterId, "no_answer", T0935);
    expect({ final: first.final, status: first.encounter.status, n: first.encounter.teleNoAnswerCount, outcome: first.encounter.teleOutcome })
      .toEqual({ final: false, status: "waiting", n: 1, outcome: "no_answer" });
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId));
    expect(entries.map((e) => e.status).sort()).toEqual(["done", "waiting"]);
    const view = (await listQueue(db, dra.actor, dra.doctorId, DAY, T0940))!;
    expect(view.ordered.map((r) => ({ tele: r.tele, id: r.encounterId, c: r.queueClass }))).toEqual([{ tele: true, id: encounterId, c: 2 }]);
    expect((await appt(appointmentId)).status).toBe("checked_in");
    expect(await bills(encounterId)).toHaveLength(0);

    await startConsultation(db, dra.actor, encounterId, T0940);
    const second = await recordTeleOutcome(db, dra.actor, encounterId, "no_answer", T0950);
    expect({ final: second.final, status: second.encounter.status, n: second.encounter.teleNoAnswerCount, reason: second.encounter.abandonReason })
      .toEqual({ final: true, status: "abandoned", n: 2, reason: "tele-call: the patient did not answer twice" });
    expect((await db.select().from(opdQueueEntries).where(and(eq(opdQueueEntries.encounterId, encounterId), eq(opdQueueEntries.status, "in_consult")))).length).toBe(0);
    expect(await listQueue(db, dra.actor, dra.doctorId, DAY, T0950).then((v) => [...v!.ordered, ...v!.inConsult].length)).toBe(0);
    const a = await appt(appointmentId);
    expect({ status: a.status, q: a.advanceQuotePaise, paid: a.advanceReceiptId !== null }).toEqual({ status: "needs_rebooking", q: FEE, paid: true });
    expect((await teleDeskMarks(db, [a])).get(a.id)).toEqual({ amountPaise: FEE, covered: true });
    // nothing billed, nothing consumed: the advance is whole
    expect(await bills(encounterId)).toHaveLength(0);
    expect(await db.select().from(allocations)).toHaveLength(0);
    await expect(completeConsultation(db, dra.actor, encounterId, { testsOrderedReturnToday: false }, T0950)).rejects.toMatchObject({ code: "encounter_state_conflict" });

    // RE-BOOKED: the payment is carried, and the new slot opens with no new payment
    const { to } = await rescheduleAppointment(db, clerk.actor, appointmentId, { slotStart: S1000 }, T0950);
    expect({ status: to.status, r: to.advanceReceiptId, q: to.advanceQuotePaise }).toEqual({ status: "booked", r: a.advanceReceiptId, q: FEE });
    expect(await openDueTeleVisits(db, T1001)).toEqual({ due: 1, opened: 1, failed: 0 });
    const reopened = (await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, to.id)))[0]!;
    expect({ mode: reopened.consultMode, status: reopened.status, type: reopened.visitType }).toEqual({ mode: "tele", status: "waiting", type: "new" });
    expect(await db.select().from(receipts)).toHaveLength(1);
    // spoken to on the second slot: now it is billed, once, from the same advance
    await startConsultation(db, dra.actor, reopened.id, T1001);
    await recordTeleOutcome(db, dra.actor, reopened.id, "spoke", T1001);
    expect(await bills(reopened.id)).toHaveLength(1);
    expect((await db.select().from(allocations)).map((x) => x.amountPaise)).toEqual([FEE]);
  });

  it("a free follow-up that was spoken to raises no bill, as an in-person free follow-up raises none", async () => {
    await db.update(tariffItems).set({ pricePaise: 0 }).where(eq(tariffItems.versionId, base.tariffVersionId));
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930, mode: "tele", telePhone: "9876543021" }, NOW_SUN);
    await recordTeleAdvance(db, clerk.actor, appointment.id, { amountPaise: 0 }, NOW_SUN);
    await openDueTeleVisits(db, T0931);
    const e = (await db.select().from(opdEncounters))[0]!;
    await startConsultation(db, dra.actor, e.id, T0931);
    await recordTeleOutcome(db, dra.actor, e.id, "spoke", T0940);
    expect(await bills(e.id)).toHaveLength(0);
    expect((await completeConsultation(db, dra.actor, e.id, { testsOrderedReturnToday: false }, T0950)).encounter.status).toBe("completed");
  });

  it("the price list moved after the payment: a LOWER fee is billed and the difference stays the patient's advance; a HIGHER fee is left to the billing office — the doctor's outcome stands either way", async () => {
    const { encounterId } = await inCall();
    await db.update(tariffItems).set({ pricePaise: 30_000 }).where(and(eq(tariffItems.versionId, base.tariffVersionId), eq(tariffItems.serviceId, base.consultNewServiceId)));
    await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0940);
    const lower = await bills(encounterId);
    expect(lower.map((i) => i.netPayablePaise)).toEqual([30_000]);
    expect((await invoiceSettlement(db, lower[0]!.id)).state).toBe("settled");
    expect((await db.select().from(allocations)).map((x) => x.amountPaise)).toEqual([30_000]);
  });

  it("…a HIGHER fee: no invoice is raised by the system, the advance stays whole, and 'spoke' is recorded", async () => {
    const { encounterId } = await inCall();
    await db.update(tariffItems).set({ pricePaise: 90_000 }).where(and(eq(tariffItems.versionId, base.tariffVersionId), eq(tariffItems.serviceId, base.consultNewServiceId)));
    const r = await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0940);
    expect(r.encounter.teleOutcome).toBe("spoke");
    expect(await bills(encounterId)).toHaveLength(0);
    expect(await db.select().from(allocations)).toHaveLength(0);
    expect((await completeConsultation(db, dra.actor, encounterId, { testsOrderedReturnToday: false }, T0950)).encounter.status).toBe("completed");
  });
});
