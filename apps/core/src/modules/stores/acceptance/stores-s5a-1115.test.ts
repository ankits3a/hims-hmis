import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { orgDepartments, vendors } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import {
  MaterialsError, activateVendor, addVendorDocument, applyBankChange, captureGrn, createPurchaseOrder, createStore, registerItem,
  registerMaterialsApprovalTypes, registerVendor, requestBankChange, runGateQc, setVendorRates,
} from "../../materials";
import { storesManifest } from "../manifest";
import {
  StoresError, approvePurchaseRequest, approveSupplierCategory, approveTicket, bandFor, bulkApprovePurchaseRequests, claimPicking, createShelf,
  delegateApprovals, deliverTicket, departmentBudget, getPurchaseRequest, getTicket, issueTicket, listCategories, openStore, raisePurchaseRequest,
  raiseTicket, registerStoresItem, seedStoresMasters, setDepartmentBudget, setPurchaseRequestBand, setShelfPar, setSupplierFields, signStoresQc,
  supplierKyc, sweepBudgetWarnings,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1115, spec docs/specs/1115-stores-buying-desk.md (owner APPROVED 2026-11-19, decision 0100):
 * Stores S5a, the front of the buying desk. One test per done-means id the build notes give S5a: D1 (the purchase
 * request), D2 (bands), D3 (the split check), D4 (department budgets), D5 (delegation and bulk), D6 (non-drug GRN QC)
 * and D7 (supplier KYC levels). D8–D20 are S5b's, D21–D23 S5c's.
 *
 * Every intent is handed the clock it runs on, except where the materials code reads the real clock itself (a bank
 * change's cooling-off runs from the approval's own decision instant): there the test reads that instant back.
 */
describe("Stores S5a: purchase requests, bands, budgets, delegation, non-drug QC, KYC (spec #1115)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let buyer: Who;
  let keeper: Who;
  let bme: Who;
  let pharmacist: Who;
  let acct: Who;
  let owner: Who;
  let inA: Who;
  let hodA: Who;
  let hodB: Who;
  let docA: Who;
  let deptA: { id: string; code: string };
  let deptB: { id: string; code: string };
  let genMain: string;
  let shelfA: string;
  let chair: string;
  let wheelchair: string;
  let monitor: string;
  let mop: string;
  let gloves: string;
  let printer: string;
  let crocin: string;
  let pharmStore: string;
  let vendorId: string;
  let fur: string;
  let registry: ModuleRegistry;

  /** 12:00 IST on 2026-11-10 — inside GEN-MAIN's 09:00–17:00. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const DAY = 24 * 60;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
  const ANSWERS = { why: "Old one failed", replacesTag: null, usePerDay: "8 patients" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const grants: Record<string, string[]> = {
      materials_head: [
        "stores.masters.manage", "stores.shelf.read", "stores.buying.manage", "stores.grn.qc", "materials.items.read", "materials.stock.read",
        "materials.vendors.manage", "materials.po.raise", "materials.grn.capture",
      ],
      purchase_officer: ["stores.buying.manage", "materials.po.raise"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "materials.grn.capture"],
      biomedical_engineer: ["stores.grn.qc"],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc"],
      accounts_officer: ["stores.budget.manage"],
      owner: ["stores.budget.manage", "approvals.requests.decide", "approvals.requests.read"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work", "stores.purchase.request"],
      department_head: ["stores.shelf.read", "stores.indents.approve", "stores.purchase.request"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    buyer = await mkUser(db, "buyer.a", ["purchase_officer"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    bme = await mkUser(db, "bme.a", ["biomedical_engineer"]);
    pharmacist = await mkUser(db, "pharm.a", ["pharmacy"]);
    acct = await mkUser(db, "accounts.a", ["accounts_officer"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);
    hodB = await mkUser(db, "hod.b", []);
    docA = await mkUser(db, "doctor.a", []);

    deptA = await anOrgDept("ICU", "ICU");
    deptB = await anOrgDept("OT", "Operation theatre");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodB.id, roleKey: "department_head", scopeType: "department", scopeId: deptB.id });

    const floor1 = await aFloor("F1", "First floor");
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    fur = cat.get("FUR")!;
    const item = async (code: string, name: string, categoryCode: string, trackMode: "tagged" | "durable" | "shelf", klass = "asset"): Promise<string> =>
      (await registerStoresItem(db, head.actor, { code, name, class: klass, baseUom: "piece", categoryId: cat.get(categoryCode)!, trackMode, gstRateBps: 1800 })).itemId;
    chair = await item("FU-CHR-0001", "Visitor chair", "FUR", "durable");
    wheelchair = await item("FU-WCH-0001", "Wheelchair", "FUR", "durable");
    monitor = await item("ME-MON-0001", "Patient monitor", "MEQ", "tagged");
    printer = await item("IT-PRN-0001", "Label printer", "ITP", "durable");
    mop = await item("HK-MOP-0001", "Wet mop refill", "HSK", "shelf", "consumable");
    gloves = await item("HK-GLV-0001", "Household gloves", "HSK", "shelf", "consumable");
    // The central store keeps the mop at a par: a stock item, never asked to buy by a department.
    await setShelfPar(db, head.actor, { shelfId: genMain, itemId: mop, minBase: 10, reorderBase: 50, maxBase: 200 });
    await openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 500, unitCostPaise: 250 }], new Date(Math.min(at(-600).getTime(), Date.now() - 600 * MIN)));
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
    ({ resourceId: pharmStore } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ itemId: crocin } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "CROC", name: "Crocin 500", class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    })));
    vendorId = await aVendor("V-FURN", "Furniture House", { pan: "ABCDE1234F", gstin: "10ABCDE1234F1Z5" });
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "clinical", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  async function aFloor(code: string, name: string): Promise<string> {
    return (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code, name }))).resourceId;
  }
  async function aVendor(code: string, legalName: string, ids: { pan?: string; gstin?: string } = {}): Promise<string> {
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName, pan: ids.pan ?? null, gstin: ids.gstin ?? null }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, v, at(-200)));
    return v;
  }
  const deptPr = (who: Who, lines: Parameters<typeof raisePurchaseRequest>[2]["lines"], when = at(0), departmentId = deptA.id) =>
    raisePurchaseRequest(db, who.actor, { source: "department", departmentId, shelfId: departmentId === deptA.id ? shelfA : null, priority: "routine", lines }, when);
  const centralPr = (lines: Parameters<typeof raisePurchaseRequest>[2]["lines"], when = at(0)) =>
    raisePurchaseRequest(db, buyer.actor, { source: "central", priority: "routine", lines }, when);
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  const prRows = (): Promise<number> => count(sql`select count(*)::int as n from stores_purchase_requests`);
  const noticesTo = (userId: string, title: string): Promise<number> =>
    count(sql`select count(*)::int as n from alerts where user_id = ${userId} and title = ${title}`);
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }
  /** A ticket of `qty` mops raised, approved, issued and delivered to ICU at `t0` (₹2.50 a mop at cost). */
  async function mopsDelivered(qty: number, t0: number): Promise<void> {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: qty }], priority: "routine", channel: "phone" }, at(t0));
    await approveTicket(db, hodA.actor, t.id, {}, at(t0 + 1));
    await claimPicking(db, keeper.actor, t.id, at(t0 + 2));
    await issueTicket(db, keeper.actor, t.id, {}, at(t0 + 3));
    await deliverTicket(db, inA.actor, t.id, {}, at(t0 + 5));
  }

  /* ─────────────────────────────── D1–D7 ─────────────────────────────── */

  it("spec #1115 D1: a department's in-charge raises a purchase request, approval pending; a line with no item is refused; the requester cannot approve it; another department's HOD is refused", async () => {
    const pr = await deptPr(inA, [{ itemId: wheelchair, qtyBase: 2, estimatePaise: 800_000 }]);
    expect(pr.prNo).toMatch(/^MPR261110\d{4}$/);
    expect(pr.status).toBe("requested");
    expect(pr.stamp).toBeNull();
    expect(pr.lines.map((l) => [l.itemId, l.qtyBase, l.unitEstimatePaise, l.estimateSource])).toEqual([[wheelchair, 2, 800_000, "requester"]]);
    expect(await noticesTo(hodA.id, "Purchase to approve")).toBe(1);

    // A line names an item row, always ("Choose from the list"): refused, and nothing written.
    const before = await prRows();
    expect(await refusal(deptPr(inA, [{ itemId: null, qtyBase: 1, estimatePaise: 10_000 }]))).toBe("item_required");
    // A stock item is the store's to reorder ("Stock item, ask the store").
    expect(await refusal(deptPr(inA, [{ itemId: mop, qtyBase: 5 }]))).toBe("stock_item");
    expect(await prRows()).toBe(before);

    // The requester never approves their own request, even when they hold the approval.
    const own = await deptPr(hodA, [{ itemId: chair, qtyBase: 1, estimatePaise: 300_000 }]);
    expect(await refusal(approvePurchaseRequest(db, hodA.actor, own.id, at(5)))).toBe("own_request");
    // An HOD of another department is refused.
    expect(await refusal(approvePurchaseRequest(db, hodB.actor, pr.id, at(5)))).toBe("not_permitted");
    expect((await getPurchaseRequest(db, pr.id, at(6))).stamp).toBeNull();

    const ok = await approvePurchaseRequest(db, hodA.actor, pr.id, at(10));
    expect(ok.status).toBe("approved");
    expect(ok.stamp).toMatchObject({ decision: "approved", by: { id: hodA.id }, forRole: "hod" });
  });

  it("spec #1115 D2: bandFor: ₹25,000 is A, ₹25,001 B, ₹5,00,000 B, ₹5,00,001 C; a ₹3,000 medical-equipment line is C; a ₹6,000 furniture line is A", async () => {
    expect(bandFor(2_500_000)).toBe("A");
    expect(bandFor(2_500_100)).toBe("B");
    expect(bandFor(50_000_000)).toBe("B");
    expect(bandFor(50_000_100)).toBe("C");
    expect(bandFor(300_000, { equipment: true })).toBe("C");

    const meq = await deptPr(inA, [{ itemId: monitor, qtyBase: 1, estimatePaise: 300_000, equipment: ANSWERS }]);
    expect([meq.estimatePaise, meq.band]).toEqual([300_000, "C"]);
    const furn = await deptPr(inA, [{ itemId: chair, qtyBase: 1, estimatePaise: 600_000 }]);
    expect([furn.estimatePaise, furn.band]).toEqual([600_000, "A"]);
    // Equipment asks its three short answers.
    expect(await refusal(deptPr(inA, [{ itemId: monitor, qtyBase: 1, estimatePaise: 300_000 }]))).toBe("answers_required");
  });

  it("spec #1115 D3: two ₹20,000 furniture requests of one department in 30 days band as B with Split?; the buyer cannot set A; central requests sum by item, not category; a rate-contract line is left out", async () => {
    const first = await deptPr(inA, [{ itemId: chair, qtyBase: 1, estimatePaise: 2_000_000 }], at(0));
    const second = await deptPr(inA, [{ itemId: wheelchair, qtyBase: 1, estimatePaise: 2_000_000 }], at(3 * DAY));
    for (const id of [first.id, second.id]) {
      const v = await getPurchaseRequest(db, id, at(3 * DAY + 10));
      expect(v.band).toBe("B");
      expect(v.split?.prIds.sort()).toEqual([first.id, second.id].sort());
    }
    // Another department's furniture is its own sum.
    const other = await deptPr(hodB, [{ itemId: chair, qtyBase: 1, estimatePaise: 2_000_000 }], at(3 * DAY), deptB.id);
    expect((await getPurchaseRequest(db, other.id, at(3 * DAY + 10))).split).toBeNull();
    // The buyer cannot lower a band.
    expect(await refusal(setPurchaseRequestBand(db, buyer.actor, second.id, "A", "one chair only", at(3 * DAY + 20)))).toBe("band_lowered");

    // Central: two items of one category are not summed; the same item twice is.
    const c1 = await centralPr([{ itemId: mop, qtyBase: 8_000, estimatePaise: 250 }], at(10));
    const c2 = await centralPr([{ itemId: gloves, qtyBase: 5_000, estimatePaise: 400 }], at(20));
    expect([(await getPurchaseRequest(db, c1.id, at(30))).band, (await getPurchaseRequest(db, c2.id, at(30))).band]).toEqual(["A", "A"]);
    const c3 = await centralPr([{ itemId: gloves, qtyBase: 5_000, estimatePaise: 400 }], at(40));
    expect((await getPurchaseRequest(db, c3.id, at(50))).band).toBe("B");
    expect((await getPurchaseRequest(db, c3.id, at(50))).split?.prIds.sort()).toEqual([c2.id, c3.id].sort());

    // A line on a live rate contract orders as band A and is left out of the sum.
    await setVendorRates(db, head.actor, vendorId, [{ itemId: printer, ratePaise: 2_000_000, uom: "piece" }], { now: at(-60) });
    const p1 = await deptPr(inA, [{ itemId: printer, qtyBase: 1 }], at(60));
    const p2 = await deptPr(inA, [{ itemId: printer, qtyBase: 1 }], at(70));
    expect(p1.lines[0]).toMatchObject({ unitEstimatePaise: 2_000_000, estimateSource: "contract", onContract: true });
    for (const id of [p1.id, p2.id]) expect((await getPurchaseRequest(db, id, at(80))).band).toBe("A");
  });

  it("spec #1115 D4: one warning at 80 % and one at 100 %; above 100 % a ticket and a request are approved with 'over budget' on the stamp; nothing is refused; equipment adds nothing and is listed apart", async () => {
    expect((await departmentBudget(db, deptA.id, "2026-11")).budgetPaise).toBeNull(); // "No budget set"
    await setDepartmentBudget(db, acct.actor, { departmentId: deptA.id, month: "2026-11", amountPaise: 6_000 }, at(-30));

    await mopsDelivered(20, 0); // ₹50.00 of ₹60.00: 83 %
    expect((await departmentBudget(db, deptA.id, "2026-11")).spentPaise).toBe(5_000);
    await sweepBudgetWarnings(db, at(10));
    await sweepBudgetWarnings(db, at(11));
    expect(await noticesTo(hodA.id, "Budget 80% used")).toBe(1);
    expect(await noticesTo(acct.id, "Budget 80% used")).toBe(1);
    expect(await noticesTo(hodA.id, "Budget used up")).toBe(0);

    await mopsDelivered(10, 20); // ₹75.00: 125 %
    await sweepBudgetWarnings(db, at(30));
    await sweepBudgetWarnings(db, at(31));
    expect(await noticesTo(hodA.id, "Budget 80% used")).toBe(1);
    expect(await noticesTo(hodA.id, "Budget used up")).toBe(1);
    expect(await noticesTo(acct.id, "Budget used up")).toBe(1);

    // Past 100 %: the ticket and the request are approved, and their stamps say so.
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 5 }], priority: "routine", channel: "phone" }, at(40));
    await approveTicket(db, hodA.actor, t.id, {}, at(41));
    const tv = await getTicket(db, t.id, at(42));
    expect(tv?.approval.state).toBe("approved");
    expect(tv?.approval.overBudget).toBe(true);
    const pr = await deptPr(inA, [{ itemId: chair, qtyBase: 1, estimatePaise: 600_000 }], at(43));
    expect((await getPurchaseRequest(db, pr.id, at(44))).budget).toMatchObject({ over: true });
    const ok = await approvePurchaseRequest(db, hodA.actor, pr.id, at(45));
    expect(ok.status).toBe("approved");
    expect(ok.stamp?.overBudget).toBe(true);

    // A band C equipment request adds nothing to the month and is listed under Equipment.
    const spent = (await departmentBudget(db, deptA.id, "2026-11")).spentPaise;
    const eq = await deptPr(inA, [{ itemId: monitor, qtyBase: 1, estimatePaise: 12_000_000, equipment: ANSWERS }], at(50));
    await approvePurchaseRequest(db, hodA.actor, eq.id, at(51));
    const b = await departmentBudget(db, deptA.id, "2026-11");
    expect(b.spentPaise).toBe(spent);
    expect(b.equipment.requests.map((r) => r.prId)).toEqual([eq.id]);
  });

  it("spec #1115 D5: a delegate approves inside the window and the stamp reads 'for HOD'; after the end date the delegate is refused; a delegation to the requester or of a PO tier is refused; bulk approval of 5 writes 5 stamps and 5 events", async () => {
    await delegateApprovals(db, hodA.actor, { toUserId: docA.id, scope: "hod_approval", departmentId: deptA.id, from: at(0), to: at(3 * DAY) }, at(0));
    const pr = await deptPr(inA, [{ itemId: chair, qtyBase: 1, estimatePaise: 300_000 }], at(10));
    const ok = await approvePurchaseRequest(db, docA.actor, pr.id, at(60));
    expect(ok.stamp).toMatchObject({ by: { id: docA.id }, forRole: "delegate", onBehalfOf: { id: hodA.id } });

    const late = await deptPr(inA, [{ itemId: chair, qtyBase: 1, estimatePaise: 300_000 }], at(3 * DAY + 10));
    expect(await refusal(approvePurchaseRequest(db, docA.actor, late.id, at(3 * DAY + 20)))).toBe("delegation_ended");

    // Never to the requester of the department's open requests; never a PO tier (kernel money).
    expect(await refusal(delegateApprovals(db, hodA.actor, { toUserId: inA.id, scope: "hod_approval", departmentId: deptA.id, from: at(3 * DAY + 30), to: at(4 * DAY) }, at(3 * DAY + 30))))
      .toBe("delegate_is_requester");
    expect(await refusal(delegateApprovals(db, hodA.actor, { toUserId: docA.id, scope: "po_tier", departmentId: deptA.id, from: at(3 * DAY + 30), to: at(4 * DAY) }, at(3 * DAY + 30))))
      .toBe("not_delegable");

    // Bulk: the materials head approves five central requests in one tap; five stamps, five events.
    const five = [];
    for (let i = 0; i < 5; i++) five.push(await centralPr([{ itemId: gloves, qtyBase: 10 + i, estimatePaise: 400 }], at(4 * DAY + i)));
    const actsBefore = await count(sql`select count(*)::int as n from events where name = 'stores.act_recorded' and payload->>'act' = 'approve_purchase_request'`);
    const done = await bulkApprovePurchaseRequests(db, head.actor, five.map((p) => p.id), at(4 * DAY + 30));
    expect(done.map((p) => p.status)).toEqual(Array(5).fill("approved"));
    expect(done.every((p) => p.stamp?.by.id === head.id)).toBe(true);
    const actsAfter = await count(sql`select count(*)::int as n from events where name = 'stores.act_recorded' and payload->>'act' = 'approve_purchase_request'`);
    expect(actsAfter - actsBefore).toBe(5);
  });

  it("spec #1115 D6: a non-drug GRN line's QC is signed by a stores.grn.qc holder, no pharmacist; a pharmacy line is refused (not_stores_line) and its QC by a materials.grn.qc holder is unchanged; a non-drug line 3 % above contract is flagged", async () => {
    await setVendorRates(db, head.actor, vendorId, [{ itemId: chair, ratePaise: 100_000, uom: "piece" }], { now: at(-60) });
    const capture = (lines: Parameters<typeof captureGrn>[2]["lines"], storeResourceId = genMain) => withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId, source: "challan", storeResourceId, challanNo: `CH-${newId().slice(-6)}`, challanDate: "2026-11-10", invoiceNo: `INV-${newId().slice(-6)}`,
      invoiceDate: "2026-11-10", lines, now: at(0),
    }));
    // 3 % above the contract: flagged, a reason needed.
    expect(await refusal(capture([{ itemId: chair, uom: "piece", qtyInUom: 2, unitCostPaise: 103_000 }]))).toBe("price_reason_required");
    const { grnId } = await capture([{ itemId: chair, uom: "piece", qtyInUom: 2, unitCostPaise: 103_000, priceReason: { code: "urgent_buy" } }]);
    const [line] = (await db.execute(sql`select price_ref_kind, price_reason_code from grn_lines where grn_id = ${grnId}`)).rows as { price_ref_kind: string; price_reason_code: string }[];
    expect(line).toEqual({ price_ref_kind: "contract", price_reason_code: "urgent_buy" });

    // Biomedical signs the non-drug QC; no pharmacist touched it.
    const qc = await signStoresQc(db, bme.actor, grnId, at(5));
    expect(qc.status).toBe("accepted");
    const [g] = (await db.execute(sql`select qc_by from grns where id = ${grnId}`)).rows as { qc_by: string }[];
    expect(g?.qc_by).toBe(bme.id);

    // A pharmacy line: the stores grant alone is refused; the pharmacist's QC gives what it always gave.
    const pharm = await capture([{ itemId: crocin, uom: "strip", qtyInUom: 10, batchNo: "B1", expiryDate: "2028-06-30", unitCostPaise: 2_500 }], pharmStore);
    expect(await refusal(signStoresQc(db, bme.actor, pharm.grnId, at(6)))).toBe("not_stores_line");
    const v = await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, pharm.grnId));
    expect(v.status).toBe("accepted");
    expect(v.verdicts.map((x) => x.verdict)).toEqual(["pass"]);
  });

  it("spec #1115 D7: supplierKyc reads 'can quote' with PAN and GSTIN and no bank; 'KYC complete' only with the document, a bank past cooling-off, the category approval and (MSME) the Udyam paper; a pharmacy PO to a 'can quote' supplier is made as before", async () => {
    const v = await aVendor("V-NEW", "New Supplier", { pan: "PQRSX1234K", gstin: "10PQRSX1234K1Z2" });
    let k = await supplierKyc(db, v, at(0), { categoryId: fur });
    expect(k.level).toBe("can_quote");
    expect(k.missing).toEqual(expect.arrayContaining(["bank", "category"]));

    // No PAN: not even "can quote".
    const bare = await aVendor("V-BARE", "Bare Supplier", { gstin: "10ZZZZZ1234Z1Z2" });
    expect((await supplierKyc(db, bare, at(0), { categoryId: fur })).level).toBe("none");

    // The bank: approved by the owner, then cooling off.
    const { changeId, approvalId } = await withTx(db, (tx) => requestBankChange(tx, head.actor, v, { accountNo: "123456789012", ifsc: "SBIN0000001" }));
    await approveRequest(db, owner.actor, { approvalId, note: "Verified by call-back" });
    await withTx(db, (tx) => applyBankChange(tx, head.actor, changeId, new Date()));
    const [row] = await db.select({ until: vendors.firstPaymentAllowedAt }).from(vendors).where(sql`${vendors.id} = ${v}`);
    const cooled = new Date(row!.until!.getTime() + MIN);
    await approveSupplierCategory(db, head.actor, v, fur, at(10));
    expect((await supplierKyc(db, v, new Date(row!.until!.getTime() - MIN), { categoryId: fur })).missing).toEqual(["cooling_off"]);
    k = await supplierKyc(db, v, cooled, { categoryId: fur });
    expect(k).toMatchObject({ level: "complete", missing: [] });

    // MSME: complete only with the Udyam paper, the class and the activity.
    await setSupplierFields(db, head.actor, v, { msmeUdyamNo: "UDYAM-BR-01-0000001", msmeClass: "micro" }, at(20));
    expect((await supplierKyc(db, v, cooled, { categoryId: fur })).missing.sort()).toEqual(["msme_activity", "udyam"]);
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "udyam", number: "UDYAM-BR-01-0000001" }));
    await setSupplierFields(db, head.actor, v, { msmeActivity: "maker", einvoiceApplicable: true }, at(30));
    expect((await supplierKyc(db, v, cooled, { categoryId: fur })).level).toBe("complete");

    // A pharmacy purchase order to a supplier that can only quote is made exactly as before S5.
    const ph = await aVendor("V-PH", "Pharma Distributor", { pan: "LMNOP1234Q", gstin: "10LMNOP1234Q1Z9" });
    expect((await supplierKyc(db, ph, at(40))).level).toBe("can_quote");
    const po = await createPurchaseOrder(db, pharmacist.actor, {
      vendorId: ph, storeResourceId: pharmStore, lines: [{ itemId: crocin, qtyPacks: 10, ratePaise: 25_000 }],
    }, { now: at(40) });
    expect(po.status).toBe("draft");
    expect(po.totalPaise).toBe(250_000 + 30_000);
  });
});
