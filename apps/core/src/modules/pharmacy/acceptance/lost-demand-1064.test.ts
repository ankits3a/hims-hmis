import { asc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../../test/helpers/pharmacy";
import { mkUser, testCfg } from "../../../../test/helpers/opd";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { patients, pharmacyDemand, pharmacyDispenseLines } from "../../../kernel/db/schema";
import {
  activateVendor, addVendorDocument, createPurchaseOrder, createStore, decidePurchaseOrder, registerMaterialsApprovalTypes, registerVendor, submitPurchaseOrder,
} from "../../materials";
import { claimDispense, findAtCounter } from "../claim";
import { RETAIL_PHARMACY_STORE_CODE } from "../config";
import { officeMissedSales } from "../office-reports";
import { pickDispense } from "../pick";
import { searchRetailShelf } from "../retail";
import { listOpenShortBook, noteAskedFor, resolveShortBookEntry } from "../short-book";
import { declineLine, verifyDispense } from "../verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Db } from "../../../kernel/db/client";
import type { DispenseView } from "../queue";
import type { RxLine } from "../../opd";

/**
 * ACCEPTANCE — issue #1064, spec docs/specs/1064-lost-demand.md (owner APPROVED 2026-11-14): a medicine asked for and
 * not supplied leaves a demand row (no patient on it) and raises the short book; the office's Missed sales report
 * counts them. The screens' half is apps/web/src/screens/acceptance/lost-demand-1064.test.tsx.
 *
 * Every act is given its time (MON..MON3, one IST day); the report reads "today" of the time it is given.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

describe("lost demand and the missed-sales report (spec #1064)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let A: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    A = fx.pharmacist.actor;
  });
  afterEach(() => { fx.unregister(); });

  /** The doctor's e-prescription, found at the counter by its QR and claimed: the claimed ticket. */
  async function ticket(lines: RxLine[]): Promise<DispenseView> {
    const { issued } = await issueRx(db, fx, lines, { at: MON });
    const found = await findAtCounter(db, testCfg, A, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("no dispense");
    return claimDispense(db, A, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);
  }

  async function retailStore(): Promise<string> {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    return resourceId;
  }

  const demandRows = async () => db.select().from(pharmacyDemand).orderBy(asc(pharmacyDemand.notedAt), asc(pharmacyDemand.id));
  const calpol = (): RxLine => line({ drug: "Calpol 500", medicineId: fx.med.calpol });

  it("spec #1064 D1: declining a desk line as 'Not in stock' records a demand row and a short-book entry with source counter", async () => {
    const t = await ticket([calpol()]);
    const asked = t.lines[0]!.qtyBase!;
    expect(asked).toBeGreaterThan(0);

    const view = await declineLine(db, A, fx.decls, t.id, 0, "Not in stock", MON2, { reasonCode: "not_in_stock" });
    expect(view.lines[0]).toMatchObject({ status: "declined", declinedReason: "Not in stock" });

    const book = await listOpenShortBook(db);
    expect(book).toEqual([expect.objectContaining({ itemId: fx.item.calpol, source: "counter", askedCount: 1, askedQtyBase: asked })]);
    const rows = await demandRows();
    expect(rows).toEqual([expect.objectContaining({
      source: "desk_decline", itemId: fx.item.calpol, medicineId: fx.med.calpol, typedName: null, qtyAskedBase: asked,
      storeResourceId: fx.storeId, dispenseId: t.id, notedBy: A.id, notedAt: MON2, shortBookEntryId: book[0]!.id,
    })]);
    // No patient on a demand row (privacy): the ticket links it, nothing names the person.
    expect(Object.keys(rows[0]!).filter((k) => /patient/i.test(k))).toEqual([]);
  });

  it("spec #1064 D2: declining a line for any other reason records no demand", async () => {
    const t = await ticket([
      line({ drug: "Azee 500", medicineId: fx.med.azithro }),
      line({ drug: "Brufen 400", medicineId: fx.med.ibuprofen }),
      line({ drug: "Ascoril LS syrup" }),
      calpol(),
    ]);
    await declineLine(db, A, fx.decls, t.id, 0, "patient has it at home", MON2, { reasonCode: "patient_declined" });
    await declineLine(db, A, fx.decls, t.id, 1, "too costly", MON2, { reasonCode: "cost" });
    await declineLine(db, A, fx.decls, t.id, 2, "doctor to change it", MON2, { reasonCode: "other" });
    // The one line declined as not in stock is the one demand.
    await declineLine(db, A, fx.decls, t.id, 3, "Not in stock", MON2, { reasonCode: "not_in_stock" });
    // A caller that sends only text (as before this spec) declines with no code, and the words are not read as one.
    const u = await ticket([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await declineLine(db, A, fx.decls, u.id, 0, "out of stock", MON2);

    const book = await listOpenShortBook(db);
    expect(book.map((e) => e.itemId)).toEqual([fx.item.calpol]);
    expect((await demandRows()).map((r) => ({ source: r.source, itemId: r.itemId, dispenseId: r.dispenseId }))).toEqual([{ source: "desk_decline", itemId: fx.item.calpol, dispenseId: t.id }]);
    const codes = await db.select({ dispenseId: pharmacyDispenseLines.dispenseId, code: pharmacyDispenseLines.declinedReasonCode })
      .from(pharmacyDispenseLines).orderBy(asc(pharmacyDispenseLines.dispenseId), asc(pharmacyDispenseLines.lineIdx));
    expect(codes.filter((c) => c.dispenseId === t.id).map((c) => c.code)).toEqual(["patient_declined", "cost", "other", "not_in_stock"]);
    expect(codes.filter((c) => c.dispenseId === u.id).map((c) => c.code)).toEqual([null]);
  });

  it("spec #1064 D3: at the walk-in counter, 'Note as asked for' after a search with no stock records a demand and a short-book entry; a typed name not in the catalogue records a demand without a short-book entry", async () => {
    const retailId = await retailStore();
    const [hit] = (await searchRetailShelf(db, A, "Calpol", MON)).filter((e) => e.itemId === fx.item.calpol);
    expect(hit).toMatchObject({ itemId: fx.item.calpol, available: 0 });

    const noted = await noteAskedFor(db, A, { source: "counter_search", itemId: hit!.itemId, medicineId: hit!.medicineId, qtyBase: 10 }, MON);
    expect(noted.demand).toMatchObject({
      source: "counter_search", itemId: fx.item.calpol, medicineId: fx.med.calpol, typedName: null, qtyAskedBase: 10, storeResourceId: retailId, dispenseId: null, notedBy: A.id,
    });
    expect(noted.shortBook).toMatchObject({ created: true, entry: { itemId: fx.item.calpol, source: "counter", askedCount: 1, askedQtyBase: 10, storeResourceId: retailId } });
    expect(noted.demand.shortBookEntryId).toBe(noted.shortBook!.entry.id);
    expect(await listOpenShortBook(db, RETAIL_PHARMACY_STORE_CODE)).toEqual([expect.objectContaining({ itemId: fx.item.calpol, source: "counter", askedCount: 1 })]);

    expect(await searchRetailShelf(db, A, "Ascoril LS syrup", MON)).toEqual([]);
    const typed = await noteAskedFor(db, A, { source: "counter_search", typedName: "Ascoril LS syrup" }, MON2);
    expect(typed.demand).toMatchObject({ source: "counter_search", itemId: null, typedName: "Ascoril LS syrup", qtyAskedBase: 1, storeResourceId: retailId, shortBookEntryId: null });
    expect(typed.shortBook).toBeNull();
    expect((await listOpenShortBook(db, RETAIL_PHARMACY_STORE_CODE)).map((e) => e.itemId)).toEqual([fx.item.calpol]);
    expect(await listOpenShortBook(db)).toEqual([]);
    expect(await demandRows()).toHaveLength(2);
  });

  it("spec #1064 D4: the same medicine asked for three times while its short-book entry is open leaves one entry with the asked count 3 and the quantities summed", async () => {
    await retailStore();
    const ask = (source: "counter_search" | "counter_short", qtyBase: number, at: Date) =>
      noteAskedFor(db, A, { source, itemId: fx.item.calpol, medicineId: fx.med.calpol, qtyBase }, at);
    const first = await ask("counter_search", 10, MON);
    const second = await ask("counter_short", 5, MON2);
    const third = await ask("counter_search", 20, MON3);
    expect([first.shortBook?.created, second.shortBook?.created, third.shortBook?.created]).toEqual([true, false, false]);

    const book = await listOpenShortBook(db, RETAIL_PHARMACY_STORE_CODE);
    expect(book).toEqual([expect.objectContaining({ itemId: fx.item.calpol, source: "counter", askedCount: 3, askedQtyBase: 35 })]);
    const rows = await demandRows();
    expect(rows.map((r) => [r.source, r.qtyAskedBase, r.shortBookEntryId])).toEqual([
      ["counter_search", 10, book[0]!.id], ["counter_short", 5, book[0]!.id], ["counter_search", 20, book[0]!.id],
    ]);

    // Once the entry is closed, the next ask opens a new one.
    await resolveShortBookEntry(db, A, book[0]!.id, "ordered", MON3);
    const fourth = await ask("counter_search", 4, MON3);
    expect(fourth.shortBook).toMatchObject({ created: true, entry: { askedCount: 1, askedQtyBase: 4 } });
    expect(fourth.shortBook!.entry.id).not.toBe(book[0]!.id);
  });

  it("spec #1064 D5: a line picked short with a balance owed records a demand for the owed quantity", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000 });
    const t = await ticket([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await verifyDispense(db, A, fx.decls, t.id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON2);
    const picked = await pickDispense(db, A, fx.decls, t.id, { lines: [{ lineIdx: 0, qtyBase: 10, pickNote: "one strip on the shelf, rest tomorrow" }] }, MON2);
    expect(picked.lines[0]!.owedQtyBase).toBe(10);

    const book = await listOpenShortBook(db);
    expect(book).toEqual([expect.objectContaining({ itemId: fx.item.crocin, source: "counter", askedCount: 1, askedQtyBase: 10 })]);
    expect(await demandRows()).toEqual([expect.objectContaining({
      source: "balance_owed", itemId: fx.item.crocin, medicineId: fx.med.crocin, qtyAskedBase: 10, storeResourceId: fx.storeId, dispenseId: t.id, shortBookEntryId: book[0]!.id,
    })]);

    // A patient who asked for less is owed nothing, and nothing was lost.
    const u = await ticket([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await verifyDispense(db, A, fx.decls, u.id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON3);
    await pickDispense(db, A, fx.decls, u.id, { lines: [{ lineIdx: 0, qtyBase: 10, pickNote: "only wants one strip", short: "patient" }] }, MON3);
    expect(await demandRows()).toHaveLength(1);
    expect(await listOpenShortBook(db)).toEqual([expect.objectContaining({ itemId: fx.item.crocin, askedCount: 1, askedQtyBase: 10 })]);
  });

  it("spec #1064 D6: the Missed sales report lists each medicine with times asked, quantity, estimated value, stock now and open PO quantity, and the typed names apart", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const p of ["materials.vendors.manage", "materials.po.raise", "pharmacy.reports.read"]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
    const head = await mkUser(db, "mat.head", ["materials_head"]);
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, fx.incharge.actor, { code: "ALPHA", legalName: "ALPHA Distributors Pvt Ltd" }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, fx.incharge.actor, vendorId, new Date()));
    // Two strips of Calpol on order (20 tablets), approved and not yet received.
    const po = await createPurchaseOrder(db, A, { vendorId, storeResourceId: fx.storeId, lines: [{ itemId: fx.item.calpol, qtyPacks: 2, ratePaise: 7_000 }] });
    await submitPurchaseOrder(db, A, po.id);
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok");

    // Calpol's only batch has expired: its MRP (₹90 a strip of 10, ₹9 a tablet) is known, nothing can be sold.
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-OLD", qtyBase: 10, expiryDate: "2026-01-31", mrpPaise: 9000 });
    // Crocin: 100 on the shelf at ₹120 a strip (₹12 a tablet).
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000 });

    // Calpol declined at the desk as not in stock, and asked for at the walk-in counter.
    const t = await ticket([calpol()]);
    const asked = t.lines[0]!.qtyBase!;
    await declineLine(db, A, fx.decls, t.id, 0, "Not in stock", MON2, { reasonCode: "not_in_stock" });
    await retailStore();
    await noteAskedFor(db, A, { source: "counter_search", itemId: fx.item.calpol, medicineId: fx.med.calpol, qtyBase: 10 }, MON2);
    // A name the catalogue does not carry, said twice, spelt two ways.
    await noteAskedFor(db, A, { source: "counter_search", typedName: "Ascoril LS syrup" }, MON2);
    await noteAskedFor(db, A, { source: "counter_search", typedName: "ascoril ls syrup", qtyBase: 2 }, MON3);
    // Crocin picked short: ten owed. Its pick holds ten of the hundred until hand-over.
    const c = await ticket([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await verifyDispense(db, A, fx.decls, c.id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON2);
    await pickDispense(db, A, fx.decls, c.id, { lines: [{ lineIdx: 0, qtyBase: 10, pickNote: "one strip on the shelf" }] }, MON2);

    const report = await officeMissedSales(db, A, { preset: "today" }, MON3);
    expect(report).toMatchObject({ from: "2026-08-17", to: "2026-08-17" });
    expect(report.rows).toEqual([
      expect.objectContaining({ itemId: fx.item.calpol, itemName: "Calpol 500 tablet", timesAsked: 2, qtyBase: asked + 10, estimatedValuePaise: (asked + 10) * 900, stockNow: 0, openPoBase: 20 }),
      expect.objectContaining({ itemId: fx.item.crocin, itemName: "Crocin 500 tablet", timesAsked: 1, qtyBase: 10, estimatedValuePaise: 12_000, stockNow: 90, openPoBase: 0 }),
    ]);
    expect(report.typed).toEqual([expect.objectContaining({ name: "Ascoril LS syrup", timesAsked: 2, qtyBase: 3 })]);

    // No patient on the report.
    const [patient] = await db.select().from(patients).where(eq(patients.id, fx.patient.id));
    const text = JSON.stringify(report);
    for (const s of [patient!.id, patient!.uhid, patient!.name]) expect(text).not.toContain(s);
    // The sales report's right: a pharmacy assistant without it is refused.
    await expect(officeMissedSales(db, fx.aide.actor, { preset: "today" }, MON3)).rejects.toMatchObject({ code: "permission_denied" });
  });
});
