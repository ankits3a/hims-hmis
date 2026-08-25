import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import {
  couponDefinitions, couponRedemptions, entitlementCounters, entitlementMovements, invoiceLines,
  membershipInstances, membershipPlans, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueInvoice } from "../billing";
import { consumeEntitlements } from "./entitlements";
import { MembershipError } from "./errors";
import { redeemCoupons } from "./redemptions";
import type { Pool } from "pg";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T4 — DD10's SERIALIZER, OBSERVED. Book rows D2 and D3.
 *
 * ═══ WHY THIS SUITE ASSERTS THE BLOCK AND NOT THE OUTCOME ═══
 *
 * §3 Q6 measured the trap before this file existed, and it is `versions.contention.test.ts`'s own
 * recorded lesson recurring: **a forced interleave alone does not discriminate the outcome.** Both
 * runs — with the lock and without it — end with ONE movement row, because the forced ordering
 * serialises the compute step anyway. So the discriminating leg is the BLOCK: an external session
 * holds the row the serializer needs, and a real writer MUST still be waiting.
 *
 * ═══ TWO THINGS THE D2 MUTANT TAUGHT THIS FILE, AND BOTH CHANGED IT ═══
 *
 * The first draft of this suite raced `issueInvoice` and held the counter row `FOR UPDATE`. The
 * Book-row mutant — `consumeEntitlements` with its `FOR UPDATE` deleted — SURVIVED both legs,
 * 2/2. Measured, not predicted, and here is why each half failed to discriminate:
 *
 *  1. **`FOR UPDATE` was the wrong lock mode to HOLD.** Appending a movement takes a `FOR KEY
 *     SHARE` lock on the counter row — that is what an INSERT does to the parent of a foreign key
 *     — and `FOR KEY SHARE` conflicts with `FOR UPDATE`. So the lock-less mutant blocked too, on
 *     its own FK, and "pending at 400 ms" was true of both implementations. The holder below takes
 *     **`FOR NO KEY UPDATE`**: the weakest mode that still conflicts with the writer's `FOR UPDATE`
 *     and does NOT conflict with the FK's `FOR KEY SHARE`. Under it the lock-less writer sails
 *     through and the shipped one waits. That is §2.6's rule discharged by execution: name the
 *     lock AND its mode, and confirm no OTHER lock the implementation takes produces the same wait.
 *
 *  2. **`issueInvoice` is already serialised end to end, by something else entirely.** Its first
 *     act inside the transaction is `nextDocNo`, whose `UPDATE document_series SET next_no = …
 *     RETURNING` takes a row-exclusive lock on the ONE series row and holds it to COMMIT. Every
 *     concurrent invoice issue in the hospital therefore queues there, before any instrument is
 *     touched — so a race run through `issueInvoice` measures the SERIES lock and cannot see the
 *     counter lock at all. The mutant scored 0/20 over-consumption through that path. The races
 *     below therefore drive `consumeEntitlements` and `redeemCoupons` DIRECTLY, which is the level
 *     DD10 rules and the level the seam is exported at.
 *
 * ═══ WHICH LOCK, IN WHICH MODE (§2.6) ═══
 *
 * Entitlements: `select id from entitlement_counters where id in (…) order by id FOR UPDATE`, in
 * `consumeEntitlements`. Coupons: the same statement over `coupon_definitions`, in `redeemCoupons`.
 *
 * Rule 20 / §2.53: `pgrep -af jest` was read as LINES, not as a count, before every timing below;
 * the task report states whether interference was observed.
 */
const FLAG = "MEMBER_BENEFITS_ENABLED";
const clerk: Actor = { type: "user", id: "membership-clerk" };

const NOW = new Date("2026-09-01T06:00:00Z");
const VALID_FROM = new Date("2026-01-01T00:00:00Z");
const VALID_TO = new Date("2026-12-31T00:00:00Z");
const BENEFIT_KEY = "consult-visits";

