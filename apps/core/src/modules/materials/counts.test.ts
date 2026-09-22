import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { events, stockBatches } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { cancelCount, closeCount, countSheet, getCount, scheduleCount, submitCount } from "./counts";
import { registerItem } from "./items";
import { balances, postMovement } from "./ledger";
import { createStore, ensureTransitStore, setStoreCustodianRoles } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 14c, FIRST SLICE — A BLIND COUNT BY SOMEONE WHO DOES NOT KEEP THE STORE ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-materials-counts.md`. Doc 09 §3.9 and doc 16
 * §11.10, with the chaos rows that shaped it:
 *   - S10's hard pair: the custodian never counts the store. Custody is read off the ledger: whoever
 *     moved stock there in the last 30 days keeps it;
 *   - blind: the counter never sees the system's figure;
 *   - I5/K8: the system figure is frozen when the count is scheduled, and whatever moved between
 *     then and the sheet's time is reconciled from the ledger, not blamed on the counter;
 *   - H7: more than 10% or ₹2,000 out orders a blind recount of those lines;
 *   - I3: stock the system does not know about weighs the same as stock that is missing.
 * No adjustment is posted. Writing the variance off needs two keys, and runbook O1 is still open.
 */
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-16T04:30:00.000Z"); // 10:00 IST
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

describe("blind stock counts (Plan 14c, first slice)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let registry: ModuleRegistry;
  let head: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let aide: { id: string; actor: Actor };
  let pharm: string;
  let main: string;
  let a1: string;
  let a2: string;
  let b1: string;
  let c1: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    for (const role of ["materials_head", "storekeeper", "pharmacy_assistant"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "materials_head", "materials.counts.manage");
    // The head may count too, but never a count they scheduled.
    await grantPermissionToRole(db, registry, "materials_head", "materials.counts.perform");
    await grantPermissionToRole(db, registry, "storekeeper", "materials.counts.perform");
    await grantPermissionToRole(db, registry, "pharmacy_assistant", "materials.counts.perform");
    head = await mkUser(db, "mat.head", ["materials_head"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    aide = await mkUser(db, "counter.aide", ["pharmacy_assistant"]);

    ({ resourceId: pharm } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ resourceId: main } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN-STORE", name: "Main store" })));
    const itemA = await anItem("AZEE500");
    const itemB = await anItem("CROC500");
    const itemC = await anItem("INSULIN");
    a1 = await aBatch(itemA, "AZ-1", "2027-06-30");
    a2 = await aBatch(itemA, "AZ-2", "2027-09-30");
    b1 = await aBatch(itemB, "CR-1", "2027-03-31");
    // ₹500 a unit: a small fraction of this line is a lot of money.
    c1 = await aBatch(itemC, "IN-1", "2027-01-31", 50_000);
    // The aide keeps the counter: every movement there is theirs.
    await move(aide.actor, pharm, a1, 100, "grn", new Date(T0.getTime() - 5 * DAY));
    await move(aide.actor, pharm, a2, 40, "grn", new Date(T0.getTime() - 5 * DAY));
    await move(aide.actor, pharm, b1, 10, "grn", new Date(T0.getTime() - 5 * DAY));
    await move(aide.actor, pharm, b1, -10, "consume", new Date(T0.getTime() - 2 * DAY));
    await move(aide.actor, pharm, c1, 100, "grn", new Date(T0.getTime() - 5 * DAY));
    // The keeper keeps the main store.
    await move(keeper.actor, main, a1, 50, "grn", new Date(T0.getTime() - 5 * DAY));
  });

  async function anItem(code: string): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name: `Item ${code}`, class: "consumable", baseUom: "tablet", batchTracked: true,
      uoms: [{ uom: "strip", toBaseMultiplier: 10 }],
    }));
    return itemId;
  }
  async function aBatch(itemId: string, batchNo: string, expiryDate: string, landedCostPaise = 500): Promise<string> {
    const id = newId();
    await db.insert(stockBatches).values({ id, itemId, batchNo, expiryDate, landedCostPaise, ownership: "owned", createdBy: head.id });
    return id;
  }
  const move = (actor: Actor, resourceId: string, batchId: string, qtyDelta: number, reason: "grn" | "consume", occurredAt: Date) =>
    withTx(db, (tx) => postMovement(tx, actor, { resourceId, batchId, qtyDelta, reason, refType: "test", refId: batchId, occurredAt }));
  const named = (name: string) => db.select().from(events).where(eq(events.name, name));

  it("goes to someone who does not keep the store, freezes the system's figure, and never shows it to the counter", async () => {
    const count = await scheduleCount(db, head.actor, { storeResourceId: pharm }, T0);

    // The aide keeps this store and the head scheduled the count: only the keeper may count it.
    expect(count).toMatchObject({ status: "counting", counterUserId: keeper.id, scheduledBy: head.id, frozenAt: T0.toISOString(), recountOf: null });
    const review = await getCount(db, head.actor, count.id);
    // CR-1 is empty but moved within 90 days, so it is on the sheet: stock found there is a finding too.
    expect(review.lines.map((l) => [l.batchNo, l.systemQty, l.countedQty])).toEqual([["AZ-1", 100, null], ["AZ-2", 40, null], ["CR-1", 0, null], ["IN-1", 100, null]]);

    const sheet = await countSheet(db, keeper.actor, count.id);
    expect(sheet.lines.map((l) => [l.itemCode, l.batchNo, l.expiryDate, l.baseUom])).toEqual([
      ["AZEE500", "AZ-1", "2027-06-30", "tablet"], ["AZEE500", "AZ-2", "2027-09-30", "tablet"], ["CROC500", "CR-1", "2027-03-31", "tablet"],
      ["INSULIN", "IN-1", "2027-01-31", "tablet"],
    ]);
    expect(JSON.stringify(sheet)).not.toMatch(/systemQty|"100"|:100\b/);
    await expect(countSheet(db, aide.actor, count.id)).rejects.toMatchObject({ code: "count_not_assigned" });
    await expect(getCount(db, keeper.actor, count.id)).rejects.toMatchObject({ code: "permission_denied" });
    const [ev] = await named("stock_count.scheduled");
    expect(ev?.payload).toMatchObject({ countId: count.id, storeResourceId: pharm, counterUserId: keeper.id, lines: 4, recountOf: null });

    // One open count per store.
    await expect(scheduleCount(db, head.actor, { storeResourceId: pharm }, T0)).rejects.toMatchObject({ code: "count_already_open" });
  });

  it("reconciles what moved during the count, flags what does not add up, orders a blind recount, and moves no stock", async () => {
    const count = await scheduleCount(db, head.actor, { storeResourceId: pharm }, T0);
    // A second counter joins after the count was assigned; the recount goes to them.
    const keeper2 = await mkUser(db, "store.keeper2", ["storekeeper"]);
    // A sale during the count.
    await move(aide.actor, pharm, a1, -5, "consume", at(10));
    const sheet = await countSheet(db, keeper.actor, count.id);
    const lineOf = (batchNo: string) => sheet.lines.find((l) => l.batchNo === batchNo)!.lineId;

    const done = await submitCount(db, keeper.actor, count.id, {
      countedAt: at(20).toISOString(),
      // AZ-1: 95 is right after the sale. AZ-2: 4 short of 40 is exactly 10% (₹20): a variance, not a
      // recount. CR-1: 3 the system says are not there: a recount. IN-1: 5 short is only 5%, but it is
      // ₹2,500: a recount on value.
      lines: [
        { lineId: lineOf("AZ-1"), countedQty: 95 }, { lineId: lineOf("AZ-2"), countedQty: 36 }, { lineId: lineOf("CR-1"), countedQty: 3 },
        { lineId: lineOf("IN-1"), countedQty: 95 },
      ],
    }, at(25));

    expect(done.status).toBe("submitted");
    const review = await getCount(db, head.actor, count.id);
    expect(review.lines.map((l) => [l.batchNo, l.systemQty, l.movedQty, l.countedQty, l.varianceQty, l.variancePaise, l.flag])).toEqual([
      ["AZ-1", 100, -5, 95, 0, 0, "match"],
      ["AZ-2", 40, 0, 36, -4, -2000, "variance"],
      ["CR-1", 0, 0, 3, 3, 1500, "recount"],
      ["IN-1", 100, 0, 95, -5, -250_000, "recount"],
    ]);
    expect(review.countedAt).toBe(at(20).toISOString());
    expect(review.recountId).not.toBeNull();

    const recount = await getCount(db, head.actor, review.recountId!);
    expect(recount).toMatchObject({ status: "counting", recountOf: count.id, counterUserId: keeper2.id, frozenAt: at(25).toISOString() });
    expect(recount.lines.map((l) => [l.batchNo, l.systemQty])).toEqual([["CR-1", 0], ["IN-1", 100]]);

    const [counted] = await named("stock.counted");
    expect(counted?.payload).toMatchObject({ countId: count.id, countedBy: keeper.id, lines: 4, matched: 1, variances: 3, recounts: 2, netVariancePaise: -250_500, recountId: review.recountId });
    const flagged = await named("stock.variance_flagged");
    expect(flagged.map((e) => (e.payload as { batchId: string; recount: boolean }))
      .map((p) => [p.batchId, p.recount]).sort()).toEqual([[a2, false], [b1, true], [c1, true]].sort());

    // Nothing was adjusted: the books still say what the ledger says.
    const books = await balances(db, { resourceId: pharm });
    expect(books.map((b) => [b.batchId, b.qtyOnHand]).sort()).toEqual([[a1, 95], [a2, 40], [b1, 0], [c1, 100]].sort());

    // A submitted count takes no second submission.
    await expect(submitCount(db, keeper.actor, count.id, { countedAt: at(20).toISOString(), lines: [] }, at(26)))
      .rejects.toMatchObject({ code: "count_not_open" });
  });

  it("refuses a sheet that is incomplete, negative, or timed outside the count, and writes nothing", async () => {
    const count = await scheduleCount(db, head.actor, { storeResourceId: pharm }, T0);
    const sheet = await countSheet(db, keeper.actor, count.id);
    const all = sheet.lines.map((l) => ({ lineId: l.lineId, countedQty: 1 }));
    const submit = (lines: { lineId: string; countedQty: number }[], countedAt: Date, who = keeper.actor) =>
      submitCount(db, who, count.id, { countedAt: countedAt.toISOString(), lines }, at(30));

    await expect(submit(all.slice(1), at(20))).rejects.toMatchObject({ code: "count_incomplete" });
    await expect(submit([{ ...all[0]!, countedQty: -1 }, ...all.slice(1)], at(20))).rejects.toMatchObject({ code: "invalid_count_qty" });
    await expect(submit([{ ...all[0]!, countedQty: 1.5 }, ...all.slice(1)], at(20))).rejects.toMatchObject({ code: "invalid_count_qty" });
    await expect(submit([{ lineId: "not-a-line", countedQty: 1 }, ...all.slice(1)], at(20))).rejects.toMatchObject({ code: "count_incomplete" });
    await expect(submit(all, at(-1))).rejects.toMatchObject({ code: "invalid_count_time" });
    await expect(submit(all, at(31))).rejects.toMatchObject({ code: "invalid_count_time" });
    await expect(submit(all, at(20), aide.actor)).rejects.toMatchObject({ code: "count_not_assigned" });

    expect((await getCount(db, head.actor, count.id)).status).toBe("counting");
    expect(await named("stock.counted")).toHaveLength(0);
  });

  it("closes a reviewed count, cancels one with a reason, and lets the store be counted again", async () => {
    const count = await scheduleCount(db, head.actor, { storeResourceId: pharm }, T0);
    await expect(closeCount(db, head.actor, count.id, { note: "reviewed" }, at(5))).rejects.toMatchObject({ code: "count_not_submitted" });
    const sheet = await countSheet(db, keeper.actor, count.id);
    await submitCount(db, keeper.actor, count.id, {
      countedAt: at(20).toISOString(),
      lines: sheet.lines.map((l) => ({ lineId: l.lineId, countedQty: l.batchNo === "AZ-1" || l.batchNo === "IN-1" ? 100 : l.batchNo === "AZ-2" ? 40 : 0 })),
    }, at(25));
    await expect(closeCount(db, keeper.actor, count.id, { note: "mine" }, at(30))).rejects.toMatchObject({ code: "permission_denied" });

    const closed = await closeCount(db, head.actor, count.id, { note: "all lines match" }, at(30));
    expect(closed).toMatchObject({ status: "closed", closedBy: head.id, closeNote: "all lines match", recountId: null });
    expect((await named("stock_count.closed"))[0]?.payload).toMatchObject({ countId: count.id, closedBy: head.id });

    const again = await scheduleCount(db, head.actor, { storeResourceId: pharm }, at(40));
    await expect(cancelCount(db, head.actor, again.id, { reason: " " }, at(41))).rejects.toMatchObject({ code: "reason_required" });
    const cancelled = await cancelCount(db, head.actor, again.id, { reason: "power cut, recount tomorrow" }, at(41));
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "power cut, recount tomorrow" });
    await expect(countSheet(db, keeper.actor, again.id)).rejects.toMatchObject({ code: "count_not_open" });
    await expect(scheduleCount(db, head.actor, { storeResourceId: pharm }, at(42))).resolves.toMatchObject({ status: "counting" });
  });

  it("refuses a store nobody may count, the transit store, and a scheduler without the grant", async () => {
    // The main store's keeper moved its stock, the head scheduled: the aide may count it.
    await expect(scheduleCount(db, head.actor, { storeResourceId: main }, T0)).resolves.toMatchObject({ counterUserId: aide.id });
    // Once the aide has also moved stock at the main store, nobody is left.
    const again = await withTx(db, (tx) => createStore(tx, head.actor, { code: "WARD-A", name: "Ward A" }));
    await move(aide.actor, again.resourceId, a1, 5, "grn", T0);
    // Entered today, dated two months back (a downtime back-entry): the keeper touched these books
    // today, and that makes them a custodian as much as a movement dated today would.
    await move(keeper.actor, again.resourceId, a1, 5, "grn", new Date(T0.getTime() - 60 * DAY));
    await expect(scheduleCount(db, head.actor, { storeResourceId: again.resourceId }, T0)).rejects.toMatchObject({ code: "no_eligible_counter" });

    // A department's staff keep its store whether or not they posted today: the store says whose it
    // is, and those roles never count it. WARD-B's stock was moved by the head alone.
    const wardB = await withTx(db, (tx) => createStore(tx, head.actor, { code: "WARD-B", name: "Ward B" }));
    await move(head.actor, wardB.resourceId, a1, 5, "grn", T0);
    await withTx(db, (tx) => setStoreCustodianRoles(tx, head.actor, wardB.resourceId, ["storekeeper", "pharmacy_assistant"]));
    await expect(scheduleCount(db, head.actor, { storeResourceId: wardB.resourceId }, T0)).rejects.toMatchObject({ code: "no_eligible_counter" });
    await withTx(db, (tx) => setStoreCustodianRoles(tx, head.actor, wardB.resourceId, ["storekeeper"]));
    await expect(scheduleCount(db, head.actor, { storeResourceId: wardB.resourceId }, T0)).resolves.toMatchObject({ counterUserId: aide.id });

    const transit = await withTx(db, (tx) => ensureTransitStore(tx));
    await expect(scheduleCount(db, head.actor, { storeResourceId: transit }, T0)).rejects.toMatchObject({ code: "not_countable" });
    await expect(scheduleCount(db, keeper.actor, { storeResourceId: pharm }, T0)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(scheduleCount(db, head.actor, { storeResourceId: "no-such-store" }, T0)).rejects.toMatchObject({ code: "unknown_store" });
  });
});
