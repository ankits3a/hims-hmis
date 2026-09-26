import { and, eq, inArray, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { SodViolationError, seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import {
  events, grnLines, grns, itemBarcodes, itemMerges, itemStockLevels, itemUoms, items, purchaseOrderLines, stockBalances, stockBatches, stockLedger,
} from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { addMedicine, addSalt } from "../formulary";
import { registerMaterialsApprovalTypes } from "./approval-types";
import { captureGrn, postGrn, runGateQc } from "./grn";
import { executeItemMerge, findDuplicateItems, getItemMerge, itemMergePreview, raiseItemMerge, similarNames } from "./item-merge";
import { registerItem, resolveBarcode, updateItem } from "./items";
import { consumedQtyByItem, movementsFor, postMovement, reserveStock } from "./ledger";
import { createPurchaseOrder, lastPurchaseByItem, setStockLevel } from "./purchase-orders";
import { getRecall, raiseRecall } from "./recalls";
import { nonMovingStock, stockValuationAt } from "./reports";
import { createStore } from "./stores";
import { issueStock } from "./transfers";
import { activateVendor, addVendorDocument, registerVendor } from "./vendors";
import type { MergeRule } from "./item-merge";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 (HYGIENE) — MERGE A DUPLICATE ITEM: THE STOCK AND THE OPEN WORK MOVE, THE HISTORY STAYS ═══
 *
 *   - after the merge the survivor holds what both held, batch by batch (same number, expiry, MRP, cost,
 *     supplier), and the duplicate holds nothing — through the ledger, an `adjust` pair per batch per store;
 *   - the duplicate's history is not rewritten: every ledger row, batch and receipt line it had is
 *     byte-for-byte what it was (a checksum), and the only rows added under its id are the merge's own;
 *   - the reads that aggregate history — valuation on a past day, consumption for reorder, non-moving,
 *     the last purchase, the item's movements, a recall's callback list — show the survivor's combined picture;
 *   - the duplicate is refused for a new order, receipt, level or edit;
 *   - the pair must be one thing, and open work that names the duplicate blocks the merge — each rule;
 *   - the medical superintendent approves (never the head who raised it); nothing moves before.
 *
 * Fixtures: a strip is 10 tablets at ₹2.50 a tablet; batches expire 2028-06-30.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const DAY_BEFORE = "2026-09-24";
const MERGE_AT = new Date("2026-09-25T06:30:00.000Z"); // noon IST, 25 Sep

describe("item merge (pharmacy P6 hygiene)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let head2: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let store: string;
  let main: string;
  let vendor: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "pharmacy", "storekeeper", "medical_superintendent"]) await ensureRole(db, role);
    const grants: Record<string, string[]> = {
      materials_head: [
        "materials.items.merge", "materials.po.raise", "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage",
        "materials.vendors.manage", "materials.recall.manage", "materials.stock.issue", "approvals.requests.decide", "approvals.requests.read",
      ],
      pharmacy: ["materials.stock.read", "materials.grn.qc"],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
      medical_superintendent: ["approvals.requests.decide", "approvals.requests.read"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    head2 = await mkUser(db, "mat.head2", ["materials_head"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ resourceId: main } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN", name: "Main store" })));
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "ACME", legalName: "ACME Pharma Pvt Ltd", gstin: "27AAACA1234A1Z5" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    vendor = vendorId;
  });

  async function anItem(code: string, name: string, over: { class?: string; baseUom?: string; storageClass?: string; medicineId?: string; strip?: number; box?: number } = {}): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name, class: over.class ?? (over.medicineId === undefined ? "consumable" : "drug"), baseUom: over.baseUom ?? "tablet", batchTracked: true,
      gstRateBps: 1200, hsnCode: "30049099", storageClass: over.storageClass ?? "ambient",
      ...(over.medicineId === undefined ? {} : { formularyMedicineId: over.medicineId }),
      uoms: [{ uom: "strip", toBaseMultiplier: over.strip ?? 10, isPurchaseUom: true }, ...(over.box === undefined ? [] : [{ uom: "box", toBaseMultiplier: over.box }])],
    }));
    return itemId;
  }

  /** A posted GRN of `strips` strips at ₹25 a strip into `into`. */
  async function received(itemId: string, strips: number, batchNo: string, opts: { into?: string; expiry?: string; post?: boolean; now?: Date; mrpPaise?: number } = {}): Promise<{ grnId: string; batchId: string }> {
    const now = opts.now ?? at(10);
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: vendor, source: "challan", storeResourceId: opts.into ?? store, challanNo: `CH-${batchNo}`, challanDate: "2026-09-24", invoiceNo: `INV-${batchNo}`,
      lines: [{ itemId, uom: "strip", qtyInUom: strips, batchNo, expiryDate: opts.expiry ?? "2028-06-30", unitCostPaise: 250, mrpPaise: opts.mrpPaise ?? 5000, mrpUom: "strip" }],
      now,
    }));
    if (opts.post === false) return { grnId, batchId: "" };
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, new Date(now.getTime() + 60_000)));
    const [batch] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, itemId), eq(stockBatches.batchNo, batchNo)));
    return { grnId, batchId: batch!.id };
  }

  const onHand = async (itemId: string): Promise<number> => Number((await db.select({ n: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)` })
    .from(stockBalances).where(eq(stockBalances.itemId, itemId)))[0]?.n ?? 0);

  /** Raised by the head, granted by the medical superintendent, carried out by the head. */
  async function merged(survivorItemId: string, mergedItemId: string, now: Date = MERGE_AT): Promise<string> {
    const m = await raiseItemMerge(db, head.actor, { survivorItemId, mergedItemId, reason: "the same strip registered twice" }, {}, now);
    await approveRequest(db, ms.actor, { approvalId: m.approvalId, note: "same drug, merge" });
    const done = await executeItemMerge(db, head.actor, m.id, {}, now);
    expect(done.status).toBe("merged");
    return m.id;
  }

  async function rules(survivorItemId: string, mergedItemId: string): Promise<MergeRule[]> {
    return (await itemMergePreview(db, head.actor, survivorItemId, mergedItemId)).refusals.map((r) => r.rule);
  }

  it("the survivor then holds what both held, batch by batch; the duplicate's history is untouched and only the merge's own rows are added", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)", { box: 100 });
    await received(a, 10, "A-1");
    const b1 = await received(b, 5, "B-1");
    const b2 = await received(b, 3, "B-2", { into: main, expiry: "2027-12-31" });
    // A dispense-like use of B before the merge: its history.
    await withTx(db, (tx) => postMovement(tx, head.actor, { resourceId: store, batchId: b1.batchId, qtyDelta: -4, reason: "consume", refType: "test", refId: "x", occurredAt: at(30) }));
    await db.insert(itemBarcodes).values({ id: "01BARCODEDUPLICATE00000001", itemId: b, code: "8901234567890", packUom: "box" });

    const before = { a: await onHand(a), b: await onHand(b) };
    expect(before).toEqual({ a: 100, b: 46 + 30 });
    const checksum = async (): Promise<{ n: number; sum: string }> => {
      const [r] = await db.select({
        n: sql<string>`count(*)`,
        sum: sql<string>`md5(coalesce(string_agg(${stockLedger.id} || ':' || ${stockLedger.batchId} || ':' || ${stockLedger.qtyDelta} || ':' || ${stockLedger.reason} || ':' || ${stockLedger.itemId} || ':' || ${stockLedger.occurredAt}, '|' order by ${stockLedger.seq}), ''))`,
      }).from(stockLedger).where(and(eq(stockLedger.itemId, b), sql`coalesce(${stockLedger.refType}, '') <> 'item_merge'`));
      return { n: Number(r!.n), sum: r!.sum };
    };
    const batchSum = async (): Promise<string> => (await db.select({ s: sql<string>`md5(string_agg(row_to_json(b)::text, '|' order by b.id))` }).from(sql`stock_batches b`).where(sql`b.item_id = ${b}`))[0]!.s;
    const grnSum = async (): Promise<string> => (await db.select({ s: sql<string>`md5(string_agg(row_to_json(g)::text, '|' order by g.id))` }).from(sql`grn_lines g`).where(sql`g.item_id = ${b}`))[0]!.s;
    const history = { ledger: await checksum(), batches: await batchSum(), grn: await grnSum() };
    expect(history.ledger.n).toBe(3); // two receipts and one use

    const mergeId = await merged(a, b);

    // The survivor holds both; the duplicate holds nothing.
    expect(await onHand(a)).toBe(before.a + before.b);
    expect(await onHand(b)).toBe(0);
    // History: byte-identical, the same count — the merge only appended its own rows under B.
    expect(await checksum()).toEqual(history.ledger);
    expect(await batchSum()).toBe(history.batches);
    expect(await grnSum()).toBe(history.grn);
    const mergeRows = await db.select().from(stockLedger).where(and(eq(stockLedger.refType, "item_merge"), eq(stockLedger.refId, mergeId)));
    expect(mergeRows.map((r) => [r.itemId === a ? "A" : "B", r.reason, r.qtyDelta]).sort()).toEqual([
      ["A", "adjust", 30], ["A", "adjust", 46], ["B", "adjust", -30], ["B", "adjust", -46],
    ].sort());
    // Batch by batch: A's batch of each number carries B's expiry, MRP, cost, supplier and receipt, at the same store.
    const twins = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, a), inArray(stockBatches.batchNo, ["B-1", "B-2"])));
    const originals = await db.select().from(stockBatches).where(eq(stockBatches.itemId, b));
    for (const o of originals) {
      const t = twins.find((x) => x.batchNo === o.batchNo)!;
      expect({ ...t, id: "", itemId: "", createdBy: "", createdAt: null }).toEqual({ ...o, id: "", itemId: "", createdBy: "", createdAt: null });
    }
    const bal = await db.select().from(stockBalances).where(inArray(stockBalances.batchId, twins.map((t) => t.id)));
    expect(bal.map((x) => [x.resourceId === store ? "OPD" : "MAIN", twins.find((t) => t.id === x.batchId)!.batchNo, x.qtyOnHand]).sort()).toEqual([["MAIN", "B-2", 30], ["OPD", "B-1", 46]]);
    // B is retired, one hop to A; its barcode and its box now belong to A.
    const [bRow] = await db.select().from(items).where(eq(items.id, b));
    expect(bRow).toMatchObject({ mergedIntoItemId: a, active: false });
    expect(await resolveBarcode(db, "8901234567890")).toEqual({ itemId: a, packUom: "box" });
    expect((await db.select().from(itemUoms).where(eq(itemUoms.itemId, a))).map((u) => [u.uom, u.toBaseMultiplier]).sort()).toEqual([["box", 100], ["strip", 10], ["tablet", 1]]);
    // The act's record and its event.
    const view = await getItemMerge(db, head.actor, mergeId);
    expect(view).toMatchObject({ status: "merged", survivor: { code: "GLV7" }, merged: { code: "GLV7X" }, mergedBy: head.id, approval: { status: "granted", decidedBy: ms.id } });
    expect(view.moved).toMatchObject({ unitsMoved: 76, barcodes: ["8901234567890"], packsAdded: [{ uom: "box", toBaseMultiplier: 100 }] });
    const [ev] = await db.select().from(events).where(eq(events.name, "item.merged"));
    expect(ev!.payload).toMatchObject({ mergeId, survivorItemId: a, mergedItemId: b, batchesMoved: 2, unitsMoved: 76 });
    // A second merge of B is refused: already merged.
    await expect(raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: b, reason: "again" })).rejects.toMatchObject({ code: "item_merge_invalid" });
  });

  it("the reads over history show the survivor's combined picture: valuation on a past day, reorder velocity, non-moving, last purchase, movements", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    await received(a, 10, "A-1", { now: at(10) });
    const b1 = await received(b, 5, "B-1", { now: at(20) });
    await withTx(db, (tx) => postMovement(tx, head.actor, { resourceId: store, batchId: b1.batchId, qtyDelta: -4, reason: "consume", refType: "test", refId: "x", occurredAt: at(30) }));
    await merged(a, b);

    // Valuation of the day BEFORE the merge: one row for A, what A and B held that evening.
    const past = await stockValuationAt(db, DAY_BEFORE);
    expect(past.byItem.map((g) => [g.code, g.qtyBase])).toEqual([["GLV7", 100 + 46]]);
    expect(new Set(past.rows.map((r) => r.itemCode))).toEqual(new Set(["GLV7"]));
    const today = await stockValuationAt(db, "2026-09-25");
    expect(today.byItem.map((g) => [g.code, g.qtyBase])).toEqual([["GLV7", 146]]);
    // Reorder velocity: what B consumed is A's.
    expect((await consumedQtyByItem(db, store, [a], at(0), at(24 * 60))).get(a)).toBe(4);
    // Non-moving over 30 days: A moved (B's use counts), so neither A's own batch nor B's moved batch is idle.
    const idle = await nonMovingStock(db, MERGE_AT, 30);
    expect(idle.rows.filter((r) => r.itemId === a)).toEqual([]);
    // The last purchase is B's receipt (the newer), in a pack A has.
    const last = (await lastPurchaseByItem(db, [a])).get(a)!;
    const [bGrn] = await db.select({ grnNo: grns.grnNo }).from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).where(eq(grnLines.itemId, b));
    expect(last).toMatchObject({ grnNo: bGrn!.grnNo, uom: "strip", multiplier: 10, ratePaise: 2500 });
    // The item's movements include B's rows, written against B.
    const moves = await movementsFor(db, { itemId: a });
    expect(moves.filter((m) => m.itemId === b).map((m) => m.reason)).toEqual(["grn", "consume", "adjust"]);
  });

  it("a recall of the moved batch reaches the patients the duplicate was dispensed to before the merge", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    const b1 = await received(b, 5, "B-1");
    await withTx(db, (tx) => postMovement(tx, head.actor, { resourceId: store, batchId: b1.batchId, qtyDelta: -2, reason: "consume", refType: "test", refId: "x", patientId: "PATIENT-1", occurredAt: at(30) }));
    await merged(a, b);
    const [twin] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, a), eq(stockBatches.batchNo, "B-1")));
    const { recall } = await raiseRecall(db, head.actor, { batchId: twin!.id, reason: "CDSCO alert", source: "cdsco" }, at(24 * 60 + 60));
    expect((await getRecall(db, head.actor, recall.id)).dispensed.map((d) => [d.patientId, d.qtyBase])).toEqual([["PATIENT-1", 2]]);
  });

  it("the duplicate is refused for a new order, receipt, level or edit — the refusal names the survivor", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    await merged(a, b);
    await expect(createPurchaseOrder(db, head.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: b, qtyPacks: 1, ratePaise: 2500 }] }))
      .rejects.toMatchObject({ code: "item_merged", detail: { survivorCode: "GLV7" } });
    await expect(received(b, 1, "B-9", { post: false })).rejects.toMatchObject({ code: "item_merged" });
    await expect(setStockLevel(db, head.actor, { itemId: b, storeResourceId: store, minBase: 0, reorderBase: 10, maxBase: 50 })).rejects.toMatchObject({ code: "item_merged" });
    await expect(withTx(db, (tx) => updateItem(tx, head.actor, b, { active: true }))).rejects.toMatchObject({ code: "item_merged" });
    // And the database says the same, whatever the path.
    await expect(db.update(items).set({ active: true }).where(eq(items.id, b))).rejects.toThrow(/items_merged_ck/);
  });

  it("open order lines, levels and barcodes move; the survivor's own level wins where both kept one", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    const po = await createPurchaseOrder(db, head.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: b, qtyPacks: 4, ratePaise: 2500 }] });
    await setStockLevel(db, head.actor, { itemId: a, storeResourceId: store, minBase: 10, reorderBase: 20, maxBase: 100 });
    await setStockLevel(db, head.actor, { itemId: b, storeResourceId: store, minBase: 1, reorderBase: 2, maxBase: 3 });
    await setStockLevel(db, head.actor, { itemId: b, storeResourceId: main, minBase: 5, reorderBase: 6, maxBase: 70 });
    await merged(a, b);
    expect((await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id))).map((l) => l.itemId)).toEqual([a]);
    const levels = await db.select().from(itemStockLevels).where(inArray(itemStockLevels.itemId, [a, b]));
    expect(levels.map((l) => [l.itemId === a ? "A" : "B", l.storeResourceId === store ? "OPD" : "MAIN", l.maxBase]).sort()).toEqual([["A", "MAIN", 70], ["A", "OPD", 100]]);
  });

  it("the pair must be one thing: each rule refuses with its reason", async () => {
    const para = await withTx(db, (tx) => addSalt(tx, pharmacist.actor, { name: "Paracetamol", drugClass: "analgesic" }));
    const azi = await withTx(db, (tx) => addSalt(tx, pharmacist.actor, { name: "Azithromycin", drugClass: "macrolide" }));
    const med = async (brandName: string, saltId: string, strength: string): Promise<string> => (await withTx(db, (tx) => addMedicine(tx, pharmacist.actor, {
      brandName, form: "tablet", routeClass: "systemic", strengthLabel: strength, scheduleFlag: "OTC", salts: [{ saltId, strength }],
    }))).medicineId;
    const crocin = await med("Crocin 500", para.saltId, "500 mg");
    const crocine = await med("Crocine 500", para.saltId, "500 mg"); // a typo'd brand: the same composition
    const para650 = await med("Dolo 650", para.saltId, "650 mg");
    const azee = await med("Azee 500", azi.saltId, "500 mg");
    const a = await anItem("CROC", "Crocin 500 tablet", { medicineId: crocin });
    const typo = await anItem("CROCE", "Crocine 500 tablet", { medicineId: crocine });
    const other = await anItem("DOLO", "Dolo 650 tablet", { medicineId: para650 });
    const macrolide = await anItem("AZEE", "Azee 500 tablet", { medicineId: azee });
    const glove = await anItem("GLV", "Glove");
    const ml = await anItem("SYR", "Crocin syrup", { medicineId: crocin, baseUom: "ml" });
    const pack = await anItem("CROC15", "Crocin 500 (15s)", { medicineId: crocin, strip: 15 });
    const narcoticGlove = await anItem("GLVN", "Glove (cabinet)", { storageClass: "narcotic" });
    const inactive = await anItem("CROCI", "Crocin (old)", { medicineId: crocin });
    await withTx(db, (tx) => updateItem(tx, head.actor, inactive, { active: false }));

    expect(await rules(a, typo)).toEqual([]); // same composition, strength, form, route: one thing
    expect(await rules(a, a)).toEqual(["same_item"]);
    expect(await rules(a, glove)).toContain("different_class");
    expect(await rules(a, other)).toContain("different_drug");
    expect(await rules(a, macrolide)).toContain("different_drug");
    expect(await rules(a, ml)).toContain("different_base_unit");
    expect(await rules(a, pack)).toContain("pack_conflict");
    expect(await rules(glove, narcoticGlove)).toContain("controlled_mismatch");
    expect(await rules(inactive, a)).toContain("survivor_inactive");
    // A raise with a refusal files nothing.
    await expect(raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: other, reason: "not the same" })).rejects.toMatchObject({
      code: "item_merge_invalid", detail: { refusals: [expect.objectContaining({ rule: "different_drug" })] },
    });
    expect(await db.select().from(itemMerges)).toEqual([]);
    // One open request per pair: a second raise naming either item is refused while the first waits.
    await raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: typo, reason: "a typo'd brand" });
    expect(await rules(a, typo)).toContain("request_open");
  });

  it("open work that names the duplicate blocks the merge: a reservation, a transfer in transit, an unposted receipt, an order carrying both, a batch that differs, a recall", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    const bb = await received(b, 5, "B-1");
    await received(a, 2, "B-1", { expiry: "2029-01-31" }); // the same number on A, another expiry

    await withTx(db, (tx) => reserveStock(tx, head.actor, { resourceId: store, batchId: bb.batchId, qty: 3, refType: "pharmacy_dispense", refId: "D-1" }));
    await withTx(db, (tx) => issueStock(tx, head.actor, { fromResourceId: store, toResourceId: main, lines: [{ itemId: b, qtyBase: 10 }], occurredAt: at(40) }));
    await received(b, 1, "B-2", { post: false });
    await createPurchaseOrder(db, head.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: a, qtyPacks: 1, ratePaise: 2500 }, { itemId: b, qtyPacks: 1, ratePaise: 2500 }] });
    expect(await rules(a, b)).toEqual(expect.arrayContaining(["reserved", "in_transit", "grn_open", "order_carries_both", "batch_conflict"] as MergeRule[]));
    await expect(raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: b, reason: "dup" })).rejects.toMatchObject({ code: "item_merge_blocked" });

    const c = await anItem("GLV7Y", "Glove size 7 (dup 2)");
    const cb = await received(c, 2, "C-1");
    await raiseRecall(db, head.actor, { batchId: cb.batchId, reason: "CDSCO alert", source: "cdsco" }, at(50));
    expect(await rules(a, c)).toContain("recalled_stock");
  });

  it("the medical superintendent approves, never the head who raised it; nothing moves before the grant, and a refusal files nothing", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    await received(b, 5, "B-1");
    // Only a holder of materials.items.merge raises.
    await expect(raiseItemMerge(db, pharmacist.actor, { survivorItemId: a, mergedItemId: b, reason: "dup" })).rejects.toMatchObject({ code: "permission_denied" });
    const m = await raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: b, reason: "the same glove twice" }, {}, at(60));
    expect(m).toMatchObject({ status: "requested", approvalStatus: "pending", source: "manual" });
    // The raiser cannot approve their own request; another head of the same role cannot either (the approver is the MS).
    await expect(approveRequest(db, head.actor, { approvalId: m.approvalId, note: "mine" })).rejects.toBeInstanceOf(SodViolationError);
    await expect(approveRequest(db, head2.actor, { approvalId: m.approvalId, note: "ok" })).rejects.toThrow();
    // Pending: nothing moves.
    await expect(executeItemMerge(db, head.actor, m.id, {}, at(61))).rejects.toMatchObject({ code: "item_merge_unapproved" });
    expect(await onHand(b)).toBe(50);
    // The MS cannot carry it out (no merge grant) even once granted.
    await approveRequest(db, ms.actor, { approvalId: m.approvalId, note: "same glove" });
    await expect(executeItemMerge(db, ms.actor, m.id, {}, at(62))).rejects.toMatchObject({ code: "permission_denied" });
    await executeItemMerge(db, head2.actor, m.id, {}, at(63));
    expect(await onHand(a)).toBe(50);

    // A rejected merge is refused, and nothing moved.
    const c = await anItem("GLV7Y", "Glove size 7 (dup 2)");
    await received(c, 1, "C-1");
    const r = await raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: c, reason: "dup" }, {}, at(70));
    await rejectRequest(db, ms.actor, { approvalId: r.approvalId, note: "different glove makers" });
    expect(await getItemMerge(db, head.actor, r.id)).toMatchObject({ status: "refused" });
    await expect(executeItemMerge(db, head.actor, r.id, {}, at(71))).rejects.toMatchObject({ code: "item_merge_wrong_status" });
    expect(await onHand(c)).toBe(10);
  });

  it("a merge re-asks every rule at the act: open work that appeared after the grant blocks it", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    const bb = await received(b, 5, "B-1");
    const m = await raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: b, reason: "dup" }, {}, at(60));
    await approveRequest(db, ms.actor, { approvalId: m.approvalId, note: "ok" });
    await withTx(db, (tx) => reserveStock(tx, head.actor, { resourceId: store, batchId: bb.batchId, qty: 3, refType: "pharmacy_dispense", refId: "D-1" }));
    await expect(executeItemMerge(db, head.actor, m.id, {}, at(61))).rejects.toMatchObject({ code: "item_merge_blocked", detail: { refusals: [expect.objectContaining({ rule: "reserved" })] } });
    expect(await onHand(b)).toBe(50);
  });

  it("stock that reaches the duplicate while the act runs undoes the whole act — nothing is left on a retired item", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    const bb = await received(b, 5, "B-1");
    const m = await raiseItemMerge(db, head.actor, { survivorItemId: a, mergedItemId: b, reason: "dup" }, {}, at(60));
    await approveRequest(db, ms.actor, { approvalId: m.approvalId, note: "ok" });
    // A receipt landing on B inside the act's window, after its stock was moved.
    const arriving = { move: async (tx: Parameters<typeof postMovement>[0]): Promise<Record<string, number>> => {
      await postMovement(tx, head.actor, { resourceId: store, batchId: bb.batchId, qtyDelta: 5, reason: "grn", refType: "test", refId: "late", occurredAt: at(61) });
      return {};
    } };
    await expect(executeItemMerge(db, head.actor, m.id, arriving, at(61))).rejects.toMatchObject({
      code: "item_merge_blocked", detail: { refusals: [expect.objectContaining({ rule: "stock_arrived" })] },
    });
    expect([await onHand(a), await onHand(b)]).toEqual([0, 50]);
    expect((await getItemMerge(db, head.actor, m.id)).status).toBe("requested");
  });

  it("an item merged into the duplicate earlier stands under the survivor too — always one hop", async () => {
    const a = await anItem("GLV7", "Glove size 7");
    const b = await anItem("GLV7X", "Glove size 7 (dup)");
    const c = await anItem("GLV7Y", "Glove size 7 (dup 2)");
    await merged(b, c, at(10));
    await merged(a, b, at(20));
    expect((await db.select({ id: items.id, into: items.mergedIntoItemId }).from(items).where(inArray(items.id, [b, c]))).map((r) => r.into)).toEqual([a, a]);
  });

  it("the agent's possible duplicates: the same medicine twice, near-identical names — never two strengths or two sizes", async () => {
    const para = await withTx(db, (tx) => addSalt(tx, pharmacist.actor, { name: "Paracetamol", drugClass: "analgesic" }));
    const crocin = (await withTx(db, (tx) => addMedicine(tx, pharmacist.actor, {
      brandName: "Crocin 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "OTC", salts: [{ saltId: para.saltId, strength: "500 mg" }],
    }))).medicineId;
    const a = await anItem("CROC", "Crocin 500 tablet", { medicineId: crocin });
    const b = await anItem("CROC2", "Crocin 500 tab", { medicineId: crocin });
    await received(b, 3, "B-1");
    await anItem("PANT", "Pantocid 40");
    await anItem("PANT2", "Pantocide 40");
    await anItem("GL7", "Glove 7");
    await anItem("GL8", "Glove 8");
    const { suggestions } = await findDuplicateItems(db, head.actor);
    expect(suggestions.map((s) => [s.why, s.survivor.code, s.merged.code])).toEqual(expect.arrayContaining([
      ["same_medicine", "CROC2", "CROC"], // B has stock, so B is proposed to stay
      ["similar_name", "PANT", "PANT2"],
    ]));
    expect(suggestions.some((s) => [s.survivor.code, s.merged.code].includes("GL8"))).toBe(false);
    expect(a).toBeDefined();
    await expect(findDuplicateItems(db, pharmacist.actor)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("near-identical names: letters and spaces may differ a little, numbers never", () => {
    expect(similarNames("Crocin 500 Tab", "crocin-500 tab")).toBe(true);
    expect(similarNames("Pantocid 40", "Pantocide 40")).toBe(true);
    expect(similarNames("Paracetamol 500", "Paracetamol 650")).toBe(false);
    expect(similarNames("Glove 7", "Glove 8")).toBe(false);
    expect(similarNames("Amoxycillin 250", "Azithromycin 250")).toBe(false);
  });
});
