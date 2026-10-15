import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { opdEncounters } from "../../kernel/db/schema";
import { completeConsultation, openUnpaidToken, registerConsultStartGuard, registerVitalsStartGuard, saveConsultNote, startConsultation } from "./consultation";
import { grantFeeBypass, openVisit } from "./encounters";
import { QUEUE_MONEY_KEYS, boardSnapshot, callNext, listQueue, queueWithoutMoney, summaryByDoctor } from "./queue";
import { recordVitals } from "./vitals";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { Db } from "../../kernel/db/client";

const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

/**
 * ═══ THE DESK LET THEM THROUGH, SO THEY ARE IN THE DOCTOR'S LINE (OWNER RULING 2026-10-09) ═══
 *
 * Owner: *"walk-in rule, a (desk let through → patient shows in doctor's line, no mark)"* ·
 * *"make sure that Doctor will not see 'paid' written or marked against any patient name or id.
 * This is a hospital not a clinic."* · *"Doctor's screens must not show money."*
 *
 * This file used to pin the opposite (ruling 2026-09-20: the token waits for its bill until the
 * doctor opens it). Both sides of the new rule are here: a visit with a recorded desk bypass is an
 * ordinary waiting patient and its consultation starts with nobody typing a reason; a visit that is
 * neither paid nor let through is stopped exactly where it was.
 *
 * THE BILLING MODULE IS REAL HERE AND NOT STUBBED for the queue rows (`seedBillingBase`): the fee
 * status the desk's copy carries is the ledger, read. The consult door's verdict is a stub in
 * `feeGate`'s exact shape, as in `vitals-fee-gate.test.ts`; `billing.e2e.test.ts` proves the real
 * one over HTTP.
 */
