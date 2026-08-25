import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  commissionAccruals, counterparties, membershipInstances, membershipPlans, partnerAgreements,
  receivableExpectations,
} from "../../kernel/db/schema";
import { accrualLedger } from "./accrual";
import { counterpartyFacts } from "./agreements";
import {
  countActivations, kickerBonusPaise, periodBounds, periodKeyFor, periodSettled, recomputeKicker,
} from "./kicker";
import type { CounterpartyFacts } from "./agreements";
import type { Db } from "../../kernel/db/client";

/**
 * O-6 — THE VOLUME KICKER: keyed on the ACTIVATION instant, recomputed as an append-only
 * adjustment, and closed once its period has been settled. Assertion Book row F10.
 *
 * Every rate, threshold, bonus and card below was invented here (DD3 / O-9).
 */
const SYSTEM: Actor = { type: "system", id: "partners.kicker" };

const AGREEMENT_FROM = new Date("2026-01-01T00:00:00Z");
const CARD_FROM = new Date("2026-01-01T00:00:00Z");
const CARD_TO = new Date("2027-12-31T00:00:00Z");
/** Inside 2026-Q3 in IST (2026-06-30T18:30Z … 2026-09-30T18:30Z). */
const ACTIVATED_IN_Q3 = new Date("2026-09-15T06:00:00Z");
/** Inside 2026-Q4, and the instant a backdated drop is FED to us. */
const FED_IN_Q4 = new Date("2026-11-10T06:00:00Z");

const TIERS = [
  { minActivations: 3, bonusPaise: 500_000 },
  { minActivations: 5, bonusPaise: 900_000 },
];

