import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import { approvals, creditNotes, invoiceLines, invoices, allocations } from "../../kernel/db/schema";
import { issueInvoice } from "../billing";
import { inclusiveTaxHead } from "../tariff";
import { createStore } from "../materials";
import { registerPharmacyApprovalTypes } from "./approval-types";
import { askDispenseDiscount, billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { gstr3bReport } from "./gstr3b";
import { pickDispense } from "./pick";
import { cancelBilledDispense } from "./refund";
import { askRetailDiscount, getRetailSale, previewRetailSale, recordRetailLicence, sellRetail } from "./retail";
import { salesRegister } from "./sales-register";
import { tallyPreview } from "./tally";
import { verifyDispense } from "./verify";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

class NoDocs implements DocumentStore {
  async put(): Promise<void> {}
  async get(): Promise<Buffer> { throw new Error("none"); }
  async remove(): Promise<void> {}
}

/**
 * ═══ OWNER RULINGS 2026-09-30 (money) — THE PHARMACY BILL, END TO END ═══
 *
 * 1. Cash rounds to the NEAREST rupee (owner's amendment: "33.60 … 34 … 30.49 … Rs 30 … 30.51 … 31"); UPI or card
 *    alone is collected to the paisa; a mixed tender with cash is cash. 15 Crocin at ₹22.40 a strip of 10 = ₹33.60.
 * 2. A sale discount off MRP, with a reason: the pharmacist up to 10%, the in-charge above 10% up to 25%, the
 *    owner above 25% or over ₹25,000 on one bill — each approval bound to the bill and the discount, never
 *    granted by whoever asked.
 * Rounding is applied after the discount, and neither is taxable.
 */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
  return "no refusal";
};
const DAY = "2026-08-17";

