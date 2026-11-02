import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { openSessionFor } from "../../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../../test/helpers/opd";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { withTx } from "../../../kernel/db/client";
import { events, invoiceLines, invoices } from "../../../kernel/db/schema";
import { balances, createStore } from "../../materials";
import { feeSwitchesView, setFeeSwitch } from "../../billing";
import { billDispense, previewDispenseBill } from "../bill";
import { claimDispense, findAtCounter } from "../claim";
import { RETAIL_PHARMACY_STORE_CODE } from "../config";
import { handOverDispense } from "../handover";
import { pickDispense } from "../pick";
import { getDispense } from "../queue";
import { previewRetailSale, recordRetailLicence, sellRetail } from "../retail";
import { acceptReturn } from "../returns";
import { pharmacyCreditOf } from "../store-credit";
import { verifyDispense } from "../verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Db } from "../../../kernel/db/client";
import type { DocumentStore } from "../../../kernel/documents/store";

/** Spec #1023 — the pharmacy fee switch, owner 2026-11-02. Off means medicines go out at ₹0. */
const BEFORE = new Date(MON.getTime() - 60 * 60_000);
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const docs: DocumentStore = {
  put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {},
};

describe("the pharmacy fee switch (spec #1023)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000, at: MON });
  });
  afterEach(() => { fx.unregister(); });

  /** Twenty Crocin tablets, prescribed at `at` and picked at MON2: the dispense is ready to bill. */
  async function picked(at: Date = MON): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { at });
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, at > MON2 ? at : MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    return id;
  }
  const billOf = async (id: string) => {
    const d = await getDispense(db, fx.pharmacist.actor, id, MON3);
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, d.invoiceId!));
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, d.invoiceId!));
    return { invoice: invoice!, lines };
  };
  const onHand = async (): Promise<number> => (await balances(db, { resourceId: fx.storeId })).reduce((s, b) => s + b.qtyOnHand, 0);

  it("spec #1023 D1: a dispense created while the switch is off bills at ₹0, keeps its MRP, and needs no tender", async () => {
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", true, BEFORE);
    const id = await picked();
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    expect(preview.free).toBe(true);
    expect(preview.totals.netPayablePaise).toBe(0);
    expect(preview.totals.grossPaise).toBeGreaterThan(0);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [] }, MON2);
    const { invoice, lines } = await billOf(id);
    expect(invoice.netPayablePaise).toBe(0);
    expect(lines[0]!.grossPaise).toBeGreaterThan(0);
    expect(lines[0]!.discountPaise).toBe(lines[0]!.grossPaise);
    await expect(billDispense(db, fx.pharmacist.actor, await picked(), { tenders: [{ mode: "cash", amountPaise: 100 }] }, MON2))
      .rejects.toMatchObject({ code: "free_bill_takes_no_money" });
  });

  it("spec #1023 D2: a dispense created while the switch is on bills at MRP as before", async () => {
    const id = await picked();
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    expect(preview.free).toBe(false);
    expect(preview.totals.netPayablePaise).toBeGreaterThan(0);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    expect((await billOf(id)).invoice.netPayablePaise).toBe(preview.totals.netPayablePaise);
  });

  it("spec #1023 D3: a free dispense moves stock exactly as a paid one does", async () => {
    const start = await onHand();
    const paid = await picked();
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, paid, MON2);
    await billDispense(db, fx.pharmacist.actor, paid, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, paid, {}, MON3);
    const afterPaid = await onHand();
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", true, MON3);
    const later = new Date(MON3.getTime() + 60_000);
    const free = await picked(later);
    await billDispense(db, fx.pharmacist.actor, free, { tenders: [] }, later);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, free, {}, later);
    expect(start - afterPaid).toBe(20);
    expect(afterPaid - (await onHand())).toBe(20);
  });

  it("spec #1023 D4: each flip is audited with who and when, and the Fees page lists the switch", async () => {
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", true, BEFORE);
    const view = await feeSwitchesView(db, MON);
    expect(view.switches.find((s) => s.kind === "pharmacy")).toEqual({
      kind: "pharmacy", off: true, changedAt: BEFORE.toISOString(), changedBy: fx.pharmacist.id,
    });
    const audit = await db.select().from(events).where(eq(events.name, "fee_switch.changed"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: fx.pharmacist.id, payload: { kind: "pharmacy", off: true } });
  });

  it("spec #1023 D5: a free medicine returned goes back on the shelf, and no refund and no credit arise", async () => {
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", true, BEFORE);
    const id = await picked();
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    const before = await onHand();
    const done = await acceptReturn(db, fx.pharmacist.actor, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "the doctor changed the medicine", reasonClass: "genuine",
    }, new Date(MON3.getTime() + 60_000));
    expect(done.refundApprovalId).toBeNull();
    expect(done.creditNotePaise).toBe(0);
    expect(await onHand()).toBe(before + 10);
    expect((await pharmacyCreditOf(db, (await getDispense(db, fx.pharmacist.actor, id, MON3)).patient.id)).availablePaise).toBe(0);
  });

  it("spec #1023 D6: flipping the switch does not change a dispense already created", async () => {
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", true, BEFORE);
    const free = await picked();
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", false, MON3);
    const after = new Date(MON3.getTime() + 60_000);
    expect((await previewDispenseBill(db, fx.pharmacist.actor, free, after)).totals.netPayablePaise).toBe(0);

    const charged = await picked(after);
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", true, new Date(after.getTime() + 30_000));
    expect((await previewDispenseBill(db, fx.pharmacist.actor, charged, new Date(after.getTime() + 60_000))).totals.netPayablePaise).toBeGreaterThan(0);
  });

  it("spec #1023 D7: a walk-in sale made while the switch is off is ₹0 with no tender, and its stock moves", async () => {
    const { resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    const manager = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
    await recordRetailLicence(db, manager.actor, {
      form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni",
    }, MON);
    const batchId = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, resourceId: retailId });
    await setFeeSwitch(db, fx.pharmacist.actor, "pharmacy", true, BEFORE);
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    const preview = await previewRetailSale(db, fx.pharmacist.actor, { lines }, MON);
    expect(preview.free).toBe(true);
    expect(preview.totals.netPayablePaise).toBe(0);
    const sale = await sellRetail(db, docs, fx.pharmacist.actor, {
      customer: { register: { name: "Ramesh Patil", sex: "male", ageYears: 52, phone: "9822001122" } }, lines, tenders: [],
    }, undefined, MON);
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, sale.invoiceId));
    expect(invoice!.netPayablePaise).toBe(0);
    expect((await balances(db, { resourceId: retailId, batchId })).reduce((s, b) => s + b.qtyOnHand, 0)).toBe(40);
  });
});
