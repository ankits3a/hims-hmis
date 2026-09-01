import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import {
  attributionIds, counterparties, membershipInstances, membershipPlans, opdEncounters,
  partnerAgreements, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
// spec §4: a module reaches another module ONLY through its declared interface. `PartnersModule`
// is exported from the index precisely so the seam can be armed from outside.
import { PartnersModule } from "../partners";
import { previewInvoice } from "./invoices";
import type { Db } from "../../kernel/db/client";

/**
 * RC-2 T3 / D6 — BENEFITS STOP AT THE SELF-PAY SHARE.
 *
 * ═══ THE RULE, AND WHY IT IS A MONEY PATH RATHER THAN A PREFERENCE ═══
 *
 * The department brainstorm's O-3 default: member and coupon benefits apply to the SELF-PAY SHARE
 * only; TPA, corporate and scheme rates are TARIFF SUBSTITUTION, not contestants. A membership
 * percentage composed on top of a panel rate gives the same money away twice — once as a rate the
 * hospital already conceded to the payer, once as a benefit to the patient — on a bill the patient
 * does not settle. RC-2 extends the same rule to the referral source it just built, because a
 * channel partner's commission has no claim on a corporate employer's bill either.
 *
 * ═══ BOTH DIRECTIONS ARE EXECUTED, WHICH IS THE POINT ═══
 *
 * A gate that refuses everything passes a one-sided test. Every case below is run TWICE against the
 * same fixture — the same patient, the same live instruments, the same slip — with `intended_payer`
 * as the only difference. `self` must still discount; the other three must not.
 *
 * ═══ THE FIXTURE'S MONEY, HAND-DERIVED ═══
 *
 * `seedBillingBase` prices OPD-CONSULT-NEW at 50 000 paise, category "consultation", EXEMPT.
 *   membership 2 000 bps = 10 000 off → net 40 000   (self)
 *   referral   1 000 bps =  5 000 off → net 45 000   (self, membership absent)
 *   any non-self payer                → net 50 000   (nothing composes)
 *
 * Every plan, code, partner and person is INVENTED HERE (Plan 09 DD3 / O-9).
 */
const CLERK: Actor = { type: "user", id: "rc2-t3-clerk" };
const FLAG = "MEMBER_BENEFITS_ENABLED";
const NOW = new Date("2026-09-01T06:00:00Z");
const FROM = new Date("2026-04-01T00:00:00Z");
const TO = new Date("2026-12-31T00:00:00Z");
const SERVICE_DAY = "2026-09-01";

/** The three non-self payers the OPD contract declares, all of which must refuse. */
const PANEL_PAYERS = ["tpa", "pmjay", "corporate"] as const;

describe("RC-2 T3 — member, coupon and referral benefits apply to the self-pay share only (D6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let consultServiceId = "";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    new PartnersModule(); // arms the referral provider exactly as production does
  });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    consultServiceId = (await seedBillingBase(db)).consultNewServiceId;
  });

  /** One patient who holds a live 20% membership AND arrives on a live 10% partner slip. */
  async function subjectWithBothInstruments(intendedPayer: string): Promise<{ encounterId: string; code: string }> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Meera Iyer", sex: "female", ageYears: 51 }));

    const planId = newId();
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-T3-${planId.slice(-6)}`, title: "Invented Member Card", kind: "membership",
      benefits: [{
        benefitKey: "INV-T3-MEMBER-20", title: "Invented member consultation benefit", kind: "percent_bps",
        value: 2_000, capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null },
      }],
      entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: newId(), planId, cardCode: `T3-${planId.slice(-6)}`, holderName: "Meera Iyer",
      patientId: patient.id, validFrom: FROM, validTo: TO, status: "active", origin: "import",
    });

    const counterpartyId = newId();
    const code = `INV-T3-SLIP-${counterpartyId.slice(-6)}`;
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-T3-CP-${counterpartyId.slice(-6)}`, name: "Invented Channel Partner",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId, versionNo: 1, effectiveFrom: FROM, effectiveTo: null,
      status: "active", createdBy: "test",
      terms: {
        payableRateBps: 1_000, eligibleCategories: ["consultation"], kicker: null,
        patientDiscountBps: 1_000, patientDiscountCategories: ["consultation"],
        patientDiscountCapPaise: null, patientDiscountTitle: "Invented partner referral",
      },
    });
    await db.insert(attributionIds).values({
      id: newId(), code, counterpartyId, state: "issued", issuedBy: "test", issuedAt: FROM,
    });

    const encounterId = newId();
    await db.insert(opdEncounters).values({
      id: encounterId, visitNo: `VT3-${encounterId}`, patientId: patient.id, workflowInstanceId: newId(),
      serviceDate: SERVICE_DAY, visitType: "new", status: "waiting", intendedPayer,
      openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return { encounterId, code };
  }

  async function quote(encounterId: string, code?: string) {
    return previewInvoice(db, {
      encounterId, lines: [{ lineId: "fee", serviceId: consultServiceId, qty: 1 }], attributionCode: code,
    }, NOW);
  }

  // ── THE DIRECTION THAT MUST STILL WORK ─────────────────────────────────────────────────────

  it("self-pay: the membership still wins and the bill is still discounted", async () => {
    const { encounterId, code } = await subjectWithBothInstruments("self");
    const draft = await quote(encounterId, code);

    expect(draft.intendedPayer).toBe("self");
    expect(draft.totals.netPayablePaise).toBe(40_000);
    expect(draft.lines[0]!.winner).toMatchObject({ ruleKey: "INV-T3-MEMBER-20", amountPaise: 10_000 });
  });

  // ── THE DIRECTION THE RULE EXISTS FOR ──────────────────────────────────────────────────────

  it.each(PANEL_PAYERS)(
    "%s: the SAME patient, the SAME live membership and the SAME slip compose NOTHING",
    async (payer) => {
      const { encounterId, code } = await subjectWithBothInstruments(payer);
      const draft = await quote(encounterId, code);

      expect(draft.intendedPayer).toBe(payer);
      expect(draft.totals.netPayablePaise).toBe(50_000); // full gross — the panel rate is the price
      expect(draft.lines[0]!.winner).toBeNull();
      expect(draft.lines[0]!.discountPaise).toBe(0);
      // Not "contested and lost" — never in the contest at all. The seat says so from `intendedPayer`.
      expect(draft.lines[0]!.candidates).toHaveLength(0);
    },
  );

  /**
   * THE MUTANT: the gate removed, i.e. `memberBenefitsEnabled()` alone, which is what shipped before
   * this task. Reproduced by pricing the corporate encounter through a draft that names NO encounter
   * — the one path where `resolveEncounter` returns `self` by construction — while the patient and
   * instruments are identical. If the gate were keyed on anything but the payer, these two would
   * agree; they must not.
   *
   * Expected kill: 40 000 (benefits composed for a corporate bill) vs the 50 000 asserted above.
   */
  it("MUTANT — without the payer gate the corporate bill would compose the member discount", async () => {
    const { encounterId, code } = await subjectWithBothInstruments("corporate");
    const gated = await quote(encounterId, code);
    expect(gated.totals.netPayablePaise).toBe(50_000);

    const patientRow = (await db.select().from(opdEncounters))[0]!;
    const ungated = await previewInvoice(db, {
      // no encounterId ⇒ intendedPayer resolves to "self" ⇒ the gate opens. Same patient, same slip.
      patientId: patientRow.patientId, lines: [{ lineId: "fee", serviceId: consultServiceId, qty: 1 }],
      attributionCode: code,
    }, NOW);

    expect(ungated.totals.netPayablePaise).toBe(40_000); // THE DAMAGE the gate prevents
    expect(gated.totals.netPayablePaise - ungated.totals.netPayablePaise).toBe(10_000);
  });

  it("the gate is the PAYER, not the flag: with benefits disabled even a self-pay bill is full price", async () => {
    process.env[FLAG] = "false";
    const { encounterId, code } = await subjectWithBothInstruments("self");
    const draft = await quote(encounterId, code);
    expect(draft.totals.netPayablePaise).toBe(50_000);
    expect(draft.lines[0]!.candidates).toHaveLength(0);
  });
});
