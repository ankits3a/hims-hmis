import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, opdAppointments, opdEncounters, opdQueueEntries, opdVitals, printJobs, receipts, tariffItems } from "../../kernel/db/schema";
import { bookAppointment, sweepAppointmentNoShows } from "./appointments";
import { listBench } from "./bench";
import { registerConsultStartGuard, startConsultation } from "./consultation";
import { moveEncounter, openVisit } from "./encounters";
import { feeMarksFor } from "./prestage";
import { boardSnapshot, listQueue } from "./queue";
import { slipDay } from "./slips";
import { openDueTeleVisits, openTeleVisitFor, recordTeleAdvance, teleFee } from "./tele";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/**
 * TELE-CALL, SLICE 3 (owner 2026-10-09): *"Doctor will see the patient name in his queue only when
 * the patient have paid."* The visit exists only when the slot has come AND the desk has been paid.
 */
const DAY = "2026-08-17"; // Monday
const S0930 = new Date("2026-08-17T04:00:00.000Z"); // 09:30 IST
const S1000 = new Date("2026-08-17T04:30:00.000Z");
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z"); // the booking day
const MON_0900 = new Date("2026-08-17T03:30:00.000Z");
const MON_0931 = new Date("2026-08-17T04:01:00.000Z");
const MON_0932 = new Date("2026-08-17T04:02:00.000Z");
const T0 = new Date("2026-08-10T05:00:00.000Z");
const FEE = 50_000;

