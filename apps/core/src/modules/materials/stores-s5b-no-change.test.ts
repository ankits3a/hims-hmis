import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { registerMaterialsApprovalTypes } from "./approval-types";
import { MaterialsError } from "./errors";
import { registerItem } from "./items";
import { createPurchaseOrder, decidePurchaseOrder, registerAwardPoGuard, sendPurchaseOrder, submitPurchaseOrder } from "./purchase-orders";
import { createStore } from "./stores";
import { activateVendor, addVendorDocument, registerVendor } from "./vendors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, decision 10) — CHARACTERISATION of the one materials change S5b makes: `purchase_orders.award_id`
 * and the award check at submit and send. A pharmacy order carries no award, so the check is NEVER asked for it, even
 * when a check that refuses everything is registered: the order is drafted, submitted, approved and sent exactly as
 * `stores-s5a-no-change.test.ts` pins. An order made from an award with no check loaded is refused (fail closed).
 */
const T0 = new Date("2026-11-10T04:30:00.000Z");
const at = (m: number): Date => new Date(T0.getTime() + m * 60_000);

describe("pharmacy POs S5b must not move (spec #1115, characterisation)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
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
    for (const role of ["materials_head", "pharmacy"]) await ensureRole(db, role);
    for (const p of ["materials.po.raise", "materials.stock.read", "approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, registry, "materials_head", p);
    for (const p of ["materials.po.raise", "materials.stock.read"]) await grantPermissionToRole(db, registry, "pharmacy", p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "ACME", legalName: "ACME Pharma Pvt Ltd" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    vendor = vendorId;
    ({ itemId: crocin } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "CROC", name: "Crocin 500", class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    })));
  });

  it("a pharmacy PO (no award) never asks the award check: draft → submit → approve → send as before, even with a refusing check registered", async () => {
    let asked = 0;
    const off = registerAwardPoGuard({
      onSubmit: async () => { asked += 1; throw new Error("must not be asked"); },
      onSend: async () => { asked += 1; throw new Error("must not be asked"); },
    });
    try {
      const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: crocin, qtyPacks: 10, ratePaise: 25_000 }] }, { now: T0 });
      expect([po.status, po.source, po.totalPaise]).toEqual(["draft", "manual", 280_000]);
      expect((await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1))).approvalTier).toBe("head");
      expect((await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok", at(2))).status).toBe("approved");
      expect((await sendPurchaseOrder(db, pharmacist.actor, po.id, at(3))).status).toBe("sent");
      expect(asked).toBe(0);
    } finally { off(); }
  });

  it("an order made from an award is refused at submit when no award check is loaded (fail closed)", async () => {
    const po = await createPurchaseOrder(db, head.actor, { vendorId: vendor, storeResourceId: store, lines: [{ itemId: crocin, qtyPacks: 1, ratePaise: 25_000 }] }, { now: T0, awardId: "award-x" });
    await expect(submitPurchaseOrder(db, head.actor, po.id, at(1))).rejects.toBeInstanceOf(MaterialsError);
  });
});
