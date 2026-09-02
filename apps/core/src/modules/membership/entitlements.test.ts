import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { loadConfig } from "../../kernel/config";
import { withTx } from "../../kernel/db/client";
import {
  couponDefinitions, couponRedemptions, entitlementCounters, entitlementMovements, invoiceLines,
  membershipInstances, membershipPlans, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueCreditNote, issueInvoice, memberBenefitsEnabled, previewInvoice } from "../billing";
import {
  consumeEntitlements, entitlementCountersOf, entitlementMovementsOf, narrowToUsableEntitlements,
  restoreEntitlements,
} from "./entitlements";
import type { EntitlementCounterState } from "./entitlements";
import type { ResolvedInstruments } from "./instruments";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T4 — the entitlement half of "consume and restore are ONE property". CRITICAL tier:
 * Book rows D1, D2, D4 and D6 are built as mutants beside this file and their isolation lines are
 * quoted in the task report.
 *
 * ═══ EVERY PLAN CODE, CARD NUMBER AND PERSON BELOW IS INVENTED HERE (DD3 / O-9) ═══
 * The out-of-git partner book may never be quoted into a tracked file. These fixtures test CLASSES
 * — a benefit backed by a counter, a partially credited bill, a restore after expiry — and a class
 * does not care which invented name carries it.
 *
 * ═══ THE FIXTURE'S MONEY, HAND-DERIVED FROM THE SHIPPED ENGINE ═══
 *
 * `seedBillingBase` prices OPD-CONSULT-NEW at 50 000 paise in category "consultation", which is
 * GST-EXEMPT (sac 999312) — so no tax head moves and every number below is the discount arithmetic
 * alone. The invented plan grants ONE benefit term, `consult-visits`, at 2 000 bps (20%) scoped to
 * that category, and the instance carries an `entitlement_counters` row for the same key.
 *
 *   one line  : gross 50 000 · benefit percentAmount(50 000, 2 000) = 10 000 · base 40 000 · net 40 000
 *   two lines : gross 100 000 · discount 20 000 · net payable 80 000 (rupee-exact, no §170 rounding)
 *
 * ═══ THE FLAG IS FLIPPED THROUGH `process.env`, NOT THROUGH AN INJECTED BOOLEAN ═══
 *
 * `memberBenefitsEnabled()` reads the environment, because `billing.controller.ts` cannot be
 * widened this phase to hand the value down (invoices.ts says why at length). Driving the real
 * reader is what makes D1's mutant — compose unconditionally — fail here rather than pass against
 * a test double.
 */
const FLAG = "MEMBER_BENEFITS_ENABLED";
const clerk: Actor = { type: "user", id: "membership-clerk" };

const PLAN_ID = "01HT4PLAN000000000000001";
const INSTANCE_ID = "01HT4CARD000000000000001";
const COUNTER_ID = "01HT4CTR0000000000000001";
const BENEFIT_KEY = "consult-visits";

const NOW = new Date("2026-09-01T06:00:00Z"); // 11:30 IST — a working morning
const VALID_FROM = new Date("2026-01-01T00:00:00Z");
const VALID_TO = new Date("2026-12-31T00:00:00Z");

/** A benefit term as a commissioning file would carry it: a shape this repo fixes, values invented. */
const PLAN_BENEFITS = [
  {
    benefitKey: BENEFIT_KEY, title: "Member consultation benefit", kind: "percent_bps", value: 2_000,
    capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null },
  },
];

