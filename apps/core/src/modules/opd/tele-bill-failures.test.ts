import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { allocations, events, invoices, opdAppointments, opdEncounters } from "../../kernel/db/schema";
import { invoiceSettlement } from "../billing";
import { bookAppointment } from "./appointments";
import { startConsultation } from "./consultation";
import { openDueTeleVisits, recordTeleAdvance } from "./tele";
import { listTeleBillFailures, retryTeleBill } from "./tele-bill-failures";
import { recordTeleOutcome } from "./tele-call";
import type { Db } from "../../kernel/db/client";

/**
 * #647 — THE FAILED TELE-CALL BILLS, AND THE WAY BACK. When the doctor says "Spoke to patient" and the
 * consultation invoice cannot be raised, 'spoke' is not recorded and a `tele.bill_failed` event is
 * written (tele-call.ts, fix round 2026-10-09). Nothing showed that event to anyone. The billing office
 * now lists every such visit still waiting, and can retry the invoice once the cause is fixed; the
 * doctor's next "Spoke" then finds the bill standing and goes through.
 */
const S0930 = new Date("2026-08-17T04:00:00.000Z");
const S1000 = new Date("2026-08-17T04:30:00.000Z");
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z");
const T0931 = new Date("2026-08-17T04:01:00.000Z");
const T0940 = new Date("2026-08-17T04:10:00.000Z");
const T0945 = new Date("2026-08-17T04:15:00.000Z");
const T0950 = new Date("2026-08-17T04:20:00.000Z");
const FEE = 50_000;

describe("#647 — failed tele-call bills: the list and the retry", () => {
  let db: Db;
  let teardown: () => Promise<void>;
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
    await seedBillingBase(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: m.deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    clerk = await mkUser(db, "tb_clerk", ["front_office", "cashier"]);
    p1 = await mkPatient(db, clerk.actor, { phone: "9876500001" });
    p2 = await mkPatient(db, clerk.actor, { phone: "9876500002" });
    await openSessionFor(db, clerk, 0);
  });

  /** A paid tele-call in the doctor's hands whose 'spoke' failed: the appointment names another patient's receipt (tele-fix F1's injection). */
  async function failedSpoke(): Promise<{ encounterId: string; appointmentId: string; receiptId: string }> {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930, mode: "tele", telePhone: "9876543021" }, NOW_SUN);
    await recordTeleAdvance(db, clerk.actor, appointment.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, NOW_SUN);
    await openDueTeleVisits(db, T0931);
    const enc = (await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, appointment.id)))[0]!;
    await startConsultation(db, dra.actor, enc.id, T0931);
    const receiptId = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointment.id)))[0]!.advanceReceiptId!;
    const other = (await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: S1000, mode: "tele", telePhone: "9876543022" }, NOW_SUN)).appointment;
    const theirs = (await recordTeleAdvance(db, clerk.actor, other.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, NOW_SUN)).receiptId!;
    await db.update(opdAppointments).set({ advanceReceiptId: theirs }).where(eq(opdAppointments.id, appointment.id));
    await expect(recordTeleOutcome(db, dra.actor, enc.id, "spoke", T0940)).rejects.toMatchObject({ code: "tele_save_failed" });
    return { encounterId: enc.id, appointmentId: appointment.id, receiptId };
  }
  const bills = (encounterId: string) => db.select().from(invoices).where(eq(invoices.encounterId, encounterId));

  it("lists a visit whose bill failed: who, which visit, which doctor, the slot, the paid quote, when and why — and nothing when none failed", async () => {
    expect(await listTeleBillFailures(db, clerk.actor, T0945)).toEqual([]);
    const { encounterId, appointmentId } = await failedSpoke();

    const rows = await listTeleBillFailures(db, clerk.actor, T0945);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      encounterId, appointmentId, state: "open", attempts: 1, quotePaise: FEE,
      doctorName: expect.any(String), slotStart: S0930.toISOString(), lastFailedAt: T0940.toISOString(),
    });
    expect(rows[0]!.visitNo).toMatch(/^V/);
    expect(rows[0]!.lastCode.length).toBeGreaterThan(0);
    expect(rows[0]!.patient).toMatchObject({ uhid: expect.any(String), restricted: false });
  });

  it("a retry while the cause stands is refused with the reason, counted, and the row stays open; nothing is raised", async () => {
    const { encounterId } = await failedSpoke();
    await expect(retryTeleBill(db, clerk.actor, encounterId, T0945)).rejects.toMatchObject({ code: "tele_bill_retry_failed" });
    expect(await bills(encounterId)).toHaveLength(0);
    const rows = await listTeleBillFailures(db, clerk.actor, T0950);
    expect(rows[0]).toMatchObject({ state: "open", attempts: 2, lastFailedAt: T0945.toISOString() });
    expect((await db.select().from(events).where(eq(events.name, "tele.bill_failed"))).map((e) => e.actorId)).toContain(clerk.actor.id);
  });

  it("once the cause is fixed, Retry raises ONE invoice settled from the advance; the row waits for the doctor, whose next 'Spoke' goes through and clears it", async () => {
    const { encounterId, appointmentId, receiptId } = await failedSpoke();
    await db.update(opdAppointments).set({ advanceReceiptId: receiptId }).where(eq(opdAppointments.id, appointmentId));

    const r = await retryTeleBill(db, clerk.actor, encounterId, T0945);
    expect(r.state).toBe("billed");
    const got = await bills(encounterId);
    expect(got).toHaveLength(1);
    expect((await invoiceSettlement(db, got[0]!.id)).state).toBe("settled");
    expect((await db.select().from(allocations)).map((a) => ({ r: a.receiptId, p: a.amountPaise }))).toEqual([{ r: receiptId, p: FEE }]);
    // A second retry raises nothing more.
    expect((await retryTeleBill(db, clerk.actor, encounterId, T0945)).state).toBe("billed");
    expect(await bills(encounterId)).toHaveLength(1);
    expect((await listTeleBillFailures(db, clerk.actor, T0950))[0]).toMatchObject({ state: "billed" });

    // The doctor says it again: recorded, still one invoice, and the row is gone.
    const ok = await recordTeleOutcome(db, dra.actor, encounterId, "spoke", T0950);
    expect(ok.encounter.teleOutcome).toBe("spoke");
    expect(await bills(encounterId)).toHaveLength(1);
    expect(await listTeleBillFailures(db, clerk.actor, T0950)).toEqual([]);
  });

  it("a visit with no failed bill cannot be retried", async () => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930, mode: "tele", telePhone: "9876543021" }, NOW_SUN);
    await recordTeleAdvance(db, clerk.actor, appointment.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, NOW_SUN);
    await openDueTeleVisits(db, T0931);
    const enc = (await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, appointment.id)))[0]!;
    await expect(retryTeleBill(db, clerk.actor, enc.id, T0945)).rejects.toMatchObject({ code: "tele_bill_state_conflict" });
    expect(await bills(enc.id)).toHaveLength(0);
  });
});
