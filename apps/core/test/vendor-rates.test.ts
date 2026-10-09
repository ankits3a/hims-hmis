import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import { grnLines, grns, vendorItemRates } from "../src/kernel/db/schema";
import {
  activateVendor, addVendorDocument, contractRatesFor, endVendorRate, getPurchaseOrder, registerVendor, setStockLevel,
  setVendorRates, suspendVendor, updatePurchaseOrder, vendorRates,
} from "../src/modules/materials";
import { orderFromRates, planPurchaseDrafts, vendorRateSheet } from "../src/modules/pharmacy/purchase-drafts";
import { addShortBookEntry } from "../src/modules/pharmacy/short-book";
import { setupTestDb, truncateAll } from "./helpers/db";
import { MON, seedPharmacyBase, stockIn } from "./helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * Owner 2026-10-04 — step 2 of buying from Aptus Drugs: the vendor's quoted rates are recorded, an order to
 * that vendor is priced from them by the server, the agent's drafts go to the cheapest contracted vendor, and an
 * order line priced above the contract shows the contract beside it.
 */
describe("a vendor's rate contract", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let acme: string;
  let beta: string;
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
  const now = new Date(MON.getTime() + 60 * 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "materials.po.raise");
    await grantPermissionToRole(db, fx.registry, "pharmacy", "materials.vendors.manage");
    acme = await aVendor("ACME");
    beta = await aVendor("BETA");
  });
  afterEach(() => { fx.unregister(); });

  async function aVendor(code: string): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, { code, legalName: `${code} Distributors` }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, MON));
    return vendorId;
  }

  async function bought(vendorId: string, itemId: string, perTablet: number, postedAt: Date): Promise<void> {
    const grnId = newId();
    await db.insert(grns).values({
      id: grnId, grnNo: `GRN-T-${grnId.slice(-6)}`, vendorId, source: "challan", challanNo: "C", challanDate: "2026-08-01",
      storeResourceId: fx.storeId, status: "posted", capturedBy: HEAD.id, postedAt, createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    await db.insert(grnLines).values({
      id: newId(), grnId, itemId, uom: "strip", qtyInUom: 10, qtyBase: 100, unitCostPaise: perTablet,
      freeGoods: false, qtyAcceptedBase: 100, mrpPaise: 12_000, mrpUom: "strip",
    });
  }

  it("records a quote per pack; the same rate again changes nothing; a new rate ends the old one; a bad row stands alone", async () => {
    const first = await setVendorRates(db, fx.pharmacist.actor, acme, [
      { itemId: fx.item.crocin, packSize: 10, ratePaise: 2_400, mrpPaise: 3_500 },
      { itemId: fx.item.calpol, packSize: 15, ratePaise: 1_000 }, // Calpol comes in strips of 10, not 15
    ], { source: "ACME quotation", now });
    expect(first[0]).toMatchObject({ ok: true, changed: true });
    expect(first[1]).toMatchObject({ ok: false, code: "unknown_uom" });
    expect((first[1] as { message: string }).message).toContain("strip of 10");

    expect(await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, packSize: 10, ratePaise: 2_400, mrpPaise: 3_500 }], { now }))
      .toEqual([expect.objectContaining({ ok: true, changed: false })]);
    await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, uom: "strip", ratePaise: 2_300, mrpPaise: 3_500 }], { now });
    const history = await db.select().from(vendorItemRates).where(and(eq(vendorItemRates.vendorId, acme), eq(vendorItemRates.itemId, fx.item.crocin)));
    expect(history.map((h) => [h.ratePaise, h.endedAt === null]).sort()).toEqual([[2_300, true], [2_400, false]]);
    // GST defaults to the item's; the reader names the item.
    expect((await vendorRates(db, fx.pharmacist.actor, acme)).map((r) => [r.itemCode, r.uom, r.multiplier, r.ratePaise, r.gstRateBps, r.mrpPaise]))
      .toEqual([["CROC500", "strip", 10, 2_300, 1_200, 3_500]]);
  });

  it("only the person who keeps vendors records or ends a rate", async () => {
    await expect(setVendorRates(db, fx.aide.actor, acme, [{ itemId: fx.item.crocin, ratePaise: 1 }])).rejects.toMatchObject({ code: "permission_denied" });
    const [r] = await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, ratePaise: 2_400 }], { now });
    await expect(endVendorRate(db, fx.aide.actor, (r as { rateId: string }).rateId)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("the rates in force: cheapest per tablet first, only from active vendors, only inside their period", async () => {
    await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, ratePaise: 2_600 }], { now });
    await setVendorRates(db, fx.pharmacist.actor, beta, [{ itemId: fx.item.crocin, ratePaise: 2_400 }], { now });
    expect((await contractRatesFor(db, [fx.item.crocin], now)).get(fx.item.crocin)!.map((c) => c.vendorId)).toEqual([beta, acme]);
    await withTx(db, (tx) => suspendVendor(tx, HEAD, beta, "licence lapsed"));
    expect((await contractRatesFor(db, [fx.item.crocin], now)).get(fx.item.crocin)!.map((c) => c.vendorId)).toEqual([acme]);
    await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, ratePaise: 2_600, validTo: "2026-08-10" }], { validFrom: "2026-08-01", now });
    expect((await contractRatesFor(db, [fx.item.crocin], now)).get(fx.item.crocin)).toBeUndefined(); // MON is 17 Aug: expired
  });

  it("the agent's drafts go to the cheapest contracted vendor at its rate — even for an item never bought", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 30 });
    await setStockLevel(db, fx.pharmacist.actor, { itemId: fx.item.crocin, storeResourceId: fx.storeId, minBase: 20, reorderBase: 40, maxBase: 200 });
    await bought(beta, fx.item.crocin, 260, new Date("2026-08-05T05:00:00Z")); // last bought from BETA at ₹26/strip
    await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, ratePaise: 2_400 }, { itemId: fx.item.azithro, ratePaise: 9_000 }], { now });
    await addShortBookEntry(db, fx.pharmacist.actor, { itemId: fx.item.azithro, drugName: "Azee", qtyWanted: 25, source: "agent" }, MON);
    const plan = await planPurchaseDrafts(db, now);
    expect(plan.groups.map((g) => [g.vendorCode, g.lines.map((l) => [l.code, l.qtyPacks, l.ratePaise, l.rateSource])])).toEqual([
      ["ACME", [["AZEE500", 3, 9_000, "contract"], ["CROC500", 17, 2_400, "contract"]]],
    ]);
    expect(plan.unassigned).toEqual([]);
  });

  it("an order from the rates: the server prices every line, free packs ride along, an item without a rate is refused by name", async () => {
    await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, ratePaise: 2_400, mrpPaise: 3_500 }], { now });
    await expect(orderFromRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.calpol, qtyPacks: 5 }], now))
      .rejects.toMatchObject({ code: "invalid_range", message: expect.stringContaining("Calpol 500 tablet") });
    const po = await orderFromRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, qtyPacks: 50, freePacks: 5 }], now);
    expect([po.status, po.vendorCode]).toEqual(["draft", "ACME"]);
    expect(po.lines.map((l) => [l.itemCode, l.uom, l.qtyPacks, l.freePacks, l.ratePaise, l.gstRateBps, l.mrpPaise, l.contractRatePaise]))
      .toEqual([["CROC500", "strip", 50, 5, 2_400, 1_200, 3_500, 2_400]]);
    // Typed up above the contract on the draft: the order still shows what was contracted.
    await updatePurchaseOrder(db, fx.pharmacist.actor, po.id, { lines: [{ itemId: fx.item.crocin, uom: "strip", qtyPacks: 50, ratePaise: 2_900, gstRateBps: 1_200 }] }, now);
    const after = await getPurchaseOrder(db, fx.pharmacist.actor, po.id);
    expect([after.lines[0]!.ratePaise, after.lines[0]!.contractRatePaise]).toEqual([2_900, 2_400]);
  });

  it("the office's rate sheet sets the contract beside what was last paid", async () => {
    await bought(beta, fx.item.crocin, 260, new Date("2026-08-05T05:00:00Z"));
    await setVendorRates(db, fx.pharmacist.actor, acme, [{ itemId: fx.item.crocin, ratePaise: 2_400 }], { now });
    expect((await vendorRateSheet(db, fx.pharmacist.actor, acme)).map((l) => [l.itemCode, l.ratePaise, l.lastPaidPaise, l.lastVendorId]))
      .toEqual([["CROC500", 2_400, 2_600, beta]]);
  });
});
