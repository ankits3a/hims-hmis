import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { mkOtPatient, mkOtUser, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import { PAYER_CLASS_VALUES } from "../../kernel/db/schema/ot";
import { recordReceipt } from "../billing";
import { depositPolicyBodySchema } from "./definitions";
import {
  grantedShortfallPaise, heldPaise, holdDeposit, openHolds, releaseHolds, requestDepositException,
  requiredDeposit,
} from "./deposit";
import { bookCase } from "./booking";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Db } from "../../kernel/db/client";
import type { DepositPolicyBody } from "./definitions";
import type { PayerClass } from "./deposit";

/**
 * PLAN 15 T3 / DD12 + §3A — `requiredDeposit`, the phase's one pure money function.
 *
 * PURE + SYNCHRONOUS, so it is tested as arithmetic: no database, no clock, no fixture graph. What
 * that buys is the PROPERTY test at the bottom — 0 <= required <= quote + implant over random
 * inputs for all eight payer classes, which no example set can express.
 */

/** §3A's defaults, exactly as `seed-ot` will draft them. Parsed, so the schema's caps apply. */
const POLICY: DepositPolicyBody = depositPolicyBodySchema.parse({
  rules: {
    self_pay: { kind: "percent_of_quote", percentBps: 10000, includeImplantEstimate: true },
    insured_tpa: { kind: "quote_minus_sanctioned", coPayFloorBps: 2000 },
    govt_scheme: { kind: "zero" },
    fp_scheme: { kind: "zero" },
    corporate_credit: { kind: "excess_over_credit" },
    membership_prepaid: { kind: "quote_minus_entitlement" },
    staff_dependant: { kind: "percent_of_quote", percentBps: 5000, includeImplantEstimate: false },
    charity: { kind: "zero" },
  },
});

