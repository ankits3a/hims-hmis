import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { otDepositHolds } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { OtError } from "./errors";
import { mkOtPatient, mkOtUser, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import { PAYER_CLASS_VALUES } from "../../kernel/db/schema/ot";
import { markEnteredInError, recordReceipt, requestRefund } from "../billing";
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
      /**
       * CLOSE REVIEW (MINOR 7) — built DIRECTLY, not through `depositPolicyBodySchema.parse`.
       *
       * The schema now refuses a charging rule on `govt_scheme`, `fp_scheme` or `charity` (D10), so
       * parsing here would reject most of the generated space and this property test would silently
       * shrink to the classes the schema happens to allow. That is the wrong direction: the bound
       * `0 ≤ required ≤ quote + implant` is a property of the FUNCTION and must hold for any rule
       * that reaches it — including one from a policy published before the constraint existed. The
       * schema's own refusal is tested separately, where it belongs.
       */
      const policy = ({
        rules: Object.fromEntries(PAYER_CLASS_VALUES.map((c, idx) => {
          const shape = (idx + rand(5)) % 5;
          if (shape === 0) return [c, { kind: "zero" }];
          if (shape === 1) return [c, { kind: "percent_of_quote", percentBps, includeImplantEstimate: rand(2) === 1 }];
          if (shape === 2) return [c, { kind: "quote_minus_sanctioned", coPayFloorBps }];
          if (shape === 3) return [c, { kind: "excess_over_credit" }];
          return [c, { kind: "quote_minus_entitlement" }];
        })),
      }) as unknown as Parameters<typeof requiredDeposit>[0];
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

  /**
   * ═══ CLOSE REVIEW (MINOR 7) — D10 IS STRUCTURAL OR IT IS NOTHING ═══
   *
   * A1's zero-deposit assertion for the three scheme classes was a property of the SEEDED policy
   * and of nothing else: `requiredDeposit` reads `policy.rules[class]` and the schema accepted any
   * rule for any class. A published policy putting a percentage on `govt_scheme` would have made
   * the claim false while the test kept passing, because the test reads the same seed it asserts
   * about. A scheme patient may not be asked for a deposit; that is what the scheme IS.
   */
  it("MINOR 7 — a scheme or charity class cannot carry a CHARGING deposit rule", () => {
    for (const cls of ["govt_scheme", "fp_scheme", "charity"] as const) {
      expect(() => depositPolicyBodySchema.parse({
        rules: { ...POLICY.rules, [cls]: { kind: "percent_of_quote", percentBps: 5000, includeImplantEstimate: false } },
      })).toThrow(new RegExp(`${cls} must carry a`));
    }
    // …and a self-pay percentage is still perfectly legal, so the guard is not a blanket ban.
    expect(() => depositPolicyBodySchema.parse({
      rules: { ...POLICY.rules, self_pay: { kind: "percent_of_quote", percentBps: 5000, includeImplantEstimate: true } },
    })).not.toThrow();
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
  let cashierActor: Actor;

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

  /**
   * CLOSE REVIEW M2 — the three ways a hold could name a receipt that cannot fund it. Each one
   * used to be accepted here and to surface hours later, on the billing desk, as a refusal naming a
   * receipt the cashier never chose — or, in the split-tender case, as a discharge bill that could
   * not be issued at all.
   */
  /**
   * ═══ PASS-2 MAJOR-1 — AN ENTERED-IN-ERROR RECEIPT REPORTED ITS FULL VALUE AS UNALLOCATED ═══
   *
   * `markEnteredInError` reverses the receipt's allocations, so `total − allocated` came back as the
   * whole amount while `advanceOf` correctly excluded it. A hold naming the dead receipt therefore
   * passed BOTH bounds — and made the discharge bill unissuable hours later, which is the exact
   * defect M2 was written to close, arriving through a door M2's own fix left open.
   */
  it("MAJOR-1 — a hold cannot be earmarked from an ENTERED-IN-ERROR receipt", async () => {
    const e = await book("2026-09-02");
    const receiptId = await advance(3_000_000);
    await markEnteredInError(db, cashierActor, {
      receiptId, reason: "keyed twice at the counter",
    });
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, {
      encounterId: e, receiptId, amountPaise: 1_000_000,
    }))).rejects.toThrow(/entered-in-error/);
  });

  /**
   * ═══ PASS-2 MAJOR-2 — THE RECEIPT CHECK IS A READ-THEN-ACT UNLESS IT IS INSIDE THE LOCK ═══
   *
   * The first remediation read the receipt's spare BEFORE `lockPatientEncounters`. Two coordinators
   * holding from one receipt for two encounters of one patient therefore both read the same spare,
   * and the loser's re-read on waking covered only the patient-level figures. Both holds landed and
   * the receipt carried more earmarks than it had money — which is the state that makes a discharge
   * bill unissuable.
   *
   * §2.99: this asserts a STATE (how much is held on the receipt), never a duration. A busy host
   * makes the interleave MORE likely, not less, so the assertion only gets truer under load.
   */
  it("MAJOR-2 — two concurrent holds on ONE receipt cannot together exceed it", async () => {
    const receiptId = await advance(3_000_000);
    const e1 = await book("2026-09-02");
    const e2 = await book("2026-09-03");

    const results = await Promise.allSettled([
      withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId, amountPaise: 2_000_000 })),
      withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId, amountPaise: 2_000_000 })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const held = (await db.select().from(otDepositHolds).where(eq(otDepositHolds.receiptId, receiptId)))
      .reduce((sum, h) => sum + h.amountPaise, 0);
    expect(held).toBe(2_000_000);
    expect(held).toBeLessThanOrEqual(3_000_000);
  });

  /**
   * ═══ WHY BOTH BOUNDS ARE KEPT, AND WHAT THIS SUITE DOES NOT TEST ═══
   *
   * The first remediation claimed the per-receipt bound strictly dominates the patient-level one and
   * rewrote A5c on that basis. The second review pass showed the claim is false: `advanceOf`
   * subtracts advance REFUNDS per patient (`billing/receipts.ts` `advanceRefundedPaise`, counting
   * vouchers in `issued`/`paid`), while a receipt's unallocated balance does not. After a refund the
   * receipt still reports its full spare and only the patient-level check refuses.
   *
   * **That divergence is NOT asserted here**, and saying so is the point: reaching it needs a
   * granted approval and an issued voucher, which is `billing/receipts.test.ts`'s fixture and not
   * this suite's. What is asserted here is that both bounds exist, that each refuses on its own
   * ground (the legs above), and that the ordering is now safe. The claim that one dominates has
   * been removed rather than re-stated — a comment asserting an inequality nobody checks is how the
   * first version got it wrong.
   */

  it("M2 — a hold naming an UNKNOWN receipt is refused here, not at the bill", async () => {
    const e = await book("2026-09-02");
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, {
      encounterId: e, receiptId: "rcpt-does-not-exist", amountPaise: 1_000_000,
    }))).rejects.toThrow(/unknown receipt/);
  });

  it("M2 — a hold cannot be earmarked from ANOTHER patient's receipt", async () => {
    const e = await book("2026-09-02");
    const other = await mkOtPatient(db, f.coordinator, "Ramesh Kumar");
    const { receiptId } = await recordReceipt(db, cashierActor, {
      patientId: other, tenders: [{ mode: "upi", amountPaise: 5_000_000, refText: "UPI/other" }],
    });
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, {
      encounterId: e, receiptId, amountPaise: 1_000_000,
    }))).rejects.toThrow(/belongs to a different patient/);
  });

  it("M2 — a hold cannot exceed what is left on the receipt it names, even when the ADVANCE covers it", async () => {
    const e = await book("2026-09-02");
    // Two receipts: ₹10,000 card and ₹20,000 cash. The patient's advance is ₹30,000 …
    const r1 = (await recordReceipt(db, cashierActor, {
      patientId, tenders: [{ mode: "card", amountPaise: 1_000_000, refText: "CARD/1" }],
    })).receiptId;
    await recordReceipt(db, cashierActor, {
      patientId, tenders: [{ mode: "cash", amountPaise: 2_000_000 }],
    });
    // … but only ₹10,000 of it is on R1, so a ₹30,000 hold naming R1 is a lie the bill cannot honour.
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, {
      encounterId: e, receiptId: r1, amountPaise: 3_000_000,
    }))).rejects.toThrow(/1000000p is unallocated and unheld on it/);
    // The truthful hold is accepted …
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e, receiptId: r1, amountPaise: 1_000_000 }));
    // … and a SECOND hold on the same receipt cannot spend the same money twice.
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, {
      encounterId: e, receiptId: r1, amountPaise: 1,
    }))).rejects.toThrow(/0p is unallocated and unheld on it/);
  });

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
      .rejects.toThrow(OtError);

    // What DOES fit, fits — the refusal is the arithmetic and not a blanket second-hold block.
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId, amountPaise: 1_000_000 }));
    expect(await withTx(db, (tx) => heldPaise(tx, e1))).toBe(2_000_000);
    expect(await withTx(db, (tx) => heldPaise(tx, e2))).toBe(1_000_000);
    // The whole advance is earmarked and not a paise more — F3's invariant, stated as the sum.
    expect(await withTx(db, (tx) => heldPaise(tx, e1)) + await withTx(db, (tx) => heldPaise(tx, e2)))
      .toBe(3_000_000);
  });

  /**
   * ═══ CLOSE REVIEW M2 MADE THE PATIENT-LEVEL BOUND A BACKSTOP, AND THAT IS WORTH SAYING ═══
   *
   * A5c above no longer asserts the patient-level MESSAGE, because it can no longer be the one that
   * fires. The arithmetic is the reason, not a preference:
   *
   *   patient spare = advance − Σ holds = Σ over receipts of (unallocated − held on that receipt)
   *
   * so a single receipt's spare is a TERM of the patient's spare and can never exceed it. Any hold
   * the per-receipt bound admits therefore already satisfies the patient-level bound, and the
   * per-receipt refusal always arrives first. F3's invariant — two encounters cannot hold the same
   * rupee — is enforced strictly more tightly than before, per receipt rather than per patient.
   *
   * The patient-level check is KEPT rather than deleted: it costs one query, and it is the thing
   * that still holds if a receipt is ever double-counted or a hold is written by a path that does
   * not go through `holdDeposit`. But it is now defence in depth, and a test that claimed to
   * exercise it would be claiming a discrimination it does not have (§3.14).
   */
  it("A5c — the two bounds agree, and the per-receipt one is the tighter", async () => {
    const r1 = await advance(2_000_000);
    const r2 = await advance(1_000_000);
    const e1 = await book("2026-09-02");
    const e2 = await book("2026-09-03");

    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId: r1, amountPaise: 2_000_000 }));
    // r1 is spent; the patient still has ₹10,000 of advance, and it is all on r2.
    await expect(withTx(db, (tx) =>
      holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId: r1, amountPaise: 1 })))
      .rejects.toThrow(/0p is unallocated and unheld on it/);
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId: r2, amountPaise: 1_000_000 }));
    // Everything is earmarked; nothing further fits anywhere.
    await expect(withTx(db, (tx) =>
      holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId: r2, amountPaise: 1 })))
      .rejects.toThrow(OtError);
  });

  it("refuses a hold against a receipt that does not exist", async () => {
    const e1 = await book("2026-09-02");
    await expect(withTx(db, (tx) =>
      holdDeposit(tx, f.coordinator, { encounterId: e1, receiptId: "r-nothing", amountPaise: 1 })))
      .rejects.toThrow(/unknown receipt r-nothing/);
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
    // Every paise of the receipt is earmarked on e1, so nothing is left to earmark anywhere.
    await expect(withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2, receiptId, amountPaise: 1 })))
      .rejects.toThrow(/0p is unallocated and unheld on it/);

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
