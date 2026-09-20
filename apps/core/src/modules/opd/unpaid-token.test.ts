import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { opdEncounters } from "../../kernel/db/schema";
import { openUnpaidToken, registerConsultStartGuard, registerVitalsStartGuard, startConsultation } from "./consultation";
import { grantFeeBypass, openVisit } from "./encounters";
import { boardSnapshot, callNext, listQueue, summaryByDoctor } from "./queue";
import { recordVitals } from "./vitals";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { Db } from "../../kernel/db/client";

const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

/**
 * ═══ THE TOKEN WAITS FOR ITS BILL, AND THE DOCTOR CAN OPEN IT (OWNER RULING 2026-09-20) ═══
 *
 * Owner: *"the emergency at the bay doesn't open the doctor's door. It waits for bill to be paid
 * until doctor opens the token from his dashboard manually. Currently the doctor have no screen to
 * do it. But we need it to be built. Once the bill is paid then the token automatically moves to
 * the display board in the queue towards the doctor consultation."*
 *
 * THE BILLING MODULE IS REAL HERE AND NOT STUBBED, which is the opposite choice from
 * `vitals-fee-gate.test.ts` one door back, and deliberate. That suite owns a DOOR and stubs the
 * verdict; this one owns the claim that a token moves BY ITSELF when money lands, and a stubbed
 * ledger cannot make that claim — the whole design rests on the hold being the invoice ledger read
 * rather than a flag somebody remembers to clear. So the fee is made real (`seedBillingBase`), the
 * receipt is a real receipt, and the queue is asked again afterwards.
 */
