import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issueDuesInvoice, issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { allocations, enteredInErrorMarks, events, receipts, receiptTenders, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { invoiceSettlement } from "./invoices";
import {
  advanceOf, allocateReceipt, listDues, markEnteredInError, patientBalance, recordReceipt, reverseAllocation,
} from "./receipts";
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
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  // The same fixed instant T5 uses: 2026-08-19T06:00:00Z + 5:30 = 11:30 IST -> IST day
  // "2026-08-19", fiscal year 2026-27 rendered "26-27", so the first receipt of a fresh database
  // is "RCP/26-27/000001".
  const NOW = new Date("2026-08-19T06:00:00Z");
  const SERVICE_DAY = "2026-08-19";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

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
});