describe("entitlements: consume, restore, and the flag that arms them", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => {
    delete process.env[FLAG];
    await teardown();
  });

  beforeEach(async () => {
    delete process.env[FLAG]; // every test states its own flag position
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    cashier = await mkCashier(db, "t4_entitlement_cashier");
    await openSessionFor(db, cashier, 100_000);
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Rupali Sen", sex: "female", ageYears: 41 }));
    patientId = patient.id;
    await db.insert(membershipPlans).values({
      id: PLAN_ID, code: "INV-PLAN-T4", title: "Invented Member Card", kind: "membership",
      benefits: PLAN_BENEFITS, entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: INSTANCE_ID, planId: PLAN_ID, cardCode: "T4-0001", holderName: "Rupali Sen",
      patientId, validFrom: VALID_FROM, validTo: VALID_TO, status: "active", origin: "import",
    });
  });

  async function grantCounter(args: { grantedQty: number; validFrom?: Date; validTo?: Date; state?: string }): Promise<void> {
    await db.insert(entitlementCounters).values({
      id: COUNTER_ID, instanceId: INSTANCE_ID, benefitKey: BENEFIT_KEY, grantedQty: args.grantedQty,
      validFrom: args.validFrom ?? VALID_FROM, validTo: args.validTo ?? VALID_TO, state: args.state ?? "active",
    });
  }

  /** One invoice, paid to the paise, priced through the SAME composer the issue will use. */
  async function issuePaid(lineCount: number): Promise<{ invoiceId: string; netPayablePaise: number }> {
    const lines = Array.from({ length: lineCount }, () => ({
      lineId: newId(), serviceId: base.consultNewServiceId, qty: 1,
    }));
    const preview = await previewInvoice(db, { patientId, lines }, NOW);
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId, lines,
      receipt: { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] },
    }, NOW);
    return { invoiceId: issued.invoiceId, netPayablePaise: issued.totals.netPayablePaise };
  }

  async function storedLines(invoiceId: string): Promise<(typeof invoiceLines.$inferSelect)[]> {
    return db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.lineNo));
  }

  // ── D1 — the flag is load-bearing ───────────────────────────────────────────────────────────

  it("with MEMBER_BENEFITS_ENABLED off, priceDraft composes NOTHING: no candidate, no winner, no movement", async () => {
    await grantCounter({ grantedQty: 4 });
    const { invoiceId, netPayablePaise } = await issuePaid(1);

    const lines = await storedLines(invoiceId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.candidates).toEqual([]); // the D-8 contest record: nothing was even proposed
    expect(lines[0]!.winner).toBeNull();
    expect(lines[0]!.discountPaise).toBe(0);
    expect(netPayablePaise).toBe(50_000); // full price — the member's card bought nothing
    expect(await entitlementMovementsOf(db, COUNTER_ID)).toEqual([]);
  });

  it("with it on, the member's benefit appears in candidates, wins, and consumes ONE unit", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 4 });
    const { invoiceId, netPayablePaise } = await issuePaid(1);

    const lines = await storedLines(invoiceId);
    const candidates = lines[0]!.candidates as { sourceKey: string; ruleKey: string; amountPaise: number }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sourceKey: "membership", ruleKey: BENEFIT_KEY, amountPaise: 10_000 });
    expect(lines[0]!.winner).toMatchObject({ sourceKey: "membership", ruleKey: BENEFIT_KEY, amountPaise: 10_000 });
    expect(lines[0]!.discountPaise).toBe(10_000);
    expect(netPayablePaise).toBe(40_000); // 50 000 − 20% of 50 000

    const movements = await entitlementMovementsOf(db, COUNTER_ID);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      delta: -1, kind: "consume", invoiceId, invoiceLineId: lines[0]!.id, reversalOfId: null, lapsedRestore: false,
    });
    const [counter] = await entitlementCountersOf(db, [INSTANCE_ID]);
    expect(counter).toMatchObject({ grantedQty: 4, movedQty: -1, remainingQty: 3 });
  });

  it("an EXHAUSTED counter is narrowed out before pricing — the next bill is full price, not a refusal", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 1 });
    const first = await issuePaid(1);
    expect(first.netPayablePaise).toBe(40_000);

    const second = await issuePaid(1);
    expect(second.netPayablePaise).toBe(50_000); // the counter is spent; the card stops discounting
    const lines = await storedLines(second.invoiceId);
    expect(lines[0]!.candidates).toEqual([]);
    expect(await entitlementMovementsOf(db, COUNTER_ID)).toHaveLength(1); // still exactly one consume
  });

  it("a LAPSED counter honours nothing, and its own validity governs — not the membership's", async () => {
    process.env[FLAG] = "true";
    // The card is live all year; the bundle's counter expired in August (O-2's independence).
    await grantCounter({ grantedQty: 4, validTo: new Date("2026-08-31T00:00:00Z") });
    const { invoiceId, netPayablePaise } = await issuePaid(1);
    expect(netPayablePaise).toBe(50_000);
    expect((await storedLines(invoiceId))[0]!.candidates).toEqual([]);
    expect(await entitlementMovementsOf(db, COUNTER_ID)).toEqual([]);
  });

  // ── D4 — a partial credit note restores ONLY the reversed line ───────────────────────────────

  it("a partial credit note restores only the credited line's unit, and leaves the other consumed", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 2 });
    const { invoiceId, netPayablePaise } = await issuePaid(2);
    expect(netPayablePaise).toBe(80_000);

    const lines = await storedLines(invoiceId);
    expect(lines).toHaveLength(2);
    expect(await entitlementMovementsOf(db, COUNTER_ID)).toHaveLength(2);
    expect((await entitlementCountersOf(db, [INSTANCE_ID]))[0]!.remainingQty).toBe(0);

    // §3 Q4's fixture trap: `issueCreditNote` wants the STORED `invoice_lines.id`, never the
    // caller's draft `lineId`. The ids are read back above for exactly that reason.
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "the second consultation did not happen",
      lines: [{ invoiceLineId: lines[1]!.id, qty: 1 }],
    }, NOW);

    const movements = await entitlementMovementsOf(db, COUNTER_ID);
    expect(movements).toHaveLength(3);
    const restores = movements.filter((m) => m.kind === "restore");
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ delta: 1, invoiceLineId: lines[1]!.id, lapsedRestore: false });
    // ONE unit back, not two: the counter is at 1, and the first line's benefit stays consumed.
    expect((await entitlementCountersOf(db, [INSTANCE_ID]))[0]!.remainingQty).toBe(1);
  });

  it("two credit notes over the same line hand the unit back ONCE — the second finds it restored", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 2 });
    const { invoiceId } = await issuePaid(2);
    const lines = await storedLines(invoiceId);

    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "first correction", lines: [{ invoiceLineId: lines[0]!.id, qty: 1 }],
    }, NOW);
    // A `correction` covers the FULL remaining value of every line still carrying one — here the
    // second line only, because the first is already credited in full.
    await issueCreditNote(db, cashier.actor, { kind: "correction", invoiceId, reason: "the whole visit is cancelled" }, NOW);

    const movements = await entitlementMovementsOf(db, COUNTER_ID);
    expect(movements.filter((m) => m.kind === "consume")).toHaveLength(2);
    expect(movements.filter((m) => m.kind === "restore")).toHaveLength(2); // one per line, never per note
    expect((await entitlementCountersOf(db, [INSTANCE_ID]))[0]!.remainingQty).toBe(2);
  });

  // ── D6 — a restore is a NEGATING ROW ────────────────────────────────────────────────────────

  it("a restore is a NEGATING ROW that names its consume, and the consume row is untouched", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 1 });
    const { invoiceId } = await issuePaid(1);
    const lines = await storedLines(invoiceId);
    const before = await entitlementMovementsOf(db, COUNTER_ID);

    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "cancelled at the desk", lines: [{ invoiceLineId: lines[0]!.id, qty: 1 }],
    }, NOW);

    const after = await entitlementMovementsOf(db, COUNTER_ID);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]); // byte-identical: nothing UPDATED the consume
    expect(after[1]).toMatchObject({ delta: 1, kind: "restore", reversalOfId: before[0]!.id });
    // Remaining is DERIVED from the two rows, and it is back where it started.
    expect((await entitlementCountersOf(db, [INSTANCE_ID]))[0]!.remainingQty).toBe(1);
  });

  it("the movement log is append-only by TRIGGER, so no writer can ever restore by UPDATE", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 1 });
    const { invoiceId } = await issuePaid(1);
    const [consume] = await entitlementMovementsOf(db, COUNTER_ID);
    expect(consume!.invoiceId).toBe(invoiceId);

    await expect(
      db.update(entitlementMovements).set({ delta: 0 }).where(eq(entitlementMovements.id, consume!.id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
    await expect(
      db.delete(entitlementMovements).where(eq(entitlementMovements.id, consume!.id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
  });

  // ── C5 — a restore after the counter lapsed happens anyway, and is FLAGGED ───────────────────

  it("a restore after the counter's own validity lapsed SUCCEEDS and is flagged", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 1, validTo: new Date("2026-09-30T00:00:00Z") });
    const { invoiceId } = await issuePaid(1);
    const lines = await storedLines(invoiceId);

    // The correction lands in November, five weeks after the bundle expired. Refusing would
    // silently keep money the patient received no value for (C5).
    const LATE = new Date("2026-11-05T06:00:00Z");
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "reversed after the bundle lapsed",
      lines: [{ invoiceLineId: lines[0]!.id, qty: 1 }],
    }, LATE);

    const movements = await entitlementMovementsOf(db, COUNTER_ID);
    expect(movements).toHaveLength(2);
    expect(movements[1]).toMatchObject({ kind: "restore", delta: 1, lapsedRestore: true });
  });

  // ── DD2's source order, pinned in the REAL composer ─────────────────────────────────────────

  it("on an EXACT tie the membership beats the coupon — DD2's order, as the composer builds it", async () => {
    process.env[FLAG] = "true";
    await grantCounter({ grantedQty: 4 });
    // 2 000 bps of 50 000 is 10 000, and so is the coupon's — an EXACT tie, which is the only
    // thing the source ORDER decides (`runContest` sorts by amount first). A composer that
    // appended the two sources the other way round would hand this line to the coupon.
    await db.insert(couponDefinitions).values({
      id: "01HT4TIE0000000000000001", code: "INV-CPN-TIE", title: "Invented tie coupon", planId: PLAN_ID,
      benefit: { kind: "percent_bps", value: 2_000, title: "Invented tie coupon" },
      scope: { serviceCategories: ["consultation"], serviceIds: null },
      minBillPaise: 0, capPaise: null, singleUse: true,
      validFrom: VALID_FROM, validTo: VALID_TO, weekdayMask: 127, createdBy: "test",
    });

    const { invoiceId, netPayablePaise } = await issuePaid(1);
    expect(netPayablePaise).toBe(40_000);
    const lines = await storedLines(invoiceId);
    const candidates = lines[0]!.candidates as { sourceKey: string; amountPaise: number }[];
    // BOTH are recorded — the D-8 audit record keeps the loser, in source order.
    expect(candidates.map((c) => c.sourceKey)).toEqual(["membership", "coupon"]);
    expect(candidates.every((c) => c.amountPaise === 10_000)).toBe(true);
    expect(lines[0]!.winner).toMatchObject({ sourceKey: "membership", ruleKey: BENEFIT_KEY });
    // The membership won, so the counter moved and the coupon was NOT redeemed.
    expect(await entitlementMovementsOf(db, COUNTER_ID)).toHaveLength(1);
    expect(await db.select().from(couponRedemptions)).toEqual([]);
  });

  // ── the narrowing, as a pure function ───────────────────────────────────────────────────────

  it("narrowToUsableEntitlements drops only the terms a counter cannot honour", async () => {
    const resolved: ResolvedInstruments = {
      patientId: "p1",
      memberships: [{
        instanceId: INSTANCE_ID, planId: PLAN_ID, planTitle: "Invented Member Card", cardCode: "T4-0001",
        status: "active", validFrom: VALID_FROM, validTo: VALID_TO,
        benefits: [
          { benefitKey: BENEFIT_KEY, title: "counter-backed", kind: "percent_bps", value: 2_000, capPaise: null, scope: { serviceCategories: null, serviceIds: null } },
          { benefitKey: "always-on", title: "unlimited", kind: "percent_bps", value: 500, capPaise: null, scope: { serviceCategories: null, serviceIds: null } },
        ],
      }],
      coupons: [],
      billGrossPaise: 0,
    };
    const counter = (over: Partial<EntitlementCounterState>): EntitlementCounterState => ({
      // FD-7 T6 — `unit` defaults to the pre-existing meaning, so every row below still reads as
      // whole visits and the value lane is opted into explicitly where it is under test.
      counterId: COUNTER_ID, instanceId: INSTANCE_ID, benefitKey: BENEFIT_KEY, unit: "count", grantedQty: 1,
      movedQty: 0, remainingQty: 1, validFrom: VALID_FROM, validTo: VALID_TO, state: "active", ...over,
    });

    // A term with NO counter is an unlimited benefit and survives every narrowing below.
    expect(narrowToUsableEntitlements(resolved, [counter({})], NOW).memberships[0]!.benefits.map((b) => b.benefitKey))
      .toEqual([BENEFIT_KEY, "always-on"]);
    expect(narrowToUsableEntitlements(resolved, [counter({ remainingQty: 0 })], NOW).memberships[0]!.benefits.map((b) => b.benefitKey))
      .toEqual(["always-on"]);
    expect(narrowToUsableEntitlements(resolved, [counter({ state: "void" })], NOW).memberships[0]!.benefits.map((b) => b.benefitKey))
      .toEqual(["always-on"]);
    expect(narrowToUsableEntitlements(resolved, [counter({ validTo: new Date("2026-08-31T00:00:00Z") })], NOW).memberships[0]!.benefits.map((b) => b.benefitKey))
      .toEqual(["always-on"]);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-7 T6 / OWNER RULING R3 — THE VALUE LANE
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * A COUNT counter answers one question — is there another visit left — and a boolean is the whole
   * of it. A MONEY balance is a different shape: ₹4,200 left against a benefit that would take
   * ₹5,000 off is neither "exhausted" nor "available in full". It is a benefit worth exactly ₹4,200
   * today, and the patient pays the rest.
   *
   * `capPaise` is where that already lives, so the balance is expressed in the vocabulary the money
   * path already speaks rather than as a second mechanism beside it — and nothing divides.
   */
  it("FD-7 T6: a paise counter NARROWS the benefit's cap to its remaining balance", () => {
    const resolved: ResolvedInstruments = {
      patientId: "p1",
      memberships: [{
        instanceId: INSTANCE_ID, planId: PLAN_ID, planTitle: "Prepaid package", cardCode: "PKG-1",
        status: "active", validFrom: VALID_FROM, validTo: VALID_TO,
        benefits: [
          { benefitKey: BENEFIT_KEY, title: "package money", kind: "percent_bps", value: 10_000, capPaise: null, scope: { serviceCategories: null, serviceIds: null } },
        ],
      }],
      coupons: [], billGrossPaise: 0,
    };
    const paise = (over: Partial<EntitlementCounterState> = {}): EntitlementCounterState => ({
      counterId: COUNTER_ID, instanceId: INSTANCE_ID, benefitKey: BENEFIT_KEY, unit: "paise",
      grantedQty: 1_000_000, movedQty: -580_000, remainingQty: 420_000,
      validFrom: VALID_FROM, validTo: VALID_TO, state: "active", ...over,
    });

    const narrowed = narrowToUsableEntitlements(resolved, [paise()], NOW).memberships[0]!.benefits;
    expect(narrowed).toHaveLength(1);                    // NOT dropped — there is money left
    expect(narrowed[0]!.capPaise).toBe(420_000);         // ₹4,200, and no more

    // A cap the PLAN already set lower wins: the balance can only ever narrow, never widen.
    const tighter = { ...resolved, memberships: [{ ...resolved.memberships[0]!, benefits: [{ ...resolved.memberships[0]!.benefits[0]!, capPaise: 50_000 }] }] };
    expect(narrowToUsableEntitlements(tighter, [paise()], NOW).memberships[0]!.benefits[0]!.capPaise).toBe(50_000);

    // And an EMPTY balance is exhausted, exactly as a spent count counter is.
    expect(narrowToUsableEntitlements(resolved, [paise({ remainingQty: 0, movedQty: -1_000_000 })], NOW).memberships[0]!.benefits)
      .toEqual([]);
  });

  /** The count lane must be untouched by all of this — the regression that would cost the most. */
  it("FD-7 T6: a count counter's terms are returned by IDENTITY, uncapped and unchanged", () => {
    const resolved: ResolvedInstruments = {
      patientId: "p1",
      memberships: [{
        instanceId: INSTANCE_ID, planId: PLAN_ID, planTitle: "Member card", cardCode: "T4-1",
        status: "active", validFrom: VALID_FROM, validTo: VALID_TO,
        benefits: [{ benefitKey: BENEFIT_KEY, title: "consults", kind: "percent_bps", value: 2_000, capPaise: null, scope: { serviceCategories: null, serviceIds: null } }],
      }],
      coupons: [], billGrossPaise: 0,
    };
    const counted: EntitlementCounterState = {
      counterId: COUNTER_ID, instanceId: INSTANCE_ID, benefitKey: BENEFIT_KEY, unit: "count",
      grantedQty: 8, movedQty: -3, remainingQty: 5, validFrom: VALID_FROM, validTo: VALID_TO, state: "active",
    };
    const out = narrowToUsableEntitlements(resolved, [counted], NOW);
    expect(out.memberships[0]!.benefits[0]!.capPaise).toBeNull();   // THE KILL for capping a count counter
    expect(out.memberships[0]).toBe(resolved.memberships[0]);       // and not even a copy was made
  });

  // ── the write ────────────────────────────────────────────────────────────────────────────────

  it("FD-7 T6: consuming a paise counter draws down the MONEY, and a count counter still spends one", async () => {
    // A REAL invoice and REAL lines: `entitlement_movements.invoice_id` and `invoice_line_id` are
    // foreign keys, deliberately — "a consumption that named an invoice line which never existed
    // would be a benefit nobody can audit" (schema/membership.ts). No counter is granted for
    // BENEFIT_KEY, so issuing consumes nothing and the two counters below are the only movement.
    const { invoiceId } = await issuePaid(2);
    const [lineA, lineB] = await storedLines(invoiceId);
    const paiseCounterId = newId();
    const countCounterId = newId();
    await db.insert(entitlementCounters).values([
      { id: paiseCounterId, instanceId: INSTANCE_ID, benefitKey: "wallet", unit: "paise", grantedQty: 1_000_000, validFrom: VALID_FROM, validTo: VALID_TO },
      { id: countCounterId, instanceId: INSTANCE_ID, benefitKey: "visits", unit: "count", grantedQty: 8, validFrom: VALID_FROM, validTo: VALID_TO },
    ]);

    await withTx(db, (tx) => consumeEntitlements(tx, cashier.actor, {
      invoiceId, at: NOW,
      consumes: [
        { instanceId: INSTANCE_ID, benefitKey: "wallet", invoiceLineId: lineA!.id, amountPaise: 42_500 },
        { instanceId: INSTANCE_ID, benefitKey: "visits", invoiceLineId: lineB!.id, amountPaise: 42_500 },
      ],
    }));

    const wallet = await entitlementMovementsOf(db, paiseCounterId);
    const visits = await entitlementMovementsOf(db, countCounterId);
    expect(wallet.map((m) => m.delta)).toEqual([-42_500]);   // the money
    expect(visits.map((m) => m.delta)).toEqual([-1]);        // THE KILL — a visit is still one visit
  });

  /** The balance is a real balance: asking for more than is left is refused, in the counter's unit. */
  it("FD-7 T6: a paise counter refuses a draw larger than its balance", async () => {
    const counterId = newId();
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId: INSTANCE_ID, benefitKey: "wallet", unit: "paise",
      grantedQty: 30_000, validFrom: VALID_FROM, validTo: VALID_TO,
    });
    await expect(
      withTx(db, (tx) => consumeEntitlements(tx, cashier.actor, {
        invoiceId: newId(), at: NOW,
        consumes: [{ instanceId: INSTANCE_ID, benefitKey: "wallet", invoiceLineId: newId(), amountPaise: 30_001 }],
      })),
    ).rejects.toMatchObject({ code: "entitlement_exhausted", detail: { remainingQty: 30_000, askQty: 30_001 } });
  });

  /** A winning benefit that took nothing off draws nothing down — no zero-delta rows in the log. */
  it("FD-7 T6: a zero-value benefit writes no movement at all", async () => {
    const { invoiceId } = await issuePaid(1);
    const [line] = await storedLines(invoiceId);
    const counterId = newId();
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId: INSTANCE_ID, benefitKey: "wallet", unit: "paise",
      grantedQty: 50_000, validFrom: VALID_FROM, validTo: VALID_TO,
    });
    await withTx(db, (tx) => consumeEntitlements(tx, cashier.actor, {
      invoiceId, at: NOW,
      consumes: [{ instanceId: INSTANCE_ID, benefitKey: "wallet", invoiceLineId: line!.id, amountPaise: 0 }],
    }));
    expect(await entitlementMovementsOf(db, counterId)).toEqual([]);
  });

  /**
   * THE PROPERTY THAT MADE THIS CHEAP. `restoreEntitlements` negates `-movement.delta` without ever
   * knowing which unit it is in, so the value lane's reversal needed NO code change — and this row
   * is what stops somebody "simplifying" that negation back into a `+1`.
   */
  it("FD-7 T6: restoring a paise draw-down hands back the MONEY, with no change to the restore path", async () => {
    const { invoiceId } = await issuePaid(1);
    const [line] = await storedLines(invoiceId);
    const lineId = line!.id;
    const counterId = newId();
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId: INSTANCE_ID, benefitKey: "wallet", unit: "paise",
      grantedQty: 1_000_000, validFrom: VALID_FROM, validTo: VALID_TO,
    });
    await withTx(db, (tx) => consumeEntitlements(tx, cashier.actor, {
      invoiceId, at: NOW,
      consumes: [{ instanceId: INSTANCE_ID, benefitKey: "wallet", invoiceLineId: lineId, amountPaise: 42_500 }],
    }));
    await withTx(db, (tx) => restoreEntitlements(tx, cashier.actor, {
      invoiceId, invoiceLineIds: [lineId], at: NOW, reason: "invoice voided",
    }));

    const log = await entitlementMovementsOf(db, counterId);
    expect(log.map((m) => m.delta)).toEqual([-42_500, 42_500]);   // THE KILL for a +1 restore
    expect(log.reduce((sum, m) => sum + m.delta, 0)).toBe(0);     // the balance is whole again
  });

  // ── the flag reader itself ──────────────────────────────────────────────────────────────────

  it("memberBenefitsEnabled agrees with loadConfig on every spelling, including the ones both refuse", () => {
    // The duplicate spelling in `invoices.ts` exists because `loadConfig()` cannot run on this code
    // path in CI (it requires DATABASE_URL, which CI never sets — F1's scar). This leg is what
    // stops the duplicate drifting into a DISAGREEMENT: both readers, all six inputs, by execution.
    const withFlag = (value?: string): NodeJS.ProcessEnv =>
      (value === undefined ? {} : { [FLAG]: value }) as NodeJS.ProcessEnv;
    const viaConfig = (value?: string): boolean =>
      loadConfig({
        DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!,
        ...(value === undefined ? {} : { [FLAG]: value }),
      } as NodeJS.ProcessEnv).memberBenefitsEnabled;

    expect(memberBenefitsEnabled(withFlag("true"))).toBe(true);
    expect(viaConfig("true")).toBe(true);
    expect(memberBenefitsEnabled(withFlag("false"))).toBe(false);
    expect(viaConfig("false")).toBe(false);
    expect(memberBenefitsEnabled(withFlag(undefined))).toBe(false); // DD14: FALSE unless an operator says otherwise
    expect(viaConfig(undefined)).toBe(false);

    // The `z.coerce.boolean()` trap in both directions: under coercion "false" is a non-empty
    // string and therefore TRUE. Anything ambiguous fails loudly instead of being guessed at.
    for (const bad of ["1", "TRUE", ""]) {
      expect(() => memberBenefitsEnabled(withFlag(bad))).toThrow();
      expect(() => viaConfig(bad)).toThrow();
    }
  });
});


