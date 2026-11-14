import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { stockBatches, supplierReturnLines, supplierReturns } from "../../kernel/db/schema";
import { activateVendor, addVendorDocument, createStore, postMovement, registerVendor, topUpAgentReturns } from "../materials";
import {
  expiryActionList, fefoLeftovers, lastScheduledExpiryRunAt, moveExpiryBatch, nextExpiryRunAt, runExpiryActionsNow, runWeeklyExpiryActions,
} from "./expiry-actions";
import { ensureLooseTray } from "./loose-trays";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #1063 — the expiry action list's pieces the acceptance test (`acceptance/expiry-action-list-1063.test.ts`) does not
 * pin: the FEFO clock, the Monday instant, the trays, the doors' rights, and a supplier whose open draft no longer
 * resolves. Every call is handed `now`; nothing reads the clock.
 */
describe("expiry action list — the pure pieces", () => {
  it("FEFO: an earlier batch that cannot sell out still uses the days up to its own month end", () => {
    // One a day. A: 1000 to sell in 100 days → 900 left. B (150 days) sells only after A's month ends: 50 of 100.
    const left = fefoLeftovers([{ key: "A", free: 1000, daysLeft: 100 }, { key: "B", free: 100, daysLeft: 150 }], 1);
    expect([...left]).toEqual([["A", 900], ["B", 50]]);
    // A sells out in 30 days, so B has 120 days: all 100 go.
    expect([...fefoLeftovers([{ key: "A", free: 30, daysLeft: 100 }, { key: "B", free: 100, daysLeft: 150 }], 1)]).toEqual([["A", 0], ["B", 0]]);
    // No sales: everything is left.
    expect([...fefoLeftovers([{ key: "A", free: 7, daysLeft: 100 }], 0)]).toEqual([["A", 7]]);
  });

  it("the next run is the next Monday 07:00 IST strictly after now; the last scheduled one is a week before it", () => {
    const at = (iso: string): string => nextExpiryRunAt(new Date(iso)).toISOString();
    expect(at("2027-01-03T17:30:00.000Z")).toBe("2027-01-04T01:30:00.000Z"); // Sunday 23:00 IST
    expect(at("2027-01-04T01:29:00.000Z")).toBe("2027-01-04T01:30:00.000Z"); // Monday 06:59 IST
    expect(at("2027-01-04T01:30:00.000Z")).toBe("2027-01-11T01:30:00.000Z"); // Monday 07:00 IST, the run's own instant
    expect(at("2027-01-06T10:00:00.000Z")).toBe("2027-01-11T01:30:00.000Z"); // Wednesday
    expect(at("2027-01-03T20:00:00.000Z")).toBe("2027-01-04T01:30:00.000Z"); // Monday 01:30 IST, still Sunday in UTC
    expect(lastScheduledExpiryRunAt(new Date("2027-01-05T03:30:00.000Z")).toISOString()).toBe("2027-01-04T01:30:00.000Z");
  });
});

const NOW = new Date("2027-01-04T01:30:00.000Z"); // Monday 07:00 IST
const DAY = 86_400_000;
const daysBefore = (n: number): Date => new Date(NOW.getTime() - n * DAY);
const SEED: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

