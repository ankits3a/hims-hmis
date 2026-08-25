import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantCreditExtend, issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import {
  commissionAccruals, counterparties, membershipInstances, membershipPlans, partnerAgreements,
  registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueAttribution } from "./attribution";
import { importStatement } from "./statements";
import { identityLeaks } from "./exports";
import { partnerPnl, partnerPnlAll } from "./pnl";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T8 — THE CHANNEL P&L: cards active, member spend, commission payable, the three
 * receivable numbers, and the net channel margin, ALL read off rows T6/T7 already write.
 *
 * ═══ THIS FILE'S ONE GENUINELY NEW QUERY IS `memberSpendPaise`, SO IT IS THE ONE TESTED HERE ON A
 * REAL INVOICE ═══
 *
 * `cardsActive`, `payableCommissionPaise`, `receivableExpectedPaise/MatchedPaise/DisputedPaise` are
 * thin reuses of `accrual.ts`/`aging.ts`, already proven correct by T6's and T7's own suites — this
 * file only needs to prove the WIRING (the right reader is called and the right field lands in the
 * right place), so those go through direct-insert fixtures the way `exports.test.ts` does. Member
 * spend is a NEW predicate, so it goes through a REAL `issuePaidInvoice` — the same "member spend
 * and whose bill this is are the same question" claim `pnl.ts`'s header makes is worth measuring,
 * not only asserting.
 *
 * ═══ THE ACCEPTANCE LINE ITSELF — "reads ZEROS with the lanes off and does not error" ═══
 *
 * Neither `RECEIVABLE_COMMISSION_ENABLED` nor `COMMISSION_ACCRUAL_ENABLED` is ever set in the
 * "zero" test below — the true off-state, not a flag flipped and flipped back. Every OTHER test
 * that needs a receivable row sets `RECEIVABLE_COMMISSION_ENABLED` itself and `afterEach` clears
 * both flags, so no test can leak its own flag into the next one (§2.87 — a leaked flag reading
 * green for the wrong reason is exactly the class F1 cost the last phase a red CI commit over).
 *
 * Every partner, plan, card and person below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const CLERK: Actor = { type: "user", id: "t8-pnl-clerk" };
const NOW = new Date("2026-08-19T06:00:00Z");
const CARD_FROM = new Date("2026-01-01T00:00:00Z");
const CARD_TO = new Date("2026-12-31T00:00:00Z");
const AGREEMENT_FROM = new Date("2026-01-01T00:00:00Z");

