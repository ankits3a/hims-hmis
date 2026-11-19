import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { seedPharmacyBase } from "../../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { withTx } from "../../../kernel/db/client";
import { items, stockBatches, supplierReturnLines, supplierReturns, transferLines, transfers } from "../../../kernel/db/schema";
import { activateVendor, addVendorDocument, createStore, postMovement, registerItem, registerVendor } from "../../materials";
import { expiryActionList, moveExpiryBatch, runExpiryActionsNow, runWeeklyExpiryActions } from "../index";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1063, spec docs/specs/1063-expiry-action-list.md (owner APPROVED 2026-11-14 with its defaults):
 * the weekly expiry action list. Every batch at the two counters (PHARM-OPD, PHARM-RETAIL, their loose and damage trays)
 * that has expired or expires within 180 days gets ONE action, the first that applies: Return (inside the supplier's
 * window, a real supplier) · Move (the other counter sold the item in 90 days and this one did not) · At risk (more stock
 * than 90 days of this counter's sales will use before the expiry month ends) · Write off (past the window, or opening
 * stock with no supplier). NDPS stock is listed apart and never drafted. The run (Monday 07:00 IST, or Run now) drafts at
 * most one open agent return per supplier and never approves, dispatches or writes off. The screen half of D3 and D5:
 * apps/web/src/screens/acceptance/expiry-action-list-1063.test.tsx.
 *
 * The code under test reads no clock: every call is handed `now`, so the dates below are fixed. NOW is Monday
 * 4 Jan 2027, 07:00 IST — the run's own instant.
 */
const NOW = new Date("2027-01-04T01:30:00.000Z");
const DAY = 86_400_000;
const daysBefore = (n: number): Date => new Date(NOW.getTime() - n * DAY);
const HEAD_SEED: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

