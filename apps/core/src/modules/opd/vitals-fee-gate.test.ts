import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdEncounters } from "../../kernel/db/schema";
import { seedBillingBase } from "../../../test/helpers/billing";
import { registerVitalsStartGuard } from "./consultation";
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
});
