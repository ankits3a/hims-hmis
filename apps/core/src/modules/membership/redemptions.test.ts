import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantCreditExtend, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import {
  couponDefinitions, couponRedemptions, events, invoiceLines, membershipInstances, membershipPlans,
  registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueCreditNote, issueInvoice, markEnteredInError, previewInvoice } from "../billing";
import { couponRedemptionStates, couponRedemptionsOf, narrowToRedeemableCoupons } from "./redemptions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T4 — the coupon half. O-4's release is the SYMMETRIC partner of the redemption and ships
 * in the same task on purpose: a mechanism armed by one task and reversed by another is §2.86's
 * defect class, and this is exactly where it would have landed.
 *
 * ═══ EVERY COUPON CODE, PLAN CODE AND PERSON BELOW IS INVENTED HERE (DD3 / O-9) ═══
 *
 * ═══ THE FIXTURE'S MONEY, HAND-DERIVED ═══
 *
 * `seedBillingBase` prices OPD-CONSULT-NEW at 50 000 paise in the EXEMPT "consultation" category,
 * so no tax head moves. The invented plan carries NO benefit terms — the coupon is meant to win
 * uncontested — and its bundled coupon is 1 000 bps (10%) scoped to that category, single-use.
 *
 *   qty 1 : gross 50 000 · coupon percentAmount(50 000, 1 000) = 5 000 · net payable 45 000
 *   qty 2 : gross 100 000 · coupon 10 000 · net payable 90 000
 *           a qty-1 refund credits divHalfUp(F × 1, 2) of each field → gross 50 000 · net 45 000,
 *           which is HALF the invoice's value and releases nothing (Book row D5).
 */
const FLAG = "MEMBER_BENEFITS_ENABLED";
const clerk: Actor = { type: "user", id: "membership-clerk" };

const PLAN_ID = "01HT4CPLAN00000000000001";
const INSTANCE_ID = "01HT4CCARD00000000000001";
const COUPON_ID = "01HT4COUPON0000000000001";
const COUPON_CODE = "INV-CPN-T4";

const NOW = new Date("2026-09-01T06:00:00Z"); // 11:30 IST, a Tuesday — inside every window below
const VALID_FROM = new Date("2026-01-01T00:00:00Z");
const VALID_TO = new Date("2026-12-31T00:00:00Z");