describe("pharmacy money rulings 2026-09-30", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let incharge: { id: string; actor: Actor };
  let incharge2: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await registerPharmacyApprovalTypes(db, fx.base.activator);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await ensureRole(db, "pharmacy_incharge");
    for (const p of ["pharmacy.retail.manage", "pharmacy.reports.read", "pharmacy.tally.export"]) await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", p);
    // One in-charge who also bills (holds `pharmacy`), and a second one to approve what the first asks.
    incharge = await mkUser(db, "ph.ic.one", ["pharmacy", "pharmacy_incharge"]);
    incharge2 = await mkUser(db, "ph.ic.two", ["pharmacy_incharge"]);
    owner = { id: fx.base.owner.id, actor: fx.base.owner };
    // ₹22.40 a strip of 10: 224 paise a tablet, so 15 tablets are ₹33.60.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 200, mrpPaise: 2240 });
  });
  afterEach(() => { fx.unregister(); });

  async function picked(qty = 15, medicineId = fx.med.crocin, drug = "Crocin 500"): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug, medicineId })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: qty }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    return id;
  }
  const invoiceOf = async (invoiceId: string) => (await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!;

  describe("ruling 1 — rounding by tender", () => {
    it("the preview quotes both: ₹34.00 in cash (+₹0.40), ₹33.60 by UPI or card, and follows the tender asked", async () => {
      const id = await picked();
      const cash = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
      expect(cash.totals).toMatchObject({ rawTotalPaise: 3360, netPayablePaise: 3400, roundingPaise: 40 });
      expect(cash.byTender).toEqual({ cash: { netPayablePaise: 3400, roundingPaise: 40 }, digital: { netPayablePaise: 3360, roundingPaise: 0 } });
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { tender: "upi" })).totals).toMatchObject({ netPayablePaise: 3360, roundingPaise: 0 });
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { tender: "card" })).totals.netPayablePaise).toBe(3360);
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { tender: "split" })).totals.netPayablePaise).toBe(3400);
    });

    it("cash: ₹33.60 is collected as ₹34.00, the nearest rupee, with a +₹0.40 rounding line", async () => {
      const id = await picked();
      const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 5000 }], changeGivenPaise: 1600 }, MON2);
      const inv = await invoiceOf(billed.invoiceId!);
      expect(inv).toMatchObject({ rawTotalPaise: 3360, roundingPaise: 40, netPayablePaise: 3400, roundingRule: "half_up" });
      const [alloc] = await db.select().from(allocations).where(eq(allocations.invoiceId, inv.id));
      expect(alloc!.amountPaise).toBe(3400);
    });

    it("UPI and card: collected to the paisa, no rounding line", async () => {
      for (const mode of ["upi", "card"] as const) {
        const id = await picked();
        const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode, amountPaise: 3360, refText: `${mode}-REF` }] }, MON2);
        expect(await invoiceOf(billed.invoiceId!)).toMatchObject({ roundingPaise: 0, netPayablePaise: 3360, roundingRule: "exact" });
      }
    });

    it("a split of cash and UPI is cash: the nearest rupee", async () => {
      const id = await picked();
      const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 1000 }, { mode: "upi", amountPaise: 2400, refText: "UTR-9" }] }, MON2);
      expect(await invoiceOf(billed.invoiceId!)).toMatchObject({ netPayablePaise: 3400, roundingPaise: 40, roundingRule: "half_up" });
    });

    it("a full cancel of a cash bill credits exactly what was paid (₹34.00), so the refund can be paid", async () => {
      const id = await picked();
      const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 3400 }] }, MON2);
      const cancelled = await cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, id, { reason: "patient bought it outside", reasonClass: "genuine" }, MON3);
      const [note] = await db.select().from(creditNotes).where(eq(creditNotes.id, cancelled.creditNoteId));
      expect(note).toMatchObject({ invoiceId: billed.invoiceId, netPaise: 3400, roundingPaise: 40 });
      const [ask] = await db.select().from(approvals).where(eq(approvals.id, cancelled.refundApprovalId));
      expect(ask!.amountPaise).toBe(3400);
    });

    it("a full cancel of a UPI bill credits the ₹33.60 taken, never a rounded-up ₹34.00", async () => {
      const id = await picked();
      const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "upi", amountPaise: 3360, refText: "UTR-2" }] }, MON2);
      const cancelled = await cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, id, { reason: "patient bought it outside", reasonClass: "genuine" }, MON3);
      const [note] = await db.select().from(creditNotes).where(eq(creditNotes.id, cancelled.creditNoteId));
      expect(note).toMatchObject({ invoiceId: billed.invoiceId, netPaise: 3360, roundingPaise: 0 });
    });

    it("OPD is untouched: a consultation bill stays half-up, and a pharmacy rounding or discount on it is refused", async () => {
      const opd = await issueInvoice(db, fx.pharmacist.actor, {
        draftId: newId(), patientId: fx.patient.id, lines: [{ lineId: newId(), serviceId: fx.base.consultNewServiceId, qty: 1 }],
        receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
      }, MON2);
      expect(await invoiceOf(opd.invoiceId)).toMatchObject({ roundingRule: "half_up" });
      const lines = [{ lineId: newId(), serviceId: fx.base.consultNewServiceId, qty: 1 }];
      expect(await refusal(issueInvoice(db, fx.pharmacist.actor, { draftId: newId(), patientId: fx.patient.id, lines, roundingRule: "exact", receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] } }, MON2)))
        .toBe("pharmacy_bill_only");
      expect(await refusal(issueInvoice(db, fx.pharmacist.actor, {
        draftId: newId(), patientId: fx.patient.id, lines, saleDiscount: { kind: "percent_bps", value: 500, reason: "x" }, receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
      }, MON2))).toBe("pharmacy_bill_only");
    });
  });

  describe("ruling 2 — the sale discount", () => {
    it("8% is the pharmacist's own: billed at once, tax carved out of the DISCOUNTED amount per line, then rounded to the nearest rupee for cash", async () => {
      const id = await picked();
      const discount = { kind: "percent_bps" as const, value: 800, reason: "senior citizen" };
      const quote = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { discount });
      // 8% of ₹33.60 = ₹2.688 → ₹2.69 (half-up, per line); ₹30.91 left: ₹31.00 cash (the owner's own example), ₹30.91 UPI.
      expect(quote.discount).toMatchObject({ amountPaise: 269, tier: "pharmacist", approverRole: null });
      expect(quote.totals).toMatchObject({ grossPaise: 3360, discountPaise: 269, rawTotalPaise: 3091, netPayablePaise: 3100, roundingPaise: 9 });
      expect(quote.byTender.digital.netPayablePaise).toBe(3091);

      const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 3100 }], discount }, MON2);
      const inv = await invoiceOf(billed.invoiceId!);
      expect(inv).toMatchObject({ grossPaise: 3360, discountPaise: 269, netPayablePaise: 3100, roundingPaise: 9 });
      for (const l of await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))) {
        const charged = l.grossPaise - l.discountPaise;
        const head = l.exempt || l.rateBps === 0 ? 0 : inclusiveTaxHead(charged, l.rateBps);
        expect(l.rateBps).toBeGreaterThan(0);
        expect({ cgst: l.cgstPaise, sgst: l.sgstPaise, taxable: l.taxableBasePaise }).toEqual({ cgst: head, sgst: head, taxable: charged - 2 * head });
        expect((l.winner as { sourceKey: string; reason: string }).reason).toBe("senior citizen");
      }
      // The tax fell with the price: less than the undiscounted bill's.
      const [first] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      expect(inv.cgstPaise).toBeLessThan(inclusiveTaxHead(3360, first!.rateBps));
      expect(inv.taxableBasePaise + inv.cgstPaise + inv.sgstPaise).toBe(3091);
    });

    it("exactly 10% is still the pharmacist's; 10.01% waits for the in-charge", async () => {
      const id = await picked();
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { discount: { kind: "percent_bps", value: 1000, reason: "r" } })).discount?.tier).toBe("pharmacist");
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { discount: { kind: "percent_bps", value: 1001, reason: "r" } })).discount?.tier).toBe("pharmacy_incharge");
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { discount: { kind: "percent_bps", value: 2500, reason: "r" } })).discount?.tier).toBe("pharmacy_incharge");
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { discount: { kind: "percent_bps", value: 2501, reason: "r" } })).discount?.tier).toBe("owner");
      expect(await refusal(billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 3400 }], discount: { kind: "percent_bps", value: 1001, reason: "r" } }, MON2)))
        .toBe("discount_approval_required");
    });

    it("15%: the in-charge approves, never the one who asked; the bill binds the approval and carries the discount", async () => {
      const id = await picked();
      const discount = { kind: "percent_bps" as const, value: 1500, reason: "staff family" };
      expect(await refusal(billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 3400 }], discount }, MON2))).toBe("discount_approval_required");

      // The in-charge who is also at the counter asks — and may not grant their own ask.
      const asked = await askDispenseDiscount(db, incharge.actor, id, discount, MON2);
      expect(asked).toMatchObject({ tier: "pharmacy_incharge", amountPaise: 504 });
      const [row] = await db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
      expect(row).toMatchObject({ typeKey: "pharmacy_discount_incharge", subjectType: "pharmacy_sale_discount", subjectId: `${id}:percent_bps:1500`, amountPaise: 504, patientId: fx.patient.id });
      expect(await refusal(approveRequest(db, incharge.actor, { approvalId: asked.approvalId, note: "ok" }))).not.toBe("no refusal");
      // Pending is not granted.
      expect(await refusal(billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 2900 }], discount: { ...discount, approvalId: asked.approvalId } }, MON2)))
        .toBe("discount_approval_required");

      await approveRequest(db, incharge2.actor, { approvalId: asked.approvalId, note: "agreed" });
      // ₹33.60 − ₹5.04 = ₹28.56 → ₹29.00 in cash (the nearest rupee).
      const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 2900 }], discount: { ...discount, approvalId: asked.approvalId } }, MON2);
      expect(await invoiceOf(billed.invoiceId!)).toMatchObject({ discountPaise: 504, netPayablePaise: 2900, roundingPaise: 44 });
    });

    it("the approval binds THIS bill and THIS discount: another %, another dispense or an in-charge's grant above 25% is refused", async () => {
      const id = await picked();
      const other = await picked();
      const discount = { kind: "percent_bps" as const, value: 1500, reason: "staff family" };
      const asked = await askDispenseDiscount(db, fx.pharmacist.actor, id, discount, MON2);
      await approveRequest(db, incharge2.actor, { approvalId: asked.approvalId, note: "agreed" });
      const withIt = (d: string, value: number) => billDispense(db, fx.pharmacist.actor, d, {
        tenders: [{ mode: "upi", amountPaise: 3360, refText: "UTR" }], discount: { kind: "percent_bps", value, reason: "staff family", approvalId: asked.approvalId },
      }, MON2);
      expect(await refusal(withIt(id, 1600))).toBe("discount_not_bound");
      expect(await refusal(withIt(other, 1500))).toBe("discount_not_bound");
      expect(await refusal(withIt(id, 3000))).toBe("discount_not_bound");
    });

    it("above 25% only the owner approves: the in-charge cannot decide it, the owner can", async () => {
      const id = await picked();
      const discount = { kind: "percent_bps" as const, value: 3000, reason: "hardship — owner asked" };
      const asked = await askDispenseDiscount(db, fx.pharmacist.actor, id, discount, MON2);
      expect(asked.tier).toBe("owner");
      expect(await refusal(approveRequest(db, incharge2.actor, { approvalId: asked.approvalId, note: "ok" }))).not.toBe("no refusal");
      await approveRequest(db, owner.actor, { approvalId: asked.approvalId, note: "yes" });
      // 30% of ₹33.60 = ₹10.08; ₹23.52 by UPI, to the paisa.
      const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "upi", amountPaise: 2352, refText: "UTR" }], discount: { ...discount, approvalId: asked.approvalId } }, MON2);
      expect(await invoiceOf(billed.invoiceId!)).toMatchObject({ discountPaise: 1008, netPayablePaise: 2352, roundingPaise: 0 });
    });

    it("a discount worth MORE than ₹25,000 on one bill is the owner's even at under 10%; exactly ₹25,000 is not", async () => {
      // ₹2,00,000 a strip of 10: ₹20,000 a tablet, 15 tablets = ₹3,00,000 of MRP.
      await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 30, mrpPaise: 20_000_000 });
      const id = await picked(15, fx.med.calpol, "Calpol 500");
      const flat = (value: number) => previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { discount: { kind: "flat_paise", value, reason: "r" } });
      expect((await flat(2_500_000)).discount).toMatchObject({ amountPaise: 2_500_000, tier: "pharmacist" });
      expect((await flat(2_500_001)).discount).toMatchObject({ amountPaise: 2_500_001, tier: "owner" });
      // 9% of ₹3,00,000 = ₹27,000: over the line.
      expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { discount: { kind: "percent_bps", value: 900, reason: "r" } })).discount?.tier).toBe("owner");
      expect(await refusal(billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "upi", amountPaise: 1, refText: "U" }], discount: { kind: "percent_bps", value: 900, reason: "r" } }, MON2)))
        .toBe("discount_approval_required");
    });
  });

  describe("the walk-in counter follows both rulings", () => {
    let retailId: string;
    beforeEach(async () => {
      const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
      ({ resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" })));
      await recordRetailLicence(db, incharge.actor, { form20No: "F20-1", form21No: "F21-1", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. K." }, MON);
      await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-R", qtyBase: 100, mrpPaise: 2240, resourceId: retailId });
    });
    const cart = () => [{ medicineId: fx.med.crocin, qtyBase: 15 }];

    it("cash rounds to the nearest rupee, UPI is exact, and 8% is the pharmacist's — the memo shows discount and rounding", async () => {
      const p = await previewRetailSale(db, fx.pharmacist.actor, { patientId: fx.patient.id, lines: cart() }, MON2);
      expect(p.byTender).toEqual({ cash: { netPayablePaise: 3400, roundingPaise: 40 }, digital: { netPayablePaise: 3360, roundingPaise: 0 } });
      const upi = await sellRetail(db, new NoDocs(), fx.pharmacist.actor, { customer: { existingId: fx.patient.id }, lines: cart(), tenders: [{ mode: "upi", amountPaise: 3360, refText: "UTR" }] }, undefined, MON2);
      expect(await invoiceOf(upi.invoiceId)).toMatchObject({ netPayablePaise: 3360, roundingPaise: 0 });

      const discount = { kind: "percent_bps" as const, value: 800, reason: "regular customer" };
      const q = await previewRetailSale(db, fx.pharmacist.actor, { patientId: fx.patient.id, lines: cart(), discount }, MON2);
      expect(q.discount).toMatchObject({ amountPaise: 269, tier: "pharmacist" });
      expect(q.totals).toMatchObject({ discountPaise: 269, netPayablePaise: 3100, roundingPaise: 9 });
      const sold = await sellRetail(db, new NoDocs(), fx.pharmacist.actor, { customer: { existingId: fx.patient.id }, lines: cart(), tenders: [{ mode: "cash", amountPaise: 3100 }], discount }, undefined, MON2);
      expect(sold.money).toMatchObject({ grossPaise: 3360, discountPaise: 269, discountReason: "regular customer", roundingPaise: 9, netPaise: 3100 });
    });

    it("15% waits for the in-charge, bound to the cart's own id — and that approval sells the cart once", async () => {
      const draftId = newId();
      const discount = { kind: "percent_bps" as const, value: 1500, reason: "staff" };
      expect(await refusal(sellRetail(db, new NoDocs(), fx.pharmacist.actor, { customer: { existingId: fx.patient.id }, lines: cart(), tenders: [{ mode: "cash", amountPaise: 2900 }], discount, draftId }, undefined, MON2)))
        .toBe("discount_approval_required");
      expect(await refusal(askRetailDiscount(db, fx.pharmacist.actor, { draftId, lines: cart(), discount }, MON2))).toBe("discount_needs_customer");
      const asked = await askRetailDiscount(db, fx.pharmacist.actor, { draftId, patientId: fx.patient.id, lines: cart(), discount }, MON2);
      await approveRequest(db, incharge2.actor, { approvalId: asked.approvalId, note: "ok" });
      const input = { customer: { existingId: fx.patient.id }, lines: cart(), tenders: [{ mode: "cash" as const, amountPaise: 2900 }], discount: { ...discount, approvalId: asked.approvalId }, draftId };
      const sold = await sellRetail(db, new NoDocs(), fx.pharmacist.actor, input, undefined, MON2);
      expect(sold.id).toBe(draftId);
      expect(await invoiceOf(sold.invoiceId)).toMatchObject({ discountPaise: 504, netPayablePaise: 2900 });
      expect(await refusal(sellRetail(db, new NoDocs(), fx.pharmacist.actor, input, undefined, MON3))).toBe("discount_not_bound");
    });
  });

  it("the register, GSTR-3B and Tally all carry the discount and the rounding, and every total adds up", async () => {
    const id = await picked();
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: 3100 }], discount: { kind: "percent_bps", value: 800, reason: "senior citizen" } }, MON2);
    const upi = await picked();
    await billDispense(db, fx.pharmacist.actor, upi, { tenders: [{ mode: "upi", amountPaise: 3360, refText: "UTR" }] }, MON2);

    const range = { preset: "custom", from: DAY, to: DAY };
    const reg = await salesRegister(db, incharge.actor, range, MON3);
    expect(reg.rows.map((r) => ({ d: r.discountPaise, r: r.roundingPaise, n: r.netPaise })).sort((a, b) => a.n - b.n))
      .toEqual([{ d: 269, r: 9, n: 3100 }, { d: 0, r: 0, n: 3360 }]);
    for (const r of reg.rows) {
      expect(r.grossPaise - r.discountPaise).toBe(r.taxablePaise + r.cgstPaise + r.sgstPaise);
      expect(r.taxablePaise + r.cgstPaise + r.sgstPaise + r.roundingPaise).toBe(r.netPaise);
    }
    const t = reg.totals.sales;
    expect(t).toMatchObject({ grossPaise: 6720, discountPaise: 269, roundingPaise: 9, netPaise: 6460 });
    expect(t.taxablePaise + t.cgstPaise + t.sgstPaise + t.roundingPaise).toBe(t.netPaise);

    const g = await gstr3bReport(db, incharge.actor, range, MON3);
    // Rounding is not a supply and the discount is already off the value: the taxable value is the register's.
    expect(g.outward.taxable).toMatchObject({ taxablePaise: t.taxablePaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise });
    expect(g.outward).toMatchObject({ discountPaise: 269, roundingPaise: 9 });

    const tally = await tallyPreview(db, incharge.actor, range, MON3);
    const sales = tally.sample.filter((v) => v.kind === "sale");
    expect(sales).toHaveLength(2);
    for (const v of sales) expect(v.entries.reduce((s, e) => s + e.amountPaise, 0)).toBe(0);
    const discounted = sales.find((v) => v.narration.includes("discount"))!;
    expect(discounted.narration).toContain("MRP Rs 33.60 less discount Rs 2.69");
    // The round-off ledger takes the +₹0.09 (income: a credit), the Sales ledger only the taxable value.
    expect(discounted.entries.find((e) => e.ledger === tally.ledgers.roundOff)?.amountPaise).toBe(-9);
    const sold = discounted.entries.find((e) => e.ledger === tally.ledgers.sales)?.amountPaise ?? 0;
    const cgst = discounted.entries.find((e) => e.ledger === tally.ledgers.outputCgst)?.amountPaise ?? 0;
    expect(-sold - 2 * cgst).toBe(3091); // taxable + both heads = the discounted amount, before rounding
  });
});