describe("opd tele-call — the visit opens at its slot, once paid (slice 3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
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
    clerk = await mkUser(db, "to_clerk", ["front_office", "cashier"]);
    vd = await mkUser(db, "to_vd", ["vitals_desk"]);
    p1 = await mkPatient(db, clerk.actor, { phone: "9876500001" });
    p2 = await mkPatient(db, clerk.actor, { phone: "9876500002" });
    await openSessionFor(db, clerk, 0);
  });
  const bookTele = async (slotStart: Date = S0930, patientId: string = p1.id) =>
    (await bookAppointment(db, clerk.actor, { patientId, doctorId: dra.doctorId, slotStart, mode: "tele", telePhone: "9876543021" }, NOW_SUN)).appointment;
  const pay = (id: string, at: Date = NOW_SUN) => recordTeleAdvance(db, clerk.actor, id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE }] }, at);
  const appt = async (id: string) => (await db.select().from(opdAppointments).where(eq(opdAppointments.id, id)))[0]!;
  const visits = () => db.select().from(opdEncounters);
  const line = async (now: Date) => await listQueue(db, dra.actor, dra.doctorId, DAY, now);

  it("UNPAID at slot time: no visit, and nothing in the doctor's queue read", async () => {
    const a = await bookTele();
    expect(await openDueTeleVisits(db, MON_0931)).toEqual({ due: 0, opened: 0, failed: 0 });
    expect(await openTeleVisitFor(db, a.id, MON_0931)).toEqual({ opened: false, encounterId: null });
    expect(await visits()).toHaveLength(0);
    expect(await line(MON_0931)).toBeNull();
    expect((await appt(a.id)).status).toBe("booked");
    expect(await db.select().from(events).where(eq(events.name, "tele.visits_opened"))).toHaveLength(0);
  });

  it("PAID: nothing before the slot; at the slot the job opens the visit — in the doctor's line with tele:true and no money mark, no paper, not on the bench, not on the hall board — once", async () => {
    const a = await bookTele();
    await pay(a.id);
    expect(await openDueTeleVisits(db, MON_0900)).toEqual({ due: 0, opened: 0, failed: 0 });
    expect(await visits()).toHaveLength(0);

    expect(await openDueTeleVisits(db, MON_0931)).toEqual({ due: 1, opened: 1, failed: 0 });
    const [enc] = await visits();
    expect({ mode: enc!.consultMode, status: enc!.status, type: enc!.visitType, appointmentId: enc!.appointmentId, by: enc!.openedBy, date: enc!.serviceDate })
      .toEqual({ mode: "tele", status: "waiting", type: "new", appointmentId: a.id, by: "opd-tele-open", date: DAY });
    expect({ status: (await appt(a.id)).status, encounterId: (await appt(a.id)).encounterId }).toEqual({ status: "checked_in", encounterId: enc!.id });

    const entries = await db.select().from(opdQueueEntries);
    expect(entries.map((e) => ({ status: e.status, kind: e.kind, at: e.appointmentAt?.toISOString(), token: e.tokenNo })))
      .toEqual([{ status: "waiting", kind: "appointment", at: S0930.toISOString(), token: 1 }]);
    // no token slip, no A4 sheet, no chart
    expect(await db.select().from(printJobs)).toHaveLength(0);
    expect(await db.select().from(opdVitals)).toHaveLength(0);

    const view = (await line(MON_0931))!;
    expect(view.ordered).toHaveLength(1);
    const row = view.ordered[0]!;
    expect({ tele: row.tele, feeStatus: row.feeStatus, queueClass: row.queueClass, at: row.appointmentAt?.toISOString() })
      .toEqual({ tele: true, feeStatus: null, queueClass: 2, at: S0930.toISOString() });
    expect(view.heldForPayment).toEqual([]);
    expect(await feeMarksFor(db, enc!)).toEqual({ feeUnpaid: false, feeBypass: null });
    /*
      THE HARD RULE, on the payload: nothing on a tele row names money. No key speaks of an advance,
      a receipt, a quote or paise; every key that says "fee" holds null; no value says paid or unpaid.
    */
    const flat = (o: unknown, path = ""): [string, unknown][] => (o !== null && typeof o === "object" && !(o instanceof Date)
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flat(v, `${path}.${k}`)) : [[path, o]]);
    const leaves = flat({ ...row, patient: null });
    expect(leaves.filter(([k]) => /advance|receipt|quote|paise|paid|invoice/i.test(k))).toEqual([]);
    expect(leaves.filter(([k, v]) => /fee/i.test(k) && v !== null)).toEqual([]);
    expect(leaves.filter(([, v]) => typeof v === "string" && /paid|unsettled|settled|credit/i.test(v))).toEqual([]);

    expect(await listBench(db, vd.actor, { serviceDate: DAY }, MON_0931)).toEqual([]);
    expect((await slipDay(db, clerk.actor, MON_0931)).items).toEqual([]);
    const board = await boardSnapshot(db, DAY, undefined, MON_0931);
    expect(board.map((b) => ({ waitingCount: b.waitingCount, next: b.next, nowServing: b.nowServing }))).toEqual([{ waitingCount: 0, next: [], nowServing: null }]);

    // the next tick finds nothing to do
    expect(await openDueTeleVisits(db, MON_0932)).toEqual({ due: 0, opened: 0, failed: 0 });
    expect(await visits()).toHaveLength(1);
    const summary = await db.select().from(events).where(eq(events.name, "tele.visits_opened"));
    expect(summary.map((e) => e.payload)).toEqual([{ serviceDate: DAY, due: 1, opened: 1, failed: 0 }]);
  });

  it("a walk-in beside it is on the bench and the board; the tele-call, due, is ahead of the walk-in in the doctor's order", async () => {
    const a = await bookTele();
    await pay(a.id);
    const walk = await openVisit(db, clerk.actor, { patientId: p2.id, departmentId: deptId, doctorId: dra.doctorId }, MON_0900);
    await withTx(db, (tx) => moveEncounter(tx, vd.actor, walk.encounter, "waiting", {}, MON_0900));
    await db.update(opdQueueEntries).set({ status: "waiting", eligibleAt: MON_0900 }).where(eq(opdQueueEntries.encounterId, walk.encounter.id));
    await openDueTeleVisits(db, MON_0931);
    const view = (await line(MON_0931))!;
    expect(view.ordered.map((r) => ({ tele: r.tele, c: r.queueClass }))).toEqual([{ tele: true, c: 2 }, { tele: false, c: 3 }]);
    const board = await boardSnapshot(db, DAY, undefined, MON_0931);
    expect(board[0]!.waitingCount).toBe(1);
    expect(board[0]!.next).toEqual([walk.tokenNo]);
    // the walk-in's paper was queued as always; the tele-call added none
    const paper = await db.select().from(printJobs);
    expect(new Set(paper.map((j) => j.encounterId))).toEqual(new Set([walk.encounter.id]));
  });

  it("a payment AFTER the slot opens the visit in that request", async () => {
    const a = await bookTele();
    const r = await pay(a.id, MON_0931);
    expect(r.opened).toBe(true);
    expect({ status: r.appointment.status, linked: r.appointment.encounterId !== null }).toEqual({ status: "checked_in", linked: true });
    expect((await visits()).map((e) => e.consultMode)).toEqual(["tele"]);
    expect(await openDueTeleVisits(db, MON_0932)).toEqual({ due: 0, opened: 0, failed: 0 });
    // …and a payment before the slot opens nothing yet
    const b = await bookTele(S1000, p2.id);
    expect((await pay(b.id, MON_0931)).opened).toBe(false);
    expect(await visits()).toHaveLength(1);
  });

  it("the price list changing after the payment changes nothing: the stamped quote is honoured and the visit opens", async () => {
    const a = await bookTele();
    await pay(a.id);
    await db.update(tariffItems).set({ pricePaise: 90_000 }).where(and(eq(tariffItems.versionId, base.tariffVersionId), eq(tariffItems.serviceId, base.consultNewServiceId)));
    expect(await teleFee(db, a.id)).toMatchObject({ amountPaise: FEE, covered: true });
    const b = await bookTele(S1000, p2.id);
    expect((await teleFee(db, b.id)).amountPaise).toBe(90_000); // an unpaid one is quoted the new price
    expect(await openDueTeleVisits(db, MON_0931)).toEqual({ due: 1, opened: 1, failed: 0 });
    expect(await db.select().from(receipts)).toHaveLength(1);
  });

  it("a follow-up inside the doctor's free window opens at its slot with no payment and no desk act, as a revisit", async () => {
    const prior = await openVisit(db, clerk.actor, { patientId: p1.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
    let enc: EncounterRow = await withTx(db, (tx) => moveEncounter(tx, vd.actor, prior.encounter, "waiting", {}, T0));
    enc = await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "in_consultation", {}, T0));
    await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "completed", { consultCompletedAt: T0, followUpDays: 14 }, T0));
    const a = await bookTele();
    expect(await openDueTeleVisits(db, MON_0931)).toEqual({ due: 1, opened: 1, failed: 0 });
    const opened = (await visits()).find((e) => e.consultMode === "tele")!;
    expect(opened.visitType).toBe("revisit");
    const row = await appt(a.id);
    expect({ status: row.status, q: row.advanceQuotePaise, r: row.advanceReceiptId }).toEqual({ status: "checked_in", q: 0, r: null });
    expect(await db.select().from(receipts)).toHaveLength(0);
  });

  it("the consultation starts on a tele visit with no bill behind it — the pay-before-consult guards are not asked — while an in-person visit is still held by them", async () => {
    const unregister = registerConsultStartGuard("test_fee_gate", async () => ({ ok: false, code: "fee_unsettled" }));
    try {
      const a = await bookTele();
      await pay(a.id);
      await openDueTeleVisits(db, MON_0931);
      const tele = (await visits())[0]!;
      const started = await startConsultation(db, dra.actor, tele.id, MON_0932);
      expect(started.encounter.status).toBe("in_consultation");

      const walk = await openVisit(db, clerk.actor, { patientId: p2.id, departmentId: deptId, doctorId: dra.doctorId }, MON_0931);
      await withTx(db, (tx) => moveEncounter(tx, vd.actor, walk.encounter, "waiting", {}, MON_0931));
      await expect(startConsultation(db, dra.actor, walk.encounter.id, MON_0932)).rejects.toMatchObject({ code: "consult_gate_refused" });
    } finally {
      unregister();
    }
  });

  it("the nightly sweep: a PAID tele-call that never opened goes to the re-booking list with its payment; an unpaid one is a no-show", async () => {
    const paid = await bookTele(S0930, p1.id);
    const r = await pay(paid.id);
    const unpaid = await bookTele(S1000, p2.id);
    await sweepAppointmentNoShows(db, new Date("2026-08-18T18:25:00.000Z"));
    const a = await appt(paid.id);
    expect({ status: a.status, r: a.advanceReceiptId, q: a.advanceQuotePaise }).toEqual({ status: "needs_rebooking", r: r.receiptId, q: FEE });
    expect((await appt(unpaid.id)).status).toBe("no_show");
    expect((await db.select().from(events).where(eq(events.name, "appointment.no_show"))).map((e) => (e.payload as { appointmentId: string }).appointmentId)).toEqual([unpaid.id]);
  });
});