describe("weekly expiry action list (spec #1063)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let head: { id: string; actor: Actor };
  let opd: string;
  let retail: string;
  let acme: string;
  let opening: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    opd = fx.storeId;
    ({ resourceId: retail } = await withTx(db, (tx) => createStore(tx, HEAD_SEED, { code: "PHARM-RETAIL", name: "Walk-in counter" })));
    await ensureRole(db, "materials_head");
    for (const p of ["materials.returns.manage", "materials.stock.issue", "materials.stock.read", "materials.stock.receive"]) {
      await grantPermissionToRole(db, fx.registry, "materials_head", p);
    }
    head = await mkUser(db, "mat.head", ["materials_head"]);
    acme = await aVendor("ACME", "ACME Pharma Distributors");
    opening = await aVendor("OPENING-STOCK", "OPENING STOCK");
  });
  afterEach(() => { fx.unregister(); });

  async function aVendor(code: string, tradeName: string): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName: `${code} Pvt Ltd`, tradeName }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, daysBefore(200)));
    return vendorId;
  }

  /** A batch on `store`'s shelf: `qty` tablets at `cost` paise a tablet (the GRN's cost), received 120 days ago. */
  async function batchAt(store: string, o: {
    item: string; batchNo: string; expiry: string; qty: number; vendorId: string | null; cost?: number; estimated?: boolean;
    custody?: { witnessId: string };
  }): Promise<string> {
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId: o.item, batchNo: o.batchNo, expiryDate: o.expiry, mrpPaise: 12_000, mrpUom: "strip",
      landedCostPaise: o.cost ?? 500, ownership: "owned", vendorId: o.vendorId, estimatedCost: o.estimated ?? false, createdBy: HEAD_SEED.id,
    });
    await withTx(db, (tx) => postMovement(tx, o.custody === undefined ? HEAD_SEED : head.actor, {
      resourceId: store, batchId, qtyDelta: o.qty, reason: "grn", refType: "test", refId: batchId, occurredAt: daysBefore(120),
      ...(o.custody === undefined ? {} : { custody: o.custody }),
    }));
    return batchId;
  }

  /** `qty` tablets sold from `store` `daysAgo` days before NOW — the `consume` row a hand-over or a walk-in sale writes. */
  async function sold(store: string, batchId: string, qty: number, daysAgo: number): Promise<void> {
    await withTx(db, (tx) => postMovement(tx, HEAD_SEED, {
      resourceId: store, batchId, qtyDelta: -qty, reason: "consume", refType: "test", refId: newId(), occurredAt: daysBefore(daysAgo),
    }));
  }

  const returnsFor = async (vendorId: string) => db.select().from(supplierReturns).where(eq(supplierReturns.vendorId, vendorId));
  const linesOf = async (returnId: string) => db.select().from(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId));
  type Listed = Awaited<ReturnType<typeof expiryActionList>>;
  const everyRow = (l: Listed) => [...l.groups.return.rows, ...l.groups.move.rows, ...l.groups.at_risk.rows, ...l.groups.write_off.rows, ...l.ndps.rows];
  const rowOf = (l: Listed, batchId: string) => everyRow(l).find((r) => r.batchId === batchId);

  it("spec #1063 D1: a real supplier's batch expiring in 60 days is listed under Return; the Monday run drafts it for that supplier, and a second run adds nothing twice", async () => {
    const b1 = await batchAt(opd, { item: fx.item.crocin, batchNo: "CR-60", expiry: "2027-03-05", qty: 100, vendorId: acme });

    const before = await expiryActionList(db, head.actor, NOW);
    expect(before.groups.return.rows.map((r) => r.batchId)).toEqual([b1]);
    expect(rowOf(before, b1)).toMatchObject({ action: "return", vendorId: acme, storeResourceId: opd, actionQtyBase: 100, valuePaise: 100 * 500, document: null });

    const ran = await runWeeklyExpiryActions(db, NOW);
    expect(ran.ran).toBe(true);
    const drafts = await returnsFor(acme);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "draft", source: "agent" });
    const lines = await linesOf(drafts[0]!.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ batchId: b1, storeResourceId: opd, qtyBase: 100, reason: "near_expiry" });

    // The row now shows its document instead of an action.
    const after = await expiryActionList(db, head.actor, NOW);
    expect(rowOf(after, b1)).toMatchObject({ action: null, document: { kind: "return", id: drafts[0]!.id, status: "draft" } });

    // The Monday job again on the same Monday does nothing; Run now by a person drafts nothing twice.
    expect((await runWeeklyExpiryActions(db, new Date(NOW.getTime() + 60_000))).ran).toBe(false);
    await runExpiryActionsNow(db, head.actor, new Date(NOW.getTime() + 2 * 3_600_000));
    expect(await returnsFor(acme)).toHaveLength(1);
    expect(await linesOf(drafts[0]!.id)).toHaveLength(1);

    // A new batch of the same supplier joins the open draft; no second return is made.
    const b2 = await batchAt(opd, { item: fx.item.calpol, batchNo: "CA-70", expiry: "2027-03-15", qty: 40, vendorId: acme });
    await runExpiryActionsNow(db, head.actor, new Date(NOW.getTime() + 3 * 3_600_000));
    const still = await returnsFor(acme);
    expect(still).toHaveLength(1);
    expect((await linesOf(still[0]!.id)).map((l) => l.batchId).sort()).toEqual([b1, b2].sort());
  });

  it("spec #1063 D2: an expired batch past the supplier's window and an opening-stock batch near expiry are listed under Write off with their value, and no return is drafted for them", async () => {
    // Expired 100 days ago; the default window takes expired stock back for 90 days.
    const stale = await batchAt(opd, { item: fx.item.crocin, batchNo: "CR-OLD", expiry: "2026-09-26", qty: 30, vendorId: acme, cost: 400 });
    // The hospital's own opening stock, expiring in 45 days, entered with a blank rate (an estimated cost).
    const own = await batchAt(opd, { item: fx.item.calpol, batchNo: "CA-OPEN", expiry: "2027-02-18", qty: 60, vendorId: opening, cost: 300, estimated: true });

    const list = await expiryActionList(db, head.actor, NOW);
    expect(list.groups.write_off.rows.map((r) => r.batchId).sort()).toEqual([stale, own].sort());
    expect(rowOf(list, stale)).toMatchObject({ action: "write_off", actionQtyBase: 30, valuePaise: 30 * 400, estimated: false });
    expect(rowOf(list, own)).toMatchObject({ action: "write_off", actionQtyBase: 60, valuePaise: 60 * 300, estimated: true });
    expect(list.groups.write_off.valuePaise).toBe(30 * 400 + 60 * 300);
    expect(list.groups.return.rows).toHaveLength(0);

    await runWeeklyExpiryActions(db, NOW);
    expect(await db.select().from(supplierReturns)).toHaveLength(0);
  });

  it("spec #1063 D3: a walk-in batch that sold nothing in 90 days while the OPD desk sold the item is listed under Move, and tapping Move drafts a transfer of that batch to the OPD store", async () => {
    // The OPD desk sells Calpol from a long-dated batch; the walk-in counter has not sold one in 90 days.
    const desk = await batchAt(opd, { item: fx.item.calpol, batchNo: "CA-DESK", expiry: "2028-12-31", qty: 500, vendorId: acme });
    await sold(opd, desk, 20, 25);
    await sold(opd, desk, 30, 5);
    const idle = await batchAt(retail, { item: fx.item.calpol, batchNo: "CA-WALKIN", expiry: "2027-06-30", qty: 200, vendorId: acme });

    const list = await expiryActionList(db, head.actor, NOW);
    expect(list.groups.move.rows.map((r) => r.batchId)).toEqual([idle]);
    expect(rowOf(list, idle)).toMatchObject({ action: "move", storeResourceId: retail, actionQtyBase: 200, moveTo: { storeResourceId: opd } });

    const moved = await moveExpiryBatch(db, head.actor, { storeResourceId: retail, batchId: idle }, NOW);
    const [t] = await db.select().from(transfers).where(eq(transfers.id, moved.transferId));
    expect(t).toMatchObject({ fromResourceId: retail, toResourceId: opd, status: "in_transit" });
    const tl = await db.select().from(transferLines).where(eq(transferLines.transferId, moved.transferId));
    expect(tl.map((l) => [l.batchId, l.qtyIssued])).toEqual([[idle, 200]]);

    // Gone from the walk-in shelf, so no longer listed to move.
    expect((await expiryActionList(db, head.actor, NOW)).groups.move.rows).toHaveLength(0);
  });

  it("spec #1063 D4: a batch expiring in about 150 days with more stock than this store's sales will use is listed under At risk with the leftover quantity and its value", async () => {
    // 90 tablets sold at the OPD desk in the last 90 days: one a day.
    const desk = await batchAt(opd, { item: fx.item.crocin, batchNo: "CR-LONG", expiry: "2028-12-31", qty: 500, vendorId: acme });
    for (const ago of [80, 50, 20]) await sold(opd, desk, 30, ago);
    // 400 tablets expiring 31 May 2027: 147 days of selling left at one a day leaves 253 on the shelf at expiry.
    const slow = await batchAt(opd, { item: fx.item.crocin, batchNo: "CR-150", expiry: "2027-05-31", qty: 400, vendorId: acme, cost: 500 });

    const list = await expiryActionList(db, head.actor, NOW);
    expect(list.groups.at_risk.rows.map((r) => r.batchId)).toEqual([slow]);
    expect(rowOf(list, slow)).toMatchObject({ action: "at_risk", qtyBase: 400, actionQtyBase: 253, valuePaise: 253 * 500 });
    expect(list.groups.at_risk.valuePaise).toBe(253 * 500);

    // A batch the same sales will clear before its expiry month ends is not listed at all.
    const quick = await batchAt(opd, { item: fx.item.calpol, batchNo: "CA-QUICK", expiry: "2027-05-31", qty: 100, vendorId: acme });
    const calpolDesk = await batchAt(opd, { item: fx.item.calpol, batchNo: "CA-LONG", expiry: "2028-12-31", qty: 500, vendorId: acme });
    for (const ago of [80, 50, 20]) await sold(opd, calpolDesk, 30, ago);
    expect(rowOf(await expiryActionList(db, head.actor, NOW), quick)).toBeUndefined();
  });

  it("spec #1063 D5: the list shows last run, next run and batches checked; Run now reruns and updates them", async () => {
    await batchAt(opd, { item: fx.item.crocin, batchNo: "CR-60", expiry: "2027-03-05", qty: 100, vendorId: acme });
    await batchAt(opd, { item: fx.item.calpol, batchNo: "CA-OLD", expiry: "2026-09-26", qty: 10, vendorId: acme });

    // Before any run: no last run; the next run is this Monday's 07:00 IST.
    const early = await expiryActionList(db, head.actor, new Date(NOW.getTime() - 3_600_000));
    expect(early.run).toMatchObject({ lastRunAt: null, batchesChecked: null, nextRunAt: "2027-01-04T01:30:00.000Z" });

    await runWeeklyExpiryActions(db, NOW);
    const monday = await expiryActionList(db, head.actor, NOW);
    expect(monday.run).toMatchObject({ lastRunAt: NOW.toISOString(), lastTrigger: "schedule", batchesChecked: 2, nextRunAt: "2027-01-11T01:30:00.000Z" });

    await batchAt(retail, { item: fx.item.azithro, batchNo: "AZ-30", expiry: "2027-02-03", qty: 20, vendorId: acme });
    const later = new Date(NOW.getTime() + 26 * 3_600_000); // Tuesday 09:00 IST
    const rerun = await runExpiryActionsNow(db, head.actor, later);
    expect(rerun.list.run).toMatchObject({ lastRunAt: later.toISOString(), lastTrigger: "run_now", batchesChecked: 3, nextRunAt: "2027-01-11T01:30:00.000Z" });
    expect((await expiryActionList(db, head.actor, later)).run).toMatchObject({ lastRunAt: later.toISOString(), batchesChecked: 3 });
  });

  it("spec #1063 D6: a narcotic batch is listed apart and never drafted", async () => {
    // The two-key cabinet, and a narcotic it holds from a real supplier, expiring in 30 days.
    const { resourceId: cabinet } = await withTx(db, (tx) => createStore(tx, HEAD_SEED, { code: "PHARM-NDPS", name: "Narcotics cabinet", attributes: { controlled: true } }));
    const { itemId: morphine } = await withTx(db, (tx) => registerItem(tx, HEAD_SEED, {
      code: "MORPH10", name: "Morphine 10 mg tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.alprax,
      storageClass: "narcotic", gstRateBps: 1200, uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }));
    const locked = await batchAt(cabinet, { item: morphine, batchNo: "MO-30", expiry: "2027-02-03", qty: 50, vendorId: acme, custody: { witnessId: fx.pharmacist.id } });
    // An item classified narcotic after its stock reached the OPD shelf.
    const slipped = await batchAt(opd, { item: fx.item.azithro, batchNo: "AZ-30", expiry: "2027-02-03", qty: 20, vendorId: acme });
    await db.update(items).set({ storageClass: "narcotic" }).where(eq(items.id, fx.item.azithro));

    const list = await expiryActionList(db, head.actor, NOW);
    expect(list.ndps.rows.map((r) => r.batchId).sort()).toEqual([locked, slipped].sort());
    for (const r of list.ndps.rows) expect(r.action).toBeNull();
    for (const g of [list.groups.return, list.groups.move, list.groups.at_risk, list.groups.write_off]) {
      expect(g.rows.filter((r) => [locked, slipped].includes(r.batchId))).toHaveLength(0);
    }

    await runWeeklyExpiryActions(db, NOW);
    await runExpiryActionsNow(db, head.actor, new Date(NOW.getTime() + 3_600_000));
    const drafted = await db.select({ id: supplierReturnLines.id }).from(supplierReturnLines)
      .where(and(inArray(supplierReturnLines.batchId, [locked, slipped])));
    expect(drafted).toHaveLength(0);
  });
});
