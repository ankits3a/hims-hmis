import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issueDuesInvoice, issuePaidInvoice, mkBillingManager, mkCashier, openSessionFor,
  seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import { dailyCloses, enteredInErrorMarks, events, opdEncounters, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import {
  activateVersion, createDraftVersion, createService, setTariffItem, submitVersion, taxHead, upsertGstCategory,
} from "../tariff";
import { dayBook, gstr1Summary, runDailyClose } from "./daily-close";
import { issueCreditNote } from "./credit-notes";
import { getInvoice, issueInvoice } from "./invoices";
import { markEnteredInError, recordReceipt } from "./receipts";
import { setDegraded } from "./recon";
import { issueRefundVoucher, payRefundVoucher, requestRefund } from "./refunds";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T10, D9 / §11.11 — the daily close: the claim, the day book, the charge-orphan scan and
 * the GSTR-1 summary.
 *
 * THE SEEDED FIXTURE (test/helpers/billing.ts `seedBillingBase`):
 *   · OPD-CONSULT-NEW / -RENEWAL, category "consultation", EXEMPT healthcare, 50000 paise each —
 *     `charge_rules.opdConsult`. GENERIC-SERVICE, category "pharmacy", TAXABLE 1200 bps, 50000.
 *   · billing_config: cash warn 15_000_000 / block 20_000_000 / PAN 5_000_000, refund bank floor
 *     1_000_000, credit cap 500_000.
 *
 * THE MONEY, from the shipped engine (modules/tariff/money.ts):
 *   divHalfUp(n, d) = floor((2n + d) / 2d) · taxHead(base, rateBps) = divHalfUp(base·rateBps, 20000)
 *   roundTotalToRupee(t) = divHalfUp(t, 100)·100    (§170, applied ONCE per document)
 *
 *   GENERIC-SERVICE qty 1: taxHead(50000, 1200) = floor((120,000,000 + 20,000)/40,000) = 3000 per
 *     head; raw 50000 + 3000 + 3000 = 56000; roundTotalToRupee(56000) = 56000 (rounding 0).
 *   A full credit note over that line credits the line's own stored money: base 50000, heads
 *     3000/3000, raw 56000, rounding 0, NET 56000.
 *
 * THE GSTR-1 FIXTURE IS b09 — the Book's, not a new one (T2 built it for exactly this row, K35).
 * Its discriminator: two pharmacy lines of base 18875 at 1200 bps carry heads of 1133 each, so the
 * merged GSTR-1 row's STORED head sum is 2266, while recomputing that row from its merged base
 * 37750 gives taxHead(37750, 1200) = 2265. One paise, one layer up from K18. The invoice is issued
 * through the REAL path against services priced to b09's own numbers, and every expectation below
 * is read out of `golden/fixtures/b09.json` rather than restated here.
 *
 * DISCLOSED SHAPING: `opd_encounters` rows are inserted directly (the T5/T8 precedent), and
 * `entered_in_error_marks` rows against INVOICES are inserted directly — `markEnteredInError` (T6)
 * covers receipts only, because an invoice's void is a `correction` credit note (D4), a different
 * act from the mark the orphan scan reads.
 */

const gstFixture = z.object({
  meta: z.object({ buyerGstin: z.string(), buyerLegalName: z.string() }),
  lines: z.array(z.object({
    serviceId: z.string(), unitPaise: z.number().int(), taxableBasePaise: z.number().int(),
    gst: z.object({ sacCode: z.string(), rateBps: z.number().int(), exempt: z.boolean(), cgstPaise: z.number().int(), sgstPaise: z.number().int() }),
    netPaise: z.number().int(),
  })).min(3),
  expected: z.object({
    grossPaise: z.number().int(), taxableBasePaise: z.number().int(),
    cgstPaise: z.number().int(), sgstPaise: z.number().int(),
    taxSummary: z.array(z.object({
      sacCode: z.string(), rateBps: z.number().int(), exempt: z.boolean(),
      taxableBasePaise: z.number().int(), cgstPaise: z.number().int(), sgstPaise: z.number().int(),
    })).min(2),
    rawTotalPaise: z.number().int(), netPayablePaise: z.number().int(), roundingPaise: z.number().int(),
  }),
});
const B09 = gstFixture.parse(
  JSON.parse(readFileSync(join(__dirname, "golden", "fixtures", "b09.json"), "utf8")),
);

describe("the daily close: claim, day book, orphan scan and GSTR-1 (D9, §11.11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };

  /** The instant every billing suite uses: 11:30 IST ⇒ IST day 2026-08-19, FY 26-27. */
  const NOW = new Date("2026-08-19T06:00:00Z");
  const DAY = "2026-08-19";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    cashier = await mkCashier(db, "close_cashier");
    await openSessionFor(db, cashier, 100_000);
  });

  async function mkTestPatient(name: string): Promise<string> {
    const actor: Actor = { type: "user", id: "close-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 45 }));
    return patient.id;
  }

  /** See the shaping disclosure in this file's header. */
  async function shapeEncounter(input: { patientId: string; visitType: string; serviceDate?: string }): Promise<string> {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, patientId: input.patientId, workflowInstanceId: newId(),
      serviceDate: input.serviceDate ?? DAY, visitType: input.visitType, status: "waiting",
      intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return id;
  }

  async function markInvoiceEnteredInError(invoiceId: string): Promise<void> {
    await db.insert(enteredInErrorMarks).values({
      id: newId(), docType: "invoice", docId: invoiceId, reason: "keyed against the wrong visit",
      markedBy: cashier.id, markedAt: NOW,
    });
  }

  const eventsNamed = (name: string) =>
    db.select({ payload: events.payload, encounterId: events.encounterId, patientId: events.patientId })
      .from(events).where(eq(events.name, name));

  /**
   * A second activated tariff version carrying b09's own prices: a pharmacy strip at 18875 and a
   * device at 33333 under a 500 bps / sac 9021 category. Built through the OWNING module's public
   * API (createService → draft copied from the base version → submit → approve → activate), never
   * by writing tariff tables, so the invoice below is priced by the real engine.
   */
  async function seedB09Tariff(): Promise<{ tabServiceId: string; devServiceId: string }> {
    const tab = await withTx(db, (tx) =>
      createService(tx, base.drafter, { code: "B09-TAB", name: "Paracetamol 500 strip", category: "pharmacy" }));
    const dev = await withTx(db, (tx) =>
      createService(tx, base.drafter, { code: "B09-DEV", name: "Orthopedic device", category: "device" }));
    await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, {
      category: "device", sacCode: "9021", exempt: false, rateBps: 500, specialRule: null, thresholdPaise: null,
    }));
    const draft = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, base.drafter, { copyFromVersionId: base.tariffVersionId });
      await setTariffItem(tx, base.drafter, d.versionId, tab.serviceId, 18_875);
      await setTariffItem(tx, base.drafter, d.versionId, dev.serviceId, 33_333);
      return d;
    });
    const submitted = await withTx(db, (tx) => submitVersion(tx, base.drafter, draft.versionId));
    await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "b09 fixture prices" });
    await activateVersion(db, base.activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
    return { tabServiceId: tab.serviceId, devServiceId: dev.serviceId };
  }

  // -------------------------------------------------------------------------------------------
  // The claim
  // -------------------------------------------------------------------------------------------

  it("the day claim is idempotent: a second run the same day emits NO second day.closed and NO duplicate flags", async () => {
    const patientId = await mkTestPatient("Orphan Patient");
    const encounterId = await shapeEncounter({ patientId, visitType: "new" });

    const first = await runDailyClose(db, DAY, NOW);
    expect(first.claimed).toBe(true);
    expect(first.orphans).toEqual([
      { encounterId, patientId, feeServiceId: base.consultNewServiceId },
    ]);
    expect(await eventsNamed("day.closed")).toHaveLength(1);
    expect(await eventsNamed("charge.orphan_flagged")).toHaveLength(1);

    const second = await runDailyClose(db, DAY, NOW);
    expect(second.claimed).toBe(false);
    // The ABSENCE assertion: the second run found the claim row taken and appended nothing at all.
    expect(await eventsNamed("day.closed")).toHaveLength(1);
    expect(await eventsNamed("charge.orphan_flagged")).toHaveLength(1);
    expect(await db.select().from(dailyCloses)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // The day book
  // -------------------------------------------------------------------------------------------

  it("the day book totals receipts by tender mode, and an entered-in-error receipt is not money", async () => {
    const payer = await mkTestPatient("Day Book Payer");
    const advancer = await mkTestPatient("Day Book Advancer");
    const voided = await mkTestPatient("Day Book Voided");

    await issuePaidInvoice(db, cashier, { patientId: payer, serviceId: base.genericServiceId }); // cash 56000
    await recordReceipt(db, cashier.actor, {
      patientId: advancer,
      tenders: [
        { mode: "cash", amountPaise: 10_000 },
        { mode: "upi", amountPaise: 20_000, refText: "UPI-REF-1" },
        { mode: "card", amountPaise: 30_000, refText: "CARD-REF-1" },
      ],
    }, NOW);
    const dead = await recordReceipt(db, cashier.actor, {
      patientId: voided, tenders: [{ mode: "cash", amountPaise: 5_000 }],
    }, NOW);
    await markEnteredInError(db, cashier.actor, { receiptId: dead.receiptId, reason: "keyed twice" }, NOW);

    // cash 56000 + 10000 = 66000 · upi 20000 · card 30000; the 5000 EIE'd receipt is excluded.
    expect(await dayBook(db, DAY)).toEqual({
      day: DAY,
      receipts: { count: 2, totalPaise: 116_000, byMode: { cash: 66_000, upi: 20_000, card: 30_000 } },
      degraded: { count: 0, totalPaise: 0 },
      invoices: { count: 1, netPayablePaise: 56_000 },
      creditNotes: { count: 0, netPaise: 0 },
      vouchersPaid: { count: 0, amountPaise: 0 },
    });
  });

  it("the day book carries credit notes, vouchers PAID and the degraded-tender breakout (E-24)", async () => {
    const manager = await mkBillingManager(db, "close_manager");
    const patientId = await mkTestPatient("Refunded Patient");

    const invoice = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.genericServiceId });
    const line = (await getInvoice(db, invoice.invoiceId))!.lines[0]!;
    const creditNote = await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: invoice.invoiceId, reason: "goods returned unused",
      lines: [{ invoiceLineId: line.id, qty: 1 }],
    }, NOW);
    expect(creditNote.netPaise).toBe(56_000);

    const asked = await requestRefund(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId: creditNote.creditNoteId, amountPaise: 56_000,
      reasonClass: "genuine", reason: "the strip was returned unopened",
    });
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "verified against the credit note" });
    const voucher = await issueRefundVoucher(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId: creditNote.creditNoteId, amountPaise: 56_000,
      reasonClass: "genuine", reason: "the strip was returned unopened",
      approvalId: asked.approvalId, method: "cash",
    }, NOW);
    await payRefundVoucher(db, cashier.actor, {
      voucherId: voucher.voucherId, payeeName: "Refunded Patient", payeeIdType: "aadhaar", payeeIdRef: "XXXX-1234",
    }, NOW);

    await setDegraded(db, cashier.actor, true, "the PSP terminal is offline", NOW);
    await recordReceipt(db, cashier.actor, {
      patientId, tenders: [{ mode: "cash", amountPaise: 7_000 }],
    }, NOW);

    expect(await dayBook(db, DAY)).toEqual({
      day: DAY,
      receipts: { count: 2, totalPaise: 63_000, byMode: { cash: 63_000, upi: 0, card: 0 } },
      degraded: { count: 1, totalPaise: 7_000 },
      invoices: { count: 1, netPayablePaise: 56_000 },
      creditNotes: { count: 1, netPaise: 56_000 },
      vouchersPaid: { count: 1, amountPaise: 56_000 },
    });
  });

  // -------------------------------------------------------------------------------------------
  // The orphan scan (§11.11)
  // -------------------------------------------------------------------------------------------

  it("the orphan scan flags an UNCHARGED visit and leaves a charged one alone — dues are charged, not orphaned", async () => {
    await grantCreditExtend(db);
    const uncharged = await mkTestPatient("Uncharged");
    const paid = await mkTestPatient("Paid");
    const dues = await mkTestPatient("Dues");

    const unchargedEnc = await shapeEncounter({ patientId: uncharged, visitType: "new" });
    const paidEnc = await shapeEncounter({ patientId: paid, visitType: "new" });
    const duesEnc = await shapeEncounter({ patientId: dues, visitType: "new" });
    await issuePaidInvoice(db, cashier, { patientId: paid, serviceId: base.consultNewServiceId, encounterId: paidEnc });
    await issueDuesInvoice(db, cashier, { patientId: dues, serviceId: base.consultNewServiceId, encounterId: duesEnc });

    const closed = await runDailyClose(db, DAY, NOW);
    expect(closed.orphans).toEqual([
      { encounterId: unchargedEnc, patientId: uncharged, feeServiceId: base.consultNewServiceId },
    ]);

    const flags = await eventsNamed("charge.orphan_flagged");
    expect(flags).toHaveLength(1);
    expect(flags[0]!.encounterId).toBe(unchargedEnc);
    expect(flags[0]!.patientId).toBe(uncharged);
    expect(flags[0]!.payload).toEqual({
      encounterId: unchargedEnc, patientId: uncharged,
      reason: `no non-entered-in-error invoice charges fee service ${base.consultNewServiceId}`,
    });
  });

  it("a REVISIT is never an orphan — it is FREE, so there is no charge to be missing", async () => {
    const patientId = await mkTestPatient("Revisit Patient");
    await shapeEncounter({ patientId, visitType: "revisit" });

    const closed = await runDailyClose(db, DAY, NOW);
    expect(closed.claimed).toBe(true);
    expect(closed.orphans).toEqual([]);
    expect(await eventsNamed("charge.orphan_flagged")).toHaveLength(0);
  });

  it("an ENTERED-IN-ERROR fee invoice is not cover: the visit is flagged again", async () => {
    const covered = await mkTestPatient("Covered");
    const voided = await mkTestPatient("Voided");
    const coveredEnc = await shapeEncounter({ patientId: covered, visitType: "new" });
    const voidedEnc = await shapeEncounter({ patientId: voided, visitType: "new" });

    // The control and the case are issued IDENTICALLY; only the mark differs.
    await issuePaidInvoice(db, cashier, {
      patientId: covered, serviceId: base.consultNewServiceId, encounterId: coveredEnc,
    });
    const dead = await issuePaidInvoice(db, cashier, {
      patientId: voided, serviceId: base.consultNewServiceId, encounterId: voidedEnc,
    });
    await markInvoiceEnteredInError(dead.invoiceId);

    const closed = await runDailyClose(db, DAY, NOW);
    expect(closed.orphans).toEqual([
      { encounterId: voidedEnc, patientId: voided, feeServiceId: base.consultNewServiceId },
    ]);
    expect(await eventsNamed("charge.orphan_flagged")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // GSTR-1 — the report layer sums STORED heads (K35)
  // -------------------------------------------------------------------------------------------

  it("gstr1Summary groups at the GSTR-1 grain and SUMS STORED HEADS — b09's merged row is 2266, not the 2265 a recompute gives", async () => {
    const { tabServiceId, devServiceId } = await seedB09Tariff();
    const b2b = await mkTestPatient("Acme Buyer");
    const b2c = await mkTestPatient("Walk-in Buyer");

    const b2bInvoice = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: b2b,
      buyerGstin: B09.meta.buyerGstin, buyerLegalName: B09.meta.buyerLegalName,
      lines: [
        { lineId: "L1", serviceId: tabServiceId, qty: 1 },
        { lineId: "L2", serviceId: tabServiceId, qty: 1 },
        { lineId: "L3", serviceId: devServiceId, qty: 1 },
      ],
      receipt: { tenders: [{ mode: "cash", amountPaise: B09.expected.netPayablePaise }] },
    }, NOW);

    // The real path reproduces the Book's invoice exactly — the fixture is the expectation.
    expect(b2bInvoice.totals).toMatchObject({
      grossPaise: B09.expected.grossPaise, taxableBasePaise: B09.expected.taxableBasePaise,
      cgstPaise: B09.expected.cgstPaise, sgstPaise: B09.expected.sgstPaise,
      rawTotalPaise: B09.expected.rawTotalPaise, netPayablePaise: B09.expected.netPayablePaise,
      roundingPaise: B09.expected.roundingPaise,
    });
    const storedLines = (await getInvoice(db, b2bInvoice.invoiceId))!.lines;
    expect(storedLines.map((l) => [l.cgstPaise, l.sgstPaise])).toEqual(
      B09.lines.map((l) => [l.gst.cgstPaise, l.gst.sgstPaise]),
    );

    // One B2C line of the SAME (sac, rate, exempt) key: base 18875, heads 1133, raw 21141,
    // roundTotalToRupee(21141) = floor((42,282 + 100)/200)·100 = 21100 (rounding −41).
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: b2c,
      lines: [{ lineId: "L1", serviceId: tabServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 21_100 }] },
    }, NOW);

    const merged = B09.expected.taxSummary[0]!; // (3004, 1200, false): base 37750, heads 2266
    const device = B09.expected.taxSummary[1]!; // (9021, 500, false): base 33333, heads 833
    // THE DISCRIMINATOR, pinned in the test itself: recomputing the merged row from its own base
    // loses a paise, so a report layer that re-derives instead of summing lands here.
    expect(taxHead(merged.taxableBasePaise, merged.rateBps)).toBe(merged.cgstPaise - 1);

    expect(await gstr1Summary(db, DAY, DAY)).toEqual([
      // B2C sorts first (an empty GSTIN key), and never merges with the B2B row above it.
      {
        buyerGstin: null, sacCode: merged.sacCode, rateBps: merged.rateBps, exempt: merged.exempt,
        taxableBasePaise: 18_875, cgstPaise: 1_133, sgstPaise: 1_133,
      },
      {
        buyerGstin: B09.meta.buyerGstin, sacCode: merged.sacCode, rateBps: merged.rateBps, exempt: merged.exempt,
        taxableBasePaise: merged.taxableBasePaise, cgstPaise: merged.cgstPaise, sgstPaise: merged.sgstPaise,
      },
      {
        buyerGstin: B09.meta.buyerGstin, sacCode: device.sacCode, rateBps: device.rateBps, exempt: device.exempt,
        taxableBasePaise: device.taxableBasePaise, cgstPaise: device.cgstPaise, sgstPaise: device.sgstPaise,
      },
    ]);
  });

  it("credit notes NET OUT of the period's heads, against the group their original line belongs to", async () => {
    const { tabServiceId } = await seedB09Tariff();
    const buyer = await mkTestPatient("Acme Buyer");

    // Two b09 pharmacy lines: base 37750, heads 2266 each, raw 42282,
    // roundTotalToRupee(42282) = floor((84,564 + 100)/200)·100 = 42300 (rounding +18).
    const invoice = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: buyer,
      buyerGstin: B09.meta.buyerGstin, buyerLegalName: B09.meta.buyerLegalName,
      lines: [
        { lineId: "L1", serviceId: tabServiceId, qty: 1 },
        { lineId: "L2", serviceId: tabServiceId, qty: 1 },
      ],
      receipt: { tenders: [{ mode: "cash", amountPaise: 42_300 }] },
    }, NOW);
    expect(invoice.totals).toMatchObject({ taxableBasePaise: 37_750, cgstPaise: 2_266, rawTotalPaise: 42_282, netPayablePaise: 42_300 });

    const group = { buyerGstin: B09.meta.buyerGstin, sacCode: "3004", rateBps: 1200, exempt: false };
    expect(await gstr1Summary(db, DAY, DAY)).toEqual([
      { ...group, taxableBasePaise: 37_750, cgstPaise: 2_266, sgstPaise: 2_266 },
    ]);

    const line = (await getInvoice(db, invoice.invoiceId))!.lines[0]!;
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: invoice.invoiceId, reason: "one strip returned",
      lines: [{ invoiceLineId: line.id, qty: 1 }],
    }, NOW);

    // The credited line's OWN stored heads come back out: 37750 − 18875, 2266 − 1133.
    expect(await gstr1Summary(db, DAY, DAY)).toEqual([
      { ...group, taxableBasePaise: 18_875, cgstPaise: 1_133, sgstPaise: 1_133 },
    ]);
  });
});