describe("the channel P&L: one row per partner, built from readers T6/T7 already ship", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  afterEach(() => {
    delete process.env.RECEIVABLE_COMMISSION_ENABLED;
    delete process.env.COMMISSION_ACCRUAL_ENABLED;
  });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db);
    cashier = await mkCashier(db, "t8_pnl_cashier");
    await openSessionFor(db, cashier, 100_000_000);
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Sudhindra Naik", sex: "male", ageYears: 40 }));
    patientId = patient.id;
  });

  async function partnerFor(args: { name?: string } = {}): Promise<{ counterpartyId: string; agreementId: string }> {
    const counterpartyId = newId();
    const agreementId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-PNL-${counterpartyId.slice(-6)}`, name: args.name ?? "Invented P&L Partner",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: agreementId, counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM, effectiveTo: null,
      status: "active", createdBy: "test",
      terms: { payableRateBps: 1_000, eligibleCategories: ["pharmacy"], receivableRateBps: 1_500, unclaimedExpiryDays: 60 },
    });
    return { counterpartyId, agreementId };
  }

  async function cardFor(
    counterpartyId: string,
    args: { status?: string; verified?: boolean; forPatientId?: string } = {},
  ): Promise<string> {
    const planId = newId();
    const instanceId = newId();
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-PLAN-${planId.slice(-6)}`, title: "Invented Partner Card", kind: "card",
      counterpartyId, benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: instanceId, planId, counterpartyId, cardCode: `IC-${instanceId.slice(-6)}`,
      holderName: "Invented Holder", patientId: args.forPatientId ?? patientId,
      validFrom: CARD_FROM, validTo: CARD_TO, status: args.status ?? "active", origin: "import",
      verified: args.verified ?? true, partnerSaleRef: `INV-SALE-${instanceId.slice(-6)}`,
    });
    return instanceId;
  }

  it("an unknown counterparty is REFUSED, not silently reported as a zero row", async () => {
    await expect(
      partnerPnl(db, { counterpartyId: "no-such-partner", asOf: NOW }),
    ).rejects.toMatchObject({ code: "unknown_counterparty" });
  });

  it("acceptance: a real partner reads every field ZERO with both lanes OFF, and does not error", async () => {
    expect(process.env.RECEIVABLE_COMMISSION_ENABLED).toBeUndefined();
    expect(process.env.COMMISSION_ACCRUAL_ENABLED).toBeUndefined();
    const { counterpartyId } = await partnerFor();

    const row = await partnerPnl(db, { counterpartyId, asOf: NOW });
    expect(row).toMatchObject({
      counterpartyId,
      cardsActive: 0,
      memberSpendPaise: 0,
      payableCommissionPaise: 0,
      receivableExpectedPaise: 0,
      receivableMatchedPaise: 0,
      receivableDisputedPaise: 0,
      netChannelMarginPaise: 0,
    });
  });

  it("cardsActive counts only ACTIVE instances of THIS partner", async () => {
    const { counterpartyId } = await partnerFor();
    const other = await partnerFor({ name: "Invented Other Partner" });
    await cardFor(counterpartyId, { status: "active" });
    await cardFor(counterpartyId, { status: "active" });
    await cardFor(counterpartyId, { status: "expired" });
    await cardFor(other.counterpartyId, { status: "active" });

    expect((await partnerPnl(db, { counterpartyId, asOf: NOW })).cardsActive).toBe(2);
    expect((await partnerPnl(db, { counterpartyId: other.counterpartyId, asOf: NOW })).cardsActive).toBe(1);
  });

  it("memberSpendPaise sums bills from a VERIFIED holder of this partner's card, valid at issue — and nothing else", async () => {
    const { counterpartyId } = await partnerFor();
    await cardFor(counterpartyId, { verified: true });
    const issued = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.genericServiceId }, NOW);

    // A SECOND patient bills too, but holds an UNVERIFIED card of the SAME partner — O-1's rule
    // that a grace/unverified card earns nothing extends to spend attribution the same way it
    // does to commission (they are the same predicate — see this file's header).
    const { patient: unverifiedHolder } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Unverified Holder", sex: "female", ageYears: 33 }));
    await cardFor(counterpartyId, { verified: false, forPatientId: unverifiedHolder.id });
    await issuePaidInvoice(db, cashier, { patientId: unverifiedHolder.id, serviceId: base.genericServiceId }, NOW);

    // A THIRD patient bills with no card of this partner at all — must not count either.
    const { patient: stranger } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "No Card At All", sex: "male", ageYears: 29 }));
    await issuePaidInvoice(db, cashier, { patientId: stranger.id, serviceId: base.genericServiceId }, NOW);

    const row = await partnerPnl(db, { counterpartyId, asOf: NOW });
    expect(row.memberSpendPaise).toBe(issued.totals.netPayablePaise);
  });

  it("memberSpendPaise excludes a bill issued OUTSIDE the card's validity window", async () => {
    const { counterpartyId } = await partnerFor();
    await cardFor(counterpartyId, { verified: true });
    // The card is valid 2026-01-01..2026-12-31; bill it a day after the card expired.
    await issuePaidInvoice(db, cashier, { patientId, serviceId: base.genericServiceId }, new Date("2027-01-01T06:00:00Z"));

    expect((await partnerPnl(db, { counterpartyId, asOf: NOW })).memberSpendPaise).toBe(0);
  });

  it("payableCommissionPaise is the ACCRUED total only — an escrowed row (O-7) is excluded", async () => {
    const { counterpartyId, agreementId } = await partnerFor();
    await db.insert(commissionAccruals).values({
      id: newId(), counterpartyId, payeeClass: "channel_partner", agreementId, direction: "payable",
      kind: "accrual", state: "accrued", amountPaise: 20_000, rateSnapshot: {}, occurredAt: NOW,
    });
    await db.insert(commissionAccruals).values({
      id: newId(), counterpartyId, payeeClass: "channel_partner", agreementId, direction: "payable",
      kind: "accrual", state: "escrowed", amountPaise: 9_000, rateSnapshot: {}, occurredAt: NOW,
    });

    expect((await partnerPnl(db, { counterpartyId, asOf: NOW })).payableCommissionPaise).toBe(20_000);
  });

  it("the three receivable numbers mirror the aging report — matched is the LEDGER, never summed claims", async () => {
    process.env.RECEIVABLE_COMMISSION_ENABLED = "true";
    const { counterpartyId, agreementId } = await partnerFor();

    const mentioned = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, NOW); // never mentioned — stays "expected"

    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-PNL-01", statementPeriod: "2026-M08",
      csv: `attribution_ref,partner_ref,amount_paise\n${mentioned.code},,60000\n`,
    }, NOW);
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-PNL-02", statementPeriod: "2026-M08",
      csv: "attribution_ref,partner_ref,amount_paise\nRF-NOSUCHSLIP,,90000\n",
    }, NOW);

    await db.insert(commissionAccruals).values({
      id: newId(), counterpartyId, payeeClass: "channel_partner", agreementId, direction: "payable",
      kind: "accrual", state: "accrued", amountPaise: 15_000, rateSnapshot: {}, occurredAt: NOW,
    });

    const row = await partnerPnl(db, { counterpartyId, asOf: NOW });
    expect(row.receivableExpectedPaise).toBe(30_000); // percentAmount(200 000, 1 500) — the silent one
    expect(row.receivableMatchedPaise).toBe(60_000); // the ledger's own confirmed total
    expect(row.receivableDisputedPaise).toBe(90_000);
    expect(row.payableCommissionPaise).toBe(15_000);
    expect(row.netChannelMarginPaise).toBe(60_000 - 15_000);
  });

  it("partnerPnlAll lists every counterparty and reads an empty array over an empty catalog (DD3)", async () => {
    expect(await partnerPnlAll(db, { asOf: NOW })).toEqual([]);

    const a = await partnerFor({ name: "Invented Partner A" });
    const b = await partnerFor({ name: "Invented Partner B" });
    const all = await partnerPnlAll(db, { asOf: NOW });
    expect(all.map((r) => r.counterpartyId).sort()).toEqual([a.counterpartyId, b.counterpartyId].sort());
  });

  it("DD15 — the row is aggregates only; no patients-table key appears anywhere in it", async () => {
    const { counterpartyId } = await partnerFor();
    await cardFor(counterpartyId);
    const row = await partnerPnl(db, { counterpartyId, asOf: NOW });
    expect(identityLeaks(row)).toEqual([]);
    // A real, non-trivial row — the leg above is a measurement, not a tautology.
    expect(Object.keys(row).length).toBeGreaterThan(5);
  });
});
