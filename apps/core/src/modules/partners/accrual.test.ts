import { asc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, mkBillingManager, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import {
  commissionAccrualSubjects, commissionAccruals, counterparties, events, membershipInstances,
  membershipPlans, partnerAgreements, registrationConfig,
} from "../../kernel/db/schema";
import { istDayIndex, membershipUsableAt } from "../membership";
import { registerPatient } from "../patients";
import {
  allocateReceipt, getInvoice, invoiceAccrualView, issueCreditNote, issueInvoice, issueRefundVoucher,
  payRefundVoucher, recordReceipt, requestRefund, reverseAllocation,
} from "../billing";
import { accrualLedger, appendAccrualDelta, attributeInvoice, escrowedTotalPaise, istDayIndexSql, payableTotalPaise } from "./accrual";
import { partnerPnl } from "./pnl";
import { counterpartyFacts, resolveAgreementAt } from "./agreements";
import { ACCRUAL_EVENT_NAMES, handleAccrualEvent } from "./consumer";
import type { AccrualLedgerRow } from "./accrual";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";
import type { Pool } from "pg";

/**
 * PLAN 09 T6 — DD12's LEDGER, ON REAL INVOICES. Assertion Book rows F1, F2, F3, F6, F7, F8, F9
 * and F11 live here; the pure arithmetic is fixtured in `golden/` and the wiring is in
 * `consumer.test.ts`.
 *
 * ═══ EVERY NUMBER BELOW IS HAND-DERIVED FROM THE SHIPPED ENGINE ═══
 *
 * `seedBillingBase`: OPD-CONSULT-NEW at 50 000 paise in the EXEMPT "consultation" category,
 * GENERIC-SERVICE at 50 000 in "pharmacy", taxable at 1 200 bps.
 *   divHalfUp(n, d) = floor((2n + d) / 2d) · taxHead(base, rateBps) = divHalfUp(base·rateBps, 20 000)
 *   percentAmount(g, bps) = divHalfUp(g·bps, 10 000)
 *
 *   consultation qty n : gross 50 000n · base 50 000n · heads 0 · net 50 000n
 *   pharmacy qty 1     : gross 50 000 · base 50 000 · taxHead(50 000, 1 200) = 3 000 per head ·
 *                        net 56 000
 *
 * ═══ WHY THE PARTNER, THE PLAN AND THE CARD ARE ALL INVENTED ═══
 *
 * DD3 and owner ruling O-9: no partner code, plan code, rate or person from the out-of-git book
 * reaches a tracked file, and every fixture here tests a CLASS — a part payment, a credit note on
 * an eligible line, a suspension, a race — which does not care which invented rate carries it.
 *
 * ═══ THE ATTRIBUTION FIXTURE, AND THE ONE FLAG THAT STAYS OFF ═══
 *
 * `MEMBER_BENEFITS_ENABLED` is never set in this file, so `priceDraft` reads no membership table
 * and the invoices below price exactly as they would for a non-member. That is deliberate: this
 * suite is about what the PARTNER earns on a bill, not about what the member saves on it, and a
 * benefit winning a line would move the taxable base under every hand-derived number above.
 */
/**
 * THE LANE IS ARMED FOR THIS SUITE, AND NOWHERE ELSE. `COMMISSION_ACCRUAL_ENABLED` defaults to
 * false (DD14), and with it off `handleAccrualEvent` returns `disabled` before it reads a single
 * billing row — which is exactly what `consumer.test.ts`'s F4 and F5 legs assert. This file is
 * about the ARITHMETIC, so it turns the flag on in `beforeEach` and off again in `afterAll`;
 * observed first as a fail-first, when every expectation here came back with an empty ledger.
 */
const FLAG = "COMMISSION_ACCRUAL_ENABLED";

const CLERK: Actor = { type: "user", id: "partners-accrual-clerk" };
const SYSTEM: Actor = { type: "system", id: "partners.accrual" };

const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST — the billing suite's own fixed instant
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");
const CARD_FROM = new Date("2026-01-01T00:00:00Z");
const CARD_TO = new Date("2026-12-31T00:00:00Z");
const PAYEE = { payeeName: "Asha Devi", payeeIdType: "aadhaar", payeeIdRef: "XXXX-XXXX-1234" };

type PartnerFixture = { counterpartyId: string; agreementId: string; instanceId: string };

describe("the commission ledger: DD12's delta-to-target on real invoices", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };
  let manager: { id: string; actor: Actor };
  let patientId: string;

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db);
    cashier = await mkCashier(db, "t6_accrual_cashier");
    await openSessionFor(db, cashier, 100_000_000);
    manager = await mkBillingManager(db, "t6_accrual_manager");
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Vimal Rao", sex: "male", ageYears: 52 }));
    patientId = patient.id;
  });

  /** An invented partner, an invented agreement version, and a VERIFIED card linked to the patient. */
  async function partnerFor(args: {
    rateBps: number;
    eligibleCategories: string[];
    status?: string;
    payeeClass?: string;
    effectiveTo?: Date | null;
    verified?: boolean;
    forPatientId?: string;
    /** 09a T3 — the card's own window, so a boundary fixture can sit inside the 05:30 IST gap. */
    cardFrom?: Date;
    cardTo?: Date;
    /** 09a close — a card imported but NOT yet linked to a patient (`match-queue` links it later). */
    unlinked?: boolean;
  }): Promise<PartnerFixture> {
    const counterpartyId = newId();
    const agreementId = newId();
    const planId = newId();
    const instanceId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Channel Partner",
      payeeClass: args.payeeClass ?? "channel_partner", status: args.status ?? "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: agreementId, counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM,
      effectiveTo: args.effectiveTo ?? null, status: "active", createdBy: "test",
      terms: { payableRateBps: args.rateBps, eligibleCategories: args.eligibleCategories, kicker: null },
    });
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-PLAN-${planId.slice(-6)}`, title: "Invented Partner Card", kind: "card",
      counterpartyId, benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: instanceId, planId, counterpartyId, cardCode: `IC-${instanceId.slice(-6)}`,
      holderName: "Vimal Rao", patientId: args.unlinked === true ? null : (args.forPatientId ?? patientId),
      validFrom: args.cardFrom ?? CARD_FROM, validTo: args.cardTo ?? CARD_TO, status: "active", origin: "import",
      verified: args.verified ?? true, partnerSaleRef: `INV-SALE-${instanceId.slice(-6)}`,
    });
    return { counterpartyId, agreementId, instanceId };
  }

  /** The two-line, 156 000-paise dues invoice this file's header derives. */
  async function mixedDuesInvoice(): Promise<{ invoiceId: string; lineIds: string[] }> {
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [
        { lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 },
        { lineId: newId(), serviceId: base.genericServiceId, qty: 1 },
      ],
      credit: { reason: "settles at the dues counter" },
    }, NOW);
    expect(issued.totals.netPayablePaise).toBe(156_000);
    const found = await getInvoice(db, issued.invoiceId);
    return { invoiceId: issued.invoiceId, lineIds: found!.lines.map((l) => l.id) };
  }

  /** Every accrual-subscribed event in the log, seq-ascending — exactly what the dispatcher walks. */
  async function accrualEvents(afterSeq = 0): Promise<DispatchedEvent[]> {
    const rows = await db
      .select({
        seq: events.seq, eventId: events.eventId, name: events.name, payload: events.payload,
        patientId: events.patientId, correlationId: events.correlationId, occurredAt: events.occurredAt,
      })
      .from(events)
      .orderBy(asc(events.seq));
    return rows
      .filter((r) => ACCRUAL_EVENT_NAMES.includes(r.name) && r.seq > afterSeq)
      .map((r) => ({ ...r, seq: r.seq, occurredAt: new Date(r.occurredAt) }));
  }

  /**
   * Drive every unhandled accrual event through the SHIPPED handler, in seq order. This is what a
   * dispatch cycle does; `consumer.test.ts` proves the bus really carries it.
   */
  async function drain(state: { seen: number }): Promise<void> {
    for (const e of await accrualEvents(state.seen)) {
      await handleAccrualEvent(db, e);
      state.seen = e.seq;
    }
  }

  const ledgerOf = async (counterpartyId: string): Promise<AccrualLedgerRow[]> =>
    accrualLedger(db, { counterpartyId });
  const deltasOf = async (counterpartyId: string): Promise<number[]> =>
    (await ledgerOf(counterpartyId)).map((r) => r.amountPaise);

  /** Pay a credit note out in full, end to end, so `payment.refunded` is a REAL event. */
  async function refundCreditNote(creditNoteId: string, amountPaise: number, at: Date): Promise<void> {
    const asked = await requestRefund(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId, amountPaise,
      reasonClass: "genuine", reason: "the service was not given",
    });
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "approved for the test" });
    const voucher = await issueRefundVoucher(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId, amountPaise,
      reasonClass: "genuine", reason: "the service was not given",
      approvalId: asked.approvalId, method: "cash",
    }, at);
    await payRefundVoucher(db, cashier.actor, { voucherId: voucher.voucherId, ...PAYEE }, at);
  }

  // ── the base: F1, F2, F3 ────────────────────────────────────────────────────────────────────

  it("F3 — the base is COLLECTED, not invoiced: a part payment of a mixed invoice earns 3 846, not 10 000", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const { invoiceId } = await mixedDuesInvoice();
    const receipt = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 60_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: receipt.receiptId, invoiceId, amountPaise: 60_000 }, NOW);

    const state = { seen: 0 };
    await drain(state);

    const ledger = await ledgerOf(partner.counterpartyId);
    expect(ledger).toHaveLength(1);
    // eligibleBase 100 000 · settleable 156 000 · collected 60 000
    // targetBase = divHalfUp(100 000 × 60 000, 156 000) = 38 462 · target = percentAmount(38 462, 1 000) = 3 846
    expect(ledger[0]!.amountPaise).toBe(3_846);
    expect(ledger[0]!.kind).toBe("accrual");
    expect(ledger[0]!.state).toBe("accrued");
    expect(ledger[0]!.basisEventName).toBe("payment.received");
    expect(ledger[0]!.instrumentId).toBe(partner.instanceId);
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(3_846);
  });

  it("F1 — the base is POST-DISCOUNT: a 20% charity discount earns 4 000, and the gross would have earned 5 000", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{
        lineId: newId(), serviceId: base.consultNewServiceId, qty: 1,
        manualDiscount: { discountCategory: "charity", kind: "percent_bps", value: 2_000, reason: "trust concession" },
      }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 40_000 }] },
    }, NOW);
    // gross 50 000, charity 20% = 10 000 → taxable base 40 000, exempt → net 40 000, netPayable 40 000
    expect(issued.totals.netPayablePaise).toBe(40_000);
    const view = (await invoiceAccrualView(db, issued.invoiceId))!;
    expect(view.lines[0]!.taxableBasePaise).toBe(40_000);

    await drain({ seen: 0 });
    // collected 40 000 = settleable 40 000 → targetBase = eligibleBase = 40 000 → target 4 000.
    // A base that read `gross_paise` would see 50 000 and answer percentAmount(50 000, 1 000) = 5 000.
    expect(await deltasOf(partner.counterpartyId)).toEqual([4_000]);
  });

  it("F2 — the base is PRE-GST: a taxable pharmacy line earns 5 000 on its base, and `net_paise` would have earned 5 600", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["pharmacy"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 56_000 }] },
    }, NOW);
    // base 50 000 + CGST 3 000 + SGST 3 000 = net 56 000
    expect(issued.totals.netPayablePaise).toBe(56_000);

    await drain({ seen: 0 });
    // eligibleBase 50 000 · settleable 56 000 · collected 56 000 → targetBase = 50 000 → target 5 000.
    // `net_paise` would have made the base 56 000 and the target 5 600 — the partner earning a
    // commission on the government's GST.
    expect(await deltasOf(partner.counterpartyId)).toEqual([5_000]);
  });

  // ── reversal through the one line of code: F8 ───────────────────────────────────────────────

  it("F8 — a 40% refund produces a PROPORTIONAL negative delta, and a second one takes the sum to zero and no lower", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 5 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 250_000 }] },
    }, NOW);
    expect(issued.totals.netPayablePaise).toBe(250_000);
    const lineId = (await getInvoice(db, issued.invoiceId))!.lines[0]!.id;

    const state = { seen: 0 };
    await drain(state);
    expect(await deltasOf(partner.counterpartyId)).toEqual([25_000]); // percentAmount(250 000, 1 000)

    /**
     * PLAN 09a / DD1 — AMENDED TO THE OWNER'S RULING, 2026-08-26. The old expectation here was
     * `[25_000]`, on the reading that the hospital "still holds 250 000 of the patient's cash so
     * the target does not move". That reading is CASH HELD, and it is defensible for THIS
     * all-eligible invoice and false for a mixed one — where it let a credit note on an INELIGIBLE
     * line raise an eligible line's commission (Plan 09 review, MAJOR 1).
     *
     * The ruling is SERVICE DELIVERED. Two of five consultations were not given, so 40% of the
     * service is gone the moment the credit note is issued, whatever the drawer says.
     * Hand-computed: eligibleBase 250 000 − 100 000 = 150 000 · settleable 250 000 − 100 000 =
     * 150 000 · collected still 250 000 → scaled = 150 000 × 250 000 / 150 000 = 250 000, CLAMPED
     * to eligibleBase 150 000 → target 15 000. Σ was 25 000, so the delta is −10 000, and it lands
     * HERE rather than waiting for the refund to be paid.
     */
    const note1 = await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: issued.invoiceId, reason: "two consultations were not given",
      lines: [{ invoiceLineId: lineId, qty: 2 }],
    }, NOW);
    await drain(state);
    expect(await deltasOf(partner.counterpartyId)).toEqual([25_000, -10_000]);
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(15_000);

    /**
     * PAYING THE REFUND ADDS NOTHING, and that is the clamp's real proof. collected falls to
     * 150 000 and settleable is already 150 000, so the target is STILL 15 000 — the ledger has
     * already told the truth and there is no second correction to make. Under the old unclamped
     * code this is where the −10 000 appeared; under the ruling the money moved when the SERVICE
     * did. 15 000 is 60% of 25 000: exactly the share of the sale that survived, either way.
     * A "reverse the whole accrual on any refund" implementation still appends −25 000 here.
     */
    await refundCreditNote(note1.creditNoteId, 100_000, NOW);
    await drain(state);
    expect(await deltasOf(partner.counterpartyId)).toEqual([25_000, -10_000]);
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(15_000);

    // The remaining three, credited and paid out. settleable 0 → target 0 → the ledger squares.
    const note2 = await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: issued.invoiceId, reason: "the rest were not given either",
      lines: [{ invoiceLineId: lineId, qty: 3 }],
    }, NOW);
    await drain(state);
    await refundCreditNote(note2.creditNoteId, 150_000, NOW);
    await drain(state);

    expect(await deltasOf(partner.counterpartyId)).toEqual([25_000, -10_000, -15_000]);
    // STRUCTURAL, not checked: target ≥ 0 and Σ deltas = target, so total reversal can never
    // exceed total accrual (DD12 property 3).
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(0);
  });

  it("an ALLOCATION REVERSAL gives the whole accrual back, through the same delta as everything else", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      credit: { reason: "settles at the dues counter" },
    }, NOW);
    const receipt = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 100_000 }] }, NOW);
    const applied = await allocateReceipt(db, cashier.actor, { receiptId: receipt.receiptId, invoiceId: issued.invoiceId, amountPaise: 100_000 }, NOW);

    const state = { seen: 0 };
    await drain(state);
    expect(await deltasOf(partner.counterpartyId)).toEqual([10_000]);

    await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId, reason: "posted to the wrong bill" }, NOW);
    await drain(state);
    expect(await deltasOf(partner.counterpartyId)).toEqual([10_000, -10_000]);
    expect((await ledgerOf(partner.counterpartyId))[1]!.kind).toBe("reversal");
    expect((await ledgerOf(partner.counterpartyId))[1]!.basisEventName).toBe("allocation.reversed");
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(0);
  });

  // ── attribution: C-17, and the partner that cannot be paid ──────────────────────────────────

  it("C-17 — an UNVERIFIED instrument accrues NOTHING, and the same bill accrues once it is verified", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"], verified: false });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    expect(await attributeInvoice(db, issued.invoiceId)).toBeNull();
    await drain({ seen: 0 });
    expect(await ledgerOf(partner.counterpartyId)).toEqual([]);

    // O-1's load-bearing half: a grace-honored card is HONOURED at the counter and accrues nothing
    // until a real book row arrives and matches it. When one does, the same events reconstruct the
    // whole accrual — which is the replay property, and the reason `verified` gates accrual only.
    await db.update(membershipInstances).set({ verified: true }).where(eq(membershipInstances.id, partner.instanceId));
    await drain({ seen: 0 });
    expect(await deltasOf(partner.counterpartyId)).toEqual([10_000]);
  });

  it("an invoice whose patient holds no partner card at all attributes to nobody", async () => {
    await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const { patient: other } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Nobody's Member", sex: "female", ageYears: 30 }));
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: other.id,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }, NOW);
    expect(await attributeInvoice(db, issued.invoiceId)).toBeNull();
    await drain({ seen: 0 });
    expect(await accrualLedger(db, { invoiceId: issued.invoiceId })).toEqual([]);
  });

  it("DD4 — nothing is ever PAYABLE to an external_rmp: the attempt is an EVENT and no ledger row", async () => {
    const partner = await partnerFor({
      rateBps: 1000, eligibleCategories: ["consultation"], payeeClass: "external_rmp",
    });
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    await drain({ seen: 0 });

    expect(await ledgerOf(partner.counterpartyId)).toEqual([]);
    const blocked = await db.select().from(events).where(eq(events.name, "payout.class_blocked"));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toEqual({
      counterpartyId: partner.counterpartyId, payeeClass: "external_rmp", amountPaise: 10_000,
      reason: "commission accrual refused: payable to an external_rmp counterparty",
    });
  });

  // ── O-7: escrow, and the totals that must not include it ────────────────────────────────────

  it("F9 — a SUSPENDED partner's accrual is WRITTEN as `escrowed`, never skipped, and no payable total includes it", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"], status: "suspended" });
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    await drain({ seen: 0 });

    const ledger = await ledgerOf(partner.counterpartyId);
    // The row EXISTS — a skipped accrual is indistinguishable from an event that never arrived,
    // and an escrowed row is a decision with a date on it (O-7's own reason).
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.state).toBe("escrowed");
    expect(ledger[0]!.amountPaise).toBe(10_000);
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(0);
    expect(await escrowedTotalPaise(db, partner.counterpartyId)).toBe(10_000);
  });

  // ── DD6: the snapshot, and the instant the version is pinned at ─────────────────────────────

  it("F7(a) — the SNAPSHOT wins over the current agreement: an amendment does not rewrite what a past commission was worth", async () => {
    const partner = await partnerFor({
      rateBps: 1000, eligibleCategories: ["consultation"], effectiveTo: new Date("2026-09-01T00:00:00Z"),
    });
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    await drain({ seen: 0 });
    expect(await deltasOf(partner.counterpartyId)).toEqual([10_000]);

    // The amendment lands, and DOUBLES the rate.
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId: partner.counterpartyId, versionNo: 2,
      effectiveFrom: new Date("2026-09-01T00:00:00Z"), effectiveTo: null, status: "active", createdBy: "test",
      terms: { payableRateBps: 2000, eligibleCategories: ["consultation"], kicker: null },
    });

    const ledger = await ledgerOf(partner.counterpartyId);
    expect(ledger[0]!.rateBps).toBe(1_000); // off the ROW's snapshot, never off the table
    expect(ledger[0]!.agreementVersionNo).toBe(1);
    expect(ledger[0]!.agreementId).toBe(partner.agreementId);
    // And the current version really is the amended one, so this is a discrimination and not a
    // fixture in which the two answers happen to agree.
    const current = await resolveAgreementAt(db, partner.counterpartyId, new Date("2026-10-01T00:00:00Z"));
    expect(current?.terms.payableRateBps).toBe(2_000);
  });

  it("F7(b) — the version is pinned at the INVOICE's issue instant: two payments straddling an amendment both price at v1", async () => {
    const partner = await partnerFor({
      rateBps: 1000, eligibleCategories: ["consultation"], effectiveTo: new Date("2026-09-01T00:00:00Z"),
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId: partner.counterpartyId, versionNo: 2,
      effectiveFrom: new Date("2026-09-01T00:00:00Z"), effectiveTo: null, status: "active", createdBy: "test",
      terms: { payableRateBps: 2000, eligibleCategories: ["consultation"], kicker: null },
    });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      credit: { reason: "settles at the dues counter" },
    }, NOW); // issued 2026-08-19, i.e. UNDER v1

    const state = { seen: 0 };
    const before = new Date("2026-08-20T06:00:00Z");
    const r1 = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 40_000 }] }, before);
    await allocateReceipt(db, cashier.actor, { receiptId: r1.receiptId, invoiceId: issued.invoiceId, amountPaise: 40_000 }, before);
    await drain(state);
    expect(await deltasOf(partner.counterpartyId)).toEqual([4_000]);

    const after = new Date("2026-09-15T06:00:00Z"); // squarely inside v2
    const r2 = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 60_000 }] }, after);
    await allocateReceipt(db, cashier.actor, { receiptId: r2.receiptId, invoiceId: issued.invoiceId, amountPaise: 60_000 }, after);
    await drain(state);

    // Under delta-to-target the SECOND event recomputes the WHOLE invoice, so resolving the
    // version at the event's own instant would reprice the first 40 000 at v2's rate too and an
    // amendment would rewrite history — which is precisely what DD6 forbids. v1 throughout:
    // target = percentAmount(100 000, 1 000) = 10 000, and the deltas are 4 000 then 6 000.
    expect(await deltasOf(partner.counterpartyId)).toEqual([4_000, 6_000]);
    const ledger = await ledgerOf(partner.counterpartyId);
    expect(ledger.map((r) => r.agreementVersionNo)).toEqual([1, 1]);
    expect(ledger.map((r) => r.rateBps)).toEqual([1_000, 1_000]);
    // At v2's rate the same invoice would have been worth 20 000 — the number this pin refuses.
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(10_000);
  });

  // ── F6: idempotency under redelivery ────────────────────────────────────────────────────────

  it("F6 — a redelivered event produces NO second accrual, even when the invoice's money moved in between", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    const lineId = (await getInvoice(db, issued.invoiceId))!.lines[0]!.id;
    const [payment] = await accrualEvents();
    expect(payment!.name).toBe("payment.received");

    expect((await handleAccrualEvent(db, payment!)).outcome).toBe("appended");

    // A credit note ROW lands, and its own event has NOT been handled yet — which is the state a
    // redelivery is dangerous in: recomputing now yields a DIFFERENT target, so a handler with no
    // idempotency guard would append a second row for one event.
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: issued.invoiceId, reason: "one consultation was not given",
      lines: [{ invoiceLineId: lineId, qty: 1 }],
    }, NOW);

    const redelivered = await handleAccrualEvent(db, payment!);
    expect(redelivered.outcome).toBe("already_recorded");
    const ledger = await ledgerOf(partner.counterpartyId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amountPaise).toBe(10_000);
  });

  it("the SECOND guard is the index: `commission_accruals_basis_event_ux` refuses a duplicate (subject, basis event)", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    await drain({ seen: 0 });
    const row = (await db.select().from(commissionAccruals))[0]!;
    await expect(
      db.insert(commissionAccruals).values({ ...row, id: newId(), seq: undefined as unknown as number }),
    ).rejects.toThrow(/commission_accruals_basis_event_ux/);
  });

  // ── F11: two events for one invoice, at once ────────────────────────────────────────────────

  it("F11(a) — an append BLOCKS while another session holds the subject row, and settles on its COMMIT", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const { invoiceId } = await mixedDuesInvoice();
    const r1 = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 60_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: r1.receiptId, invoiceId, amountPaise: 60_000 }, NOW);
    const state = { seen: 0 };
    await drain(state); // creates the subject row and the first delta

    const subject = (await db.select().from(commissionAccrualSubjects))[0]!;
    const r2 = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 96_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: r2.receiptId, invoiceId, amountPaise: 96_000 }, NOW);
    const pending = (await accrualEvents(state.seen))[0]!;

    const holder = await pool.connect();
    let stateAt400: string;
    let settleMs: number;
    try {
      await holder.query("begin");
      // FOR NO KEY UPDATE, and the MODE is the whole experiment. It conflicts with the writer's
      // `FOR UPDATE` and NOT with the `FOR KEY SHARE` that inserting a `commission_accruals` row
      // takes on this same parent through its foreign key — so a lock-less writer sails through
      // here and the shipped one waits. Holding `FOR UPDATE` instead would block both and prove
      // nothing (the phase relay records that exact false negative, measured on T4's D2).
      await holder.query("select id from commission_accrual_subjects where id = $1 for no key update", [subject.id]);

      const p = handleAccrualEvent(db, pending);
      p.catch(() => {}); // no unhandled rejection while unobserved
      stateAt400 = await Promise.race([p.then(() => "settled", () => "settled"), new Promise<string>((r) => setTimeout(() => r("pending"), 400))]);
      const releasedAt = Date.now();
      await holder.query("commit");
      await p;
      settleMs = Date.now() - releasedAt;
    } finally {
      holder.release();
    }

    expect({ after400ms: stateAt400 }).toEqual({ after400ms: "pending" });
    expect(settleMs).toBeLessThan(300);
    expect(await payableTotalPaise(db, partner.counterpartyId)).toBe(10_000);
  });

  /**
   * The explicit timeout is the price of keeping the trial body identical to the one the F11
   * mutant was raced against: each trial truncates and re-seeds the whole billing base, which is
   * ~1 s of setup for ~50 ms of race. Measured at 12.3 s in an isolated `--runInBand` run and
   * over the suite's 15 000 ms default under a parallel `pnpm verify`. Shrinking the setup would
   * have made the shipped test a different experiment from the one that killed the mutant.
   */
  it("F11(b) — two events for ONE invoice handled concurrently cannot double-append: 12 unforced races", async () => {
    const TRIALS = 12; // §2.3: a floor, and the observed rate is what the report quotes
    let overAppended = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      await truncateAll(db);
      await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
      base = await seedBillingBase(db);
      await grantCreditExtend(db);
      cashier = await mkCashier(db, "t6_race_cashier");
      await openSessionFor(db, cashier, 100_000_000);
      const { patient } = await withTx(db, (tx) =>
        registerPatient(tx, CLERK, { name: "Race Subject", sex: "other", ageYears: 40 }));
      patientId = patient.id;
      const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
      const { invoiceId } = await mixedDuesInvoice();

      const r1 = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 60_000 }] }, NOW);
      await allocateReceipt(db, cashier.actor, { receiptId: r1.receiptId, invoiceId, amountPaise: 60_000 }, NOW);
      const state = { seen: 0 };
      await drain(state); // the subject row exists, and Σ = 3 846

      // TWO more allocations, BOTH landed before either event is handled — which is the shape the
      // alerts consumer's docstring records being observed: two dispatch cycles, one invoice.
      const r2 = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 40_000 }] }, NOW);
      await allocateReceipt(db, cashier.actor, { receiptId: r2.receiptId, invoiceId, amountPaise: 40_000 }, NOW);
      const r3 = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 56_000 }] }, NOW);
      await allocateReceipt(db, cashier.actor, { receiptId: r3.receiptId, invoiceId, amountPaise: 56_000 }, NOW);
      const [e2, e3] = await accrualEvents(state.seen);

      await Promise.allSettled([handleAccrualEvent(db, e2!), handleAccrualEvent(db, e3!)]);
      // collected 156 000 = settleable 156 000 → targetBase 100 000 → target 10 000, whatever
      // order the two cycles ran in. Without the lock both read Σ = 3 846 and both append 6 154.
      const total = await payableTotalPaise(db, partner.counterpartyId);
      if (total !== 10_000) overAppended += 1;
    }
    expect({ overAppended, of: TRIALS }).toEqual({ overAppended: 0, of: TRIALS });
  }, 180_000);

  // ── the schema's own refusals, asserted here because this task writes a `direction` ──────────

  it("`commission_accruals_direction_ck` and the subject's own CHECK refuse a third direction", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }, NOW);
    await expect(
      db.insert(commissionAccrualSubjects).values({
        id: newId(), agreementId: partner.agreementId, invoiceId: issued.invoiceId,
        direction: "contra", counterpartyId: partner.counterpartyId,
      }),
    ).rejects.toThrow(/commission_accrual_subjects_direction_ck/);
    await expect(
      db.insert(commissionAccruals).values({
        id: newId(), subjectId: null, counterpartyId: partner.counterpartyId, payeeClass: "channel_partner",
        agreementId: partner.agreementId, direction: "contra", invoiceId: issued.invoiceId,
        kind: "accrual", state: "accrued", amountPaise: 1, rateSnapshot: {}, occurredAt: NOW,
      }),
    ).rejects.toThrow(/commission_accruals_direction_ck/);
  });

  it("the ledger is APPEND-ONLY: the DD5 trigger refuses an UPDATE and a DELETE", async () => {
    const partner = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"] });
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    await drain({ seen: 0 });
    const row = (await db.select().from(commissionAccruals))[0]!;
    await expect(
      db.update(commissionAccruals).set({ state: "escrowed" }).where(eq(commissionAccruals.id, row.id)),
    ).rejects.toThrow(/partner_ledger_immutable|append-only/);
    await expect(
      db.delete(commissionAccruals).where(eq(commissionAccruals.id, row.id)),
    ).rejects.toThrow(/partner_ledger_immutable|append-only/);
    // Which is why O-7's escrow is a state chosen at INSERT and never a later update.
    expect(await accrualLedger(db, { counterpartyId: partner.counterpartyId })).toHaveLength(1);
  });

  it("`appendAccrualDelta` writes nothing at all when the delta is zero", async () => {
    const partner = await partnerFor({ rateBps: 1500, eligibleCategories: ["procedure"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    const view = (await invoiceAccrualView(db, issued.invoiceId))!;
    const attribution = (await attributeInvoice(db, issued.invoiceId))!;
    const counterparty = (await counterpartyFacts(db, attribution.counterpartyId))!;
    const agreement = (await resolveAgreementAt(db, counterparty.counterpartyId, attribution.issuedAt))!;
    const result = await appendAccrualDelta(db, {
      actor: SYSTEM, attribution, counterparty, agreement, view,
      basisEventId: newId(), basisEventName: "payment.received", occurredAt: NOW,
    });
    expect(result.outcome).toBe("no_delta");
    // The SUBJECT row is still created — it is the serializer, and a later event for this invoice
    // must find the same one to lock rather than racing to create it.
    expect(await db.select().from(commissionAccrualSubjects)).toHaveLength(1);
    expect(await ledgerOf(partner.counterpartyId)).toEqual([]);
  });
  /**
   * PLAN 09a T2 — DD2. A BACKDATED AGREEMENT VERSION MUST NOT RE-ACCRUE THE WHOLE INVOICE.
   *
   * Plan 09 keyed the subject `(agreement_id, invoice_id, direction)`. An amendment that is
   * backdated over an invoice already accrued therefore resolves to a NEW agreement id, opens a
   * SECOND subject, finds no prior rows under it, and appends the entire target a second time —
   * measured by Plan 09's independent reviewer as `[5000, 10000]`, total 15 000 where 10 000 is
   * right.
   *
   * The subject is re-keyed on `(invoice_id, direction)`. Nothing is lost: every accrual row
   * carries its own `agreement_id` column and its own `rate_snapshot` (Plan 09 DD6), so which
   * terms priced which delta is still reconstructible per ROW. What changes is that DD12's
   * invariant — **Σ deltas = target** — becomes true PER INVOICE, which is what it always meant.
   *
   * The two appends are driven directly rather than through the dispatcher because that is the
   * level DD2 rules and the level the reviewer measured; `consumer.test.ts` proves the bus carries
   * it.
   */
  it("a BACKDATED agreement version re-prices the invoice, it does not re-accrue it (09a DD2)", async () => {
    const partner = await partnerFor({ rateBps: 500, eligibleCategories: ["consultation"] });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    expect(issued.totals.netPayablePaise).toBe(100_000); // consultation is exempt — no tax head

    const view = (await invoiceAccrualView(db, issued.invoiceId))!;
    const attribution = (await attributeInvoice(db, issued.invoiceId))!;
    const counterparty = (await counterpartyFacts(db, attribution.counterpartyId))!;

    // ── v1 at 500 bps on a fully-collected 100 000 eligible base → target 5 000. ──
    const v1 = (await resolveAgreementAt(db, counterparty.counterpartyId, attribution.issuedAt))!;
    expect(v1.agreementId).toBe(partner.agreementId);
    await appendAccrualDelta(db, {
      actor: SYSTEM, attribution, counterparty, agreement: v1, view,
      basisEventId: newId(), basisEventName: "payment.received", occurredAt: NOW,
    });
    expect(await deltasOf(partner.counterpartyId)).toEqual([5_000]);

    // ── The amendment: a SECOND active version, effective from the same day, at twice the rate. ──
    const v2Id = newId();
    await db.insert(partnerAgreements).values({
      id: v2Id, counterpartyId: partner.counterpartyId, versionNo: 2, effectiveFrom: AGREEMENT_FROM,
      effectiveTo: null, status: "active", createdBy: "test",
      terms: { payableRateBps: 1000, eligibleCategories: ["consultation"], kicker: null },
    });
    const v2 = (await resolveAgreementAt(db, counterparty.counterpartyId, attribution.issuedAt))!;
    expect(v2.agreementId).toBe(v2Id); // the backdated version now governs this invoice's instant

    await appendAccrualDelta(db, {
      actor: SYSTEM, attribution, counterparty, agreement: v2, view,
      basisEventId: newId(), basisEventName: "payment.received", occurredAt: NOW,
    });

    // The target under v2 is 10 000, and 5 000 of it is already accrued: the delta is the
    // DIFFERENCE. Keyed on the agreement this read `[5_000, 10_000]` and summed to 15 000.
    expect(await deltasOf(partner.counterpartyId)).toEqual([5_000, 5_000]);
    const total = (await ledgerOf(partner.counterpartyId)).reduce((s, r) => s + r.amountPaise, 0);
    expect({ total }).toEqual({ total: 10_000 });

    // ONE subject for this invoice, whichever agreement version priced it. This is the assertion
    // the old key could not make, and it is the reason the second append found the first's rows.
    expect(await db.select().from(commissionAccrualSubjects)).toHaveLength(1);

    // Which terms priced which delta is still reconstructible — per ROW, from the row's own
    // agreement id, exactly as DD6 intends.
    const ledger = await ledgerOf(partner.counterpartyId);
    expect(ledger.map((r) => r.agreementId)).toEqual([partner.agreementId, v2Id]);
  });
  // ──────────── PLAN 09a T3 — DD3: the ledger and the counter must agree what day it is ────────────

  /**
   * THE ~18.5-HOUR WINDOW, AND WHY IT IS AN ORDINARY WORKING DAY RATHER THAN AN EDGE CASE.
   *
   * Plan 09's B6/K7 rule membership validity as an **IST calendar-day** comparison, and
   * `membershipUsableAt` — the predicate the COUNTER runs — honours it. `attributeInvoice` compared
   * raw instants in SQL. The holder-book importer writes a date-only column as `T00:00:00.000Z`,
   * which is **05:30 IST**. So for every imported card, on the final day of its validity, from
   * 05:30 IST until midnight — the whole of a working day — the counter honoured the discount and
   * the partner was credited NOTHING.
   *
   * No test anywhere pinned the boundary because every partners fixture used a December expiry
   * against an August clock: `CARD_TO` and the invoice instant were never near each other, so the
   * two clocks could not be caught disagreeing. That is §2.102's rule — a fixture whose fields
   * cannot differ hides the defect that distinguishes them — and the fix is a leg where they do.
   *
   * The assertion is deliberately not "attribution happens". It is **the two predicates return the
   * same answer for the same instant**, which is the property DD3 actually rules; asserting only
   * the attribution would pass against a predicate that had been widened too far in the other
   * direction, and the negative legs below are what close that door.
   */
  const usable = (validFrom: Date, validTo: Date, at: Date): boolean =>
    membershipUsableAt(
      { instanceId: "x", planId: "p", planTitle: "t", cardCode: "c", status: "active", validFrom, validTo, benefits: [] },
      at,
    );

  it("DD3 — a card expiring at 05:30 IST is HONOURED all day, and the partner is credited all day", async () => {
    // 2026-08-19T00:00:00Z is 05:30 IST on the 19th — exactly what the importer writes for a card
    // whose book row says it runs to the 19th. The invoice is at 11:30 IST on the SAME IST day.
    const CARD_TO_BOUNDARY = new Date("2026-08-19T00:00:00Z");
    expect(NOW.getTime()).toBeGreaterThan(CARD_TO_BOUNDARY.getTime()); // raw instants DISAGREE...
    expect(usable(CARD_FROM, CARD_TO_BOUNDARY, NOW)).toBe(true);      // ...and the COUNTER honours it

    const partner = await partnerFor({
      rateBps: 1000, eligibleCategories: ["consultation"], cardTo: CARD_TO_BOUNDARY,
    });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);

    // The ledger's own clock must reach the counter's answer. Comparing raw instants it did not.
    const attribution = await attributeInvoice(db, issued.invoiceId);
    expect(attribution).not.toBeNull();
    expect(attribution!.instrumentId).toBe(partner.instanceId);
  });

  it("DD3 — a card STARTING at 05:30 IST covers a bill earlier the same IST day", async () => {
    // 00:30 IST on the 19th is 2026-08-18T19:00:00Z — the PREVIOUS UTC day, the SAME IST day.
    const EARLY = new Date("2026-08-18T19:00:00Z");
    const CARD_FROM_BOUNDARY = new Date("2026-08-19T00:00:00Z");
    expect(EARLY.getTime()).toBeLessThan(CARD_FROM_BOUNDARY.getTime()); // raw instants DISAGREE
    expect(usable(CARD_FROM_BOUNDARY, CARD_TO, EARLY)).toBe(true);

    const partner = await partnerFor({
      rateBps: 1000, eligibleCategories: ["consultation"], cardFrom: CARD_FROM_BOUNDARY,
    });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, EARLY);
    const attribution = await attributeInvoice(db, issued.invoiceId);
    expect(attribution).not.toBeNull();
    expect(attribution!.instrumentId).toBe(partner.instanceId);
  });

  /**
   * THE DOOR THE FIX MUST NOT OPEN. A day-based predicate is WIDER than an instant-based one, so
   * the risk it introduces is over-attribution: a card that lapsed yesterday earning on today's
   * bill. Both legs below fail against a predicate widened past the calendar day, and both agree
   * with the counter — which is the point: the two clocks match on the NO answers too.
   */
  it("DD3 — a card that lapsed the PREVIOUS IST day still attributes to nobody", async () => {
    const LAPSED = new Date("2026-08-18T00:00:00Z"); // 05:30 IST on the 18th; the bill is the 19th
    expect(usable(CARD_FROM, LAPSED, NOW)).toBe(false);

    await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"], cardTo: LAPSED });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    expect(await attributeInvoice(db, issued.invoiceId)).toBeNull();
  });

  it("DD3 — a card that starts the NEXT IST day attributes to nobody", async () => {
    const TOMORROW = new Date("2026-08-20T00:00:00Z"); // 05:30 IST on the 20th; the bill is the 19th
    expect(usable(TOMORROW, CARD_TO, NOW)).toBe(false);

    await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"], cardFrom: TOMORROW });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    expect(await attributeInvoice(db, issued.invoiceId)).toBeNull();
  });
  /**
   * THE ANTI-DRIFT PIN (§2.54). `istDayIndexSql` is the SQL transliteration of `istDayIndex`, and
   * two expressions of one rule drift by construction unless something fails when they disagree.
   * This is that something. The instants are chosen to sit ON the boundaries where a wrong offset
   * or a wrong rounding direction shows up: 05:29:59.999 IST and 05:30:00.000 IST are on opposite
   * sides of the UTC midnight that the holder-book importer writes, and 23:59 IST is the far end of
   * the same IST day.
   */
  it("DD3 — the SQL day index and the TS `istDayIndex` agree at every boundary that matters", async () => {
    const instants = [
      new Date("2026-08-18T18:29:59.999Z"), // 23:59:59.999 IST on the 18th — last ms of that day
      new Date("2026-08-18T18:30:00.000Z"), // 00:00:00.000 IST on the 19th — first ms of the next
      new Date("2026-08-19T00:00:00.000Z"), // 05:30 IST on the 19th — what the importer writes
      new Date("2026-08-19T06:00:00.000Z"), // 11:30 IST on the 19th — a working-hours bill
      new Date("2026-08-19T18:29:59.999Z"), // 23:59:59.999 IST on the 19th
      new Date("1970-01-01T00:00:00.000Z"), // the epoch, where a floor-toward-zero bug would show
    ];
    for (const at of instants) {
      const rows = (await db.execute(
        sql`select ${istDayIndexSql(sql`${at}::timestamptz`)} as d`,
      )).rows as { d: string | number }[];
      expect({ at: at.toISOString(), sql: Number(rows[0]!.d) })
        .toEqual({ at: at.toISOString(), sql: istDayIndex(at) });
    }
  });

  /**
   * AND THE BEHAVIOURAL HALF: the P&L must count the very invoice the ledger credits. Same card,
   * same 05:30-IST expiry, same bill — read through `partnerPnl` rather than `attributeInvoice`.
   * Before this task the two answered differently, and the file's own header promised they could not.
   */
  it("DD3 — the channel P&L counts the boundary bill the ledger credits (the second copy)", async () => {
    const CARD_TO_BOUNDARY = new Date("2026-08-19T00:00:00Z");
    const partner = await partnerFor({
      rateBps: 1000, eligibleCategories: ["consultation"], cardTo: CARD_TO_BOUNDARY,
    });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    expect(issued.totals.netPayablePaise).toBe(100_000);

    // The ledger's answer.
    expect(await attributeInvoice(db, issued.invoiceId)).not.toBeNull();
    // The P&L's answer, which must be the SAME answer.
    const pnl = await partnerPnl(db, { counterpartyId: partner.counterpartyId, asOf: NOW });
    expect({ memberSpendPaise: pnl.memberSpendPaise }).toEqual({ memberSpendPaise: 100_000 });
  });
  /**
   * PLAN 09a CLOSE — MAJOR 1 FROM THE INDEPENDENT REVIEW. TWO COUNTERPARTIES MUST NEVER SHARE A
   * SUBJECT, AND THE FIRST RE-KEY LET THEM.
   *
   * DD2 dropped `agreement_id` from the subject key to stop a backdated amendment re-accruing an
   * invoice. `agreement_id` was also the only thing keeping two COUNTERPARTIES apart, because an
   * agreement belongs to exactly one of them. Keyed on `(invoice_id, direction)` alone, a second
   * partner attributed to the same invoice found the FIRST partner's subject, summed the FIRST
   * partner's rows as its own prior, and appended the difference — so the incoming partner was
   * short-paid by exactly what the outgoing one had already been credited.
   *
   * **It is reachable through shipped code, which is why it is a defect and not a hypothetical.**
   * `membership_instances.patient_id` is *"null until a human links it"* and `match-queue` links it
   * later; `attributeInvoice` breaks ties on `seq`, which is insert order. So a card **imported
   * earlier and linked later** displaces the card that is currently attributed — and the flip is
   * ordinary operations, not an attack.
   *
   * The key is therefore `(invoice_id, direction, counterparty_id)`: coarser than the agreement, so
   * DD2's backdated amendment still lands on one subject, and finer than the invoice, so two
   * partners can never pool. The test below fails against `(invoice_id, direction)` with B credited
   * 5 000 instead of 10 000.
   */
  it("two counterparties on ONE invoice never share a subject, and neither pays the other's prior", async () => {
    // B is imported FIRST (lower `seq`) but arrives UNLINKED, exactly as the holder-book import
    // leaves a card whose patient nobody has matched yet.
    const b = await partnerFor({ rateBps: 1000, eligibleCategories: ["consultation"], unlinked: true });
    const a = await partnerFor({ rateBps: 500, eligibleCategories: ["consultation"] });

    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100_000 }] },
    }, NOW);
    const view = (await invoiceAccrualView(db, issued.invoiceId))!;

    // ── While only A is linked, the invoice is A's: 100 000 × 500 bps = 5 000. ──
    const attrA = (await attributeInvoice(db, issued.invoiceId))!;
    expect(attrA.counterpartyId).toBe(a.counterpartyId);
    const cpA = (await counterpartyFacts(db, a.counterpartyId))!;
    const agA = (await resolveAgreementAt(db, a.counterpartyId, attrA.issuedAt))!;
    await appendAccrualDelta(db, {
      actor: SYSTEM, attribution: attrA, counterparty: cpA, agreement: agA, view,
      basisEventId: newId(), basisEventName: "payment.received", occurredAt: NOW,
    });
    expect(await deltasOf(a.counterpartyId)).toEqual([5_000]);

    // ── The human links B. `match-queue` does exactly this, and B's lower `seq` now wins. ──
    await db.update(membershipInstances).set({ patientId }).where(eq(membershipInstances.id, b.instanceId));
    const attrB = (await attributeInvoice(db, issued.invoiceId))!;
    expect(attrB.counterpartyId).toBe(b.counterpartyId);

    const cpB = (await counterpartyFacts(db, b.counterpartyId))!;
    const agB = (await resolveAgreementAt(db, b.counterpartyId, attrB.issuedAt))!;
    await appendAccrualDelta(db, {
      actor: SYSTEM, attribution: attrB, counterparty: cpB, agreement: agB, view,
      basisEventId: newId(), basisEventName: "payment.received", occurredAt: NOW,
    });

    // B's target is 100 000 × 1 000 bps = 10 000, and B has been credited NOTHING before now.
    // Sharing A's subject made this `[5_000]` — A's 5 000 counted as B's own prior.
    expect(await deltasOf(b.counterpartyId)).toEqual([10_000]);
    expect(await payableTotalPaise(db, b.counterpartyId)).toBe(10_000);

    // TWO subjects, one per counterparty, and each names the partner it serialises.
    const subjects = await db.select().from(commissionAccrualSubjects);
    expect(subjects).toHaveLength(2);
    expect([...subjects.map((r) => r.counterpartyId)].sort())
      .toEqual([a.counterpartyId, b.counterpartyId].sort());

    // A is untouched by B's arrival: this phase does not decide what a re-attribution owes A —
    // it only guarantees B is never paid out of A's ledger. (Recorded as an open item in the CLOSE.)
    expect(await payableTotalPaise(db, a.counterpartyId)).toBe(5_000);
  });
});