describe("expiry action list — trays, rights and a draft that no longer resolves", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let head: { id: string; actor: Actor };
  let opd: string;
  let retail: string;
  let acme: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    opd = fx.storeId;
    ({ resourceId: retail } = await withTx(db, (tx) => createStore(tx, SEED, { code: "PHARM-RETAIL", name: "Walk-in counter" })));
    await ensureRole(db, "materials_head");
    for (const p of ["materials.returns.manage", "materials.stock.issue", "materials.stock.read"]) await grantPermissionToRole(db, fx.registry, "materials_head", p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "ACME", legalName: "ACME Pvt Ltd" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, daysBefore(200)));
    acme = vendorId;
  });
  afterEach(() => { fx.unregister(); });

  async function batchAt(store: string, item: string, batchNo: string, expiry: string, qty: number): Promise<string> {
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId: item, batchNo, expiryDate: expiry, mrpPaise: 12_000, mrpUom: "strip", landedCostPaise: 500, ownership: "owned", vendorId: acme, createdBy: SEED.id,
    });
    await withTx(db, (tx) => postMovement(tx, SEED, { resourceId: store, batchId, qtyDelta: qty, reason: "grn", refType: "test", refId: batchId, occurredAt: daysBefore(120) }));
    return batchId;
  }
  const sold = async (store: string, batchId: string, qty: number, daysAgo: number): Promise<void> => {
    await withTx(db, (tx) => postMovement(tx, SEED, { resourceId: store, batchId, qtyDelta: -qty, reason: "consume", refType: "test", refId: newId(), occurredAt: daysBefore(daysAgo) }));
  };
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try { await p; return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); }
  };

  it("the damage tray is written off, never returned, even from a real supplier near expiry", async () => {
    const tray = await withTx(db, (tx) => ensureLooseTray(tx, SEED, opd, "damage"));
    const b = await batchAt(tray, fx.item.crocin, "CR-DMG", "2027-02-13", 12);
    const list = await expiryActionList(db, head.actor, NOW);
    expect(list.groups.write_off.rows).toEqual([expect.objectContaining({ batchId: b, tray: "damage", counter: "opd", action: "write_off", why: "damage_tray", actionQtyBase: 12 })]);
    expect(list.groups.return.rows).toHaveLength(0);
    await runWeeklyExpiryActions(db, NOW);
    expect(await db.select().from(supplierReturns)).toHaveLength(0);
  });

  it("a counter's loose tray sells for the counter: the walk-in batch moves when only the OPD loose tray sold the item", async () => {
    const loose = await withTx(db, (tx) => ensureLooseTray(tx, SEED, opd, "loose"));
    const cut = await batchAt(loose, fx.item.calpol, "CA-CUT", "2028-12-31", 40);
    await sold(loose, cut, 12, 10);
    const idle = await batchAt(retail, fx.item.calpol, "CA-WALKIN", "2027-06-30", 50);
    const list = await expiryActionList(db, head.actor, NOW);
    expect(list.groups.move.rows).toEqual([expect.objectContaining({ batchId: idle, moveTo: expect.objectContaining({ storeResourceId: opd }) })]);
  });

  it("each door asks its right; Move takes only a batch the list shows under Move; an agent actor drafts nothing", async () => {
    const b = await batchAt(opd, fx.item.crocin, "CR-60", "2027-03-05", 10);
    expect(await codeOf(expiryActionList(db, fx.clerk.actor, NOW))).toBe("permission_denied");
    expect(await codeOf(runExpiryActionsNow(db, fx.clerk.actor, NOW))).toBe("permission_denied");
    expect(await codeOf(moveExpiryBatch(db, fx.pharmacist.actor, { storeResourceId: opd, batchId: b }, NOW))).toBe("permission_denied");
    // A Return row is not a Move.
    expect(await codeOf(moveExpiryBatch(db, head.actor, { storeResourceId: opd, batchId: b }, NOW))).toBe("not_found");
    const agent: Actor = { type: "agent", id: "print-relay" };
    expect(await codeOf(topUpAgentReturns(db, agent, NOW, { lines: [{ vendorId: acme, batchId: b, storeResourceId: opd, qtyBase: 10, reason: "near_expiry" }] }))).toBe("permission_denied");
    expect(await db.select().from(supplierReturns)).toHaveLength(0);
  });

  it("a supplier whose open draft no longer resolves is skipped, never given a second draft", async () => {
    const b1 = await batchAt(opd, fx.item.crocin, "CR-60", "2027-03-05", 100);
    await runWeeklyExpiryActions(db, NOW);
    const [draft] = await db.select().from(supplierReturns);
    // 60 sold after the draft was made: its line of 100 can no longer leave.
    await sold(opd, b1, 60, 0);
    await batchAt(opd, fx.item.calpol, "CA-70", "2027-03-15", 30);
    const later = new Date(NOW.getTime() + 3_600_000);
    const out = await runExpiryActionsNow(db, head.actor, later);
    expect(out.run.skipped).toEqual([expect.objectContaining({ vendorId: acme, code: "insufficient_stock" })]);
    expect(await db.select().from(supplierReturns)).toHaveLength(1);
    expect(await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.returnId, draft!.id))).toHaveLength(1);
  });
});
