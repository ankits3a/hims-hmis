import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdEncounters } from "../../kernel/db/schema";
import { seedBillingBase } from "../../../test/helpers/billing";
import { registerConsultStartGuard, registerVitalsStartGuard, startConsultation } from "./consultation";
import { grantFeeBypass, openVisit } from "./encounters";
import { preStage } from "./prestage";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

/**
 * ═══ FD-32 — PAY BEFORE VITALS, AND THE DOOR THAT OPENS ANYWAY (OWNER RULING 2026-09-13) ═══
 *
 * Owner: *"I can see a patient who got the token but has not been billed yet is visible in vitals
 * dashboard. I think we must put a guard here. No patient should reach vitals desk until he has
 * paid. However, in case of emergency or VIP patient, the front desk could enable the patient to
 * bypass the billing with a warning sign/disclaimer/notification on each desk where the patient
 * goes."*
 *
 * A GUARD REGISTERED BY BILLING IS STUBBED HERE ON PURPOSE. The real verdict is `feeGate`, and
 * `billing.e2e.test.ts` pins it from both sides; what this suite owns is the DOOR — that OPD asks,
 * that a refusal stops the write, that the bypass is honoured by the door itself rather than by
 * each guard, and that the money fact reaches the screens. Stubbing the verdict is what lets those
 * four be tested without standing up the billing module, and it is the same seam `registerConsult-
 * StartGuard` already establishes.
 */