/**
 * RC-2 T5 / D7 — PACKAGE v0 RIDES THE SHIPPED COUNTERS. NOTHING NEW WAS BUILT.
 *
 * The design asks for a care package whose consult is "covered, usage counter". Recon found the
 * whole mechanism already present and, crucially, NOT gated on plan kind: `loadInstances`
 * inner-joins `membership_plans` and filters on the PATIENT and the CODES, never on `kind`. So a
 * `kind = 'package'` row resolves through exactly the path a `'membership'` row does, its benefit
 * term contests exactly the same way, and `entitlement_counters` / `entitlement_movements` already
 * count the usages down. **Package v0 is therefore a PROOF, not a build** — no table, no column, no
 * migration, and this file's Files-list entry is the whole of RC-2's change to the package lane.
 *
 * A package's consult benefit is modelled as 10 000 bps — the covered consult is a 100% benefit
 * with a counter, not a special "free" flag. That keeps one contest and one audit record: the seat
 * shows WHY the line is zero (the package won) rather than showing a zero with no story.
 *
 * ═══ THE EXHAUSTION EDGE IS THE ONE THAT MATTERS, AND IT IS A NARROWING NOT A REFUSAL ═══
 *
 * `composeBenefits`'s header states the rule this proves: an exhausted counter is DROPPED before
 * pricing rather than refused at commit, "if the refusal lived only at the write, their FIFTH visit
 * could not be invoiced at all". Both halves are executed below — the narrowed path bills in full
 * and writes nothing, and `consumeEntitlements` is shown refusing the same counter directly, which
 * is precisely the damage the narrowing prevents.
 */
