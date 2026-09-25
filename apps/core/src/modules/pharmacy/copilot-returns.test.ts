import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { permissionCheckFor, runTool } from "../../kernel/copilot/catalog";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { stockBatches, supplierReturns } from "../../kernel/db/schema";
import { activateVendor, addVendorDocument, postMovement, registerVendor } from "../materials";
import { pharmacyCopilotTools } from "./copilot-tools";
import type { Actor } from "@hmis/contracts";
import type { CopilotToolCtx } from "../../kernel/copilot/types";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PARITY P4 — "EXPIRY RETURN BANA DO": THE AGENT SAYS WHAT WOULD GO BACK, AND WRITES NOTHING ═══
 *
 * The tool reads the plan (`planSupplierReturns`) on the real clock, as the P2 and P3 tools do, so
 * the fixture's dates are RELATIVE to today — a batch that expired ten days ago is inside the 90-day
 * window whatever day this suite runs (the fixed-date time-bomb lesson).
 */
describe("the copilot's draft_supplier_returns (parity P4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
  const day = (offset: number): string => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "materials.returns.manage");
  });
  afterEach(() => { fx.unregister(); });

  async function vendorBatch(code: string, expiryDate: string, qty: number): Promise<void> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, { code, legalName: `${code} Distributors` }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, new Date()));
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId: fx.item.crocin, batchNo: `${code}-1`, expiryDate, mrpPaise: 3_500, mrpUom: "strip", landedCostPaise: 250,
      vendorId, ownership: "owned", createdBy: HEAD.id,
    });
    await withTx(db, (tx) => postMovement(tx, HEAD, { resourceId: fx.storeId, batchId, qtyDelta: qty, reason: "grn", refType: "test", refId: batchId, occurredAt: new Date() }));
  }

  it("answers with the plan (vendors, batches, what can only be destroyed) and a card to the office; writes nothing", async () => {
    await vendorBatch("ACME", day(-10), 40); // expired ten days ago: inside the window
    await vendorBatch("BETA", day(-200), 10); // past the window: destroy only
    const c: CopilotToolCtx = { db, actor: fx.pharmacist.actor, subject: null, serviceDate: day(0), question: "expiry return bana do" };
    const tool = pharmacyCopilotTools.find((t) => t.intent === "draft_supplier_returns")!;
    expect(tool.permission).toBe("materials.returns.manage");
    const a = await runTool(tool, c, permissionCheckFor(c));
    expect(a).toMatchObject({
      key: "copilot.answer.returnPlan", params: { vendors: 1, batches: 1, amount: "100", toDestroy: 1 },
      payload: { kind: "supplier_return_plan", href: "/pharmacy/office?view=returns", vendors: 1, batches: 1, taxablePaise: 10_000, toDestroy: 1 },
    });
    expect(await db.select().from(supplierReturns)).toHaveLength(0);
    // A login that may not draft a return is not offered one.
    const aide: CopilotToolCtx = { ...c, actor: fx.aide.actor };
    expect(await runTool(tool, aide, permissionCheckFor(aide))).not.toMatchObject({ key: "copilot.answer.returnPlan" });
  });

  it("with nothing to send back, says so", async () => {
    const c: CopilotToolCtx = { db, actor: fx.pharmacist.actor, subject: null, serviceDate: day(0), question: "expiry return bana do" };
    const tool = pharmacyCopilotTools.find((t) => t.intent === "draft_supplier_returns")!;
    expect(await runTool(tool, c, permissionCheckFor(c))).toMatchObject({ key: "copilot.answer.returnNothing", params: { toDestroy: 0 } });
  });
});
