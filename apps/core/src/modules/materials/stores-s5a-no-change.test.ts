import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { SodViolationError, seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { grnLines, grns } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { MATERIALS_APPROVAL_TYPES, PO_APPROVAL_TYPE, PO_OWNER_APPROVAL_TYPE, registerMaterialsApprovalTypes } from "./approval-types";
import { PO_HEAD_APPROVAL_LIMIT_PAISE } from "./config";
import { MaterialsError } from "./errors";
import { captureGrn, postGrn, runGateQc } from "./grn";
import { registerItem } from "./items";
import { approvalTierFor, createPurchaseOrder, decidePurchaseOrder, sendPurchaseOrder, submitPurchaseOrder } from "./purchase-orders";
import { createStore } from "./stores";
import { activateVendor, addVendorDocument, assertVendorPurchasable, getVendor, registerVendor, suspendVendor, updateVendor } from "./vendors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S5a (#1115, spec "Pharmacy-live paths touched, each pinned") — CHARACTERISATION, NOT ACCEPTANCE.
 *
 * S5a adds supplier KYC levels, new nullable vendor columns, a non-drug GRN QC twin and approval delegation beside
 * materials code that live PHARMACY runs on. These tests were written against `main` before any materials edit and are
 * green there: a pharmacy purchase order (draft, submit, the two tiers, approve, send, the refusals), a pharmacy GRN's
 * QC by the pharmacist, vendor onboarding (register, paperwork, activate, patch, suspend) and the approval types'
 * approvers. They must stay green, unchanged, after S5a: a red one means pharmacy moved.
 */
const T0 = new Date("2026-11-10T04:30:00.000Z");
const at = (m: number): Date => new Date(T0.getTime() + m * 60_000);

describe("pharmacy paths S5a must not move (spec #1115, characterisation)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let store: string;
  let vendor: string;
  let crocin: string;

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
      materials_head: ["materials.po.raise", "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "approvals.requests.decide", "approvals.requests.read"],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc"],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
      owner: ["approvals.requests.decide", "approvals.requests.read"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    vendor = await aVendor("ACME");
    ({ itemId: crocin } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "CROC", name: "Crocin 500", class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    })));
  });

  async function aVendor(code: string): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName: `${code} Pharma Pvt Ltd` }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    return vendorId;
  }
  async function code(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) { if (e instanceof MaterialsError) return e.code; throw e; }
    throw new Error("expected a refusal");
  }

  it("a pharmacy PO: draft → submit at the head's tier (≤ ₹50,000) → approved → sent; the raiser cannot decide it", async () => {
    expect(PO_HEAD_APPROVAL_LIMIT_PAISE).toBe(5_000_000);
    expect([approvalTierFor(5_000_000), approvalTierFor(5_000_001)]).toEqual(["head", "owner"]);
    const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: crocin, qtyPacks: 10, ratePaise: 25_000 }] }, { now: T0 });
    expect([po.status, po.source, po.subtotalPaise, po.gstPaise, po.totalPaise]).toEqual(["draft", "manual", 250_000, 30_000, 280_000]);
    const sub = await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
    expect([sub.status, sub.approvalTier, sub.approval?.approverRole]).toEqual(["pending_approval", "head", "materials_head"]);
    await expect(decidePurchaseOrder(db, pharmacist.actor, po.id, "approve", "mine", at(2))).rejects.toBeInstanceOf(SodViolationError);
    const ok = await decidePurchaseOrder(db, head.actor, po.id, "approve", "within budget", at(3));
    expect([ok.status, ok.approvedBy]).toEqual(["approved", head.id]);
    expect((await sendPurchaseOrder(db, pharmacist.actor, po.id, at(4))).status).toBe("sent");
  });

  it("a pharmacy PO above ₹50,000 waits for the owner; the head cannot grant it; a suspended vendor is refused at submit", async () => {
    const big = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: crocin, qtyPacks: 200, ratePaise: 25_000 }] }, { now: T0 });
    const sub = await submitPurchaseOrder(db, pharmacist.actor, big.id, at(1));
    expect([sub.approvalTier, sub.approval?.approverRole]).toEqual(["owner", "owner"]);
    await expect(decidePurchaseOrder(db, head.actor, big.id, "approve", "ok", at(2))).rejects.toThrow();
    expect((await decidePurchaseOrder(db, owner.actor, big.id, "approve", "ok", at(3))).status).toBe("approved");

    const other = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: crocin, qtyPacks: 1, ratePaise: 25_000 }] }, { now: T0 });
    await withTx(db, (tx) => suspendVendor(tx, head.actor, vendor, "paperwork lapsed"));
    expect(await code(submitPurchaseOrder(db, pharmacist.actor, other.id, at(5)))).toBe("vendor_not_active");
  });

  it("a pharmacy GRN: the pharmacist's gate QC passes the line, records the pharmacist, and the post moves the stock", async () => {
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: vendor, source: "challan", storeResourceId: store, challanNo: "CH-1", challanDate: "2026-11-10",
      lines: [{ itemId: crocin, uom: "strip", qtyInUom: 10, batchNo: "B1", expiryDate: "2028-06-30", unitCostPaise: 2_500 }], now: at(0),
    }));
    const qc = await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    expect(qc.status).toBe("accepted");
    expect(qc.verdicts.map((v) => [v.verdict, v.rule ?? null])).toEqual([["pass", null]]);
    const [g] = await db.select({ status: grns.status, qcBy: grns.qcBy }).from(grns).where(eq(grns.id, grnId));
    expect(g).toEqual({ status: "accepted", qcBy: pharmacist.id });
    const [l] = await db.select({ acc: grnLines.qtyAcceptedBase, rej: grnLines.qtyRejectedBase }).from(grnLines).where(eq(grnLines.grnId, grnId));
    expect(l).toEqual({ acc: 100, rej: 0 });
    expect((await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, at(5)))).status).toBe("posted");
  });

  it("vendor onboarding: registered as draft, refused activation without the base paperwork, active with it, patched field by field", async () => {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "NEWV", legalName: "New Vendor", pan: "ABCDE1234F", msmeClass: "micro" }));
    expect((await getVendor(db, vendorId))?.status).toBe("draft");
    expect(await code(assertVendorPurchasable(db, vendorId))).toBe("vendor_not_active");
    await expect(withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0))).rejects.toBeInstanceOf(MaterialsError);
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    await withTx(db, (tx) => updateVendor(tx, head.actor, vendorId, { paymentTermsDays: 30, msmeClass: "small" }));
    const v = await getVendor(db, vendorId);
    expect([v?.status, v?.paymentTermsDays, v?.msmeClass, v?.pan, v?.bank]).toEqual(["active", 30, "small", "ABCDE1234F", null]);
    expect((await assertVendorPurchasable(db, vendorId)).id).toBe(vendorId);
  });

  it("the materials approval types keep their approvers: PO tiers head and owner, the bank change and payment run the owner's", () => {
    const by = new Map(MATERIALS_APPROVAL_TYPES.map((s) => [s.typeKey, s.approverRole] as const));
    expect([by.get(PO_APPROVAL_TYPE), by.get(PO_OWNER_APPROVAL_TYPE)]).toEqual(["materials_head", "owner"]);
    expect(by.get("materials_vendor_bank_change")).toBe("owner");
    expect(by.get("materials_payment_run_approval")).toBe("owner");
  });
});