describe("the volume kicker: activated, never fed (O-6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let counterpartyId: string;
  let planId: string;
  let facts: CounterpartyFacts;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    counterpartyId = newId();
    planId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Channel Partner",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM, effectiveTo: null,
      status: "active", createdBy: "test",
      terms: {
        payableRateBps: 1000, eligibleCategories: ["consultation"],
        kicker: { periodKind: "quarter", tiers: TIERS },
      },
    });
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-PLAN-${planId.slice(-6)}`, title: "Invented Partner Card", kind: "card",
      counterpartyId, benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
    facts = (await counterpartyFacts(db, counterpartyId))!;
  });

  /** A card SOLD by the partner: activated at one instant, fed to us at another. */
  async function card(args: { activatedAt: Date | null; createdAt: Date; verified?: boolean }): Promise<void> {
    const id = newId();
    await db.insert(membershipInstances).values({
      id, planId, counterpartyId, cardCode: `IC-${id.slice(-6)}`, holderName: "Invented Holder",
      validFrom: CARD_FROM, validTo: CARD_TO, status: "active", origin: "import",
      verified: args.verified ?? true, activatedAt: args.activatedAt, createdAt: args.createdAt,
      partnerSaleRef: `INV-SALE-${id.slice(-6)}`,
    });
  }

  const kickerRows = async (): Promise<{ amountPaise: number; periodKey: string | null; state: string; kind: string }[]> =>
    (await accrualLedger(db, { counterpartyId }))
      .filter((r) => r.kind === "kicker")
      .map((r) => ({ amountPaise: r.amountPaise, periodKey: r.periodKey, state: r.state, kind: r.kind }));

  // ── the period arithmetic, which is an IST fact and not a UTC one ────────────────────────────

  it("period keys and bounds are IST: the instant 18:31 UTC on 30 September is already Q4", () => {
    expect(periodKeyFor("quarter", new Date("2026-09-30T18:29:00Z"))).toBe("2026-Q3");
    expect(periodKeyFor("quarter", new Date("2026-09-30T18:31:00Z"))).toBe("2026-Q4");
    expect(periodKeyFor("month", new Date("2026-09-30T18:29:00Z"))).toBe("2026-M09");
    expect(periodKeyFor("month", new Date("2026-09-30T18:31:00Z"))).toBe("2026-M10");

    // [start, end) in real instants: the IST quarter boundary is 18:30 UTC the day before.
    expect(periodBounds("2026-Q3")).toEqual({
      start: new Date("2026-06-30T18:30:00.000Z"), end: new Date("2026-09-30T18:30:00.000Z"),
    });
    expect(periodBounds("2026-M09")).toEqual({
      start: new Date("2026-08-31T18:30:00.000Z"), end: new Date("2026-09-30T18:30:00.000Z"),
    });
    // Every key this file writes round-trips through its own bounds.
    for (const key of ["2026-Q1", "2026-Q4", "2026-M01", "2026-M12"]) {
      const { start, end } = periodBounds(key);
      expect(periodKeyFor(key.includes("Q") ? "quarter" : "month", start)).toBe(key);
      expect(periodKeyFor(key.includes("Q") ? "quarter" : "month", new Date(end.getTime() - 1))).toBe(key);
    }
    expect(() => periodBounds("Q3-2026")).toThrow(/unreadable period key/);
  });

  it("tiers do NOT stack: the highest threshold that is met is what the period earns", () => {
    expect(kickerBonusPaise({ periodKind: "quarter", tiers: TIERS }, 2)).toBe(0);
    expect(kickerBonusPaise({ periodKind: "quarter", tiers: TIERS }, 3)).toBe(500_000);
    expect(kickerBonusPaise({ periodKind: "quarter", tiers: TIERS }, 4)).toBe(500_000);
    expect(kickerBonusPaise({ periodKind: "quarter", tiers: TIERS }, 5)).toBe(900_000);
    expect(kickerBonusPaise({ periodKind: "quarter", tiers: TIERS }, 50)).toBe(900_000);
    expect(kickerBonusPaise(null, 50)).toBe(0);
  });

  // ── F10: the count is of ACTIVATIONS ─────────────────────────────────────────────────────────

  it("F10 — a BACKDATED drop earns nothing in the quarter it was FED in, and earns in the quarter it was ACTIVATED in", async () => {
    // Three cards activated in Q3, fed to us in Q4 — the book-stuffing shape O-6 exists to make
    // unprofitable by construction rather than by detection.
    await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });

    expect(await countActivations(db, counterpartyId, periodBounds("2026-Q4"))).toBe(0);
    expect(await countActivations(db, counterpartyId, periodBounds("2026-Q3"))).toBe(3);

    // Q4, the quarter the file LANDED in: nothing was activated in it, so nothing is earned. An
    // implementation that counted FED rows would find three here and pay 500 000 for an upload.
    const q4 = await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q4", occurredAt: FED_IN_Q4 });
    expect(q4).toEqual({ outcome: "no_delta", activations: 0, earnedPaise: 0, priorPaise: 0 });
    expect(await kickerRows()).toEqual([]);

    // Q3, the quarter they were ACTIVATED in: three activations, the 3-tier, 500 000.
    const q3 = await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 });
    expect(q3).toMatchObject({ outcome: "appended", activations: 3, earnedPaise: 500_000, deltaPaise: 500_000, state: "accrued" });
    expect(await kickerRows()).toEqual([{ amountPaise: 500_000, periodKey: "2026-Q3", state: "accrued", kind: "kicker" }]);
  });

  it("a card with NO activation instant, and an UNVERIFIED one, are both uncounted", async () => {
    await card({ activatedAt: null, createdAt: FED_IN_Q4 }); // sold, never activated
    await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4, verified: false }); // C-17
    await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    expect(await countActivations(db, counterpartyId, periodBounds("2026-Q3"))).toBe(1);
  });

  it("an activation on the IST quarter BOUNDARY belongs to the period that has just begun", async () => {
    await card({ activatedAt: new Date("2026-09-30T18:30:00.000Z"), createdAt: FED_IN_Q4 });
    expect(await countActivations(db, counterpartyId, periodBounds("2026-Q3"))).toBe(0);
    expect(await countActivations(db, counterpartyId, periodBounds("2026-Q4"))).toBe(1);
    await card({ activatedAt: new Date("2026-09-30T18:29:59.999Z"), createdAt: FED_IN_Q4 });
    expect(await countActivations(db, counterpartyId, periodBounds("2026-Q3"))).toBe(1);
  });

  // ── DD5: recompute is a ROW, and a settled period is closed ──────────────────────────────────

  it("recompute is APPEND-ONLY: a raised threshold appends the DIFFERENCE, never an edit", async () => {
    for (let i = 0; i < 3; i += 1) await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 });
    expect(await kickerRows()).toHaveLength(1);

    // Running it again with nothing changed appends nothing — the arithmetic is what makes a
    // recompute idempotent, because `basis_event_id` is NULL on an adjustment and the uniqueness
    // index cannot constrain it (Postgres treats NULLs as distinct).
    const again = await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 });
    expect(again).toEqual({ outcome: "no_delta", activations: 3, earnedPaise: 500_000, priorPaise: 500_000 });
    expect(await kickerRows()).toHaveLength(1);

    // Two MORE activations land for the same quarter — the retroactivity O-6 says is real.
    await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    const raised = await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 });
    expect(raised).toMatchObject({ outcome: "appended", activations: 5, earnedPaise: 900_000, deltaPaise: 400_000 });
    expect(await kickerRows()).toEqual([
      { amountPaise: 500_000, periodKey: "2026-Q3", state: "accrued", kind: "kicker" },
      { amountPaise: 400_000, periodKey: "2026-Q3", state: "accrued", kind: "kicker" },
    ]);
  });

  it("a SETTLED period is CLOSED to recompute, and re-opening it is an owner action this phase does not build", async () => {
    for (let i = 0; i < 5; i += 1) await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 });
    expect(await kickerRows()).toHaveLength(1);

    expect(await periodSettled(db, counterpartyId, "2026-Q3")).toBe(false);
    // A statement line for that period reaches `matched` — the only settled-period signal this
    // phase has a table for (T7's import writes these rows; see `kicker.ts`'s header).
    await db.insert(receivableExpectations).values({
      id: newId(), counterpartyId, amountPaise: 900_000, state: "matched",
      statementRef: "INV-STMT-0001", statementPeriod: "2026-Q3", statementLineNo: 1,
      expectedAt: FED_IN_Q4, matchedAt: FED_IN_Q4, updatedBy: "test",
    });
    expect(await periodSettled(db, counterpartyId, "2026-Q3")).toBe(true);

    await expect(
      recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 }),
    ).rejects.toMatchObject({ code: "period_closed" });
    expect(await kickerRows()).toHaveLength(1); // and nothing was written on the way out

    // An UNSETTLED period of the same partner is untouched by that.
    await card({ activatedAt: new Date("2026-11-01T06:00:00Z"), createdAt: FED_IN_Q4 });
    await card({ activatedAt: new Date("2026-11-02T06:00:00Z"), createdAt: FED_IN_Q4 });
    await card({ activatedAt: new Date("2026-11-03T06:00:00Z"), createdAt: FED_IN_Q4 });
    const q4 = await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q4", occurredAt: FED_IN_Q4 });
    expect(q4).toMatchObject({ outcome: "appended", activations: 3, deltaPaise: 500_000 });
  });

  it("O-7 — a SUSPENDED partner's kicker is ESCROWED too, and no payable total includes it", async () => {
    for (let i = 0; i < 3; i += 1) await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await db.update(counterparties).set({ status: "suspended" }).where(eq(counterparties.id, counterpartyId));
    const suspended = (await counterpartyFacts(db, counterpartyId))!;
    const result = await recomputeKicker(db, { actor: SYSTEM, counterparty: suspended, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 });
    expect(result).toMatchObject({ outcome: "appended", state: "escrowed" });
    expect(await kickerRows()).toEqual([{ amountPaise: 500_000, periodKey: "2026-Q3", state: "escrowed", kind: "kicker" }]);
  });

  it("an agreement with NO kicker clause earns none, and says so rather than appending a zero", async () => {
    await db.update(partnerAgreements)
      .set({ terms: { payableRateBps: 1000, eligibleCategories: ["consultation"], kicker: null } })
      .where(eq(partnerAgreements.counterpartyId, counterpartyId));
    for (let i = 0; i < 9; i += 1) await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    expect(await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 }))
      .toEqual({ outcome: "no_kicker", activations: 9 });
    expect(await kickerRows()).toEqual([]);
  });

  it("a period with NO agreement in force refuses rather than pricing at nothing", async () => {
    await db.update(partnerAgreements)
      .set({ effectiveTo: new Date("2026-05-01T00:00:00Z") })
      .where(eq(partnerAgreements.counterpartyId, counterpartyId));
    for (let i = 0; i < 3; i += 1) await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await expect(
      recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 }),
    ).rejects.toMatchObject({ code: "no_effective_agreement" });
  });

  it("the kicker row carries the SNAPSHOT that explains it: the tiers, the count and what was already paid", async () => {
    for (let i = 0; i < 3; i += 1) await card({ activatedAt: ACTIVATED_IN_Q3, createdAt: FED_IN_Q4 });
    await recomputeKicker(db, { actor: SYSTEM, counterparty: facts, periodKey: "2026-Q3", occurredAt: FED_IN_Q4 });
    const row = (await db.select().from(commissionAccruals).where(eq(commissionAccruals.kind, "kicker")))[0]!;
    expect(row.subjectId).toBeNull();   // an adjustment corrects a PERIOD, not an invoice
    expect(row.invoiceId).toBeNull();
    expect(row.basisEventId).toBeNull();
    expect(row.occurredAt).toEqual(FED_IN_Q4);
    expect(row.rateSnapshot).toMatchObject({
      versionNo: 1,
      payableRateBps: 1000,
      // pinned at the period's LAST instant: the terms in force when the period closed are the
      // terms under which its volume was agreed.
      pinnedAt: new Date(periodBounds("2026-Q3").end.getTime() - 1).toISOString(),
      kicker: { periodKind: "quarter", tiers: TIERS },
      activations: 3,
      earnedPaise: 500_000,
      priorPaise: 0,
    });
  });
});
