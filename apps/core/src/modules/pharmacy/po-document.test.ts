import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { activateVendor, addVendorDocument, createPurchaseOrder, registerVendor } from "../materials";
import { purchaseOrderDocument } from "./office";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/** #637 — the purchase order on paper names the vendor's discount: list rate, discount, then the net rate it is priced at. */
describe("the PO paper carries the vendor discount (#637)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let vendorId: string;
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "materials.po.raise");
    ({ vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, { code: "ACME", legalName: "ACME Distributors" })));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, MON));
  });
  afterEach(() => { fx.unregister(); });

  const order = (lines: { itemId: string; qtyPacks: number; ratePaise: number; discountBps?: number }[]) =>
    createPurchaseOrder(db, fx.pharmacist.actor, { vendorId, storeResourceId: fx.storeId, lines }, { now: MON });

  it("a discounted line prints its list rate and discount beside the net rate", async () => {
    const po = await order([{ itemId: fx.item.crocin, qtyPacks: 10, ratePaise: 25_000, discountBps: 1_250 }, { itemId: fx.item.azithro, qtyPacks: 2, ratePaise: 9_000 }]);
    const { html } = await purchaseOrderDocument(db, fx.pharmacist.actor, po.id);
    expect(html).toContain("List ₹");
    expect(html).toContain("Disc");
    expect(html).toMatch(/250\.00<\/td><td class="n">12\.5%<\/td><td class="n">218\.75</);
    // The undiscounted line shows its rate as the list rate and no discount.
    expect(html).toMatch(/90\.00<\/td><td class="n">—<\/td><td class="n">90\.00</);
  });

  it("an order with no discount keeps the plain columns", async () => {
    const po = await order([{ itemId: fx.item.crocin, qtyPacks: 10, ratePaise: 25_000 }]);
    const { html } = await purchaseOrderDocument(db, fx.pharmacist.actor, po.id);
    expect(html).not.toContain("List ₹");
  });
});