const PKG_PLAN_ID = "01HT5PKG0000000000000001";
const PKG_INSTANCE_ID = "01HT5PKGCARD00000000001";
const PKG_COUNTER_ID = "01HT5PKGCTR000000000001";
const PKG_BENEFIT_KEY = "package-consult";

describe("RC-2 T5 — package v0 rides membership_plans.kind='package' and the shipped counters (D7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; token: string; actor: Actor };
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    process.env[FLAG] = "true"; // every case here is a benefits-on case
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    cashier = await mkCashier(db, "t5_package_cashier");
    await openSessionFor(db, cashier, 100_000);
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Devika Menon", sex: "female", ageYears: 36 }));
    patientId = patient.id;

    await db.insert(membershipPlans).values({
      id: PKG_PLAN_ID, code: "INV-PKG-T5", title: "Invented Health Check Package",
      kind: "package", // ← THE WHOLE OF THE DIFFERENCE FROM A MEMBERSHIP ROW
      benefits: [{
        benefitKey: PKG_BENEFIT_KEY, title: "Package consultation (covered)", kind: "percent_bps",
        value: 10_000, capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null },
      }],
      entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: PKG_INSTANCE_ID, planId: PKG_PLAN_ID, cardCode: "T5-PKG-1", holderName: "Devika Menon",
      patientId, validFrom: VALID_FROM, validTo: VALID_TO, status: "active", origin: "import",
    });
  });

  async function grantPackageCounter(grantedQty: number): Promise<void> {
    await db.insert(entitlementCounters).values({
      id: PKG_COUNTER_ID, instanceId: PKG_INSTANCE_ID, benefitKey: PKG_BENEFIT_KEY,
      grantedQty, validFrom: VALID_FROM, validTo: VALID_TO, state: "active",
    });
  }

  async function issueOneConsult(): Promise<{ invoiceId: string; netPayablePaise: number }> {
    const lines = [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 }];
    const preview = await previewInvoice(db, { patientId, lines }, NOW);
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId, lines,
      receipt: preview.totals.netPayablePaise === 0
        ? undefined
        : { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] },
    }, NOW);
    return { invoiceId: issued.invoiceId, netPayablePaise: issued.totals.netPayablePaise };
  }

  it("a covered consult zeroes the line, names the package as the winner, and counts ONE usage down", async () => {
    await grantPackageCounter(2);
    const { invoiceId, netPayablePaise } = await issueOneConsult();

    expect(netPayablePaise).toBe(0); // covered — nothing to collect
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    expect(lines[0]!.winner).toMatchObject({ ruleKey: PKG_BENEFIT_KEY, amountPaise: 50_000 });
    expect(lines[0]!.discountPaise).toBe(50_000);

    const movements = await entitlementMovementsOf(db, PKG_COUNTER_ID);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: "consume", delta: -1, invoiceId });
  });

  it("past the counter's limit the visit bills IN FULL and writes NO movement — narrowed, not refused", async () => {
    await grantPackageCounter(1);

    const first = await issueOneConsult();
    expect(first.netPayablePaise).toBe(0);
    expect(await entitlementMovementsOf(db, PKG_COUNTER_ID)).toHaveLength(1);

    // The second visit: the counter is spent, so the term is dropped BEFORE pricing.
    const second = await issueOneConsult();
    expect(second.netPayablePaise).toBe(50_000);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, second.invoiceId));
    expect(lines[0]!.winner).toBeNull();
    expect(lines[0]!.candidates).toEqual([]); // not proposed-and-lost: not proposed at all
    expect(await entitlementMovementsOf(db, PKG_COUNTER_ID)).toHaveLength(1); // still ONE, unchanged
  });

  /**
   * THE MUTANT'S DAMAGE, shown without a scratch file. If the exhausted counter were NOT narrowed
   * out before pricing, the term would win the contest and the WRITE would be reached — and this is
   * what the write does. `composeBenefits`'s header predicts exactly this sentence: the fifth visit
   * could not be invoiced at all.
   */
  it("MUTANT — without the narrowing the spent counter reaches the write, which REFUSES the whole bill", async () => {
    await grantPackageCounter(1);
    await issueOneConsult(); // spends it

    await expect(
      withTx(db, (tx) => consumeEntitlements(tx, cashier.actor, {
        invoiceId: newId(), at: NOW,
        consumes: [{ instanceId: PKG_INSTANCE_ID, benefitKey: PKG_BENEFIT_KEY, invoiceLineId: newId(), amountPaise: 0 }],
      })),
    ).rejects.toMatchObject({ code: "entitlement_exhausted", detail: { remainingQty: 0, askQty: 1 } });
  });

  it("the kind is the ONLY difference: a package resolves exactly as a membership does", async () => {
    await grantPackageCounter(1);
    const plans = await db.select().from(membershipPlans).where(eq(membershipPlans.id, PKG_PLAN_ID));
    expect(plans[0]!.kind).toBe("package");
    // …and it still priced. `loadInstances` filters on patient and codes, never on kind — asserted
    // by the fact that a `package` row composed at all.
    const { netPayablePaise } = await issueOneConsult();
    expect(netPayablePaise).toBe(0);
  });
});