describe("an unsettled token is held out of the doctor's queue", () => {
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

  it("it is out of the callable order, in heldForPayment, and callNext cannot reach it", async () => {
    const { encounterId, tokenNo } = await unpaidWaiting("Sunita Devi");

    const view = await queue();
    expect(view.ordered).toHaveLength(0);
    expect(view.heldForPayment.map((e) => e.tokenNo)).toEqual([tokenNo]);
    expect(view.counts).toMatchObject({ waiting: 0, heldForPayment: 1 });
    /* The doctor's rail is told WHY this patient has no bill — it is the desk's own sentence. */
    expect(view.heldForPayment[0]!.encounter.feeBypassReason).toContain("emergency");
    expect(view.heldForPayment[0]!.feeStatus).toBe("unsettled");
    /* No position: a held token is not in the ordering, and giving it one would say it was. */
    expect(view.heldForPayment[0]!.position).toBeNull();

    /* CALL NEXT FINDS NOBODY — the token is not merely re-sorted, it is not in the running. */
    const called = await callNext(db, dra.actor, view.session.id, MON);
    expect(called.entry).toBeNull();

    const rows = await db.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId));
    expect(rows[0]!.status).toBe("waiting"); // …and nothing about the visit moved
  });

  /**
   * ═══ THE WHOLE STORY, END TO END — THE BAY'S OWN EMERGENCY SAVE (#268) MEETS THE HOLD ═══
   *
   * The helper above reaches this state through the FRONT DESK's waiver because that is the road
   * that existed when this suite was written. The road the owner actually walked is the bay's red
   * button: no clerk, no counter, one tap on a collapsing patient. It writes the same waiver in the
   * nurse's name (#268), so it arrives at the same hold — and that sentence, not a clerk's, is what
   * the doctor reads on the rail. Pinned here because the two rulings were made a day apart and
   * nothing else asserts that they compose.
   */
  it("a patient charted by the BAY's emergency save arrives held, carrying the nurse's own sentence", async () => {
    /*
      THE VITALS DOOR'S VERDICT IS STUBBED AND THE HOLD IS NOT, which is the same split
      `vitals-fee-gate.test.ts` draws one door back: billing registers the real `feeGate` on BOTH
      doors in `billing.module.ts` and `billing.e2e.test.ts` proves that wiring over HTTP. What is
      real here is everything this suite is about — the waiver the save writes, the ledger the hold
      reads, and the doctor's own door. MEASURED, not assumed: without this line the save found an
      OPEN door (no guard is registered in a unit test), waived nothing, and the row failed on
      `feeWaived` — which is the test telling the truth about what a bare unit world contains.
    */
    const unregisterVitals = registerVitalsStartGuard("test_fee_gate", () =>
      Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "new" } }));
    const patient = await mkPatient(db, clerk.actor, { name: "Chandan Ram" });
    const open = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    /* No `grantFeeBypass` anywhere: the emergency save opens the fee gate itself and signs it. */
    const saved = await recordVitals(db, vd.actor, open.encounter.id, adultOk, MON, { emergency: true });
    expect(saved.feeWaived).toBe(true);
    expect(saved.encounter.feeBypassBy).toBe(vd.id);

    const view = await queue();
    expect(view.ordered).toHaveLength(0);
    expect(view.heldForPayment.map((e) => e.tokenNo)).toEqual([open.queueEntry.tokenNo]);
    expect(view.heldForPayment[0]!.encounter.feeBypassReason).toContain("vitals taken at the bay before billing");

    /* And the doctor's own door is the only way through it, exactly as the owner ruled. */
    const opened = await openUnpaidToken(db, dra.actor, open.encounter.id, "emergency — seeing him now", MON);
    expect(opened.encounter.consultFeeOverrideBy).toBe(dra.userId);
    expect((await queue()).ordered.map((e) => e.tokenNo)).toEqual([open.queueEntry.tokenNo]);
    unregisterVitals();
  });

  it("the hall is not told: the public board does not announce an unpaid token", async () => {
    const { tokenNo } = await unpaidWaiting("Ganesh Oraon");

    const board = await boardSnapshot(db, "2026-08-17", undefined, MON);
    const mine = board.find((b) => b.doctorId === dra.doctorId)!;
    expect(mine.next).not.toContain(tokenNo);
    expect(mine.next).toEqual([]);
    expect(mine.waitingCount).toBe(0);

    /* The staff surface counts it separately — a figure the desk acts on, never shown in the hall. */
    const summary = await summaryByDoctor(db, deptId, "2026-08-17", MON);
    expect(summary.find((s) => s.doctor.id === dra.doctorId)).toMatchObject({ waitingCount: 0, heldForPaymentCount: 1 });
  });

  describe("the doctor opens it", () => {
    it("names the doctor and the reason, returns the token to the order, and lets the consultation start", async () => {
      consultGateRefusing();
      const { encounterId, tokenNo } = await unpaidWaiting("Rina Kumari");
      /* Before: the doctor's own door is shut, exactly as the owner ruled on the bay's waiver. */
      await expect(startConsultation(db, dra.actor, encounterId, MON)).rejects.toMatchObject({ code: "consult_gate_refused" });

      const opened = await openUnpaidToken(db, dra.actor, encounterId, "emergency — chest pain, seeing her now", MON);
      expect(opened.encounter.consultFeeOverrideBy).toBe(dra.userId);
      expect(opened.encounter.consultFeeOverrideReason).toBe("emergency — chest pain, seeing her now");

      const view = await queue();
      expect(view.ordered.map((e) => e.tokenNo)).toEqual([tokenNo]);
      expect(view.heldForPayment).toHaveLength(0);
      expect(view.counts).toMatchObject({ waiting: 1, heldForPayment: 0 });
      /* Still unpaid, and still saying so: a decision about the ORDER never moves a rupee. */
      expect(view.ordered[0]!.feeStatus).toBe("unsettled");
      expect(view.ordered[0]!.encounter.consultFeeOverrideReason).toContain("chest pain");

      const board = await boardSnapshot(db, "2026-08-17", undefined, MON);
      expect(board.find((b) => b.doctorId === dra.doctorId)!.next).toEqual([tokenNo]);

      /* AND THE DOOR OPENS, with the fee gate still refusing underneath it. */
      const started = await startConsultation(db, dra.actor, encounterId, MON);
      expect(started.encounter.status).toBe("in_consultation");
    });

    it("excuses the MONEY and nothing else: a guard refusing for any other reason still refuses", async () => {
      unregister = registerConsultStartGuard("test_clinical_gate", () =>
        Promise.resolve({ ok: false as const, code: "patient_sealed", detail: {} }));
      const { encounterId } = await unpaidWaiting("Munna");
      await openUnpaidToken(db, dra.actor, encounterId, "emergency — seeing him now", MON);

      await expect(startConsultation(db, dra.actor, encounterId, MON)).rejects.toMatchObject({
        code: "consult_gate_refused", detail: { code: "patient_sealed" },
      });
    });

    it("is refused without a reason, refused to a doctor it is not, and not re-assigned by a second call", async () => {
      const { encounterId } = await unpaidWaiting("Phulwa Devi");

      await expect(openUnpaidToken(db, dra.actor, encounterId, "  ", MON)).rejects.toMatchObject({ code: "reason_required" });
      /* The corridor rule: this is the treating doctor's session to spend, and nobody else's. */
      await expect(openUnpaidToken(db, drb.actor, encounterId, "I will see her", MON)).rejects.toMatchObject({ code: "not_your_patient" });
      await expect(openUnpaidToken(db, clerk.actor, encounterId, "the desk says so", MON)).rejects.toMatchObject({ code: "not_a_doctor" });

      const first = await openUnpaidToken(db, dra.actor, encounterId, "emergency — breathless", MON);
      const again = await openUnpaidToken(db, dra.actor, encounterId, "something else entirely", MON);
      expect(again.encounter.consultFeeOverrideBy).toBe(first.encounter.consultFeeOverrideBy);
      expect(again.encounter.consultFeeOverrideReason).toBe("emergency — breathless");
    });
  });

  /**
   * ═══ "ONCE THE BILL IS PAID THEN THE TOKEN AUTOMATICALLY MOVES" ═══
   *
   * Nobody calls anything. A receipt lands at the counter for this visit's consultation fee, and
   * the next read of the queue has the token in it — because the hold IS the ledger, read. This is
   * the row that would go red the day somebody replaces it with a stored flag.
   */
  it("when the bill is paid the token moves by itself — into the order and onto the board", async () => {
    const { encounterId, patientId, tokenNo } = await unpaidWaiting("Ramesh Yadav");
    expect((await queue()).heldForPayment).toHaveLength(1);

    await openSessionFor(db, cashier, 200_000);
    await issuePaidInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, encounterId }, MON);

    const view = await queue();
    expect(view.heldForPayment).toHaveLength(0);
    expect(view.ordered.map((e) => e.tokenNo)).toEqual([tokenNo]);
    expect(view.ordered[0]!.feeStatus).toBe("settled");
    /* Nobody decided anything: the money moved, not a person. */
    expect(view.ordered[0]!.encounter.consultFeeOverrideReason).toBeNull();

    const board = await boardSnapshot(db, "2026-08-17", undefined, MON);
    expect(board.find((b) => b.doctorId === dra.doctorId)).toMatchObject({ next: [tokenNo], waitingCount: 1 });

    const called = await callNext(db, dra.actor, view.session.id, MON);
    expect(called.entry?.tokenNo).toBe(tokenNo);
  });

  /**
   * THE HOSPITAL THAT HAS NOT CONFIGURED BILLING holds nothing — `encounterFeeStatuses` returns an
   * empty map there, and a queue that emptied itself on day one of commissioning would be the
   * worst possible first impression of this feature. Measured in its own db, without the billing
   * seed the rest of this suite relies on.
   */
  it("an UNCONFIGURED hospital holds nothing", async () => {
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
  });
});