describe("FD-32 — the vitals desk is gated on payment, and the front desk can open it", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let patient: { id: string; uhid: string };
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor, {});
  });
  afterEach(() => { unregister?.(); unregister = null; });

  /** The unpaid verdict, in `feeGate`'s exact shape. */
  function gateRefusing(): void {
    unregister = registerVitalsStartGuard("test_fee_gate", () =>
      Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "new" } }));
  }

  async function opened(): Promise<string> {
    const o = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    return o.encounter.id;
  }

  it("an unpaid patient is REFUSED at the vitals desk, and nothing is written", async () => {
    gateRefusing();
    const encId = await opened();

    await expect(recordVitals(db, vd.actor, encId, adultOk, MON))
      .rejects.toMatchObject({ code: "consult_gate_refused" });
    /* The refusal names WHICH door, so a screen can say "pay first" rather than "consultation". */
    await expect(recordVitals(db, vd.actor, encId, adultOk, MON))
      .rejects.toMatchObject({ detail: { door: "vitals", code: "fee_unsettled" } });
    /*
      AND IT NAMES THE DOOR THAT IS OPEN. The owner read `the vitals desk is gated: fee_unsettled`
      off a real screen with the emergency button in front of him and could not tell it was the way
      through — the code moved to `detail` and the message became a sentence for the person.
    */
    await expect(recordVitals(db, vd.actor, encId, adultOk, MON))
      .rejects.toMatchObject({ message: expect.stringContaining("emergency save") as unknown as string });

    /* NOTHING WRITTEN: the visit has not moved on, so the refusal cost the nurse nothing to undo. */
    const rows = await db.select().from(opdEncounters).where(eq(opdEncounters.id, encId));
    expect(rows[0]!.status).toBe("registered");
  });

  it("the front desk opens the door with a REASON, and the same call then lands", async () => {
    gateRefusing();
    const encId = await opened();
    await expect(recordVitals(db, vd.actor, encId, adultOk, MON)).rejects.toMatchObject({ code: "consult_gate_refused" });

    /* A bare or missing reason is refused: the sentence is what every later desk is shown. */
    await expect(grantFeeBypass(db, clerk.actor, encId, "  ", MON)).rejects.toMatchObject({ code: "reason_required" });

    const enc = await grantFeeBypass(db, clerk.actor, encId, "emergency — breathless, sent straight through", MON);
    expect(enc.feeBypassBy).toBe(clerk.id);
    expect(enc.feeBypassReason).toBe("emergency — breathless, sent straight through");

    const done = await recordVitals(db, vd.actor, encId, adultOk, MON);
    expect(done.vitals.encounterId).toBe(encId);
  });

  it("the bypass is the FIRST clerk's and is not reassigned by a second call", async () => {
    const encId = await opened();
    const first = await grantFeeBypass(db, clerk.actor, encId, "VIP — chairman's guest", MON);
    const again = await grantFeeBypass(db, vd.actor, encId, "something else entirely", MON);
    expect(again.feeBypassBy).toBe(first.feeBypassBy);
    expect(again.feeBypassReason).toBe("VIP — chairman's guest");
  });

  /**
   * THE MARKER THE OWNER ASKED FOR, at its source. *"A symbol to symbolize in the vital dashboard
   * that the user has not yet paid."* The bay cannot read billing, so the fact rides the pre-stage.
   * The pair that matters is unpaid AND bypassed — the patient who is at the desk anyway.
   */
  it("the pre-stage carries the waiver, and an UNCONFIGURED hospital raises no unpaid warning", async () => {
    const encId = await opened();
    const before = await preStage(db, vd.actor, encId, MON);
    /*
      MEASURED AND KEPT, because my first expectation here was wrong and the code was right.
      `encounterFeeStatuses` returns an EMPTY map when `billing_config` is absent — its own comment:
      "a hospital that has not configured billing has no fee for a stamp to be a fact about, and
      inventing `unsettled` there would paint every token amber on day one of commissioning". So an
      unconfigured deployment shows NO unpaid symbol, which is the same answer the gate gives when
      it lets `billing_not_configured` pass through. The warning and the refusal agree about a
      hospital that has no fee policy, and that agreement is the thing worth pinning.
    */
    expect(before.feeUnpaid).toBe(false);
    expect(before.feeBypass).toBeNull();

    await grantFeeBypass(db, clerk.actor, encId, "emergency — breathless", MON);
    const after = await preStage(db, vd.actor, encId, MON);
    /* The waiver itself travels regardless: it is the front desk's act, not a billing verdict. */
    expect(after.feeBypass).toMatchObject({ by: clerk.id, reason: "emergency — breathless" });
    /* And it does NOT flip the money fact — a bypass waives the ORDER, never the fee. */
    expect(after.feeUnpaid).toBe(before.feeUnpaid);
  });

  /**
   * THE CONFIGURED HOSPITAL, which is the one the owner is describing. With a fee policy in place
   * an unbilled visit reads `unsettled`, and that is the symbol the bay, the consultation and the
   * OPD Order Desk are told to wear.
   */
  it("with billing CONFIGURED, an unbilled visit reads unpaid — and a bypass does not clear it", async () => {
    await seedBillingBase(db);
    const encId = await opened();
    const before = await preStage(db, vd.actor, encId, MON);
    expect(before.feeUnpaid).toBe(true);

    await grantFeeBypass(db, clerk.actor, encId, "VIP — chairman's guest", MON);
    const after = await preStage(db, vd.actor, encId, MON);
    expect(after.feeUnpaid).toBe(true);
    expect(after.feeBypass).toMatchObject({ reason: "VIP — chairman's guest" });
  });

  it("with no guard registered the desk is open — an unconfigured hospital is not stopped", async () => {
    const encId = await opened();
    const done = await recordVitals(db, vd.actor, encId, adultOk, MON);
    expect(done.vitals.encounterId).toBe(encId);
  });

  /**
   * ═══ THE BAY'S OWN EMERGENCY DOOR (OWNER RULING 2026-09-20) ═══
   *
   * Owner: *"he fails to bypass when the condition of the patient is emergency … the vitals desk
   * doesn't even record/save the vitals data of the patient if the billing is not done. I think, we
   * should allow the patient to record his vitals if the condition is like emergency."*
   *
   * FD-32's waiver was the front desk's alone, and the desk is not where the patient is. These
   * four pin the shape of the answer: it lands, it is SIGNED, the money fact does not move, and the
   * doctor's door stays shut behind it.
   */
  describe("the emergency save opens the gate itself", () => {
    const urgent = { emergency: true };

    it("the emergency save lands through a shut gate, and the waiver carries the saver's name", async () => {
      gateRefusing();
      const encId = await opened();
      /* The ordinary save is still refused on the very same visit — the button is the difference. */
      await expect(recordVitals(db, vd.actor, encId, adultOk, MON)).rejects.toMatchObject({ code: "consult_gate_refused" });

      const done = await recordVitals(db, vd.actor, encId, adultOk, MON, urgent);
      expect(done.vitals.encounterId).toBe(encId);
      expect(done.vitals.emergency).toBe(true);
      /* The screen is told, so the bay can say what it just did rather than save in silence. */
      expect(done.feeWaived).toBe(true);
      /* SIGNED: the waiver is the nurse's own, in the same columns the clerk's waiver uses. */
      expect(done.encounter.feeBypassBy).toBe(vd.id);
      expect(done.encounter.feeBypassReason).toContain("vitals taken at the bay before billing");
      const rows = await db.select().from(opdEncounters).where(eq(opdEncounters.id, encId));
      expect(rows[0]!.feeBypassBy).toBe(vd.id);
      expect(rows[0]!.status).toBe("waiting");
    });

    it("the money fact does not move: the desk still shows UNPAID, now with the bay's sentence beside it", async () => {
      await seedBillingBase(db);
      gateRefusing();
      const encId = await opened();
      await recordVitals(db, vd.actor, encId, adultOk, MON, urgent);

      const after = await preStage(db, vd.actor, encId, MON);
      /* A waiver waives the ORDER, never the fee — the counter still has this visit to bill. */
      expect(after.feeUnpaid).toBe(true);
      expect(after.feeBypass).toMatchObject({ by: vd.id });
      expect(after.feeBypass!.reason).toContain("the fee is still due");
    });

    it("the door stays open for the rest of the visit, and the waiver is not re-assigned", async () => {
      gateRefusing();
      const encId = await opened();
      await recordVitals(db, vd.actor, encId, adultOk, MON, urgent);

      /* A second set of numbers on a patient already waved through is not a second refusal —
         and it is taken by a DIFFERENT nurse, which is what "not re-assigned" has to mean. */
      const vd2 = await mkUser(db, "vd2", ["vitals_desk"]);
      const second = await recordVitals(db, vd2.actor, encId, adultOk, MON);
      expect(second.vitals.encounterId).toBe(encId);
      /* And it is not a second waiver: the audit question is who opened the door FIRST. */
      expect(second.feeWaived).toBe(false);
      expect(second.encounter.feeBypassBy).toBe(vd.id);
    });

    it("a visit that HAS paid is stamped with nothing — the waiver is not a side effect of the button", async () => {
      const encId = await opened();
      const done = await recordVitals(db, vd.actor, encId, adultOk, MON, urgent);
      expect(done.feeWaived).toBe(false);
      expect(done.encounter.feeBypassBy).toBeNull();
    });

    /**
     * THE ADJACENT PROPERTY, and the one this ruling must NOT change. `vitalsStartGuards` and
     * `consultStartGuards` are two registries precisely so that "waved past for vitals" cannot
     * quietly become "waved past for the consultation": the patient is charted, then billed, then
     * seen. If a later task widens the bypass to the doctor's door, this row goes red and says so.
     */
    it("the doctor's door is still shut: an emergency chart does not start a consultation", async () => {
      gateRefusing();
      const unregisterConsult = registerConsultStartGuard("test_consult_fee_gate", () =>
        Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "new" } }));
      try {
        const encId = await opened();
        await recordVitals(db, vd.actor, encId, adultOk, MON, urgent);
        await expect(startConsultation(db, dra.actor, encId, MON)).rejects.toMatchObject({
          code: "consult_gate_refused", detail: { guard: "test_consult_fee_gate", code: "fee_unsettled" },
        });
      } finally {
        unregisterConsult();
      }
    });
  });
});