describe("a visit the desk let through unpaid is an ordinary patient in the doctor's line", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let cashier: Awaited<ReturnType<typeof mkCashier>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    base = await seedBillingBase(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    cashier = await mkCashier(db, "cash1");
  });
  afterEach(() => { unregister?.(); unregister = null; });

  /** The refusing consult guard, in `feeGate`'s exact shape — the doctor's door, shut. */
  function consultGateRefusing(): void {
    unregister = registerConsultStartGuard("test_consult_fee_gate", () =>
      Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "new" } }));
  }

  /**
   * A visit that is READY FOR THE DOCTOR AND UNPAID: the front desk waved it past the counter
   * (FD-32), the bay charted it, so its entry is `waiting` — the state the ruling is about. Every
   * other road to this state (the bay's own emergency save) lands on the same row.
   */
  async function unpaidWaiting(name: string, doctor = dra): Promise<{ encounterId: string; patientId: string; tokenNo: number }> {
    const patient = await mkPatient(db, clerk.actor, { name });
    const open = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, MON);
    await grantFeeBypass(db, clerk.actor, open.encounter.id, `emergency — ${name}`, MON);
    await recordVitals(db, vd.actor, open.encounter.id, adultOk, MON);
    return { encounterId: open.encounter.id, patientId: patient.id, tokenNo: open.queueEntry.tokenNo };
  }

  const queue = async (): Promise<NonNullable<Awaited<ReturnType<typeof listQueue>>>> =>
    (await listQueue(db, dra.actor, dra.doctorId, "2026-08-17", MON))!;

  /** Every key of a JSON-shaped value, at any depth. */
  const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
    }
    return out;
  };

  it("it sits in the callable order in its own place, nothing is held, and callNext reaches it", async () => {
    const first = await unpaidWaiting("Sunita Devi");
    const paid = await mkPatient(db, clerk.actor, { name: "Paid Second" });
    const open = await openVisit(db, clerk.actor, { patientId: paid.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await grantFeeBypass(db, clerk.actor, open.encounter.id, "fixture: reaches the bay", MON);
    await recordVitals(db, vd.actor, open.encounter.id, adultOk, MON);
    await openSessionFor(db, cashier, 200_000);
    await issuePaidInvoice(db, cashier, { patientId: paid.id, serviceId: base.consultNewServiceId, encounterId: open.encounter.id }, MON);

    const view = await queue();
    expect(view.ordered.map((e) => [e.tokenNo, e.position])).toEqual([[first.tokenNo, 1], [open.queueEntry.tokenNo, 2]]);
    expect(view.heldForPayment).toEqual([]);
    expect(view.counts).toMatchObject({ waiting: 2, heldForPayment: 0 });
    /* The DESK's copy still says who has not paid — collecting it is the desk's work. */
    expect(view.ordered.map((e) => e.feeStatus)).toEqual(["unsettled", "settled"]);
    expect(view.ordered[0]!.encounter.feeBypassReason).toContain("emergency");

    const called = await callNext(db, dra.actor, view.session.id, MON);
    expect(called.entry?.tokenNo).toBe(first.tokenNo);
  });

  it("a patient charted by the BAY's emergency save is in the line too", async () => {
    const unregisterVitals = registerVitalsStartGuard("test_fee_gate", () =>
      Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "new" } }));
    const patient = await mkPatient(db, clerk.actor, { name: "Chandan Ram" });
    const open = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const saved = await recordVitals(db, vd.actor, open.encounter.id, adultOk, MON, { emergency: true });
    unregisterVitals();
    expect(saved.feeWaived).toBe(true);
    expect(saved.encounter.feeBypassBy).toBe(vd.id);

    const view = await queue();
    expect(view.ordered.map((e) => e.tokenNo)).toEqual([open.queueEntry.tokenNo]);
    expect(view.heldForPayment).toEqual([]);
  });

  it("the hall board announces it and the desk summary counts it as waiting", async () => {
    const { tokenNo } = await unpaidWaiting("Ganesh Oraon");

    const board = await boardSnapshot(db, "2026-08-17", undefined, MON);
    expect(board.find((b) => b.doctorId === dra.doctorId)).toMatchObject({ next: [tokenNo], waitingCount: 1 });
    const summary = await summaryByDoctor(db, deptId, "2026-08-17", MON);
    expect(summary.find((s) => s.doctor.id === dra.doctorId)).toMatchObject({ waitingCount: 1, heldForPaymentCount: 0 });
  });

  describe("the consultation door", () => {
    it("LET THROUGH → the consultation starts, is noted and is completed with no reason asked of the doctor", async () => {
      consultGateRefusing();
      const { encounterId } = await unpaidWaiting("Rina Kumari");

      const started = await startConsultation(db, dra.actor, encounterId, MON);
      expect(started.encounter.status).toBe("in_consultation");
      /* Nobody wrote a doctor's override: the desk's bypass is the only decision on this visit. */
      expect(started.encounter.consultFeeOverrideBy).toBeNull();
      expect(started.encounter.feeBypassBy).toBe(clerk.id);

      const noted = await saveConsultNote(db, dra.actor, encounterId, { advice: "fluids" }, MON);
      expect(noted.encounter.status).toBe("in_consultation");
      const done = await completeConsultation(db, dra.actor, encounterId, { testsOrderedReturnToday: false }, MON);
      expect(done.encounter.status).toBe("completed");
    });

    it("NEITHER PAID NOR LET THROUGH → the bay's pay-before-vitals door still stops the visit", async () => {
      const unregisterVitals = registerVitalsStartGuard("test_fee_gate", () =>
        Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "new" } }));
      const patient = await mkPatient(db, clerk.actor, { name: "Unpaid Walk-in" });
      const open = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      await expect(recordVitals(db, vd.actor, open.encounter.id, adultOk, MON)).rejects.toMatchObject({ code: "consult_gate_refused" });
      unregisterVitals();
      /* Never charted, so never `waiting`: the doctor's line does not have them. */
      expect((await queue()).ordered).toEqual([]);
    });

    it("NEITHER PAID NOR LET THROUGH but already waiting (a receipt voided after vitals) → the consultation is still refused, in words without money", async () => {
      consultGateRefusing();
      const { encounterId } = await unpaidWaiting("Voided Receipt");
      /* The state a void leaves: unpaid, and no desk decision on the visit. */
      await db.update(opdEncounters).set({ feeBypassBy: null, feeBypassReason: null, feeBypassAt: null }).where(eq(opdEncounters.id, encounterId));

      const refusal = await startConsultation(db, dra.actor, encounterId, MON).catch((e: unknown) => e as { code: string; message: string; detail: unknown });
      expect(refusal).toMatchObject({ code: "consult_gate_refused", detail: { guard: "test_consult_fee_gate", code: "fee_unsettled" } });
      /* The doctor's phone prints this sentence as it stands. */
      expect((refusal as { message: string }).message).not.toMatch(/paid|fee|bill|₹|dues|held/i);
      const rows = await db.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId));
      expect(rows[0]!.status).toBe("waiting");
    });

    it("excuses the MONEY and nothing else: a guard refusing for any other reason still refuses a let-through visit", async () => {
      unregister = registerConsultStartGuard("test_clinical_gate", () =>
        Promise.resolve({ ok: false as const, code: "patient_sealed", detail: {} }));
      const { encounterId } = await unpaidWaiting("Munna");

      await expect(startConsultation(db, dra.actor, encounterId, MON)).rejects.toMatchObject({
        code: "consult_gate_refused", detail: { code: "patient_sealed" },
      });
    });
  });

  /**
   * THE RETIRED ROUTE STILL ANSWERS. No screen calls `consult/open-unpaid` any more, but a phone
   * that has not updated may, and a visit a doctor opened this morning under the old rule must
   * still start this afternoon.
   */
  describe("the doctor's own override, retired", () => {
    it("an old app build's call is answered as before and breaks nothing", async () => {
      consultGateRefusing();
      const { encounterId } = await unpaidWaiting("Phulwa Devi");

      await expect(openUnpaidToken(db, dra.actor, encounterId, "  ", MON)).rejects.toMatchObject({ code: "reason_required" });
      await expect(openUnpaidToken(db, drb.actor, encounterId, "I will see her", MON)).rejects.toMatchObject({ code: "not_your_patient" });
      await expect(openUnpaidToken(db, clerk.actor, encounterId, "the desk says so", MON)).rejects.toMatchObject({ code: "not_a_doctor" });
      const first = await openUnpaidToken(db, dra.actor, encounterId, "emergency — breathless", MON);
      const again = await openUnpaidToken(db, dra.actor, encounterId, "something else entirely", MON);
      expect(again.encounter.consultFeeOverrideReason).toBe(first.encounter.consultFeeOverrideReason);

      expect((await queue()).ordered).toHaveLength(1);
      expect((await startConsultation(db, dra.actor, encounterId, MON)).encounter.status).toBe("in_consultation");
    });

    it("an override written before the ruling still opens the door for a visit with no desk bypass", async () => {
      consultGateRefusing();
      const { encounterId } = await unpaidWaiting("Opened This Morning");
      await openUnpaidToken(db, dra.actor, encounterId, "emergency — seeing him now", MON);
      await db.update(opdEncounters).set({ feeBypassBy: null, feeBypassReason: null, feeBypassAt: null }).where(eq(opdEncounters.id, encounterId));

      expect((await startConsultation(db, dra.actor, encounterId, MON)).encounter.status).toBe("in_consultation");
    });
  });

  /**
   * ═══ THE DOCTOR'S COPY OF THE QUEUE HAS NO MONEY KEY IN IT, ANYWHERE ═══
   * `GET /opd/queues` hands this to every caller without a fee-seeing permission
   * (`billing.e2e.test.ts` asks the route as a doctor and as the desk).
   */
  it("queueWithoutMoney: no fee status, no bypass reason, no override reason, nothing held — on every row", async () => {
    consultGateRefusing();
    const lineRow = await unpaidWaiting("In The Line");
    const calledRow = await unpaidWaiting("Called One");
    const withRow = await unpaidWaiting("With The Doctor");
    await openUnpaidToken(db, dra.actor, lineRow.encounterId, "old build wrote this", MON);
    await startConsultation(db, dra.actor, withRow.encounterId, MON);
    const full = await queue();
    await callNext(db, dra.actor, full.session.id, MON);
    void calledRow;

    const mine = queueWithoutMoney(await queue());
    expect(mine.ordered.length + (mine.current === null ? 0 : 1) + mine.inConsult.length).toBe(3);
    expect(mine.current).not.toBeNull();
    expect(mine.heldForPayment).toEqual([]);
    const keys = keysOf({ ordered: mine.ordered, current: mine.current, inConsult: mine.inConsult, left: mine.left });
    for (const k of QUEUE_MONEY_KEYS) expect(keys.has(k)).toBe(false);
    expect([...keys].filter((k) => /fee|paid|bypass|override|amount|paise|unsettled|invoice|bill|dues/i.test(k))).toEqual([]);
    expect(JSON.stringify(mine.ordered) + JSON.stringify(mine.current) + JSON.stringify(mine.inConsult)).not.toMatch(/unsettled|old build wrote this|emergency —/);
  });

  it("an UNCONFIGURED hospital: the same line, and the desk's copy has no status to report", async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra2", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk2", ["front_office"]);
    vd = await mkUser(db, "vd2", ["vitals_desk"]);
    const { tokenNo } = await unpaidWaiting("Anita Kumari");

    const view = await queue();
    expect(view.heldForPayment).toHaveLength(0);
    expect(view.ordered.map((e) => e.tokenNo)).toEqual([tokenNo]);
    expect(view.ordered[0]!.feeStatus).toBeNull();
  });
});
