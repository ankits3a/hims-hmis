import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, issueRx, line, reissueRx, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { creditNotes, grnLines, grns, invoiceLines, invoices, pharmacyDispenseLines, pharmacyDispenses, vendors } from "../../kernel/db/schema";
import { createStore } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { pharmacyMetrics } from "./metrics";
import { topSellingItems } from "./office-stock-reports";
import { pickDispense } from "./pick";
import { cancelBilledDispense } from "./refund";
import { previewRetailSale, recordRetailLicence, sellRetail } from "./retail";
import { marginReport, salesRegister } from "./sales-register";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PHARMACY NUMBERS (#777) — one IST day at the counter, walked through the real dispense, bill and
 * refund paths (the money must be billing's own, so it is not hand-written), with the instants the
 * times read and the goods received written by hand:
 *
 *   AZ   azithro × 3, cash, received 10:00, handed over 10:30 ......... dispensed in FULL
 *   CR   crocin × 15, UPI, received 10:10, handed over 10:50, one line picked short ... in PART
 *   BACK azithro × 3, billed then cancelled with a refund (a credit note) ... NOT AT ALL
 *   Q    a prescription that reached the queue and waits ................. NOT AT ALL
 *   V1→V2  a prescription re-issued while queued: v1's ticket is cancelled as superseded and is
 *          NOT a second prescription; v2 waits ....................... one received, NOT AT ALL
 *   WALK a walk-in crocin × 10 (a bill, no prescription)
 *   GRN  G1 posted on the day: 100 × ₹5 + 20 × ₹2.50 accepted, one line rejected = ₹550.00;
 *        G2 posted on the day with every line rejected; G3 a draft; G4 posted the day before.
 *
 * The range is passed explicitly; nothing here reads the clock.
 */
class NoDocuments implements DocumentStore {
  async put(): Promise<void> { throw new Error("a walk-in OTC sale files no prescription"); }
  async get(): Promise<Buffer> { throw new Error("not found"); }
  async remove(): Promise<void> { /* nothing */ }
}

jest.setTimeout(180_000);

const DAY = "2026-08-17";
const at = (hhmm: string, day = DAY): Date => new Date(`${day}T${hhmm}:00+05:30`);

describe("pharmacyMetrics — the pharmacy tab of Hospital numbers", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let owner: { id: string; actor: Actor };
  let noMargin: { id: string; actor: Actor };
  let day: { az: string; cr: string; refunded: string; walkIn: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  afterEach(() => { fx.unregister(); });

  async function billed(medicineId: string, drug: string, frequency: string, days: number, mode: "cash" | "upi", qty: number): Promise<{ id: string; invoiceId: string }> {
    const { issued } = await issueRx(db, fx, [line({ drug, medicineId, frequency, durationDays: days })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: qty }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    const b = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode, amountPaise: preview.totals.netPayablePaise, ...(mode === "cash" ? {} : { refText: "UPI-REF-1" }) }] }, MON2);
    return { id, invoiceId: b.invoiceId! };
  }

  /** Hand-set instants: the ticket's arrival and its hand-over (the counter's clock is not this test's subject). */
  async function handedOver(dispenseId: string, received: Date, handed: Date): Promise<void> {
    await db.update(pharmacyDispenses).set({ createdAt: received, status: "handed_over", handedOverAt: handed, handedOverBy: fx.pharmacist.id })
      .where(eq(pharmacyDispenses.id, dispenseId));
  }

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    for (const role of ["owner", "billing_manager", "pharmacy_incharge"]) await ensureRole(db, role);
    for (const p of ["pharmacy.reports.read", "pharmacy.reports.margin", "pharmacy.metrics.read"]) await grantPermissionToRole(db, fx.registry, "owner", p);
    for (const p of ["pharmacy.reports.read", "pharmacy.metrics.read"]) await grantPermissionToRole(db, fx.registry, "billing_manager", p);
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    owner = await mkUser(db, "the.owner", ["owner"]);
    noMargin = await mkUser(db, "accounts", ["billing_manager"]);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30, mrpPaise: 15_000 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 50, mrpPaise: 12_000 });

    const az = await billed(fx.med.azithro, "Azee 500", "OD", 3, "cash", 3);
    await handedOver(az.id, at("10:00"), at("10:30"));
    const cr = await billed(fx.med.crocin, "Crocin 500", "TDS", 5, "upi", 15);
    await handedOver(cr.id, at("10:10"), at("10:50"));
    await db.update(pharmacyDispenseLines).set({ pickNote: "shelf short by 3" }).where(eq(pharmacyDispenseLines.dispenseId, cr.id));
    const back = await billed(fx.med.azithro, "Azee 500", "OD", 3, "cash", 3);
    await cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, back.id, { reason: "patient bought it outside", reasonClass: "genuine" }, MON3);

    /* Q — reached the queue, waits. */
    const q = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await findAtCounter(db, testCfg, fx.pharmacist.actor, q.issued.qrPayload, MON2);
    /* V1 → V2 — re-issued while queued: v1's ticket is cancelled as superseded. */
    const v1 = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await findAtCounter(db, testCfg, fx.pharmacist.actor, v1.issued.qrPayload, MON2);
    const v2 = await reissueRx(db, fx, v1.encounter.id, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, durationDays: 3 })], { at: MON2 });
    await findAtCounter(db, testCfg, fx.pharmacist.actor, v2.qrPayload, MON3);

    /* WALK — the walk-in counter: its own store and licence, an OTC line, no prescription. */
    const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
    const { resourceId: retail } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    const licensee = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
    await recordRetailLicence(db, licensee.actor, { form20No: "F20-1", form21No: "F21-1", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. K." }, MON2);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-R", qtyBase: 20, resourceId: retail });
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    const p = await previewRetailSale(db, fx.pharmacist.actor, { patientId: fx.patient.id, lines }, MON3);
    const sale = await sellRetail(db, new NoDocuments(), fx.pharmacist.actor, {
      customer: { existingId: fx.patient.id }, lines, tenders: [{ mode: "card", amountPaise: p.totals.netPayablePaise, refText: "CARD-REF-1" }],
    }, undefined, MON3);
    day = { az: az.invoiceId, cr: cr.invoiceId, refunded: back.invoiceId, walkIn: sale.invoiceId };

    /* GRN — G1 counts; G2 (all rejected), G3 (draft) and G4 (the day before) do not. */
    const vendorId = newId();
    await db.insert(vendors).values({ id: vendorId, code: "V-TEST", legalName: "Test Distributors", createdBy: "t", updatedBy: "t" });
    let g = 0;
    const grn = async (status: string, posted: Date | null, accepted: [number, number][]): Promise<void> => {
      const id = newId();
      g += 1;
      await db.insert(grns).values({
        id, grnNo: `G2608170${String(g)}`, vendorId, source: "challan", challanNo: `CH-${String(g)}`, challanDate: DAY,
        storeResourceId: fx.storeId, status, capturedBy: "t", postedAt: posted, createdBy: "t", updatedBy: "t",
      });
      for (const [qty, cost] of accepted) {
        await db.insert(grnLines).values({
          id: newId(), grnId: id, itemId: fx.item.crocin, uom: "tablet", qtyInUom: Math.max(qty, 1), qtyBase: Math.max(qty, 1),
          unitCostPaise: cost, qtyAcceptedBase: qty, qtyRejectedBase: qty === 0 ? 1 : 0,
        });
      }
    };
    await grn("posted", at("11:00"), [[100, 500], [20, 250], [0, 900]]);
    await grn("posted", at("11:30"), [[0, 500]]);
    await grn("draft", null, [[50, 500]]);
    await grn("posted", at("18:00", "2026-08-16"), [[10, 500]]);
  });

  it("bills, sales, returns and net are the stored invoices and credit note — and the sales register's own totals", async () => {
    const m = await pharmacyMetrics(db, owner.actor, { from: DAY, to: DAY });
    const bills = await db.select().from(invoices).where(inArray(invoices.id, [day.az, day.cr, day.refunded, day.walkIn]));
    const [note] = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, day.refunded));
    const sales = bills.reduce((s, b) => s + b.netPayablePaise, 0);
    expect({ bills: m.bills, salesPaise: m.salesPaise, returnsPaise: m.returnsPaise, netPaise: m.netPaise })
      .toEqual({ bills: 4, salesPaise: sales, returnsPaise: note!.netPaise, netPaise: sales - note!.netPaise });
    expect(note!.netPaise).toBeGreaterThan(0);

    const reg = await salesRegister(db, owner.actor, { preset: "custom", from: DAY, to: DAY }, MON3);
    expect({ bills: m.bills, salesPaise: m.salesPaise, returnsPaise: m.returnsPaise, netPaise: m.netPaise }).toEqual({
      bills: reg.totals.sales.count, salesPaise: reg.totals.sales.netPaise, returnsPaise: reg.totals.refunds.netPaise, netPaise: reg.totals.net.netPaise,
    });
  });

  it("prescriptions: five received (the superseded v1 is not a second one), one in full, one in part, three not at all", async () => {
    const m = await pharmacyMetrics(db, owner.actor, { from: DAY, to: DAY });
    expect(m.prescriptions).toEqual({ received: 5, full: 1, part: 1, none: 3 });
    expect(m.receivedToDispensed).toEqual({ n: 2, medianMin: 35, p90Min: 39 });
  });

  it("top items by net amount, returns netted, quantities in base units — the office's top-selling list, first ten", async () => {
    const m = await pharmacyMetrics(db, owner.actor, { from: DAY, to: DAY });
    expect(Object.fromEntries(m.topItems.map((i) => [i.itemCode, i.qtyBase]))).toEqual({ CROC500: 25, AZEE500: 3 });
    const amounts = m.topItems.map((i) => i.amountPaise);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    // Crocin was never returned: its amount is its invoice lines' net, on the counter's bill and the walk-in's.
    const crLines = await db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, [day.cr, day.walkIn]));
    expect(m.topItems.find((i) => i.itemCode === "CROC500")!.amountPaise).toBe(crLines.reduce((s, l) => s + l.netPaise, 0));
    const top = await topSellingItems(db, owner.actor, { preset: "custom", from: DAY, to: DAY }, MON3);
    expect(m.topItems.map((i) => ({ itemId: i.itemId, qtyBase: i.qtyBase, amountPaise: i.amountPaise })))
      .toEqual(top.byValue.slice(0, 10).map((i) => ({ itemId: i.itemId, qtyBase: i.qtyBase, amountPaise: i.valuePaise })));
  });

  it("purchases received: one posted GRN with stock accepted, at its accepted cost (₹550.00)", async () => {
    const m = await pharmacyMetrics(db, owner.actor, { from: DAY, to: DAY });
    expect(m.purchases).toEqual({ grns: 1, valuePaise: 55_000 });
    const before = await pharmacyMetrics(db, owner.actor, { from: "2026-08-16", to: "2026-08-16" });
    expect(before.purchases).toEqual({ grns: 1, valuePaise: 5_000 });
  });

  it("margin rides only with pharmacy.reports.margin, and equals the margin report's totals (cost: 28 tablets × ₹5)", async () => {
    const m = await pharmacyMetrics(db, owner.actor, { from: DAY, to: DAY });
    const mr = await marginReport(db, owner.actor, { preset: "custom", from: DAY, to: DAY }, MON3);
    expect(m.margin).toEqual({
      revenuePaise: mr.totals.revenuePaise, costPaise: 28 * 500, profitPaise: mr.totals.marginPaise, marginBps: mr.totals.marginBps,
    });
    expect(mr.totals.costPaise).toBe(28 * 500);

    const plain = await pharmacyMetrics(db, noMargin.actor, { from: DAY, to: DAY });
    expect("margin" in plain).toBe(false);
    expect(JSON.stringify(plain)).not.toMatch(/cost|profit|margin/i);
    expect(plain.netPaise).toBe(m.netPaise);
  });
});
