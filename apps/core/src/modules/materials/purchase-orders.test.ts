import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { SodViolationError, seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { approvals, events } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { PO_APPROVAL_TYPE, PO_OWNER_APPROVAL_TYPE, registerMaterialsApprovalTypes } from "./approval-types";
import { PO_HEAD_APPROVAL_LIMIT_PAISE } from "./config";
import { captureGrn, postGrn, runGateQc } from "./grn";
import { registerItem } from "./items";
import {
  allowedReceiptBase, approvalTierFor, assertNotPoApprover, cancelPurchaseOrder, createPurchaseOrder, decidePurchaseOrder,
  getPurchaseOrder, lastPurchaseByItem, lineGstPaise, onOrderAt, receivableLines, sendPurchaseOrder, setStockLevel,
  submitPurchaseOrder, updatePurchaseOrder,
} from "./purchase-orders";
import { createStore } from "./stores";
import { activateVendor, addVendorDocument, registerVendor, suspendVendor } from "./vendors";
import type { CaptureLine } from "./grn";
import type { PoLineInput } from "./purchase-orders";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P2 — THE PURCHASE ORDER, END TO END AGAINST THE DATABASE ═══
 *
 * The owner has not ruled on procurement, so every refusal here guards a DEFAULT recorded in the
 * plan doc: the head approves up to ₹50,000 and the owner above it; nobody decides an order they
 * drafted or submitted; whoever approved it does not receive it; a GRN may pass the ordered quantity
 * by 2% and no more; less leaves the order open.
 *
 * Fixtures: a strip is 10 tablets and every rate is per strip, so `qty_packs` and base units differ
 * on every line and a mutant that forgets the multiplier cannot pass.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

describe("purchase orders (parity P2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let head2: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let store: string;
  let otherStore: string;
  let vendor: string;
  let otherVendor: string;
  let crocin: string;
  let gauze: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "pharmacy", "storekeeper", "owner"]) await ensureRole(db, role);
    const grants: Record<string, string[]> = {
      materials_head: ["materials.po.raise", "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage", "approvals.requests.decide", "approvals.requests.read"],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc"],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
      owner: ["approvals.requests.decide", "approvals.requests.read"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    head2 = await mkUser(db, "mat.head2", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ resourceId: otherStore } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN", name: "Main store" })));
    vendor = await aVendor("ACME");
    otherVendor = await aVendor("BETA");
    crocin = await anItem("CROC", 1200);
    gauze = await anItem("GAUZE", 500);
  });

  async function aVendor(code: string, activate = true): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName: `${code} Pharma Pvt Ltd` }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    if (activate) await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    return vendorId;
  }

  async function anItem(code: string, gstRateBps: number): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name: `Item ${code}`, class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    return itemId;
  }

  const line = (itemId: string, over: Partial<PoLineInput> = {}): PoLineInput => ({ itemId, qtyPacks: 10, ratePaise: 25_000, ...over });

  /** Drafted by the pharmacist, submitted by the pharmacist, approved by the head: an order that may be received. */
  async function approvedOrder(lines: PoLineInput[] = [line(crocin)], approver = head): Promise<string> {
    const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines }, { now: T0 });
    await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
    await decidePurchaseOrder(db, approver.actor, po.id, "approve", "within budget", at(2));
    return po.id;
  }

  const grnLine = (itemId: string, qtyInUom: number, over: Partial<CaptureLine> = {}): CaptureLine =>
    ({ itemId, uom: "strip", qtyInUom, batchNo: `B-${String(qtyInUom)}`, expiryDate: "2028-06-30", unitCostPaise: 2_500, ...over });

  const capture = (actor: Actor, poId: string | null, lines: CaptureLine[], vendorId = vendor, storeResourceId = store) =>
    withTx(db, (tx) => captureGrn(tx, actor, {
      vendorId, source: "challan", storeResourceId, challanNo: `CH-${String(Math.random()).slice(2, 8)}`, challanDate: "2026-09-24",
      purchaseOrderId: poId, lines, now: at(10),
    }));

  async function receive(actor: Actor, poId: string, lines: CaptureLine[], vendorId = vendor): Promise<string> {
    const { grnId } = await capture(actor, poId, lines, vendorId);
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, at(20)));
    return grnId;
  }

  // ─────────────────────────────── money and tiers ───────────────────────────────

  it("prices a line per pack, GST half-up per line, and keeps the sums on the header", async () => {
    expect(lineGstPaise(25_000 * 3, 1200)).toBe(9_000);
    expect(lineGstPaise(1_234, 500)).toBe(62); // 61.7 → 62
    const po = await createPurchaseOrder(db, pharmacist.actor, {
      vendorId: vendor, storeResourceId: store, lines: [line(crocin, { qtyPacks: 3 }), line(gauze, { qtyPacks: 2, ratePaise: 1_234 })],
    }, { now: T0 });
    expect(po.status).toBe("draft");
    expect(po.poNo).toMatch(/^MPO260924\d{4}$/);
    expect(po.lines.map((l) => [l.itemCode, l.uom, l.multiplier, l.qtyPacks, l.orderedBase, l.lineTotalPaise, l.gstRateBps])).toEqual([
      ["CROC", "strip", 10, 3, 30, 75_000, 1200], ["GAUZE", "strip", 10, 2, 20, 2_468, 500],
    ]);
    expect([po.subtotalPaise, po.gstPaise, po.totalPaise]).toEqual([77_468, 9_000 + 123, 77_468 + 9_123]);
  });

  it("routes a total AT the limit to the head and one paisa over to the owner", async () => {
    expect(approvalTierFor(PO_HEAD_APPROVAL_LIMIT_PAISE)).toBe("head");
    expect(approvalTierFor(PO_HEAD_APPROVAL_LIMIT_PAISE + 1)).toBe("owner");
    // ₹50,000 exactly, GST nil: 200 strips at ₹250.
    const atLimit = await createPurchaseOrder(db, pharmacist.actor, {
      vendorId: vendor, storeResourceId: store, lines: [line(crocin, { qtyPacks: 200, ratePaise: 25_000, gstRateBps: 0 })],
    }, { now: T0 });
    const over = await createPurchaseOrder(db, pharmacist.actor, {
      vendorId: vendor, storeResourceId: store, lines: [line(crocin, { qtyPacks: 200, ratePaise: 25_000, gstRateBps: 0 }), line(gauze, { qtyPacks: 1, ratePaise: 1, gstRateBps: 0 })],
    }, { now: T0 });
    expect(atLimit.totalPaise).toBe(PO_HEAD_APPROVAL_LIMIT_PAISE);
    expect(over.totalPaise).toBe(PO_HEAD_APPROVAL_LIMIT_PAISE + 1);
    const a = await submitPurchaseOrder(db, pharmacist.actor, atLimit.id, at(1));
    const b = await submitPurchaseOrder(db, pharmacist.actor, over.id, at(1));
    const [ra] = await db.select().from(approvals).where(eq(approvals.id, a.approvalId!));
    const [rb] = await db.select().from(approvals).where(eq(approvals.id, b.approvalId!));
    expect([a.approvalTier, ra?.typeKey, ra?.approverRole, ra?.amountPaise]).toEqual(["head", PO_APPROVAL_TYPE, "materials_head", PO_HEAD_APPROVAL_LIMIT_PAISE]);
    expect([b.approvalTier, rb?.typeKey, rb?.approverRole]).toEqual(["owner", PO_OWNER_APPROVAL_TYPE, "owner"]);
    // The head cannot decide the owner's tier; the owner can.
    await expect(decidePurchaseOrder(db, head.actor, over.id, "approve", "ok", at(3))).rejects.toBeDefined();
    expect((await getPurchaseOrder(db, head.actor, over.id)).status).toBe("pending_approval");
    const decided = await decidePurchaseOrder(db, owner.actor, over.id, "approve", "ok, seasonal stock", at(3));
    expect([decided.status, decided.approvedBy]).toEqual(["approved", owner.id]);
  });

  // ─────────────────────────────── who may decide ───────────────────────────────

  it("refuses whoever DRAFTED an order deciding it, even when a colleague submitted it", async () => {
    const po = await createPurchaseOrder(db, head.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin)] }, { now: T0 });
    await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
    await expect(decidePurchaseOrder(db, head.actor, po.id, "approve", "mine", at(2))).rejects.toBeInstanceOf(SodViolationError);
    const blocked = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(blocked.map((e) => (e.payload as { pairKey: string }).pairKey)).toEqual(["requester_approver"]);
    expect((await getPurchaseOrder(db, head.actor, po.id)).status).toBe("pending_approval");
    // Another head may.
    expect((await decidePurchaseOrder(db, head2.actor, po.id, "approve", "fine", at(3))).status).toBe("approved");
  });

  it("refuses the submitter deciding their own request (the kernel's pair)", async () => {
    const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin)] }, { now: T0 });
    await submitPurchaseOrder(db, head.actor, po.id, at(1));
    await expect(decidePurchaseOrder(db, head.actor, po.id, "approve", "mine", at(2))).rejects.toBeInstanceOf(SodViolationError);
  });

  it("a rejection sends the order back to draft with the reason; a resubmit files a fresh approval", async () => {
    const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin)] }, { now: T0 });
    const first = await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
    const back = await decidePurchaseOrder(db, head.actor, po.id, "reject", "rate is above the contract", at(2));
    expect([back.status, back.rejectionNote, back.approvalId]).toEqual(["draft", "rate is above the contract", null]);
    await updatePurchaseOrder(db, pharmacist.actor, po.id, { lines: [line(crocin, { ratePaise: 22_000 })] }, at(3));
    const again = await submitPurchaseOrder(db, pharmacist.actor, po.id, at(4));
    expect(again.approvalId).not.toBe(first.approvalId);
    expect(again.rejectionNote).toBeNull();
  });

  it("an approval granted in the inbox is settled onto the order the next time it is read", async () => {
    const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin)] }, { now: T0 });
    const sub = await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
    await approveRequest(db, head.actor, { approvalId: sub.approvalId!, note: "from the inbox" });
    const read = await getPurchaseOrder(db, keeper.actor, po.id);
    expect([read.status, read.approvedBy]).toEqual(["approved", head.id]);
    const approved = await db.select().from(events).where(eq(events.name, "purchase_order.approved"));
    expect(approved).toHaveLength(1);
    await getPurchaseOrder(db, keeper.actor, po.id);
    expect(await db.select().from(events).where(eq(events.name, "purchase_order.approved"))).toHaveLength(1);
  });

  it("only the raisers draft, and only a draft is edited", async () => {
    await expect(createPurchaseOrder(db, keeper.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin)] }))
      .rejects.toMatchObject({ code: "permission_denied" });
    const id = await approvedOrder();
    await expect(updatePurchaseOrder(db, pharmacist.actor, id, { note: "late edit" })).rejects.toMatchObject({ code: "po_wrong_status" });
    await expect(createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin), line(crocin)] }))
      .rejects.toMatchObject({ code: "po_invalid" });
  });

  // ─────────────────────────────── the vendor must be active ───────────────────────────────

  it("refuses a vendor that is not active — at draft, and at submit when it was suspended since", async () => {
    const draftVendor = await aVendor("GAMMA", false);
    await expect(createPurchaseOrder(db, pharmacist.actor, { vendorId: draftVendor, storeResourceId: store, lines: [line(crocin)] }))
      .rejects.toMatchObject({ code: "vendor_not_active" });
    const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin)] }, { now: T0 });
    await withTx(db, (tx) => suspendVendor(tx, head.actor, vendor, "licence renewal pending"));
    await expect(submitPurchaseOrder(db, pharmacist.actor, po.id, at(1))).rejects.toMatchObject({ code: "vendor_not_active" });
  });

  // ─────────────────────────────── receiving against it ───────────────────────────────

  it("refuses the order's approver as its receiver — in the act, and through the SoD engine with an audit event", async () => {
    const poId = await approvedOrder([line(crocin)], head);
    await expect(capture(head.actor, poId, [grnLine(crocin, 10)])).rejects.toMatchObject({ code: "po_approver_receiving" });
    await expect(assertNotPoApprover(db, head.actor, poId)).rejects.toBeInstanceOf(SodViolationError);
    const blocked = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(blocked.map((e) => (e.payload as { pairKey: string }).pairKey)).toEqual(["po_approver_grn_receiver"]);
    // Somebody else receives it.
    await assertNotPoApprover(db, keeper.actor, poId);
    await expect(capture(keeper.actor, poId, [grnLine(crocin, 10)])).resolves.toMatchObject({ grnId: expect.any(String) });
  });

  it("the approver cannot POST a GRN against the order either, whoever captured it", async () => {
    const poId = await approvedOrder([line(crocin)], head);
    const { grnId } = await capture(keeper.actor, poId, [grnLine(crocin, 10)]);
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await expect(withTx(db, (tx) => postGrn(tx, head.actor, grnId, at(20)))).rejects.toMatchObject({ code: "po_approver_receiving" });
  });

  it("allows up to 2% over the ordered quantity and refuses more; free goods are counted apart", async () => {
    expect(allowedReceiptBase(100)).toBe(102);
    expect(allowedReceiptBase(1_000)).toBe(1_020);
    // 100 strips = 1,000 tablets ordered; 102 strips is 2% over.
    const poId = await approvedOrder([line(crocin, { qtyPacks: 100 })]);
    const refused = capture(keeper.actor, poId, [grnLine(crocin, 103)]);
    await expect(refused).rejects.toMatchObject({ code: "po_over_receipt", detail: { orderedBase: 1_000, alreadyBase: 0, thisBase: 1_030, allowedBase: 1_020 } });
    await receive(keeper.actor, poId, [grnLine(crocin, 102), grnLine(crocin, 20, { batchNo: "FREE-1", unitCostPaise: 0, freeGoods: true })]);
    const po = await getPurchaseOrder(db, keeper.actor, poId);
    expect([po.status, po.lines[0]!.receivedBase, po.lines[0]!.freeReceivedBase, po.lines[0]!.remainingBase]).toEqual(["received", 1_020, 200, 0]);
  });

  it("short supply leaves the order open; the rest arrives on a second GRN", async () => {
    const poId = await approvedOrder([line(crocin, { qtyPacks: 10 }), line(gauze, { qtyPacks: 5 })]);
    await receive(keeper.actor, poId, [grnLine(crocin, 6)]);
    let po = await getPurchaseOrder(db, keeper.actor, poId);
    expect(po.status).toBe("part_received");
    expect(po.lines.map((l) => [l.itemCode, l.receivedBase, l.remainingBase])).toEqual([["CROC", 60, 40], ["GAUZE", 0, 50]]);
    const r = await receivableLines(db, keeper.actor, poId);
    expect(r.lines.map((l) => [l.itemCode, l.remainingPacks, l.unitCostPaise])).toEqual([["CROC", 4, 2_500], ["GAUZE", 5, 2_500]]);
    // The second delivery counts what the first left, not the whole order again.
    await expect(capture(keeper.actor, poId, [grnLine(crocin, 5)])).rejects.toMatchObject({ code: "po_over_receipt" });
    await receive(keeper.actor, poId, [grnLine(crocin, 4, { batchNo: "B-SECOND" }), grnLine(gauze, 5)]);
    po = await getPurchaseOrder(db, keeper.actor, poId);
    expect(po.status).toBe("received");
    const received = await db.select().from(events).where(eq(events.name, "purchase_order.received"));
    expect(received.map((e) => (e.payload as { status: string }).status)).toEqual(["part_received", "received"]);
  });

  it("two lorries captured before either posts share one headroom", async () => {
    const poId = await approvedOrder([line(crocin, { qtyPacks: 10 })]);
    await capture(keeper.actor, poId, [grnLine(crocin, 10)]);
    await expect(capture(keeper.actor, poId, [grnLine(crocin, 1, { batchNo: "B-X" })])).rejects.toMatchObject({ code: "po_over_receipt", detail: { alreadyBase: 100 } });
  });

  it("refuses another vendor's delivery, another store, an item the order does not carry, and an order not yet approved", async () => {
    const poId = await approvedOrder([line(crocin)]);
    await expect(capture(keeper.actor, poId, [grnLine(crocin, 1)], otherVendor)).rejects.toMatchObject({ code: "po_mismatch" });
    await expect(capture(keeper.actor, poId, [grnLine(crocin, 1)], vendor, otherStore)).rejects.toMatchObject({ code: "po_mismatch" });
    await expect(capture(keeper.actor, poId, [grnLine(gauze, 1)])).rejects.toMatchObject({ code: "po_mismatch" });
    const draft = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin)] }, { now: T0 });
    await expect(capture(keeper.actor, draft.id, [grnLine(crocin, 1)])).rejects.toMatchObject({ code: "po_wrong_status" });
  });

  it("send moves an approved order to sent; cancel needs a reason and refuses an order with a GRN against it", async () => {
    const poId = await approvedOrder();
    expect((await sendPurchaseOrder(db, pharmacist.actor, poId, at(5))).status).toBe("sent");
    await expect(cancelPurchaseOrder(db, pharmacist.actor, poId, "  ", at(6))).rejects.toMatchObject({ code: "reason_required" });
    await capture(keeper.actor, poId, [grnLine(crocin, 1)]);
    await expect(cancelPurchaseOrder(db, pharmacist.actor, poId, "vendor out of stock", at(6))).rejects.toMatchObject({ code: "po_wrong_status" });
    const other = await approvedOrder([line(gauze)]);
    expect((await cancelPurchaseOrder(db, pharmacist.actor, other, "ordered elsewhere", at(7))).status).toBe("cancelled");
  });

  // ─────────────────────────────── levels, on order, last purchase ───────────────────────────────

  it("levels hold 0 ≤ min ≤ reorder < max; on-order separates drafts from placed orders", async () => {
    await expect(setStockLevel(db, pharmacist.actor, { itemId: crocin, storeResourceId: store, minBase: 50, reorderBase: 40, maxBase: 200 }))
      .rejects.toMatchObject({ code: "invalid_stock_level" });
    await expect(setStockLevel(db, keeper.actor, { itemId: crocin, storeResourceId: store, minBase: 10, reorderBase: 40, maxBase: 200 }))
      .rejects.toMatchObject({ code: "permission_denied" });
    await setStockLevel(db, pharmacist.actor, { itemId: crocin, storeResourceId: store, minBase: 10, reorderBase: 40, maxBase: 200 });
    await setStockLevel(db, pharmacist.actor, { itemId: crocin, storeResourceId: store, minBase: 20, reorderBase: 50, maxBase: 300 });
    const set = await db.select().from(events).where(and(eq(events.name, "stock_level.set")));
    expect(set.map((e) => (e.payload as { previous: unknown }).previous)).toEqual([null, { minBase: 10, reorderBase: 40, maxBase: 200 }]);

    await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [line(crocin, { qtyPacks: 3 })] }, { now: T0 });
    const placed = await approvedOrder([line(crocin, { qtyPacks: 10 })]);
    await receive(keeper.actor, placed, [grnLine(crocin, 4)]);
    expect((await onOrderAt(db, store, [crocin])).get(crocin)).toEqual({ onOrderBase: 60, inDraftBase: 30 });
  });

  it("the last purchase is the latest PAID receipt: its vendor, its pack, and the pack's rate", async () => {
    const first = await approvedOrder([line(crocin, { qtyPacks: 10 })]);
    await receive(keeper.actor, first, [grnLine(crocin, 10, { unitCostPaise: 2_400 })]);
    // A later delivery from another vendor, and a later free-goods line that must not count.
    const po2 = await createPurchaseOrder(db, pharmacist.actor, { vendorId: otherVendor, storeResourceId: store, lines: [line(crocin, { qtyPacks: 5 })] }, { now: T0 });
    await submitPurchaseOrder(db, pharmacist.actor, po2.id, at(30));
    await decidePurchaseOrder(db, head.actor, po2.id, "approve", "ok", at(31));
    await receive(keeper.actor, po2.id, [grnLine(crocin, 5, { batchNo: "B-BETA", unitCostPaise: 2_600 }), grnLine(crocin, 1, { batchNo: "B-FREE", unitCostPaise: 0, freeGoods: true })], otherVendor);
    const last = (await lastPurchaseByItem(db, [crocin])).get(crocin);
    expect(last).toMatchObject({ vendorId: otherVendor, vendorActive: true, uom: "strip", multiplier: 10, ratePaise: 26_000 });
  });
});