describe("coupon redemption and O-4's release", () => {
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
    process.env[FLAG] = "true"; // the lane under test; every case here is a benefits-on case
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    cashier = await mkCashier(db, "t4_coupon_cashier");
    await openSessionFor(db, cashier, 100_000);
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Gagan Puri", sex: "male", ageYears: 33 }));
    patientId = patient.id;
    await db.insert(membershipPlans).values({
      id: PLAN_ID, code: "INV-PLAN-CPN", title: "Invented Coupon Card", kind: "card",
      benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: INSTANCE_ID, planId: PLAN_ID, cardCode: "T4-CPN-1", holderName: "Gagan Puri",
      patientId, validFrom: VALID_FROM, validTo: VALID_TO, status: "active", origin: "import",
    });
    await db.insert(couponDefinitions).values({
      id: COUPON_ID, code: COUPON_CODE, title: "Invented welcome coupon", planId: PLAN_ID,
      benefit: { kind: "percent_bps", value: 1_000, title: "Invented welcome coupon" },
      scope: { serviceCategories: ["consultation"], serviceIds: null },
      minBillPaise: 0, capPaise: null, singleUse: true,
      validFrom: VALID_FROM, validTo: VALID_TO, weekdayMask: 127, createdBy: "test",
    });
  });

  async function issuePaid(qty: number): Promise<{ invoiceId: string; receiptId: string; netPayablePaise: number }> {
    const lines = [{ lineId: newId(), serviceId: base.consultNewServiceId, qty }];
    const preview = await previewInvoice(db, { patientId, lines }, NOW);
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId, lines,
      receipt: { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] },
    }, NOW);
    return { invoiceId: issued.invoiceId, receiptId: issued.receiptId!, netPayablePaise: issued.totals.netPayablePaise };
  }

  async function releasedEvents(): Promise<{ payload: unknown }[]> {
    return db.select({ payload: events.payload }).from(events)
      .where(eq(events.name, "coupon.redemption_released")).orderBy(asc(events.seq));
  }

  it("a bundled coupon wins the contest and lands ONE redemption row carrying what it took", async () => {
    const { invoiceId, netPayablePaise } = await issuePaid(1);
    expect(netPayablePaise).toBe(45_000);

    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    expect(lines[0]!.winner).toMatchObject({ sourceKey: "coupon", ruleKey: COUPON_CODE, amountPaise: 5_000 });

    const rows = await couponRedemptionsOf(db, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      couponId: COUPON_ID, cycleNo: 0, state: "redeemed", singleUse: true, patientId,
      invoiceId, instanceId: INSTANCE_ID, amountPaise: 5_000, releasedOfId: null,
    });
  });

  it("a spent single-use coupon is narrowed out of the NEXT bill rather than refusing it", async () => {
    const first = await issuePaid(1);
    expect(first.netPayablePaise).toBe(45_000);

    const second = await issuePaid(1);
    expect(second.netPayablePaise).toBe(50_000); // full price — the coupon is spent
    expect(await couponRedemptionsOf(db, second.invoiceId)).toEqual([]);

    const states = await couponRedemptionStates(db, [COUPON_ID]);
    expect(states.get(COUPON_ID)).toMatchObject({ singleUse: true, cycleNo: 0 });
    expect(states.get(COUPON_ID)!.openRedemptionIds).toHaveLength(1);
  });

  // ── D5 — a partial refund releases NOTHING ──────────────────────────────────────────────────

  it("a HALF-VALUE refund credit note releases no redemption: the sale it was consumed against happened", async () => {
    const { invoiceId, netPayablePaise } = await issuePaid(2);
    expect(netPayablePaise).toBe(90_000);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));

    // Half the qty of the only line — 45 000 of the 90 000 payable (see the header's derivation).
    const note = await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "one of the two consultations was not given",
      lines: [{ invoiceLineId: lines[0]!.id, qty: 1 }],
    }, NOW);
    expect(note.netPaise).toBe(45_000);

    const rows = await couponRedemptionsOf(db, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("redeemed"); // no release row at all
    expect(await releasedEvents()).toEqual([]);
    // And the coupon is still spent, so the member cannot re-present it on a fresh bill.
    const next = await issuePaid(1);
    expect(next.netPayablePaise).toBe(50_000);
  });

  it("a clearance discount releases nothing either — it credits VALUE and cancels no sale", async () => {
    // The clearance lane needs something OUTSTANDING, so this bill goes out on D2's credit lane
    // rather than paid: 45 000 payable, nothing tendered, the dues counter settles 1 000 of it.
    // (Charity's seeded cap is 5 000 bps of the raw total = 22 500, approval above 3 000 bps =
    // 13 500 — so a 1 000 ask needs neither.)
    await grantCreditExtend(db);
    const lines = [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 }];
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId, lines, credit: { reason: "settles at the dues counter" },
    }, NOW);
    expect(issued.totals.netPayablePaise).toBe(45_000); // the coupon still applied
    const redeemed = (await couponRedemptionsOf(db, issued.invoiceId))[0]!;

    const note = await issueCreditNote(db, cashier.actor, {
      kind: "clearance_discount", invoiceId: issued.invoiceId, reason: "dues counter settlement",
      discountCategory: "charity", askPaise: 1_000,
    }, NOW);
    expect(note.netPaise).toBe(1_000);

    const rows = await couponRedemptionsOf(db, issued.invoiceId);
    expect(rows).toEqual([redeemed]); // untouched, and no release row beside it
    expect(await releasedEvents()).toEqual([]);
  });

  // ── O-4's two triggers ──────────────────────────────────────────────────────────────────────

  it("a full-value CORRECTION releases the redemption as a negating row, and says so as an event", async () => {
    const { invoiceId } = await issuePaid(1);
    const redeemed = (await couponRedemptionsOf(db, invoiceId))[0]!;

    await issueCreditNote(db, cashier.actor, { kind: "correction", invoiceId, reason: "billed in error" }, NOW);

    const rows = await couponRedemptionsOf(db, invoiceId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(redeemed); // the redemption row is untouched — DD5, by trigger
    expect(rows[1]).toMatchObject({
      couponId: COUPON_ID, cycleNo: 0, state: "released", amountPaise: 0, releasedOfId: redeemed.id,
    });
    const emitted = await releasedEvents();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      redemptionId: redeemed.id, releaseRowId: rows[1]!.id, couponId: COUPON_ID, invoiceId,
      trigger: "correction_credit_note",
    });
  });

  it("marking the invoice's RECEIPT entered-in-error releases it too — the money was never received", async () => {
    const { invoiceId, receiptId } = await issuePaid(1);
    const redeemed = (await couponRedemptionsOf(db, invoiceId))[0]!;

    await markEnteredInError(db, cashier.actor, { receiptId, reason: "posted against the wrong person" }, NOW);

    const rows = await couponRedemptionsOf(db, invoiceId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ state: "released", releasedOfId: redeemed.id, amountPaise: 0 });
    expect((await releasedEvents())[0]!.payload).toMatchObject({ trigger: "entered_in_error" });
  });

  it("a released coupon is redeemable AGAIN, on the next cycle — which is what `cycle_no` is for", async () => {
    const first = await issuePaid(1);
    await issueCreditNote(db, cashier.actor, { kind: "correction", invoiceId: first.invoiceId, reason: "billed in error" }, NOW);

    const states = await couponRedemptionStates(db, [COUPON_ID]);
    expect(states.get(COUPON_ID)).toMatchObject({ cycleNo: 1, openRedemptionIds: [] });

    const second = await issuePaid(1);
    expect(second.netPayablePaise).toBe(45_000); // the coupon works again — O-4's whole point
    const rows = await couponRedemptionsOf(db, second.invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cycleNo: 1, state: "redeemed" });
    // Four rows across both invoices, and not one of them was ever updated.
    expect(await db.select().from(couponRedemptions)).toHaveLength(3);
  });

  it("the redemption row is append-only by TRIGGER, so a release can never be an UPDATE", async () => {
    const { invoiceId } = await issuePaid(1);
    const redeemed = (await couponRedemptionsOf(db, invoiceId))[0]!;
    await expect(
      db.update(couponRedemptions).set({ state: "released" }).where(eq(couponRedemptions.id, redeemed.id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
  });

  // ── DD10's BELT, asserted WITHOUT the braces ────────────────────────────────────────────────

  it("the partial unique index refuses a second redeemed row at the same cycle, whatever the writer did", async () => {
    // THE LOCK IS THE MECHANISM; THE INDEX IS WHAT SURVIVES A FUTURE WRITER WHO FORGETS IT. This
    // leg therefore bypasses `redeemCoupons` entirely and writes the rows by hand: no lock is
    // taken, no state is counted, and the DATABASE is the only thing left refusing. Book row D3's
    // second mutant — drop the index, keep the lock — cannot be killed by any assertion that goes
    // through the writer, because the lock alone answers correctly there.
    const { invoiceId } = await issuePaid(1);
    const [redeemed] = await couponRedemptionsOf(db, invoiceId);
    const row = (over: Record<string, unknown>): typeof couponRedemptions.$inferInsert => ({
      id: newId(), couponId: COUPON_ID, cycleNo: 0, state: "redeemed", singleUse: true,
      patientId, invoiceId, instanceId: null, amountPaise: 0, actorId: "raw-writer", at: NOW,
      ...over,
    });

    await expect(db.insert(couponRedemptions).values(row({})))
      .rejects.toThrow(/coupon_redemptions_single_use_uq/);
    // The index is PARTIAL, and each half of its predicate is load-bearing: a RELEASE row and a
    // non-single-use redemption both land at the same cycle without complaint.
    await db.insert(couponRedemptions).values(row({ state: "released", releasedOfId: redeemed!.id }));
    await db.insert(couponRedemptions).values(row({ singleUse: false }));
    // ... and the NEXT cycle is exactly what O-4's re-redemption needs to be free.
    await db.insert(couponRedemptions).values(row({ cycleNo: 1 }));
    expect(await db.select().from(couponRedemptions)).toHaveLength(4);
  });

  it("narrowToRedeemableCoupons drops a spent single-use coupon and keeps a multi-use one", () => {
    const resolved = {
      patientId: "p1",
      memberships: [],
      coupons: [
        { couponId: "c-single", code: "S", title: "s", instanceId: null, benefit: { benefitKey: "S", title: "s", kind: "percent_bps" as const, value: 100, capPaise: null, scope: { serviceCategories: null, serviceIds: null } }, minBillPaise: 0, validFrom: VALID_FROM, validTo: VALID_TO, weekdayMask: 127, windowStartMinute: null, windowEndMinute: null, status: "active" as const },
        { couponId: "c-multi", code: "M", title: "m", instanceId: null, benefit: { benefitKey: "M", title: "m", kind: "percent_bps" as const, value: 100, capPaise: null, scope: { serviceCategories: null, serviceIds: null } }, minBillPaise: 0, validFrom: VALID_FROM, validTo: VALID_TO, weekdayMask: 127, windowStartMinute: null, windowEndMinute: null, status: "active" as const },
      ],
      billGrossPaise: 0,
    };
    const states = new Map([
      ["c-single", { couponId: "c-single", singleUse: true, cycleNo: 0, openRedemptionIds: ["r1"] }],
      ["c-multi", { couponId: "c-multi", singleUse: false, cycleNo: 0, openRedemptionIds: ["r2"] }],
    ]);
    expect(narrowToRedeemableCoupons(resolved, states).coupons.map((c) => c.couponId)).toEqual(["c-multi"]);
    // A released single-use coupon comes back: no OPEN redemption is what "redeemable" means.
    states.set("c-single", { couponId: "c-single", singleUse: true, cycleNo: 1, openRedemptionIds: [] });
    expect(narrowToRedeemableCoupons(resolved, states).coupons.map((c) => c.couponId)).toEqual(["c-single", "c-multi"]);
  });
});
