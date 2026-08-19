import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issueDuesInvoice, issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { allocations, invoices, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { invoiceSettlement, outstandingOf } from "./invoices";
import { advanceOf, allocateReceipt, listDues, markEnteredInError, recordReceipt, reverseAllocation } from "./receipts";
import type { Pool } from "pg";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T6, D1 — the ledger's CONCURRENCY core: what stops two counters overpaying one invoice,
 * or spending one receipt twice, and what the append-only reversal actually restores.
 *
 * The fixture is T5's (`seedBillingBase`): OPD-CONSULT-NEW is EXEMPT and priced 50000 paise, so
 * every invoice below is exactly qty · 50000 with no GST and no §170 rounding, and the numbers on
 * screen are about ALLOCATION rather than pricing. billing_config: creditCap 500_000 (every
 * remainder here is far below it, so no approval is ever involved) · outstandingCap 2_000_000 mode
 * "warn".
 *
 * DISCLOSED SHAPING (the last test only): two `invoices` rows are inserted DIRECTLY so that their
 * ids and their arrival order disagree by construction. Nothing else in this file shapes a row.
 */
describe("allocations: the ledger's serialization and reversal (D1)", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

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
    await grantCreditExtend(db);
  });

  async function mkTestPatient(name = "Ledger Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "ledger-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 35 }));
    return patient.id;
  }

  async function cashierWithSession(username: string): Promise<{ id: string; actor: Actor }> {
    const cashier = await mkCashier(db, username);
    await openSessionFor(db, cashier, 100_000);
    return cashier;
  }

  const advanceFor = async (
    cashier: { actor: Actor }, patientId: string, amountPaise: number,
  ): Promise<{ receiptId: string }> =>
    recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise }] }, NOW);

  test("race 1 — two concurrent allocations against ONE invoice: exactly one over_allocation, and the invoice is never overpaid", async () => {
    const cashier = await cashierWithSession("cashier-race1");
    const patientId = await mkTestPatient();

    // OPD-CONSULT-NEW qty 1 is EXEMPT: netPayable 50000. A 40000 cash receipt at issue leaves
    // outstanding 10000 through D2's credit lane (10000 << creditCap 500000, no approval).
    const invoice = await issueDuesInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, receiptPaise: 40_000,
    });
    expect(await outstandingOf(db, invoice.invoiceId)).toBe(10_000);

    // TWO receipts, one per racer. A single shared receipt would serialize on the RECEIPT row and
    // the invoice lock — the thing this race exists to measure — would never be reached.
    const a = await advanceFor(cashier, patientId, 6_000);
    const b = await advanceFor(cashier, patientId, 6_000);

    // 6000 + 6000 = 12000 against 10000 outstanding: the ledger must refuse exactly one.
    const results = await Promise.allSettled([
      allocateReceipt(db, cashier.actor, { receiptId: a.receiptId, invoiceId: invoice.invoiceId, amountPaise: 6_000 }, NOW),
      allocateReceipt(db, cashier.actor, { receiptId: b.receiptId, invoiceId: invoice.invoiceId, amountPaise: 6_000 }, NOW),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(loser).toBeDefined();
    expect(loser!.reason.code).toBe("over_allocation");

    // 40000 taken at issue + exactly one 6000 clearance = 46000 of a 50000 bill.
    expect(await outstandingOf(db, invoice.invoiceId)).toBe(4_000);
    const applied = await db.select().from(allocations).where(eq(allocations.invoiceId, invoice.invoiceId));
    expect(applied).toHaveLength(2);
    expect(applied.reduce((sum, row) => sum + row.amountPaise, 0)).toBe(46_000);
  });

  test("race 1, the lock leg — the invoice-row FOR UPDATE is REAL: an allocation is still pending while an outside session holds that row", async () => {
    const cashier = await cashierWithSession("cashier-lock");
    const patientId = await mkTestPatient();
    const invoice = await issueDuesInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, receiptPaise: 40_000,
    });
    const advance = await advanceFor(cashier, patientId, 5_000);

    // §3.28: the observation point must be OUTSIDE the target's own write path, or the mechanism
    // and ordinary row locking are indistinguishable. The held row is the INVOICE, and the LOCK
    // MODE is what puts it outside that path:
    //   · `allocateReceipt` inserts into `allocations`, which carries a real FK to `invoices.id`.
    //     Postgres takes FOR KEY SHARE on the referenced row for that insert — in EVERY
    //     implementation, serializer or none.
    //   · FOR KEY SHARE conflicts with FOR UPDATE and with nothing else. So holding the invoice row
    //     FOR UPDATE here would block the FK check too, and an allocation with no serializer at all
    //     would look exactly as "pending" as the shipped one — the trap §3.28 names.
    //   · FOR NO KEY UPDATE conflicts with FOR SHARE / FOR NO KEY UPDATE / FOR UPDATE, and NOT with
    //     FOR KEY SHARE. It therefore blocks the serializer's `... for update` and passes the FK
    //     check untouched: the ONLY lock in `allocateReceipt` that can wait on this hold is the
    //     invoice `FOR UPDATE` itself. The receipt row is not held and the FK on `receipts` is a
    //     different row entirely.
    // Measured against mutant M-A1 (the invoice FOR UPDATE dropped), which settles immediately here.
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from invoices where id = $1 for no key update", [invoice.invoiceId]);

      const p = allocateReceipt(
        db, cashier.actor, { receiptId: advance.receiptId, invoiceId: invoice.invoiceId, amountPaise: 5_000 }, NOW,
      );
      p.catch(() => {}); // no unhandled rejection while unobserved
      const state = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      expect(state).toBe("pending");

      await holder.query("commit");
      const done = await p;
      expect(done.settlement).toEqual({ state: "partial", outstandingPaise: 5_000 });
    } finally {
      holder.release();
    }
    expect(await outstandingOf(db, invoice.invoiceId)).toBe(5_000);
  });

  test("race 2 — two concurrent allocations draining ONE receipt: exactly one over_allocation (the receipt-side serializer)", async () => {
    const cashier = await cashierWithSession("cashier-race2");
    const patientId = await mkTestPatient();

    // Two DIFFERENT invoices, so the invoice locks never contend — only the shared receipt row can
    // serialize these two, and its remainder (6000) covers exactly one of the two 6000 asks.
    const first = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const second = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await advanceFor(cashier, patientId, 6_000);

    const results = await Promise.allSettled([
      allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: first.invoiceId, amountPaise: 6_000 }, NOW),
      allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: second.invoiceId, amountPaise: 6_000 }, NOW),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(loser).toBeDefined();
    expect(loser!.reason.code).toBe("over_allocation");
    expect(loser!.reason.detail).toMatchObject({ askedPaise: 6_000, remainingPaise: 0 });

    expect(await db.select().from(allocations)).toHaveLength(1);
    expect(await advanceOf(db, patientId)).toBe(0);
  });

  test("three partial allocations exhaust the invoice: the derived state walks unpaid to partial to settled", async () => {
    const cashier = await cashierWithSession("cashier-cumulative");
    const patientId = await mkTestPatient();

    const invoice = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await advanceFor(cashier, patientId, 100_000);
    expect(await invoiceSettlement(db, invoice.invoiceId)).toEqual({ state: "unpaid", outstandingPaise: 100_000 });

    const allocate = (amountPaise: number) =>
      allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: invoice.invoiceId, amountPaise }, NOW);

    expect((await allocate(30_000)).settlement).toEqual({ state: "partial", outstandingPaise: 70_000 });
    expect((await allocate(30_000)).settlement).toEqual({ state: "partial", outstandingPaise: 40_000 });
    expect((await allocate(40_000)).settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    expect(await invoiceSettlement(db, invoice.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await db.select().from(allocations)).toHaveLength(3);
    expect(await advanceOf(db, patientId)).toBe(0);
  });

  test("a reversal restores the receipt's advance balance", async () => {
    const cashier = await cashierWithSession("cashier-reverse-advance");
    const patientId = await mkTestPatient();

    const invoice = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await advanceFor(cashier, patientId, 100_000);
    const applied = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: invoice.invoiceId, amountPaise: 80_000 }, NOW,
    );
    expect(await advanceOf(db, patientId)).toBe(20_000);

    await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId, reason: "wrong bill" }, NOW);
    expect(await advanceOf(db, patientId)).toBe(100_000);
  });

  test("a reversal frees the invoice's capacity: the freed amount can be allocated again (effective = apply minus reverse)", async () => {
    const cashier = await cashierWithSession("cashier-reverse-capacity");
    const patientId = await mkTestPatient();

    const invoice = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await advanceFor(cashier, patientId, 100_000);
    const applied = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: invoice.invoiceId, amountPaise: 100_000 }, NOW,
    );
    expect(await invoiceSettlement(db, invoice.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });

    await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId }, NOW);
    expect(await invoiceSettlement(db, invoice.invoiceId)).toEqual({ state: "unpaid", outstandingPaise: 100_000 });

    // Both guards read the EFFECTIVE sum, so the same money clears the same bill a second time:
    // the invoice has its 100000 of room back and the receipt has its 100000 unspent again.
    const again = await allocateReceipt(
      db, cashier.actor, { receiptId: advance.receiptId, invoiceId: invoice.invoiceId, amountPaise: 100_000 }, NOW,
    );
    expect(again.settlement).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await db.select().from(allocations)).toHaveLength(3); // apply, reverse, apply
    expect(await advanceOf(db, patientId)).toBe(0);
  });

  test("an entered-in-error receipt can no longer be allocated", async () => {
    const cashier = await cashierWithSession("cashier-eie-alloc");
    const patientId = await mkTestPatient();

    const invoice = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    const advance = await advanceFor(cashier, patientId, 100_000);
    await markEnteredInError(db, cashier.actor, { receiptId: advance.receiptId, reason: "money was never taken" }, NOW);

    await expect(
      allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: invoice.invoiceId, amountPaise: 10_000 }, NOW),
    ).rejects.toMatchObject({ code: "unknown_receipt", detail: { enteredInError: true } });
    expect(await db.select().from(allocations)).toHaveLength(0);
  });

  test("a settled invoice has nothing outstanding to allocate against: over_allocation at zero", async () => {
    const cashier = await cashierWithSession("cashier-settled-alloc");
    const patientId = await mkTestPatient();

    const paid = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId });
    expect(await invoiceSettlement(db, paid.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });
    const advance = await advanceFor(cashier, patientId, 10_000);

    await expect(
      allocateReceipt(db, cashier.actor, { receiptId: advance.receiptId, invoiceId: paid.invoiceId, amountPaise: 1 }, NOW),
    ).rejects.toMatchObject({ code: "over_allocation", detail: { askedPaise: 1, outstandingPaise: 0 } });
    expect(await advanceOf(db, patientId)).toBe(10_000);
  });

  test("the dues worklist is ordered by seq and NEVER by id — proven on a fixture whose two orders disagree", async () => {
    const cashier = await cashierWithSession("cashier-seq");
    const patientId = await mkTestPatient();

    // `newId()` is a ULID: 80 bits of fresh randomness per millisecond, so within one millisecond
    // `id DESC` is a total order but NOT insertion order (§3.26). A fixture built from real issues
    // could therefore come out AGREEING by luck and prove nothing, so these two ids are chosen to
    // disagree with certainty: the row inserted FIRST (lower `seq`) carries the lexically GREATER
    // id, and the row inserted SECOND carries the lexically SMALLER one.
    const firstIssuedId = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    const secondIssuedId = "01AAAAAAAAAAAAAAAAAAAAAAAA";
    expect(firstIssuedId > secondIssuedId).toBe(true);

    const shapeDue = async (id: string, invoiceNo: string, netPayablePaise: number): Promise<void> => {
      await db.insert(invoices).values({
        id, invoiceNo, patientId, encounterId: null,
        tariffVersionId: base.tariffVersionId, intendedPayer: "self",
        buyerGstin: null, buyerLegalName: null,
        grossPaise: netPayablePaise, discountPaise: 0, taxableBasePaise: netPayablePaise,
        cgstPaise: 0, sgstPaise: 0, rawTotalPaise: netPayablePaise, roundingPaise: 0, netPayablePaise,
        creditExtended: true, creditReason: "shaped dues fixture", creditApprovalId: null,
        issuedBy: cashier.id, issuedAt: NOW, serviceDay: SERVICE_DAY,
      });
    };
    await shapeDue(firstIssuedId, "INV/26-27/900001", 10_000);
    await shapeDue(secondIssuedId, "INV/26-27/900002", 20_000);

    const dues = await listDues(db, cashier.actor, { patientId });
    expect(dues.map((d) => d.invoiceId)).toEqual([firstIssuedId, secondIssuedId]);
    expect(dues.map((d) => d.outstandingPaise)).toEqual([10_000, 20_000]);
    expect(dues[0]!.seq).toBeLessThan(dues[1]!.seq);
    // The disagreement is the point: an id-ordered read of the same two rows comes out reversed.
    expect([...dues].sort((x, y) => (x.invoiceId < y.invoiceId ? -1 : 1)).map((d) => d.invoiceId))
      .toEqual([secondIssuedId, firstIssuedId]);
  });
});