/** How many natural-race trials to run. §2.3: the spike's 20 is a FLOOR, and this is that floor. */
const TRIALS = 20;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("entitlement and coupon contention: the DD10 serializer is observable", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };

  beforeAll(async () => {
    ({ db, pool, teardown } = await setupTestDb());
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    cashier = await mkCashier(db, "t4_contention_cashier");
    await openSessionFor(db, cashier, 100_000_000);
  });
  afterAll(async () => {
    delete process.env[FLAG];
    await teardown();
  });
  beforeEach(() => { delete process.env[FLAG]; });

  /**
   * A fresh member with ONE unit left, plus a plain invoice whose two stored lines the racers hang
   * their movements on. The invoice is issued with benefits OFF so that nothing is consumed by the
   * issue itself — the consume under test is the one this file drives.
   */
  async function raceFixture(): Promise<{ counterId: string; instanceId: string; lineIds: string[] }> {
    const planId = newId();
    const instanceId = newId();
    const counterId = newId();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Race Subject", sex: "other", ageYears: 30 }));
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-RACE-${planId}`, title: "Invented Race Card", kind: "membership",
      benefits: [{
        benefitKey: BENEFIT_KEY, title: "Member consultation benefit", kind: "percent_bps",
        value: 2_000, capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null },
      }],
      entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: instanceId, planId, cardCode: `RC-${instanceId}`, holderName: "Race Subject",
      patientId: patient.id, validFrom: VALID_FROM, validTo: VALID_TO, status: "active", origin: "import",
    });
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId, benefitKey: BENEFIT_KEY, grantedQty: 1,
      validFrom: VALID_FROM, validTo: VALID_TO, state: "active",
    });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: patient.id,
      lines: [
        { lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 },
        { lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 },
      ],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    const lines = await db.select({ id: invoiceLines.id }).from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, issued.invoiceId)).orderBy(asc(invoiceLines.lineNo));
    return { counterId, instanceId, lineIds: [lines[0]!.id, lines[1]!.id] };
  }

  async function couponRaceFixture(): Promise<{ couponId: string; patientId: string; invoiceId: string }> {
    const planId = newId();
    const couponId = newId();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Coupon Race Subject", sex: "other", ageYears: 30 }));
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-CRACE-${planId}`, title: "Invented Coupon Race Card", kind: "card",
      benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(couponDefinitions).values({
      id: couponId, code: `INV-CPN-${couponId}`, title: "Invented race coupon", planId,
      benefit: { kind: "percent_bps", value: 1_000, title: "Invented race coupon" },
      scope: { serviceCategories: ["consultation"], serviceIds: null },
      minBillPaise: 0, capPaise: null, singleUse: true,
      validFrom: VALID_FROM, validTo: VALID_TO, weekdayMask: 127, createdBy: "test",
    });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: patient.id,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }, NOW);
    return { couponId, patientId: patient.id, invoiceId: issued.invoiceId };
  }

  const consumeOnce = (args: { instanceId: string; invoiceLineId: string; invoiceId: string }): Promise<unknown> =>
    withTx(db, (tx) => consumeEntitlements(tx, cashier.actor, {
      invoiceId: args.invoiceId, at: NOW,
      consumes: [{ instanceId: args.instanceId, benefitKey: BENEFIT_KEY, invoiceLineId: args.invoiceLineId }],
    }));

  const redeemOnce = (args: { couponId: string; patientId: string; invoiceId: string }): Promise<unknown> =>
    withTx(db, (tx) => redeemCoupons(tx, cashier.actor, {
      invoiceId: args.invoiceId, patientId: args.patientId, at: NOW,
      redemptions: [{ couponId: args.couponId, instanceId: null, amountPaise: 5_000 }],
    }));

  // ── 1. THE BLOCK — the leg that discriminates ───────────────────────────────────────────────

  it("a consume BLOCKS while another session holds the counter row, and settles on its COMMIT", async () => {
    const { counterId, instanceId, lineIds } = await raceFixture();
    const invoiceLineId = lineIds[0]!;
    const invoiceId = (await db.select({ invoiceId: invoiceLines.invoiceId }).from(invoiceLines)
      .where(eq(invoiceLines.id, invoiceLineId)))[0]!.invoiceId;

    const holder = await pool.connect();
    let stateAt400: string;
    let settleMs: number;
    try {
      await holder.query("begin");
      // FOR NO KEY UPDATE, and the mode is the whole experiment — see this file's header. It
      // conflicts with the writer's FOR UPDATE and NOT with the FOR KEY SHARE its own INSERT takes
      // on the same row, so a lock-less writer is NOT held here and the shipped one is.
      await holder.query("select id from entitlement_counters where id = $1 for no key update", [counterId]);

      const p = consumeOnce({ instanceId, invoiceLineId, invoiceId });
      p.catch(() => {}); // no unhandled rejection while unobserved
      stateAt400 = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      const releasedAt = Date.now();
      await holder.query("commit");
      await p;
      settleMs = Date.now() - releasedAt;
    } finally {
      holder.release();
    }

    expect({ after400ms: stateAt400 }).toEqual({ after400ms: "pending" });
    // "within milliseconds of its COMMIT" — the spike measured 0 ms; the bound is loose enough to
    // survive a busy build host and far tighter than the 400 ms the block itself held.
    expect(settleMs).toBeLessThan(300);

    const movements = await db.select().from(entitlementMovements).where(eq(entitlementMovements.counterId, counterId));
    expect(movements).toHaveLength(1);
    expect(movements[0]!.delta).toBe(-1);
  });

  it("a redemption BLOCKS while another session holds the coupon's catalog row", async () => {
    const fixture = await couponRaceFixture();
    const holder = await pool.connect();
    let stateAt400: string;
    let settleMs: number;
    try {
      await holder.query("begin");
      await holder.query("select id from coupon_definitions where id = $1 for no key update", [fixture.couponId]);

      const p = redeemOnce(fixture);
      p.catch(() => {});
      stateAt400 = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      const releasedAt = Date.now();
      await holder.query("commit");
      await p;
      settleMs = Date.now() - releasedAt;
    } finally {
      holder.release();
    }

    expect({ after400ms: stateAt400 }).toEqual({ after400ms: "pending" });
    expect(settleMs).toBeLessThan(300);
    const rows = await db.select().from(couponRedemptions).where(eq(couponRedemptions.couponId, fixture.couponId));
    expect(rows).toHaveLength(1);
  });

  // ── 2. THE NATURAL RACE — the observed rate, never engineered ────────────────────────────────

  it(`the last unit cannot be consumed twice: ${String(TRIALS)} unforced races over a counter of 1`, async () => {
    let overConsumed = 0;
    let contested = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const { counterId, instanceId, lineIds } = await raceFixture();
      const invoiceId = (await db.select({ invoiceId: invoiceLines.invoiceId }).from(invoiceLines)
        .where(eq(invoiceLines.id, lineIds[0]!)))[0]!.invoiceId;
      const results = await Promise.allSettled([
        consumeOnce({ instanceId, invoiceLineId: lineIds[0]!, invoiceId }),
        consumeOnce({ instanceId, invoiceLineId: lineIds[1]!, invoiceId }),
      ]);
      // The loser's refusal is TYPED — that is the lock turning a lost race into a sentence a
      // counter can render, rather than into a raw constraint violation or a wrong number.
      for (const r of results) {
        if (r.status === "rejected") {
          contested += 1;
          expect(r.reason).toBeInstanceOf(MembershipError);
          expect((r.reason as MembershipError).code).toBe("entitlement_exhausted");
        }
      }
      const movements = await db.select().from(entitlementMovements).where(eq(entitlementMovements.counterId, counterId));
      if (movements.filter((m) => m.kind === "consume").length > 1) overConsumed += 1;
      const remaining = 1 + movements.reduce((n, m) => n + m.delta, 0);
      expect({ trial, remainingNonNegative: remaining >= 0 }).toEqual({ trial, remainingNonNegative: true });
    }
    expect({ overConsumed, of: TRIALS }).toEqual({ overConsumed: 0, of: TRIALS });
    // Non-vacuity: if NO trial ever contended, the measurement above would be about nothing. The
    // window opens on its own in READ COMMITTED (§3 Q6) — this records that it did.
    expect(contested).toBeGreaterThan(0);
  }, 180_000);

  it(`a single-use coupon cannot be redeemed twice: ${String(TRIALS)} unforced races over one code`, async () => {
    let doubleRedeemed = 0;
    let contested = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const fixture = await couponRaceFixture();
      const results = await Promise.allSettled([redeemOnce(fixture), redeemOnce(fixture)]);
      for (const r of results) {
        if (r.status === "rejected") {
          contested += 1;
          // DD10's own division of labour: the LOCK's job is to turn a raw 23505 into a clean typed
          // refusal, and the INDEX's job is that the second redemption never lands. This assertion
          // is the first half — with the lock removed the index still holds the row count at one,
          // but the refusal arrives as a postgres error instead (measured: Book row D3, mutant a).
          expect(r.reason).toBeInstanceOf(MembershipError);
          expect((r.reason as MembershipError).code).toBe("coupon_already_redeemed");
        }
      }
      const rows = await db.select().from(couponRedemptions).where(eq(couponRedemptions.couponId, fixture.couponId));
      const redeemed = rows.filter((r) => r.state === "redeemed");
      if (redeemed.length > 1) doubleRedeemed += 1;
      expect({ trial, atMostOne: redeemed.length <= 1 }).toEqual({ trial, atMostOne: true });
    }
    expect({ doubleRedeemed, of: TRIALS }).toEqual({ doubleRedeemed: 0, of: TRIALS });
    expect(contested).toBeGreaterThan(0);
  }, 180_000);

  // ── 3. END TO END — true, and deliberately NOT claimed as proof of the lock ──────────────────

  it("two concurrent INVOICES for one member never over-consume — but see the header: the series lock is what serialises them", async () => {
    process.env[FLAG] = "true";
    const planId = newId();
    const instanceId = newId();
    const counterId = newId();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "End To End", sex: "other", ageYears: 44 }));
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-E2E-${planId}`, title: "Invented E2E Card", kind: "membership",
      benefits: [{
        benefitKey: BENEFIT_KEY, title: "Member consultation benefit", kind: "percent_bps",
        value: 2_000, capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null },
      }],
      entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: instanceId, planId, cardCode: `E2E-${instanceId}`, holderName: "End To End",
      patientId: patient.id, validFrom: VALID_FROM, validTo: VALID_TO, status: "active", origin: "import",
    });
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId, benefitKey: BENEFIT_KEY, grantedQty: 1,
      validFrom: VALID_FROM, validTo: VALID_TO, state: "active",
    });

    const issue = (): Promise<unknown> => issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: patient.id,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }, NOW);
    await Promise.allSettled([issue(), issue()]);

    const movements = await db.select().from(entitlementMovements).where(eq(entitlementMovements.counterId, counterId));
    expect(movements.filter((m) => m.kind === "consume")).toHaveLength(1);
  });
});
