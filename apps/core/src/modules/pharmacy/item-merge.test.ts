import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { pharmacyDispenseLines, pharmacySaleItems, pharmacyShelfLocations, pharmacyShortBook, stockBatches } from "../../kernel/db/schema";
import { registerItem, registerMaterialsApprovalTypes, sellableBatchesByItem } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { pharmacyCopilotTools } from "./copilot-tools";
import { handOverDispense } from "./handover";
import { officeExecuteMerge, officeItems, officeMergePreview, officeRaiseMerge } from "./item-merge";
import { pickDispense } from "./pick";
import { getSaleItem, registerSaleItem, requireActiveSaleItem, setSaleItemActive } from "./sale-items";
import { marginReport, salesRegister } from "./sales-register";
import { setShelfLocation } from "./shelf-locations";
import { addShortBookEntry } from "./short-book";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 (HYGIENE) — ITEM MERGE AT THE COUNTER AND IN THE OFFICE ═══
 *
 * The same Crocin 500 registered twice: `CROC500` (the fixture's, A) and `CROC500X` (B, a duplicate with
 * its own sale registration, shelf label, short-book row and stock). After the merge —
 *   - the desk's FEFO candidates for A include B's moved batch, and the next dispense picks it first;
 *   - B's sale registration is retired, A keeps its own `RX-` service (or takes one when it had none);
 *   - B's shelf label and open short-book row are A's; B cannot be registered, re-enabled or shelved again;
 *   - the sales register and the margin show what B sold under A;
 * — and a dispense that is not handed over, naming B, blocks the merge. The agent's duplicates list and its
 * copilot tool find the pair.
 */
const DAY = "2026-08-17";
const range = { preset: "custom", from: DAY, to: DAY };

