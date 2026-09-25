import { eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { creditNotes, invoiceLines, invoices } from "../../kernel/db/schema";
import { dayBook, gstr1Summary } from "../billing";
import { createStore } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { pickDispense } from "./pick";
import { cancelBilledDispense } from "./refund";
import { previewRetailSale, recordRetailLicence, sellRetail } from "./retail";
import { hsnReport, marginReport, salesRegister } from "./sales-register";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE SALES REGISTER, THE MARGIN AND THE HSN SUMMARY ═══
 *
 * One IST day at the counter: two dispenses billed (cash, UPI), a third billed and then cancelled
 * with a refund (a credit note), and a walk-in sale. Then:
 *   - the register's totals ARE billing's own: the day book's invoice and credit-note totals, and
 *     GSTR-1's taxable value and tax heads for the same day;
 *   - margin = taxable value − units × the batch's GRN cost, line by line, and a returned unit gives
 *     its revenue and its cost back;
 *   - the HSN summary's totals are the invoices' stored tax less the credit note's, and its quantity
 *     is the units sold less the units returned;
 *   - a reader without `pharmacy.reports.margin` gets the register without cost or profit, and the
 *     margin report is refused; the counter pharmacist reads neither.
 */
class NoDocuments implements DocumentStore {
  async put(): Promise<void> { throw new Error("a walk-in OTC sale files no prescription"); }
  async get(): Promise<Buffer> { throw new Error("not found"); }
  async remove(): Promise<void> { /* nothing */ }
}

const DAY = "2026-08-17";
const range = { preset: "custom", from: DAY, to: DAY };

describe("the sales register, the margin and the HSN summary (parity P5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let owner: { id: string; actor: Actor };
  let accounts: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    for (const role of ["owner", "billing_manager", "pharmacy_incharge"]) await ensureRole(db, role);
    for (const p of ["pharmacy.reports.read", "pharmacy.reports.margin"]) await grantPermissionToRole(db, fx.registry, "owner", p);
    await grantPermissionToRole(db, fx.registry, "billing_manager", "pharmacy.reports.read");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    owner = await mkUser(db, "the.owner", ["owner"]);
    accounts = await mkUser(db, "accounts", ["billing_manager"]);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30, mrpPaise: 15_000 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 50, mrpPaise: 12_000 });
  });
  afterEach(() => { fx.unregister(); });

  /** A prescription dispensed and billed at the counter; returns the dispense and its invoice. */
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

  /** The day: azithro × 3 (cash), crocin × 15 (UPI), azithro × 3 billed then refunded, a walk-in crocin × 10. */
  async function aDay(): Promise<{ az: string; cr: string; refunded: string; walkIn: string }> {
    const az = await billed(fx.med.azithro, "Azee 500", "OD", 3, "cash", 3);
    const cr = await billed(fx.med.crocin, "Crocin 500", "TDS", 5, "upi", 15);
    const back = await billed(fx.med.azithro, "Azee 500", "OD", 3, "cash", 3);
    await cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, back.id, { reason: "patient bought it outside", reasonClass: "genuine" }, MON3);
    // The walk-in counter: its own store and licence, an OTC line, no prescription.
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
    return { az: az.invoiceId, cr: cr.invoiceId, refunded: back.invoiceId, walkIn: sale.invoiceId };
  }

  it("its totals are billing's own: the day book's invoices and credit notes, and GSTR-1's taxable value and tax heads", async () => {
    const day = await aDay();
    const reg = await salesRegister(db, owner.actor, range, MON3);

    expect(reg.rows.map((r) => [r.kind, r.source, r.tender])).toEqual([
      ["sale", "dispense", "cash"], ["sale", "dispense", "upi"], ["sale", "dispense", "cash"], ["refund", "dispense", null], ["sale", "walk_in", "card"],
    ]);
    const book = await dayBook(db, DAY);
    expect(reg.totals.sales).toMatchObject({ count: book.invoices.count, netPaise: book.invoices.netPayablePaise });
    expect(reg.totals.refunds).toMatchObject({ count: book.creditNotes.count, netPaise: book.creditNotes.netPaise });
    const gstr1 = await gstr1Summary(db, DAY, DAY);
    const sum = (k: "taxableBasePaise" | "cgstPaise" | "sgstPaise"): number => gstr1.reduce((s, r) => s + r[k], 0);
    expect(reg.totals.net).toMatchObject({ taxablePaise: sum("taxableBasePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise") });

    // Each row is its bill, as stored: the invoice's heads, its prescriber, its operator.
    const [stored] = await db.select().from(invoices).where(eq(invoices.id, day.az));
    expect(reg.rows[0]).toMatchObject({
      invoiceNo: stored!.invoiceNo, taxablePaise: stored!.taxableBasePaise, cgstPaise: stored!.cgstPaise, netPaise: stored!.netPayablePaise,
      prescriber: "Dr dr.sen", operatorName: "ph.mehta", outstandingPaise: 0, patientId: fx.patient.id,
    });
    expect(reg.rows[0]!.lines).toMatchObject([{ itemCode: "AZEE500", batchNo: "AZ-1", qtyBase: 3 }]);
    expect(reg.rows[4]).toMatchObject({ source: "walk_in", prescriber: null, storeCode: RETAIL_PHARMACY_STORE_CODE, lines: [{ itemCode: "CROC500", batchNo: "CR-R", qtyBase: 10 }] });
    const [note] = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, day.refunded));
    expect(reg.rows[3]).toMatchObject({ kind: "refund", docNo: note!.creditNoteNo, netPaise: note!.netPaise, lines: [{ itemCode: "AZEE500", qtyBase: 3 }] });

    // Grouped by item: azithro sold 6 and 3 came back.
    const byItem = await salesRegister(db, owner.actor, { ...range, groupBy: "item" }, MON3);
    expect(byItem.groups.map((g) => [g.sub, g.qtyBase])).toEqual(expect.arrayContaining([["AZEE500", 3], ["CROC500", 25]]));
    const byTender = await salesRegister(db, owner.actor, { ...range, groupBy: "tender" }, MON3);
    expect(byTender.groups.map((g) => g.key).sort()).toEqual(["card", "cash", "refund", "upi"]);
    // A store narrows it.
    const retailOnly = await salesRegister(db, owner.actor, { ...range, storeCode: RETAIL_PHARMACY_STORE_CODE }, MON3);
    expect(retailOnly.rows.map((r) => r.source)).toEqual(["walk_in"]);
  });

  it("margin = taxable value − units × the batch's GRN cost; a refund gives both back", async () => {
    const day = await aDay();
    const lines = await db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, [day.az, day.cr, day.walkIn]));
    const taxable = (invoiceId: string): number => lines.filter((l) => l.invoiceId === invoiceId).reduce((s, l) => s + l.taxableBasePaise, 0);

    const m = await marginReport(db, owner.actor, { ...range, groupBy: "item" }, MON3);
    const az = m.rows.find((r) => r.sub === "AZEE500")!;
    const cr = m.rows.find((r) => r.sub === "CROC500")!;
    // `stockIn` puts every batch at ₹5 a tablet (500 paise).
    expect(az).toMatchObject({ qtyBase: 3, revenuePaise: taxable(day.az), costPaise: 3 * 500, marginPaise: taxable(day.az) - 3 * 500 });
    expect(cr).toMatchObject({ qtyBase: 25, revenuePaise: taxable(day.cr) + taxable(day.walkIn), costPaise: 25 * 500 });
    expect(cr.marginPaise).toBe(cr.revenuePaise - cr.costPaise);
    expect(m.totals.marginPaise).toBe(m.totals.revenuePaise - m.totals.costPaise);
    expect(m.totals.marginBps).toBe(Math.round((m.totals.marginPaise * 10_000) / m.totals.revenuePaise));

    const byDoctor = await marginReport(db, owner.actor, { ...range, groupBy: "doctor" }, MON3);
    expect(byDoctor.rows.map((r) => r.label).sort()).toEqual(["Dr dr.sen", "—"].sort());
    const byCategory = await marginReport(db, owner.actor, { ...range, groupBy: "category" }, MON3);
    expect(byCategory.rows.map((r) => [r.label, r.costPaise])).toEqual([["tablet", 28 * 500]]);

    // The register carries the same margin, to the owner.
    const reg = await salesRegister(db, owner.actor, range, MON3);
    expect(reg.margin).toBe(true);
    expect(reg.totals.profitPaise).toBe(m.totals.marginPaise);
  });

  it("without pharmacy.reports.margin: the register has no cost or profit and the margin report is refused; the counter reads neither", async () => {
    await aDay();
    const reg = await salesRegister(db, accounts.actor, range, MON3);
    expect(reg.margin).toBe(false);
    expect(reg.rows.every((r) => r.costPaise === null && r.profitPaise === null && r.lines.every((l) => l.costPaise === null && l.profitPaise === null))).toBe(true);
    expect([reg.totals.costPaise, reg.totals.profitPaise, reg.totals.marginBps]).toEqual([null, null, null]);
    await expect(marginReport(db, accounts.actor, range, MON3)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(salesRegister(db, fx.pharmacist.actor, range, MON3)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(hsnReport(db, fx.pharmacist.actor, range, MON3)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("the HSN summary's totals are the invoices' stored tax less the credit note's; its quantity is units sold less units returned", async () => {
    const day = await aDay();
    const r = await hsnReport(db, accounts.actor, range, MON3);
    const inv = await db.select().from(invoices).where(inArray(invoices.id, [day.az, day.cr, day.refunded, day.walkIn]));
    const [note] = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, day.refunded));
    const sum = (k: "taxableBasePaise" | "cgstPaise" | "sgstPaise"): number => inv.reduce((s, i) => s + i[k], 0) - note![k];
    expect(r.totals).toMatchObject({ taxablePaise: sum("taxableBasePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: 0 });
    expect(r.totals.valuePaise).toBe(r.totals.taxablePaise + r.totals.cgstPaise + r.totals.sgstPaise);
    // Azee is 5%, Crocin 12%: two rows, tablets counted as TBS.
    expect(r.rows.map((x) => [x.rateBps, x.uqc, x.qty])).toEqual([[500, "TBS", 3], [1200, "TBS", 25]]);
  });
});