describe("requiredDeposit (Plan 15 T3 / A1)", () => {
  /**
   * ═══ A1's DISCRIMINATING INPUT, AND WHY IT IS THIS ONE ═══
   *
   * `insured_tpa`, quote 60,000, sanctioned 60,000, co-pay floor 20 %.
   *
   *   shipped: max(60000 − 60000, 20 % of 60000) = **12,000**
   *   mutant:      60000 − 60000                 = **0**
   *
   * A sanction BELOW the quote does not discriminate — both return the shortfall — so the fixture
   * uses a sanction EQUAL to it. That is the case where a TPA has approved everything and the
   * patient still owes the policy's co-pay and non-payables, and it is the commonest TPA case there
   * is. Without the floor the counter tells the patient they owe nothing and the hospital finds out
   * at discharge.
   */
  it("A1 — `insured_tpa` applies the co-pay FLOOR when the sanction covers the whole quote", () => {
    const required = requiredDeposit(POLICY, {
      payerClass: "insured_tpa", quotePaise: 6_000_000, implantEstimatePaise: 0, sanctionedPaise: 6_000_000,
    });
    expect(required).toBe(1_200_000);
    // The non-discriminating leg, kept because it is the OTHER half of the rule: below the quote,
    // the shortfall wins over the floor.
    expect(requiredDeposit(POLICY, {
      payerClass: "insured_tpa", quotePaise: 6_000_000, implantEstimatePaise: 0, sanctionedPaise: 1_000_000,
    })).toBe(5_000_000);
    // No pre-auth back yet is the same position as sanctioned = 0: the whole bill is due.
    expect(requiredDeposit(POLICY, {
      payerClass: "insured_tpa", quotePaise: 6_000_000, implantEstimatePaise: 0,
    })).toBe(6_000_000);
  });

  it("A1 — `govt_scheme`, `fp_scheme` and `charity` are EXACTLY zero, whatever the quote", () => {
    for (const payerClass of ["govt_scheme", "fp_scheme", "charity"] as const) {
      expect({ payerClass, required: requiredDeposit(POLICY, {
        payerClass, quotePaise: 9_999_999, implantEstimatePaise: 5_000_000,
      }) }).toEqual({ payerClass, required: 0 });
    }
  });

  it("`self_pay` is 100 % of the quote PLUS the implant estimate — the owner's default", () => {
    expect(requiredDeposit(POLICY, {
      payerClass: "self_pay", quotePaise: 6_000_000, implantEstimatePaise: 4_000_000,
    })).toBe(10_000_000);
  });

  /**
   * `staff_dependant` at 50 % of the QUOTE ONLY — `includeImplantEstimate: false`. The two flags
   * are what make one rule shape serve two policies, and the difference is visible only when an
   * implant is expected, which is exactly the fixture §2.102 would otherwise let coincide.
   */
  it("`staff_dependant` is 50 % of the quote and EXCLUDES the implant estimate", () => {
    expect(requiredDeposit(POLICY, {
      payerClass: "staff_dependant", quotePaise: 6_000_000, implantEstimatePaise: 4_000_000,
    })).toBe(3_000_000);
    // The coinciding fixture, named: with NO implant the two flag values agree and prove nothing.
    expect(requiredDeposit(POLICY, {
      payerClass: "staff_dependant", quotePaise: 6_000_000, implantEstimatePaise: 0,
    })).toBe(3_000_000);
  });

  it("`corporate_credit` and `membership_prepaid` bill only the EXCESS, and never a negative", () => {
    expect(requiredDeposit(POLICY, {
      payerClass: "corporate_credit", quotePaise: 6_000_000, implantEstimatePaise: 4_000_000, creditAvailablePaise: 7_000_000,
    })).toBe(3_000_000);
    // Credit above the whole bill is 0, not −1,000,000 — the negative would render as a refund due.
    expect(requiredDeposit(POLICY, {
      payerClass: "corporate_credit", quotePaise: 6_000_000, implantEstimatePaise: 0, creditAvailablePaise: 7_000_000,
    })).toBe(0);
    expect(requiredDeposit(POLICY, {
      payerClass: "membership_prepaid", quotePaise: 6_000_000, implantEstimatePaise: 0, entitlementPaise: 2_500_000,
    })).toBe(3_500_000);
    expect(requiredDeposit(POLICY, {
      payerClass: "membership_prepaid", quotePaise: 6_000_000, implantEstimatePaise: 0, entitlementPaise: 9_000_000,
    })).toBe(0);
  });

  /** Every result is an integer number of paise. A percentage of an odd quote is where a float
   *  would appear, and a fractional paise reaching `assertPaise` downstream is a hard failure. */
  it("always returns an INTEGER number of paise, and never rounds UP against the patient", () => {
    // 33 % of 100_001 is 33_000.33 — floored to 33_000, which is 0.33 paise in the patient's favour.
    const oddPolicy = depositPolicyBodySchema.parse({
      rules: { ...POLICY.rules, self_pay: { kind: "percent_of_quote", percentBps: 3300, includeImplantEstimate: false } },
    });
    const required = requiredDeposit(oddPolicy, { payerClass: "self_pay", quotePaise: 100_001, implantEstimatePaise: 0 });
    expect(Number.isSafeInteger(required)).toBe(true);
    expect(required).toBe(33_000);
  });

  /**
   * ═══ THE PROPERTY, OVER RANDOM INPUTS FOR EVERY PAYER CLASS (A1) ═══
   *
   *     0 <= required <= quotePaise + implantEstimatePaise
   *
   * Both halves fail in opposite directions and both are reachable by a plausible policy. A NEGATIVE
   * required satisfies its own gate and renders on a screen as a refund due; a required ABOVE the
   * whole bill asks a patient to pre-pay more than the operation costs.
   *
   * The upper bound holds because the SCHEMA caps `percentBps` and `coPayFloorBps` at 10,000 — the
   * guard lives there rather than here so there is one place to change one rule. The random policies
   * below are generated THROUGH the schema, so a cap removed from it fails this test rather than
   * quietly widening the property.
   *
   * Deterministic seed: a property test that fails only on some runs is a flake, and §2.99's lesson
   * is that a green-on-an-idle-host assertion is not evidence.
   */
  it("A1 — the bound holds for every payer class over 2,000 random policy/input pairs", () => {
    let seed = 20260828;
    const rand = (n: number): number => {
      // xorshift32 — deterministic, and the sequence is the same on every machine and every run.
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed % n;
    };

    const violations: unknown[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const percentBps = rand(10001);
      const coPayFloorBps = rand(10001);
      const policy = depositPolicyBodySchema.parse({
        rules: Object.fromEntries(PAYER_CLASS_VALUES.map((c, idx) => {
          const shape = (idx + rand(5)) % 5;
          if (shape === 0) return [c, { kind: "zero" }];
          if (shape === 1) return [c, { kind: "percent_of_quote", percentBps, includeImplantEstimate: rand(2) === 1 }];
          if (shape === 2) return [c, { kind: "quote_minus_sanctioned", coPayFloorBps }];
          if (shape === 3) return [c, { kind: "excess_over_credit" }];
          return [c, { kind: "quote_minus_entitlement" }];
        })),
      });
      const quotePaise = rand(50_000_000);
      const implantEstimatePaise = rand(20_000_000);
      for (const payerClass of PAYER_CLASS_VALUES as readonly PayerClass[]) {
        const required = requiredDeposit(policy, {
          payerClass, quotePaise, implantEstimatePaise,
          // Deliberately unconstrained: a sanction ABOVE the bill, a credit above the bill and an
          // entitlement above the bill are all real data-entry outcomes and all three are where a
          // missing `Math.max(0, …)` produces a negative.
          sanctionedPaise: rand(80_000_000),
          creditAvailablePaise: rand(80_000_000),
          entitlementPaise: rand(80_000_000),
        });
        if (!Number.isSafeInteger(required) || required < 0 || required > quotePaise + implantEstimatePaise) {
          violations.push({ payerClass, quotePaise, implantEstimatePaise, required, rule: policy.rules[payerClass] });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  /** The schema is the upper bound's real owner, so a policy that would break the property is
   *  refused at the door rather than producing a number nobody should trust. */
  it("the SCHEMA refuses a policy that would break the bound — above 100 %", () => {
    expect(() => depositPolicyBodySchema.parse({
      rules: { ...POLICY.rules, self_pay: { kind: "percent_of_quote", percentBps: 15000, includeImplantEstimate: true } },
    })).toThrow();
    expect(() => depositPolicyBodySchema.parse({
      rules: { ...POLICY.rules, insured_tpa: { kind: "quote_minus_sanctioned", coPayFloorBps: 12000 } },
    })).toThrow();
    // …and a policy missing a payer class is refused too: the eight are a CHECK on two tables, and
    // a class with no rule would be unbookable, silently.
    const { charity, ...incomplete } = POLICY.rules;
    expect(charity).toBeDefined();
    expect(() => depositPolicyBodySchema.parse({ rules: incomplete })).toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A5c — the holds ledger, against a real database. `requiredDeposit` above is arithmetic; this is
// the half F3 forced into existence, and it needs money in a receipt to mean anything.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("holdDeposit / releaseHolds (Plan 15 T3 / A5c, F3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi");
    const cashier = await mkOtUser(db, "ot_cashier_1", ["cashier"]);
    // Through the test helper, never `billing/sessions` directly: the module-isolation lint forbids
    // reaching past another module's `index.ts`, and it caught exactly that here (spec §4).
    await openSessionFor(db, { id: cashier.id }, 0);
    cashierActor = cashier;
  });

  let cashierActor: Actor;

  /** Money on the patient with nothing allocated against it — an ADVANCE, per patient (F3). */
  async function advance(amountPaise: number): Promise<string> {
    const { receiptId } = await recordReceipt(db, cashierActor, {
      patientId, tenders: [{ mode: "cash", amountPaise }],
    });
    return receiptId;
  }

  async function book(listDate: string): Promise<string> {
    const { encounterId } = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, listDate, payerClass: "self_pay",
    });
    return encounterId;
  }

  /**
   * ═══ A5c — TWO ENCOUNTERS CANNOT HOLD THE SAME RUPEE ═══
   *
   * Advance 30,000; hold 20,000 on encounter 1; hold 20,000 on encounter 2.
   *
   *   shipped: the second is REFUSED — 30,000 − 20,000 = 10,000 of spare advance
   *   mutant:  both held, because `advanceOf` alone still reads 30,000
   *
   * The mutant's harm is exactly F3's finding: two operations that both believe they are paid for,
   * off one payment. It is not a hypothetical — a patient with a morning D&C and an afternoon
   * ganglion is one booking screen away.
   */
  it("A5c — a second encounter cannot hold advance the first has already earmarked", async () => {
    const receiptId = await advance(3_000_000);
    const e1 = await book("2026-09-02");
    const e2 = await book("2026-09-03");

    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId, amountPaise: 2_000_000 }));
    await expect(withTx(db, (tx) =>
      holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId, amountPaise: 2_000_000 })))
      .rejects.toThrow(/is already held on their day-care encounters/);

    // What DOES fit, fits — the refusal is the arithmetic and not a blanket second-hold block.
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId, amountPaise: 1_000_000 }));
    expect(await withTx(db, (tx) => heldPaise(tx, e1))).toBe(2_000_000);
    expect(await withTx(db, (tx) => heldPaise(tx, e2))).toBe(1_000_000);
  });

  it("A5c — the NON-discriminating leg: with ONE encounter, `advanceOf` alone gives the same answer", async () => {
    const receiptId = await advance(3_000_000);
    const e1 = await book("2026-09-02");
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId, amountPaise: 2_000_000 }));
    await expect(withTx(db, (tx) =>
      holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId, amountPaise: 2_000_000 })))
      .rejects.toThrow(/already held/);
  });

  it("refuses a hold with no advance behind it at all", async () => {
    const e1 = await book("2026-09-02");
    await expect(withTx(db, (tx) =>
      holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId: "r-nothing", amountPaise: 1 })))
      .rejects.toThrow(/the patient's advance is 0p/);
  });

  it("refuses a zero or negative hold, and an unknown encounter", async () => {
    const receiptId = await advance(1_000_000);
    const e1 = await book("2026-09-02");
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId, amountPaise: 0 })))
      .rejects.toThrow(/positive integer of paise/);
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: "nope", receiptId, amountPaise: 1 })))
      .rejects.toThrow(/unknown day-care encounter/);
  });

  /**
   * §3A's third-party rule: a deposit paid by an employer or a relative refunds to the PAYEE, and
   * Spike Q6 rules that "refund" means a voucher with a typed payee rather than a tender reversal.
   * The identity is captured at HOLD time, which is the only moment anybody is standing at the desk.
   */
  it("records who paid, when it was not the patient (§3A)", async () => {
    const receiptId = await advance(2_000_000);
    const e1 = await book("2026-09-02");
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, {
      encounterId: e1, receiptId, amountPaise: 2_000_000,
      paidBy: { name: "Bharat Forge Ltd", relation: "employer", phone: "9800000001" },
    }));
    const holds = await withTx(db, (tx) => openHolds(tx, e1));
    expect(holds[0]!.paidBy).toEqual({ name: "Bharat Forge Ltd", relation: "employer", phone: "9800000001" });
  });

  /**
   * A released hold returns its money to the spare advance — which is what makes a cancelled case's
   * deposit available for the re-booking, and what §3A means by "released".
   */
  it("releasing holds frees the advance again, and the release carries its reason", async () => {
    const receiptId = await advance(3_000_000);
    const e1 = await book("2026-09-02");
    const e2 = await book("2026-09-03");
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId, amountPaise: 3_000_000 }));
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId, amountPaise: 1 })))
      .rejects.toThrow(/already held/);

    const released = await withTx(db, (tx) => releaseHolds(tx, e1, "case cancelled — patient withdrew"));
    expect(released).toEqual({ released: 1, amountPaise: 3_000_000 });
    // Now it fits.
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId, amountPaise: 3_000_000 }));
    expect(await withTx(db, (tx) => heldPaise(tx, e1))).toBe(0);
    // A second release is a no-op rather than an error — the re-deploy shape, applied to a refund.
    expect(await withTx(db, (tx) => releaseHolds(tx, e1, "again"))).toEqual({ released: 0, amountPaise: 0 });
  });

  /**
   * N12 — the exception is the ONLY path to a satisfied gate below `required`, and it is scoped to
   * the encounter it was granted for. An exception for THIS patient's OTHER encounter must not
   * satisfy this one, which is F3's finding applied to the escape hatch rather than to the money.
   */
  it("N12 — a granted exception authorises a shortfall on ITS OWN encounter and no other", async () => {
    const e1 = await book("2026-09-02");
    const e2 = await book("2026-09-03");
    const { approvalId } = await withTx(db, (tx) => requestDepositException(tx, f.coordinator, {
      encounterId: e1, patientId, allowedShortfallPaise: 2_000_000, reason: "BPL family, MS counselled",
    }));
    // Pending authorises nothing.
    expect(await withTx(db, (tx) => grantedShortfallPaise(tx, e1, approvalId))).toBe(0);
    await approveRequest(db, f.owner, { approvalId, note: "approved" });
    expect(await withTx(db, (tx) => grantedShortfallPaise(tx, e1, approvalId))).toBe(2_000_000);
    // …and NOT for the patient's other encounter.
    expect(await withTx(db, (tx) => grantedShortfallPaise(tx, e2, approvalId))).toBe(0);
    // …and no approval id at all is zero, never "unlimited".
    expect(await withTx(db, (tx) => grantedShortfallPaise(tx, e1, null))).toBe(0);
  });

  it("an exception must authorise a positive shortfall and carry a reason", async () => {
    const e1 = await book("2026-09-02");
    await expect(withTx(db, (tx) => requestDepositException(tx, f.coordinator, {
      encounterId: e1, patientId, allowedShortfallPaise: 0, reason: "x",
    }))).rejects.toThrow(/positive shortfall/);
    await expect(withTx(db, (tx) => requestDepositException(tx, f.coordinator, {
      encounterId: e1, patientId, allowedShortfallPaise: 100, reason: "   ",
    }))).rejects.toThrow(/must carry a reason/);
  });
});