describe("item merge at the counter and in the office (pharmacy P6 hygiene)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let head: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let dup: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await seedSodPairs(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "medical_superintendent", "owner"]) await ensureRole(db, role);
    for (const p of ["materials.items.merge", "materials.stock.read", "pharmacy.sale_items.manage"]) await grantPermissionToRole(db, fx.registry, "materials_head", p);
    for (const p of ["approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, fx.registry, "medical_superintendent", p);
    for (const p of ["pharmacy.reports.read", "pharmacy.reports.margin"]) await grantPermissionToRole(db, fx.registry, "owner", p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    dup = await withTx(db, async (tx) => {
      const { itemId } = await registerItem(tx, head.actor, {
        code: "CROC500X", name: "Crocin 500 tab", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.crocin, gstRateBps: 1200,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return itemId;
    });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", expiryDate: "2027-12-31", qtyBase: 50 });
    await stockIn(db, fx, { itemId: dup, batchNo: "CR-B", expiryDate: "2027-03-31", qtyBase: 30 });
  });
  afterEach(() => { fx.unregister(); });

  /** A crocin prescription claimed at the counter; returns the dispense id. */
  async function claimed(qty: number): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "TDS", durationDays: 5 })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: qty }] }, MON2);
    return r.dispense.id;
  }

  /** Claimed, picked, billed and handed over. */
  async function sold(qty: number): Promise<string> {
    const id = await claimed(qty);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: "3210" } }, MON3);
    return id;
  }

  async function merge(): Promise<void> {
    const m = await officeRaiseMerge(db, head.actor, { survivorItemId: fx.item.crocin, mergedItemId: dup, reason: "Crocin 500 registered twice", source: "agent" }, MON3);
    await approveRequest(db, ms.actor, { approvalId: m.approvalId, note: "the same strip" });
    const done = await officeExecuteMerge(db, head.actor, m.id, MON3);
    expect(done.status).toBe("merged");
  }

  it("the desk's FEFO candidates for A include B's moved batch, and the next dispense picks it first", async () => {
    await merge();
    const offered = (await sellableBatchesByItem(db, fx.storeId, [fx.item.crocin], MON3)).get(fx.item.crocin) ?? [];
    expect(offered.map((b) => [b.batchNo, b.expiryDate, b.available])).toEqual([["CR-B", "2027-03-31", 30], ["CR-A", "2027-12-31", 50]]);
    expect((await sellableBatchesByItem(db, fx.storeId, [dup], MON3)).get(dup)).toBeUndefined();

    const id = await claimed(10);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    const [l] = await db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, id));
    const [batch] = await db.select().from(stockBatches).where(eq(stockBatches.id, l!.batchId!));
    expect([l!.itemId, batch!.batchNo, batch!.itemId]).toEqual([fx.item.crocin, "CR-B", fx.item.crocin]);
  });

  it("B's sale registration is retired and A keeps its own service; the shelf label and the open short-book row are A's; B is refused a new registration, a re-enable, a shelf", async () => {
    const aService = (await getSaleItem(db, fx.item.crocin))!.serviceId;
    await setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: dup, location: "R-7" }, MON2);
    await addShortBookEntry(db, fx.pharmacist.actor, { itemId: dup, drugName: "Crocin 500 tab", source: "desk" }, MON2);
    const preview = await officeMergePreview(db, head.actor, fx.item.crocin, dup);
    expect(preview.refusals).toEqual([]);
    expect(preview.moves.filter((m) => m.count > 0).map((m) => m.key)).toEqual(expect.arrayContaining(["stock", "saleItemRetired", "shelf", "shortBook"]));
    expect(preview.stock.map((s) => [s.batchNo, s.qtyBase, s.into])).toEqual([["CR-B", 30, "new_batch"]]);

    await merge();
    await expect(requireActiveSaleItem(db, dup)).rejects.toMatchObject({ code: "sale_item_inactive" });
    expect((await getSaleItem(db, fx.item.crocin))!.serviceId).toBe(aService);
    expect((await db.select().from(pharmacyShelfLocations)).map((s) => [s.itemId, s.location])).toEqual([[fx.item.crocin, "R-7"]]);
    expect((await db.select().from(pharmacyShortBook)).map((s) => [s.itemId, s.drugName, s.resolvedAt])).toEqual([[fx.item.crocin, "Crocin 500 tablet", null]]);
    // A shortage noted against B from now on is A's (the same open row).
    expect((await addShortBookEntry(db, fx.pharmacist.actor, { itemId: dup, drugName: "Crocin", source: "desk" }, MON3)).created).toBe(false);

    await expect(withTx(db, (tx) => setSaleItemActive(tx, head.actor, dup, true))).rejects.toMatchObject({ code: "item_merged" });
    await expect(setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: dup, location: "R-8" }, MON3)).rejects.toMatchObject({ code: "item_merged" });
  });

  it("when only B was registered for sale, A is registered with its own service at the merge", async () => {
    const plain = (await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "CROC500S", name: "Crocin 500 strip", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.crocin, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }))).itemId;
    expect(await getSaleItem(db, plain)).toBeUndefined();
    const m = await officeRaiseMerge(db, head.actor, { survivorItemId: plain, mergedItemId: dup, reason: "the same strip" }, MON3);
    await approveRequest(db, ms.actor, { approvalId: m.approvalId, note: "ok" });
    await officeExecuteMerge(db, head.actor, m.id, MON3);
    const a = await getSaleItem(db, plain);
    expect(a).toMatchObject({ active: true });
    expect(a!.serviceId).not.toBe((await getSaleItem(db, dup))!.serviceId);
    expect(await getSaleItem(db, dup)).toMatchObject({ active: false });
    expect((await db.select().from(pharmacySaleItems).where(eq(pharmacySaleItems.itemId, plain))).length).toBe(1);
    await expect(withTx(db, (tx) => registerSaleItem(tx, fx.pharmacist.actor, dup))).rejects.toMatchObject({ code: "item_merged" });
  });

  it("a dispense not yet handed over that names B blocks the merge (a handed-over one does not: the sales register case merges after one)", async () => {
    // Two items over one medicine: the counter picks the last by code — B.
    const id = await claimed(5);
    const [l] = await db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, id));
    expect(l!.itemId).toBe(dup);
    const blocked = await officeMergePreview(db, head.actor, fx.item.crocin, dup);
    expect(blocked.refusals.map((r) => r.rule)).toContain("open_dispense");
    await expect(officeRaiseMerge(db, head.actor, { survivorItemId: fx.item.crocin, mergedItemId: dup, reason: "dup" }, MON3)).rejects.toMatchObject({ code: "item_merge_blocked" });
  });

  it("the sales register and the margin show what B sold under A", async () => {
    await sold(10); // sold as B (the counter's pick before the merge)
    await merge();
    await sold(6); // sold as A
    const byItem = await salesRegister(db, owner.actor, { ...range, groupBy: "item" }, MON3);
    expect(byItem.groups.map((g) => [g.sub, g.qtyBase])).toEqual([["CROC500", 16]]);
    const m = await marginReport(db, owner.actor, { ...range, groupBy: "item" }, MON3);
    expect(m.rows.map((r) => [r.sub, r.qtyBase, r.costPaise])).toEqual([["CROC500", 16, 16 * 500]]);
  });

  it("the office's items side and the copilot find the pair the agent would merge", async () => {
    const side = await officeItems(db, head.actor);
    expect(side.duplicates.map((d) => [d.why, d.survivor.code, d.merged.code])).toEqual([["same_medicine", "CROC500", "CROC500X"]]);
    const tool = pharmacyCopilotTools.find((t) => t.intent === "find_duplicate_items")!;
    expect(tool.permission).toBe("materials.items.merge");
    const answer = await tool.run({ db, actor: head.actor, subject: null, serviceDate: DAY, question: "duplicate items dikhao" } as Parameters<typeof tool.run>[0]);
    expect(answer).toMatchObject({ key: "copilot.answer.duplicateItems", params: { pairs: 1, sameMedicine: 1 }, payload: { href: "/pharmacy/office?view=items" } });
    await merge();
    const after = await officeItems(db, head.actor);
    expect(after.duplicates).toEqual([]);
    expect(after.recent.map((r) => [r.status, r.source, r.merged.code])).toEqual([["merged", "agent", "CROC500X"]]);
  });
});
