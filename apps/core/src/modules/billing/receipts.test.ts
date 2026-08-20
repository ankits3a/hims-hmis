import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issueDuesInvoice, issuePaidInvoice, mkBillingManager, mkCashier, openSessionFor,
  seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { withTx } from "../../kernel/db/client";
import {
  allocations, enteredInErrorMarks, events, receipts, receiptTenders, refundVouchers, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { invoiceSettlement } from "./invoices";
import {
  advanceOf, allocateReceipt, listDues, markEnteredInError, patientBalance, recordReceipt, reverseAllocation,
} from "./receipts";
import { issueRefundVoucher, REFUND_APPROVAL_SUBJECT, REFUND_APPROVAL_TYPE } from "./refunds";
import type { Pool } from "pg";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T6, D1 — the patient money ledger: receipts (the advance lane), allocations, and the
 * derived readers.
 *
 * THE SEEDED FIXTURE every number below is derived from (test/helpers/billing.ts
 * `seedBillingBase`):
 *   · tariff: three services at 50000 paise each on one activated version — OPD-CONSULT-NEW in
 *     category "consultation" (sac 999312, EXEMPT: heads 0, so net = gross) and GENERIC-SERVICE in
 *     "pharmacy" (sac 3004, taxable at 1200 bps).
 *   · billing_config: cash warn 15_000_000 / block 20_000_000 / PAN 5_000_000 · creditCap 500_000 ·
 *     outstandingCap 2_000_000 mode "warn" · feeBps { upi: 0, card: 150 }.
 *
 * Every dues fixture uses the EXEMPT consult service, so an invoice for qty n is exactly
 * n · 50000 paise with zero GST and zero §170 rounding (50000 is a whole number of rupees) — the
 * ledger arithmetic below is then visibly about ALLOCATION, not about pricing.
 */
describe("receipts and allocations: the patient money ledger (D1)", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  // The same fixed instant T5 uses: 2026-08-19T06:00:00Z + 5:30 = 11:30 IST -> IST day
  // "2026-08-19", fiscal year 2026-27 rendered "26-27", so the first receipt of a fresh database
  // is "RCP/26-27/000001".
  const NOW = new Date("2026-08-19T06:00:00Z");
  const SERVICE_DAY = "2026-08-19";

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  beforeAll(async () => {
    ({ db, pool, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  /** A fresh database in the state `beforeEach` leaves — the cold start each race iteration needs. */
  async function resetToSeededBase(): Promise<void> {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  }

  async function mkTestPatient(name = "Ledger Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "ledger-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 35 }));
    return patient.id;
  }

  /** A §14 confidential patient — the row `listDues` must render by alias, never by name. */
  async function mkConfidentialPatient(): Promise<string> {
    const actor: Actor = { type: "user", id: "ledger-clerk" };
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, actor, {
        name: "Screened Name", sex: "male", ageYears: 44, isConfidential: true, alias: "Blue Heron",
      }),
    );
    return patient.id;
  }

  async function cashierWithSession(username: string): Promise<{ id: string; actor: Actor }> {
    const cashier = await mkCashier(db, username);
    await openSessionFor(db, cashier, 100_000);
    return cashier;
  }

  const countRows = async (): Promise<{ receipts: number; allocations: number; marks: number }> => ({
    receipts: (await db.select().from(receipts)).length,
    allocations: (await db.select().from(allocations)).length,
    marks: (await db.select().from(enteredInErrorMarks)).length,
  });

  const eventsNamed = (name: string) => db.select().from(events).where(eq(events.name, name));

  /** One cash advance for this patient, through the shipped writer. */
  const bankCashAdvance = async (
    cashier: { actor: Actor }, patientId: string, amountPaise: number,
  ): Promise<{ receiptId: string }> =>
    recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise }] }, NOW);

  /**
   * A GRANTED `billing_refund` approval bound to this patient and this exact amount — the T8 shape
   * (refunds.test.ts `grantedRefundApproval`). An advance refund's subject IS the patient: an
   * advance is a balance, not a document (`resolveTarget`).
   */
  async function grantedAdvanceRefundApproval(input: {
    patientId: string; amountPaise: number; requester: Actor; approver: Actor;
  }): Promise<string> {
    const filed = await withTx(db, (tx) =>
      requestApproval(tx, input.requester, {
        typeKey: REFUND_APPROVAL_TYPE,
        subject: { type: REFUND_APPROVAL_SUBJECT, id: input.patientId },
        patientId: input.patientId,
        amountPaise: input.amountPaise,
        requestNote: "the patient is leaving and wants the balance back",
      }),
    );
    await approveRequest(db, input.approver, { approvalId: filed.approvalId, note: "approved for the test" });
    return filed.approvalId;
  }

  /** Issues the whole of `amountPaise` back to the patient as an advance-refund voucher (status `issued`). */
  async function refundWholeAdvance(
    cashier: { actor: Actor }, manager: { actor: Actor }, patientId: string, amountPaise: number,
  ): Promise<string> {
    const approvalId = await grantedAdvanceRefundApproval({
      patientId, amountPaise, requester: cashier.actor, approver: manager.actor,
    });
    const voucher = await issueRefundVoucher(
      db, cashier.actor,
      {
        kind: "advance_refund", patientId, amountPaise, reasonClass: "genuine",
        reason: "the patient is leaving and wants the balance back", approvalId, method: "cash",
      },
      NOW,
    );
    return voucher.voucherId;
  }

  /**
   * The T7/T8 `codeOf` shape, kept verbatim so a refusal that WRONGLY RETURNS is reported as an
   * expected-vs-received pair rather than as a bare throw. A guard implemented wrongly fails by
   * ACCEPTING, so this is exactly where tripwire 21's expected/received pair has to come from.
   */
  const codeOf = async (run: Promise<unknown>): Promise<{ code: unknown; detail: unknown }> => {
    let refused = false;
    let returned: unknown = null;
    let err: { code?: unknown; detail?: unknown } = {};
    try {
      returned = (await run) ?? null;
    } catch (e) {
      refused = true;
      err = e as { code?: unknown; detail?: unknown };
    }
    expect({ refused, returned }).toEqual({ refused: true, returned: null });
    return { code: err.code, detail: err.detail };
  };

  test("recordReceipt banks an advance: the receipt and its tenders persist, receipt.recorded and advance.received are appended", async () => {
    const cashier = await cashierWithSession("cashier-advance");
    const patientId = await mkTestPatient();

    const result = await recordReceipt(
      db,
      cashier.actor,
      {
        patientId,
        tenders: [
          { mode: "cash", amountPaise: 30_000 },
          { mode: "upi", amountPaise: 20_000, refText: "UPI-REF-1" },
        ],
        note: "advance against tomorrow's procedure",
      },
      NOW,
    );

    expect(result).toMatchObject({ receiptNo: "RCP/26-27/000001", totalPaise: 50_000 });
    const rows = await db.select().from(receipts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.receiptId, patientId, receivedBy: cashier.id, serviceDay: SERVICE_DAY,
      totalPaise: 50_000, form60: false, degraded: false, note: "advance against tomorrow's procedure",
    });

    // expectedNetPaise is stamped at CAPTURE: cash settles at face value and carries none; the
    // seeded UPI fee basis is 0 bps, so a 20000 UPI tender expects 20000 - 0 = 20000.
    const tenders = await db.select().from(receiptTenders).where(eq(receiptTenders.receiptId, result.receiptId));
    expect(tenders).toHaveLength(2);
    expect(tenders.find((t) => t.mode === "cash")).toMatchObject({ amountPaise: 30_000, state: "captured", expectedNetPaise: null });
    expect(tenders.find((t) => t.mode === "upi")).toMatchObject({ amountPaise: 20_000, refText: "UPI-REF-1", expectedNetPaise: 20_000 });

    const recorded = await eventsNamed("receipt.recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ receiptId: result.receiptId, receiptNo: "RCP/26-27/000001", totalPaise: 50_000 });
    const advance = await eventsNamed("advance.received");
    expect(advance).toHaveLength(1);
    expect(advance[0]!.payload).toMatchObject({ receiptId: result.receiptId, amountPaise: 50_000 });
    // A standalone advance has no invoice, so nothing is allocated and nothing correlates.
    expect(recorded[0]!.correlationId).toBeNull();
    expect(await eventsNamed("payment.received")).toHaveLength(0);
    expect((await countRows()).allocations).toBe(0);
    expect(await advanceOf(db, patientId)).toBe(50_000);
  });

  test("the C-2 cash law reaches the advance lane: a cash advance counts into the episode, and a blocked one is audited", async () => {
    const cashier = await cashierWithSession("cashier-c2-advance");
    const patientId = await mkTestPatient();
    const cash = (amountPaise: number) => [{ mode: "cash" as const, amountPaise }];

    // 4_900_000 is under the seeded PAN threshold 5_000_000 and under warn 15_000_000: accepted.
    await recordReceipt(db, cashier.actor, { patientId, tenders: cash(4_900_000) }, NOW);
    // 4_900_000 + 200_000 = 5_100_000 > 5_000_000 -> PAN or Form 60 required. THIS is the
    // assertion that the ADVANCE counted: 200_000 on its own is nowhere near the threshold.
    await expect(
      recordReceipt(db, cashier.actor, { patientId, tenders: cash(200_000) }, NOW),
    ).rejects.toMatchObject({ code: "pan_required" });
    expect((await countRows()).receipts).toBe(1);
    await recordReceipt(db, cashier.actor, { patientId, tenders: cash(200_000), form60: true }, NOW);

    // 5_100_000 + 9_900_000 = 15_000_000, exactly the warn threshold — warn is `>=`, so it warns
    // and still accepts.
    await recordReceipt(db, cashier.actor, { patientId, tenders: cash(9_900_000), form60: true }, NOW);
    const warned = await eventsNamed("cash_threshold.warned");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.payload).toMatchObject({ patientId, episodeCashPaise: 15_000_000, thresholdPaise: 15_000_000 });

    // 15_000_000 + 5_000_000 = 20_000_000, exactly the block threshold: refused, nothing persists.
    await expect(
      recordReceipt(db, cashier.actor, { patientId, tenders: cash(5_000_000), form60: true }, NOW),
    ).rejects.toMatchObject({ code: "cash_threshold_blocked" });
    expect((await countRows()).receipts).toBe(3);
    // The audit survives the refusal it audits (the `issueInvoice` rule, same law).
    const blocked = await eventsNamed("cash_threshold.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toMatchObject({ patientId, episodeCashPaise: 20_000_000, thresholdPaise: 20_000_000 });
  });

  test("an advance receipt needs the ACTING cashier's own open session: no_open_session", async () => {
    const cashier = await mkCashier(db, "cashier-advance-nosession"); // deliberately never opened
    const patientId = await mkTestPatient();

    await expect(
      recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 10_000 }] }, NOW),
    ).rejects.toMatchObject({ code: "no_open_session" });
    expect(await countRows()).toMatchObject({ receipts: 0, allocations: 0 });
  });

  test("patientBalance assembles both sides of the ledger from the readers, and both move when money is allocated", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-balance");
    const patientId = await mkTestPatient();

    // OPD-CONSULT-NEW is EXEMPT: qty 2 -> gross 100000, heads 0, netPayable 100000, rounding 0.
    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    expect(dues.totals.netPayablePaise).toBe(100_000);
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 30_000 }] }, NOW);

    const before = await patientBalance(db, cashier.actor, patientId);
    expect(before).toMatchObject({ patientId, advancePaise: 30_000, outstandingPaise: 100_000 });
    expect(before.dues).toHaveLength(1);
    expect(before.dues[0]).toMatchObject({
      invoiceId: dues.invoiceId, invoiceNo: dues.invoiceNo, netPayablePaise: 100_000,
      outstandingPaise: 100_000, creditExtended: true, restricted: false, name: "Ledger Patient",
    });

    await allocateReceipt(
      db, cashier.actor,
      { receiptId: advance.receiptId, invoiceId: dues.invoiceId, amountPaise: 30_000 },
      NOW,
    );

    const after = await patientBalance(db, cashier.actor, patientId);
    expect(after).toMatchObject({ advancePaise: 0, outstandingPaise: 70_000 });
    expect(after.dues[0]).toMatchObject({ outstandingPaise: 70_000 });
  });

  test("listDues is oldest-first, carries each invoice's outstanding, and renders a confidential patient by alias", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-dues");
    const plainId = await mkTestPatient("Plain Patient");
    const vipId = await mkConfidentialPatient();

    // Issued in this order, so `seq` runs 1..3 in this order whatever the ULIDs come out as.
    const first = await issueDuesInvoice(db, cashier, { patientId: plainId, serviceId: base.consultNewServiceId, qty: 1 });
    const second = await issueDuesInvoice(db, cashier, { patientId: vipId, serviceId: base.consultNewServiceId, qty: 2 });
    const settled = await issuePaidInvoice(db, cashier, { patientId: plainId, serviceId: base.consultNewServiceId });
    const third = await issueDuesInvoice(db, cashier, { patientId: plainId, serviceId: base.consultNewServiceId, qty: 3 });

    const dues = await listDues(db, cashier.actor);
    // The settled invoice is not a due — settlement is DERIVED, so nothing had to mark it.
    expect(dues.map((d) => d.invoiceId)).toEqual([first.invoiceId, second.invoiceId, third.invoiceId]);
    expect(dues.map((d) => d.invoiceId)).not.toContain(settled.invoiceId);
    expect(dues.map((d) => d.outstandingPaise)).toEqual([50_000, 100_000, 150_000]);
    expect(dues[0]!.seq).toBeLessThan(dues[1]!.seq);
    expect(dues[1]!.seq).toBeLessThan(dues[2]!.seq);

    // §14: the cashier holds no patients.confidential.read, so the VIP row renders its alias and
    // never its name; the ordinary row renders the name.
    expect(dues[1]).toMatchObject({ patientId: vipId, restricted: true, name: null, alias: "Blue Heron" });
    expect(dues[0]).toMatchObject({ patientId: plainId, restricted: false, name: "Plain Patient", alias: null });

    expect((await listDues(db, cashier.actor, { patientId: vipId })).map((d) => d.invoiceId)).toEqual([second.invoiceId]);
  });

  test("allocateReceipt clears dues in parts: each apply appends its own payment.received and the state walks to settled", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-clear");
    const patientId = await mkTestPatient();

    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 100_000 }] }, NOW);

    const partial = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: dues.invoiceId, amountPaise: 40_000 }, NOW,
    );
    expect(partial.settlement).toEqual({ state: "partial", outstandingPaise: 60_000 });

    const closing = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: dues.invoiceId, amountPaise: 60_000 }, NOW,
    );
    expect(closing.settlement).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await invoiceSettlement(db, dues.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });

    const rows = await db.select().from(allocations);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "apply")).toBe(true);
    const received = await eventsNamed("payment.received");
    expect(received).toHaveLength(2);
    expect(received.map((e) => e.correlationId)).toEqual([dues.invoiceId, dues.invoiceId]);
    expect(received.map((e) => (e.payload as { amountPaise: number }).amountPaise)).toEqual([40_000, 60_000]);
    expect(await advanceOf(db, patientId)).toBe(0);
  });

  test("an invoice cannot be overpaid, and one patient's receipt cannot touch another patient's invoice", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-overalloc");
    const patientId = await mkTestPatient();
    const otherId = await mkTestPatient("Other Patient");

    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 150_000 }] }, NOW);

    await expect(
      allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: dues.invoiceId, amountPaise: 150_000 }, NOW),
    ).rejects.toMatchObject({ code: "over_allocation", detail: { askedPaise: 150_000, outstandingPaise: 100_000 } });

    // Money is patient-scoped: the other patient's advance cannot see this invoice at all.
    const strangerAdvance = await recordReceipt(
      db, cashier.actor, { patientId: otherId, tenders: [{ mode: "cash", amountPaise: 100_000 }] }, NOW,
    );
    await expect(
      allocateReceipt(db, cashier.actor, { receiptId: strangerAdvance.receiptId, invoiceId: dues.invoiceId, amountPaise: 100_000 }, NOW),
    ).rejects.toMatchObject({ code: "unknown_invoice" });

    expect((await countRows()).allocations).toBe(0);
    expect(await invoiceSettlement(db, dues.invoiceId)).toEqual({ state: "unpaid", outstandingPaise: 100_000 });
  });

  test("a receipt cannot be spent twice: the second invoice sees no remainder left on it", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-remainder");
    const patientId = await mkTestPatient();

    const first = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const second = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 50_000 }] }, NOW);

    await allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: first.invoiceId, amountPaise: 50_000 }, NOW);
    await expect(
      allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: second.invoiceId, amountPaise: 1 }, NOW),
    ).rejects.toMatchObject({ code: "over_allocation", detail: { askedPaise: 1, remainingPaise: 0 } });

    expect((await countRows()).allocations).toBe(1);
    expect(await invoiceSettlement(db, second.invoiceId)).toEqual({ state: "unpaid", outstandingPaise: 100_000 });
  });

  test("reverseAllocation APPENDS its mirror row and appends allocation.reversed — nothing is deleted", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-reverse");
    const patientId = await mkTestPatient();

    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 100_000 }] }, NOW);
    const applied = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: dues.invoiceId, amountPaise: 100_000 }, NOW,
    );
    expect(applied.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const reversed = await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId, reason: "posted to the wrong bill" }, NOW);
    expect(reversed).toMatchObject({ amountPaise: 100_000, settlement: { state: "unpaid", outstandingPaise: 100_000 } });

    const rows = await db.select().from(allocations);
    expect(rows).toHaveLength(2); // the apply row SURVIVES — the ledger is append-only
    const mirror = rows.find((r) => r.kind === "reverse");
    expect(mirror).toMatchObject({
      id: reversed.reversalId, reversalOfId: applied.allocationId, receiptId: advance.receiptId,
      invoiceId: dues.invoiceId, amountPaise: 100_000, reason: "posted to the wrong bill",
    });

    const reversals = await eventsNamed("allocation.reversed");
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.correlationId).toBe(dues.invoiceId);
    expect(reversals[0]!.payload).toMatchObject({
      allocationId: applied.allocationId, receiptId: advance.receiptId, invoiceId: dues.invoiceId,
      amountPaise: 100_000, reason: "posted to the wrong bill",
    });
  });

  test("an allocation can only be reversed once, and an allocation that never existed is the same refusal", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-double-reverse");
    const patientId = await mkTestPatient();

    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 100_000 }] }, NOW);
    const applied = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: dues.invoiceId, amountPaise: 100_000 }, NOW,
    );
    await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId }, NOW);

    await expect(
      reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId }, NOW),
    ).rejects.toMatchObject({ code: "allocation_reversed_already", detail: { allocationId: applied.allocationId } });
    await expect(
      reverseAllocation(db, cashier.actor, { allocationId: newId() }, NOW),
    ).rejects.toMatchObject({ code: "allocation_reversed_already", detail: { found: false } });

    expect((await countRows()).allocations).toBe(2);
  });

  test("markEnteredInError reverses the receipt's live allocations IN THE SAME transaction, and a second mark is refused", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-eie");
    const patientId = await mkTestPatient();

    const first = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const second = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 100_000 }] }, NOW);
    const toFirst = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: first.invoiceId, amountPaise: 60_000 }, NOW,
    );
    const toSecond = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: second.invoiceId, amountPaise: 40_000 }, NOW,
    );

    const marked = await markEnteredInError(db, cashier.actor, { receiptId: advance.receiptId, reason: "cash was never handed over" }, NOW);
    expect(marked.reversedAllocationIds).toEqual([toFirst.allocationId, toSecond.allocationId]);

    // Both reversals and the mark are one atomic act: 2 applies + 2 reverses, one mark row.
    expect(await countRows()).toMatchObject({ allocations: 4, marks: 1 });
    const mark = (await db.select().from(enteredInErrorMarks))[0];
    expect(mark).toMatchObject({ docType: "receipt", docId: advance.receiptId, reason: "cash was never handed over", markedBy: cashier.id });
    expect(await eventsNamed("allocation.reversed")).toHaveLength(2);
    const eie = await eventsNamed("document.entered_in_error");
    expect(eie).toHaveLength(1);
    expect(eie[0]!.payload).toMatchObject({ docType: "receipt", docId: advance.receiptId, reason: "cash was never handed over" });

    await expect(
      markEnteredInError(db, cashier.actor, { receiptId: advance.receiptId, reason: "again" }, NOW),
    ).rejects.toMatchObject({ code: "eie_already_marked" });
    expect(await countRows()).toMatchObject({ allocations: 4, marks: 1 });
  });

  test("an entered-in-error receipt's money leaves BOTH the advance balance and the settlement it was paying", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-eie-readers");
    const patientId = await mkTestPatient();

    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 150_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: dues.invoiceId, amountPaise: 100_000 }, NOW);

    // BEFORE: 150000 taken, 100000 of it spoken for -> 50000 banked, and the bill reads settled.
    expect(await advanceOf(db, patientId)).toBe(50_000);
    expect(await invoiceSettlement(db, dues.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await listDues(db, cashier.actor, { patientId })).toHaveLength(0);

    await markEnteredInError(db, cashier.actor, { receiptId: advance.receiptId, reason: "receipt raised against the wrong patient" }, NOW);

    // AFTER: the receipt is dead on BOTH sides — no banked advance, and the bill is a due again.
    expect(await advanceOf(db, patientId)).toBe(0);
    expect(await invoiceSettlement(db, dues.invoiceId)).toEqual({ state: "unpaid", outstandingPaise: 100_000 });
    expect((await listDues(db, cashier.actor, { patientId })).map((d) => d.outstandingPaise)).toEqual([100_000]);
    expect(await patientBalance(db, cashier.actor, patientId)).toMatchObject({ advancePaise: 0, outstandingPaise: 100_000 });
  });

  // ===========================================================================================
  // The entered-in-error / advance-refund invariant: a mark may never drive the advance negative
  // ===========================================================================================

  test("an entered-in-error mark that would strand an advance refund is REFUSED, and the patient's next advance still reads in full", async () => {
    const cashier = await cashierWithSession("cashier-eie-refunded");
    const manager = await mkBillingManager(db, "manager-eie-refunded");
    const patientId = await mkTestPatient();

    // 10000p banked, then the WHOLE 10000 handed back on an approved advance-refund voucher.
    // `advanceRefundedPaise` is PER-PATIENT and names no receipt, so the balance is correctly 0
    // and NOTHING links the voucher to the receipt that funded it.
    const banked = await bankCashAdvance(cashier, patientId, 10_000);
    await refundWholeAdvance(cashier, manager, patientId, 10_000);
    expect(await advanceOf(db, patientId)).toBe(0);

    // Marking the receipt now would drop its 10000 out of the live set while the voucher's
    // subtraction stands, leaving a -10000 advance. The mark is refused instead: the money HAS
    // been returned, the receipt is already economically neutralised, and voiding it as well would
    // double-count. No cascade cancels the voucher — paid cash cannot be un-paid.
    const refusal = await codeOf(
      markEnteredInError(db, cashier.actor, { receiptId: banked.receiptId, reason: "cash was never handed over" }, NOW),
    );
    expect(refusal).toMatchObject({
      code: "eie_advance_refunded",
      detail: { receiptId: banked.receiptId, wouldBeAdvancePaise: -10_000, refundedPaise: 10_000 },
    });
    expect(await countRows()).toMatchObject({ receipts: 1, marks: 0 }); // the refusal wrote nothing
    expect(await advanceOf(db, patientId)).toBe(0);

    // THE HARM, ASSERTED. The patient's NEXT, unrelated advance must read back at its FULL value.
    // Against shipped code the mark succeeded and this read 90_000 — the hospital silently kept
    // 10000p of a patient's money with no document naming it.
    await bankCashAdvance(cashier, patientId, 100_000);
    expect(await advanceOf(db, patientId)).toBe(100_000);
    expect(await patientBalance(db, cashier.actor, patientId)).toMatchObject({ advancePaise: 100_000 });
  });

  test("race — a mark and an advance refund on ONE patient, and two marks on one patient: exactly one wins and the advance never goes negative (measured 5x isolated, cold start every run)", async () => {
    const RUNS = 5;
    let cleanRuns = 0;
    for (let i = 0; i < RUNS; i++) {
      await resetToSeededBase();
      const cashier = await cashierWithSession(`cashier-eie-race-${String(i)}`);
      const manager = await mkBillingManager(db, `manager-eie-race-${String(i)}`);

      // LEG A — markEnteredInError against an advance-refund voucher issue, same patient.
      // Both serialize on the SINGLE ordered patient-wide receipt lock
      // (`select id from receipts where patient_id = $1 order by id for update`, mode FOR UPDATE),
      // which the mark now takes and T8's advance lane already took.
      const legA = await mkTestPatient();
      const bankedA = await bankCashAdvance(cashier, legA, 10_000);
      const approvalA = await grantedAdvanceRefundApproval({
        patientId: legA, amountPaise: 10_000, requester: cashier.actor, approver: manager.actor,
      });
      const raced = await Promise.allSettled([
        markEnteredInError(db, cashier.actor, { receiptId: bankedA.receiptId, reason: "cash was never handed over" }, NOW),
        issueRefundVoucher(db, cashier.actor, {
          kind: "advance_refund", patientId: legA, amountPaise: 10_000, reasonClass: "genuine",
          reason: "balance returned", approvalId: approvalA, method: "cash",
        }, NOW),
      ]);
      expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lostA = raced.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      expect(lostA).toBeDefined();
      // BOTH commit orders are correct and the loser names which one happened:
      //   · refund first -> the mark would leave -10000  -> eie_advance_refunded
      //   · mark first   -> the receipt is dead, advance 0 -> refund_exceeds_advance
      expect(["eie_advance_refunded", "refund_exceeds_advance"]).toContain(lostA!.reason.code);
      expect(await advanceOf(db, legA)).toBe(0);

      // LEG B — TWO concurrent marks on TWO receipts of one patient, against one outstanding
      // voucher. This is the leg where the patient-wide lock is the SOLE defence: each mark's own
      // `lockReceipt` takes a DIFFERENT row, so without the patient-wide lock nothing makes the
      // two transactions wait for one another and both read a would-be advance of 0.
      const legB = await mkTestPatient("Two Receipt Patient");
      const first = await bankCashAdvance(cashier, legB, 10_000);
      const second = await bankCashAdvance(cashier, legB, 10_000);
      await refundWholeAdvance(cashier, manager, legB, 10_000);
      expect(await advanceOf(db, legB)).toBe(10_000);

      const marks = await Promise.allSettled([
        markEnteredInError(db, cashier.actor, { receiptId: first.receiptId, reason: "keyed twice" }, NOW),
        markEnteredInError(db, cashier.actor, { receiptId: second.receiptId, reason: "keyed twice" }, NOW),
      ]);
      expect(marks.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lostB = marks.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      expect(lostB).toBeDefined();
      expect(lostB!.reason.code).toBe("eie_advance_refunded");
      expect(await advanceOf(db, legB)).toBe(0);
      // No cascade cancelled the voucher: a paid-out refund is cash that left the drawer.
      expect(await db.select().from(refundVouchers).where(eq(refundVouchers.patientId, legB))).toHaveLength(1);

      cleanRuns++;
    }
    expect(cleanRuns).toBe(RUNS);
  });

  test("race, the lock leg — the ordered patient-wide receipt FOR UPDATE is REAL: the mark is still pending while an outside session holds a DIFFERENT receipt of the same patient", async () => {
    const cashier = await cashierWithSession("cashier-eie-lock");
    const patientId = await mkTestPatient();
    const held = await bankCashAdvance(cashier, patientId, 10_000);
    const target = await bankCashAdvance(cashier, patientId, 10_000);

    // §3.28/§3.39: the observation point sits OUTSIDE the target's own write path, and the LOCK
    // MODE is load-bearing.
    //   · The outside holder takes FOR NO KEY UPDATE on ONE receipt of this patient — the one the
    //     mark does NOT target. That mode conflicts with FOR UPDATE and NOT with FOR KEY SHARE,
    //     the mode an FK check would take.
    //   · `markEnteredInError`'s other locks cannot produce this wait: its ordered invoice
    //     statement touches `invoices` only (and `target` carries no allocation, so that set is
    //     empty), and `lockReceipt` takes FOR UPDATE on `target` — a DIFFERENT row from the one
    //     held here. `entered_in_error_marks` carries NO foreign key to `receipts` (`doc_id` is
    //     plain text), so its INSERT takes no implicit FOR KEY SHARE on any receipt row; nothing
    //     is appended to `allocations` because there is no allocation to reverse; `appendEvent`
    //     writes `events`; the advance reads are plain SELECTs and never wait.
    //   · So the ONLY lock in the implementation that can wait on this hold is the single ordered
    //     `select id from receipts where patient_id = $1 order by id for update` itself.
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from receipts where id = $1 for no key update", [held.receiptId]);

      const p = markEnteredInError(db, cashier.actor, { receiptId: target.receiptId, reason: "cash was never handed over" }, NOW);
      p.catch(() => {}); // no unhandled rejection while unobserved
      const state = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      expect(state).toBe("pending");

      await holder.query("commit");
      const done = await p;
      expect(done.reversedAllocationIds).toEqual([]);
    } finally {
      holder.release();
    }
    expect(await countRows()).toMatchObject({ receipts: 2, marks: 1 });
    expect(await advanceOf(db, patientId)).toBe(10_000);
  });

  // ===========================================================================================
  // The SECOND door into the same invariant: an ALLOCATION may never drive the advance negative
  //
  // `markEnteredInError` above takes the receipt's money OUT of the live set while the voucher's
  // subtraction stands. `allocateReceipt` reaches the identical state from the other side: it adds
  // to the effective-allocations term, which subtracts from the same balance. Both shipped
  // `over_allocation` guards pass in the fixture below — the ask fits the invoice's outstanding and
  // fits the receipt's unspent remainder — because neither of them knows a voucher exists.
  // ===========================================================================================

  test("an allocation that would spend an advance a voucher already refunded is REFUSED, and the patient's next advance still reads in full", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-alloc-refunded");
    const manager = await mkBillingManager(db, "manager-alloc-refunded");
    const patientId = await mkTestPatient();

    // 50000p banked, then the WHOLE 50000 handed back on an approved advance-refund voucher.
    // `advanceRefundedPaise` is PER-PATIENT and names no receipt, so the balance is correctly 0 and
    // NOTHING links the voucher to the receipt that funded it.
    const banked = await bankCashAdvance(cashier, patientId, 50_000);
    await refundWholeAdvance(cashier, manager, patientId, 50_000);
    expect(await advanceOf(db, patientId)).toBe(0);

    // A 100000p dues bill, so BOTH shipped guards wave the ask through: 50000 <= the invoice's
    // 100000 outstanding, and 50000 <= the 50000 still unallocated on the receipt.
    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    expect(dues.totals.netPayablePaise).toBe(100_000);

    const refusal = await codeOf(
      allocateReceipt(db, cashier.actor, { receiptId: banked.receiptId, invoiceId: dues.invoiceId, amountPaise: 50_000 }, NOW),
    );
    expect(refusal).toMatchObject({
      code: "allocation_exceeds_advance",
      detail: { askedPaise: 50_000, wouldBeAdvancePaise: -50_000, refundedPaise: 50_000 },
    });
    // A DISCRIMINATING signal: the two over-allocation guards and this one are different
    // mechanisms, and a caller that cannot tell them apart cannot tell the cashier what to do.
    expect(refusal.code).not.toBe("over_allocation");
    expect((await countRows()).allocations).toBe(0); // the refusal wrote nothing
    expect(await invoiceSettlement(db, dues.invoiceId)).toEqual({ state: "unpaid", outstandingPaise: 100_000 });
    expect(await advanceOf(db, patientId)).toBe(0);

    // THE HARM, ASSERTED. The patient's NEXT, unrelated advance must read back at its FULL value.
    // Against shipped code the allocation succeeded, `advanceOf` went to -50000, and this read
    // 50_000 — the hospital silently kept 50000p of a patient's money with no document naming it,
    // over the same `GET /billing/patients/:patientId/balance` the counter screen polls.
    await bankCashAdvance(cashier, patientId, 100_000);
    expect(await advanceOf(db, patientId)).toBe(100_000);
    expect(await patientBalance(db, cashier.actor, patientId)).toMatchObject({ advancePaise: 100_000 });
  });

  test("the advance guard is NOT over-broad: an unrefunded advance still clears a bill in full, a partly refunded one clears what is left, and the issue-with-receipt path is untouched", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-alloc-legit");
    const manager = await mkBillingManager(db, "manager-alloc-legit");

    // (a) NO voucher anywhere — the ordinary counter act. The whole advance still spends.
    const plainId = await mkTestPatient("Plain Advance Patient");
    const plain = await bankCashAdvance(cashier, plainId, 50_000);
    const plainDues = await issueDuesInvoice(db, cashier, { patientId: plainId, serviceId: base.consultNewServiceId, qty: 1 });
    const applied = await allocateReceipt(
      db, cashier.actor, { receiptId: plain.receiptId, invoiceId: plainDues.invoiceId, amountPaise: 50_000 }, NOW,
    );
    expect(applied.settlement).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await advanceOf(db, plainId)).toBe(0);
    expect((await countRows()).allocations).toBe(1);

    // (b) A voucher the REMAINING money covers is not the defect either: 100000 banked, 40000
    // returned -> 60000 of real money left, and every paisa of it still clears a bill. The guard
    // bites at 60001, not at 60000 — it is a balance check, not a "has this patient a voucher"
    // check.
    const partId = await mkTestPatient("Part Refunded Patient");
    const part = await bankCashAdvance(cashier, partId, 100_000);
    const approvalId = await grantedAdvanceRefundApproval({
      patientId: partId, amountPaise: 40_000, requester: cashier.actor, approver: manager.actor,
    });
    await issueRefundVoucher(
      db, cashier.actor,
      {
        kind: "advance_refund", patientId: partId, amountPaise: 40_000, reasonClass: "genuine",
        reason: "the patient wanted part of the balance back", approvalId, method: "cash",
      },
      NOW,
    );
    expect(await advanceOf(db, partId)).toBe(60_000);
    const partDues = await issueDuesInvoice(db, cashier, { patientId: partId, serviceId: base.consultNewServiceId, qty: 2 });
    const overAsk = await codeOf(
      allocateReceipt(db, cashier.actor, { receiptId: part.receiptId, invoiceId: partDues.invoiceId, amountPaise: 60_001 }, NOW),
    );
    expect(overAsk).toMatchObject({
      code: "allocation_exceeds_advance",
      detail: { askedPaise: 60_001, wouldBeAdvancePaise: -1, refundedPaise: 40_000 },
    });
    const partApplied = await allocateReceipt(
      db, cashier.actor, { receiptId: part.receiptId, invoiceId: partDues.invoiceId, amountPaise: 60_000 }, NOW,
    );
    expect(partApplied.settlement).toEqual({ state: "partial", outstandingPaise: 40_000 });
    expect(await advanceOf(db, partId)).toBe(0);

    // (c) THE ISSUE-WITH-RECEIPT PATH IS UNTOUCHED (`issueInvoice`, invoices.ts — deliberately NOT
    // modified). It allocates a receipt it creates in the SAME transaction and caps the allocation
    // at that receipt's own total, so its net effect on the advance is `total - allocated >= 0`: it
    // can only RAISE the balance and can never strand a voucher. Asserted here on the hardest
    // patient for it — one whose advance a voucher has already emptied to zero.
    const issueId = await mkTestPatient("Issue With Receipt Patient");
    const emptied = await bankCashAdvance(cashier, issueId, 50_000);
    await refundWholeAdvance(cashier, manager, issueId, 50_000);
    expect(await advanceOf(db, issueId)).toBe(0);
    const paid = await issuePaidInvoice(db, cashier, { patientId: issueId, serviceId: base.consultNewServiceId });
    expect(paid.totals.netPayablePaise).toBe(50_000);
    expect(await invoiceSettlement(db, paid.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await advanceOf(db, issueId)).toBe(0); // still 0 — never negative, never absorbed
    expect(paid.receiptId).not.toBe(emptied.receiptId);
  });

  test("race — an allocation against an advance refund, and two allocations on two receipts of one patient: exactly one wins and the advance never goes negative (measured 5x isolated, cold start every run)", async () => {
    const RUNS = 5;
    let cleanRuns = 0;
    for (let i = 0; i < RUNS; i++) {
      await resetToSeededBase();
      await grantCreditExtend(db);
      const cashier = await cashierWithSession(`cashier-alloc-race-${String(i)}`);
      const manager = await mkBillingManager(db, `manager-alloc-race-${String(i)}`);

      // LEG A — allocateReceipt against an advance-refund voucher issue, SAME patient, SAME
      // receipt. Both serialize on receipt rows taken FOR UPDATE: T8's lane takes the whole
      // patient-wide ordered set, and `allocateReceipt` now takes that same set (its own
      // single-row `lockReceipt` would already have intersected it, because the target receipt is
      // inside the refund lane's set — this leg therefore measures the RECEIPT lock, not
      // specifically the patient-wide statement; leg B is the one that isolates that).
      const legA = await mkTestPatient();
      const bankedA = await bankCashAdvance(cashier, legA, 50_000);
      const duesA = await issueDuesInvoice(db, cashier, { patientId: legA, serviceId: base.consultNewServiceId, qty: 2 });
      const approvalA = await grantedAdvanceRefundApproval({
        patientId: legA, amountPaise: 50_000, requester: cashier.actor, approver: manager.actor,
      });
      const raced = await Promise.allSettled([
        allocateReceipt(db, cashier.actor, { receiptId: bankedA.receiptId, invoiceId: duesA.invoiceId, amountPaise: 50_000 }, NOW),
        issueRefundVoucher(db, cashier.actor, {
          kind: "advance_refund", patientId: legA, amountPaise: 50_000, reasonClass: "genuine",
          reason: "balance returned", approvalId: approvalA, method: "cash",
        }, NOW),
      ]);
      expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lostA = raced.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      expect(lostA).toBeDefined();
      // BOTH commit orders are correct and the loser names which one happened:
      //   · refund first     -> the allocation would leave -50000 -> allocation_exceeds_advance
      //   · allocation first -> the advance is 0, nothing to refund -> refund_exceeds_advance
      expect(["allocation_exceeds_advance", "refund_exceeds_advance"]).toContain(lostA!.reason.code);
      expect(await advanceOf(db, legA)).toBe(0);

      // LEG B — TWO concurrent allocations spending TWO DIFFERENT receipts of one patient onto TWO
      // DIFFERENT invoices, against one outstanding voucher. This is the leg where the ordered
      // patient-wide receipt lock is the SOLE defence: the two invoice locks are different rows and
      // each allocation's own `lockReceipt` takes a different row, so without the patient-wide
      // statement nothing makes the two transactions wait, both read an advance of 50000, both
      // compute a would-be advance of 0, and the pair lands the balance at -50000.
      const legB = await mkTestPatient("Two Receipt Patient");
      const firstReceipt = await bankCashAdvance(cashier, legB, 50_000);
      const secondReceipt = await bankCashAdvance(cashier, legB, 50_000);
      await refundWholeAdvance(cashier, manager, legB, 50_000);
      expect(await advanceOf(db, legB)).toBe(50_000);
      const firstDues = await issueDuesInvoice(db, cashier, { patientId: legB, serviceId: base.consultNewServiceId, qty: 1 });
      const secondDues = await issueDuesInvoice(db, cashier, { patientId: legB, serviceId: base.consultNewServiceId, qty: 1 });

      const spends = await Promise.allSettled([
        allocateReceipt(db, cashier.actor, { receiptId: firstReceipt.receiptId, invoiceId: firstDues.invoiceId, amountPaise: 50_000 }, NOW),
        allocateReceipt(db, cashier.actor, { receiptId: secondReceipt.receiptId, invoiceId: secondDues.invoiceId, amountPaise: 50_000 }, NOW),
      ]);
      expect(spends.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lostB = spends.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      expect(lostB).toBeDefined();
      expect(lostB!.reason.code).toBe("allocation_exceeds_advance");
      expect(await advanceOf(db, legB)).toBe(0);
      // No cascade cancelled the voucher: a paid-out refund is cash that left the drawer.
      expect(await db.select().from(refundVouchers).where(eq(refundVouchers.patientId, legB))).toHaveLength(1);

      cleanRuns++;
    }
    expect(cleanRuns).toBe(RUNS);
  });

  test("race, the lock leg — the ordered patient-wide receipt FOR UPDATE is REAL in allocateReceipt: it is still pending while an outside session holds a DIFFERENT receipt of the same patient", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-alloc-lock");
    const patientId = await mkTestPatient();
    const held = await bankCashAdvance(cashier, patientId, 50_000);
    const target = await bankCashAdvance(cashier, patientId, 50_000);
    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });

    // §3.28/§3.39: the observation point sits OUTSIDE the target's own write path, and the LOCK
    // MODE is load-bearing.
    //   · The outside holder takes FOR NO KEY UPDATE on ONE receipt of this patient — the one the
    //     allocation does NOT spend. That mode conflicts with FOR UPDATE and NOT with FOR KEY
    //     SHARE, the mode an FK check would take.
    //   · `allocateReceipt`'s other locks cannot produce this wait: `lockInvoice` takes FOR UPDATE
    //     on an `invoices` row nobody holds; `lockReceipt` takes FOR UPDATE on `target`, a
    //     DIFFERENT row from the one held here; the INSERT into `allocations` takes the implicit
    //     FOR KEY SHARE of its two foreign keys on that same invoice row and on `target`, never on
    //     `held`, and FOR KEY SHARE does not conflict with FOR NO KEY UPDATE in any case;
    //     `appendEvent` writes `events`; the advance and settlement reads are plain SELECTs and
    //     never wait.
    //   · So the ONLY lock in the implementation that can wait on this hold is the single ordered
    //     `select id from receipts where patient_id = $1 order by id for update` itself.
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from receipts where id = $1 for no key update", [held.receiptId]);

      const p = allocateReceipt(
        db, cashier.actor, { receiptId: target.receiptId, invoiceId: dues.invoiceId, amountPaise: 50_000 }, NOW,
      );
      p.catch(() => {}); // no unhandled rejection while unobserved
      const state = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      expect(state).toBe("pending");

      await holder.query("commit");
      const done = await p;
      expect(done.settlement).toEqual({ state: "partial", outstandingPaise: 50_000 });
    } finally {
      holder.release();
    }
    expect((await countRows()).allocations).toBe(1);
    expect(await advanceOf(db, patientId)).toBe(50_000);
  });
});
