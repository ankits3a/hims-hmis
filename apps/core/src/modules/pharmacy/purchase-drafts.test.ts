import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { permissionCheckFor, runTool } from "../../kernel/copilot/catalog";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { grnLines, grns, purchaseOrders } from "../../kernel/db/schema";
import { activateVendor, addVendorDocument, registerVendor, setStockLevel, suspendVendor } from "../materials";
import { pharmacyCopilotTools } from "./copilot-tools";
import { officeToday } from "./office";
import { draftPurchaseOrders, planPurchaseDrafts } from "./purchase-drafts";
import { reorderAdvice } from "./replenishment";
import { addShortBookEntry } from "./short-book";
import type { Actor } from "@hmis/contracts";
import type { CopilotToolCtx } from "../../kernel/copilot/types";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PARITY P2 — THE AGENT DRAFTS THE ORDERS; A PERSON MAKES AND SENDS THEM ═══
 *
 * The plan: one DRAFT per vendor, from the reorder list and the short book, each item addressed to
 * its LAST supplier at that receipt's rate. The copilot's tool only reads the plan; the office's
 * button writes drafts; nothing is submitted, approved or sent here.
 */
describe("purchase drafts (parity P2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let acme: string;
  let beta: string;
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "materials.po.raise");
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

  /** A posted, accepted, PAID receipt of `strips` strips at `perTablet` paise a tablet — the history the draft prices from. */
  async function bought(vendorId: string, itemId: string, perTablet: number, postedAt: Date, over: { free?: boolean } = {}): Promise<void> {
    const grnId = newId();
    await db.insert(grns).values({
      id: grnId, grnNo: `GRN-T-${grnId.slice(-6)}`, vendorId, source: "challan", challanNo: "C", challanDate: "2026-08-01",
      storeResourceId: fx.storeId, status: "posted", capturedBy: HEAD.id, postedAt, createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    await db.insert(grnLines).values({
      id: newId(), grnId, itemId, uom: "strip", qtyInUom: 10, qtyBase: 100, unitCostPaise: over.free === true ? 0 : perTablet,
      freeGoods: over.free === true, qtyAcceptedBase: 100, mrpPaise: 12_000, mrpUom: "strip",
    });
  }

  const now = new Date(MON.getTime() + 60 * 60_000);

  async function scenario(): Promise<void> {
    // Crocin: at its reorder level, bought first from ACME and then, later, from BETA.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 30 });
    await setStockLevel(db, fx.pharmacist.actor, { itemId: fx.item.crocin, storeResourceId: fx.storeId, minBase: 20, reorderBase: 40, maxBase: 200 });
    await bought(acme, fx.item.crocin, 240, new Date("2026-08-01T05:00:00Z"));
    await bought(beta, fx.item.crocin, 260, new Date("2026-08-05T05:00:00Z"));
    await bought(acme, fx.item.crocin, 0, new Date("2026-08-06T05:00:00Z"), { free: true }); // free goods: not a price
    // Calpol: no level and no movement, but somebody said "Calpol khatam".
    await bought(acme, fx.item.calpol, 150, new Date("2026-08-02T05:00:00Z"));
    await addShortBookEntry(db, fx.pharmacist.actor, { itemId: fx.item.calpol, drugName: "Calpol", source: "desk" }, MON);
    // Azithro: short, 25 tablets wanted, never bought — nobody to address it to.
    await addShortBookEntry(db, fx.pharmacist.actor, { itemId: fx.item.azithro, drugName: "Azee", qtyWanted: 25, source: "agent" }, MON);
    // A drug the stores do not carry at all.
    await addShortBookEntry(db, fx.pharmacist.actor, { drugName: "Montair LC", source: "desk" }, MON);
  }

  it("the reorder list carries the levels, and at the reorder level suggests max − (on hand + on order)", async () => {
    await scenario();
    const crocin = (await reorderAdvice(db, now)).items.find((i) => i.itemId === fx.item.crocin)!;
    expect([crocin.status, crocin.available, crocin.levels, crocin.onOrderBase, crocin.inDraftBase, crocin.orderBase])
      .toEqual(["reorder", 30, { minBase: 20, reorderBase: 40, maxBase: 200 }, 0, 0, 170]);
  });

  it("plans one order per LAST supplier at that receipt's rate, adds the short book, and leaves the rest for a person", async () => {
    await scenario();
    const plan = await planPurchaseDrafts(db, now);
    expect(plan.groups.map((g) => [g.vendorCode, g.lines.map((l) => [l.code, l.uom, l.qtyPacks, l.ratePaise, l.reasons])])).toEqual([
      ["BETA", [["CROC500", "strip", 17, 2_600, ["reorder"]]]],
      ["ACME", [["CALP500", "strip", 1, 1_500, ["short_book"]]]],
    ]);
    expect(plan.unassigned.map((u) => [u.code, u.qtyPacks, u.why, u.reasons])).toEqual([["AZEE500", 3, "no_history", ["short_book"]]]);
    expect(plan.unmatched.map((u) => u.drugName)).toEqual(["Montair LC"]);
    expect(plan.expectedDate).toBe("2026-08-20");
  });

  it("an item whose last supplier is no longer active goes to a person, not to that supplier", async () => {
    await scenario();
    await withTx(db, (tx) => suspendVendor(tx, HEAD, beta, "licence lapsed"));
    const plan = await planPurchaseDrafts(db, now);
    expect(plan.unassigned.map((u) => [u.code, u.why])).toEqual([["AZEE500", "no_history"], ["CROC500", "vendor_inactive"]]);
  });

  it("the copilot's tool answers with the plan and writes nothing", async () => {
    await scenario();
    const c: CopilotToolCtx = { db, actor: fx.pharmacist.actor, subject: null, serviceDate: "2026-08-17", question: "order karo" };
    const tool = pharmacyCopilotTools.find((t) => t.intent === "draft_purchase_orders")!;
    expect(tool.permission).toBe("materials.po.raise");
    const a = await runTool(tool, c, permissionCheckFor(c));
    expect(a).toMatchObject({
      key: "copilot.answer.purchaseDraftPlan", params: { orders: 2, lines: 2, unassigned: 1 },
      payload: { kind: "purchase_draft_plan", href: "/pharmacy/office", unmatched: 1 },
    });
    expect(await db.select().from(purchaseOrders)).toHaveLength(0);
    // A clerk who cannot raise an order is not offered one.
    const clerk: CopilotToolCtx = { ...c, actor: fx.aide.actor };
    expect(await runTool(tool, clerk, permissionCheckFor(clerk))).not.toMatchObject({ key: "copilot.answer.purchaseDraftPlan" });
  });

  it("the person's press writes DRAFTS only, one per vendor, and the same items are not drafted twice", async () => {
    await scenario();
    const drafts = await draftPurchaseOrders(db, fx.pharmacist.actor, now, [{ itemId: fx.item.azithro, vendorId: acme, ratePaise: 30_000 }]);
    expect(drafts.map((d) => [d.vendorCode, d.status, d.source, d.expectedDate, d.lines.map((l) => [l.itemCode, l.qtyPacks, l.ratePaise])]).sort()).toEqual([
      ["ACME", "draft", "agent", "2026-08-20", [["AZEE500", 3, 30_000], ["CALP500", 1, 1_500]]],
      ["BETA", "draft", "agent", "2026-08-20", [["CROC500", 17, 2_600]]],
    ]);
    const again = await planPurchaseDrafts(db, now);
    expect([again.groups.length, again.unassigned.length]).toEqual([0, 0]);
    expect(again.alreadyDrafted.map((a) => a.code)).toEqual(["AZEE500", "CALP500", "CROC500"]);
    const crocin = (await reorderAdvice(db, now)).items.find((i) => i.itemId === fx.item.crocin)!;
    expect([crocin.inDraftBase, crocin.orderBase]).toEqual([170, 0]);
    // The office's home counts them as drafts to review, and the open shortages beside them.
    const today = await officeToday(db, fx.pharmacist.actor, now);
    expect([today.drafts.length, today.awaitingYou.length, today.shortages.length, today.plan.orders]).toEqual([2, 0, 3, 0]);
    expect(await db.select().from(purchaseOrders).where(eq(purchaseOrders.status, "draft"))).toHaveLength(2);
  });

  it("only a person who may raise an order may press it", async () => {
    await scenario();
    await expect(draftPurchaseOrders(db, fx.aide.actor, now)).rejects.toMatchObject({ code: "permission_denied" });
  });
});
