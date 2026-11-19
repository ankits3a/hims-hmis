import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { setHalt } from "../../../kernel/copilot/halt";
import { withTx } from "../../../kernel/db/client";
import { orgDepartments } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import { activateVendor, addVendorDocument, createPurchaseOrder, issueStock, registerMaterialsApprovalTypes, registerVendor } from "../../materials";
import { storesManifest } from "../manifest";
import {
  NO_WARNING_WINDOW_MS, acceptParSuggestion, approvePlannerT3, createShelf, getTicket, listCategories, notNowTopUp, openStore, parSuggestions,
  plannerForecast, plannerScore, plannerTrail, raiseTicket, receiveAtShelf, recordShelfUse, registerStoresItem, runPlannerNight, seedStoresMasters,
  sendTopUp, setDepartmentBudget, setPlannerSettings, setShelfPar, stockOutsWithoutWarning, storesAuditPack, suggestPars, topUpProposal, towerView,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1117, spec docs/specs/1117-stores-stock-planner.md (owner APPROVED 2026-11-19, decision 0101):
 * Stores S7, the stock planner agent. D1–D13 here (every intent is handed the clock it runs on); D14 and D15 (the
 * phone top-up and the 16:9 par suggestions) are the web half, apps/web/src/screens/acceptance/stores-planner-1117.test.tsx.
 *
 * Fixtures build use history the way the hospital does: the central store issues to a shelf, the shelf's in-charge
 * receives and taps "Used", all dated in the past. "Weekly" uses are 7 days apart, half a day off the midnight, so no
 * use sits on a window's edge.
 */
describe("Stores S7: the stock planner (spec #1117)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let keeper: Who;
  let inA: Who;
  let hodA: Who;
  let acct: Who;
  let owner: Who;
  let deptA: { id: string; code: string };
  let deptB: { id: string; code: string };
  let deptC: { id: string; code: string };
  let deptD: { id: string; code: string };
  let floor1: string;
  let genMain: string;
  let shelfA: string;
  let cats: Map<string, string>;
  const ITEMS: Record<string, string> = {};

  /** 02:10 IST on 2026-11-11: the planner's night. */
  const NOW = new Date("2026-11-10T20:40:00.000Z");
  const DAY_MS = 86_400_000;
  const at = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);
  /** The opening rate of every item at GEN-MAIN, per base unit. */
  const RATE = 1_000;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    for (const k of Object.keys(ITEMS)) delete ITEMS[k];
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const grants: Record<string, string[]> = {
      materials_head: [
        "stores.masters.manage", "stores.planner.manage", "stores.audit.read", "stores.tower.read", "materials.items.read", "materials.stock.read",
        "materials.vendors.manage", "materials.po.raise",
      ],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
      accounts_officer: ["stores.budget.manage"],
      owner: ["stores.tower.read", "stores.audit.read"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    acct = await mkUser(db, "accounts.a", ["accounts_officer"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);
    deptA = await anOrgDept("HSK", "Housekeeping");
    deptB = await anOrgDept("LDY", "Laundry");
    deptC = await anOrgDept("KIT", "Kitchen");
    deptD = await anOrgDept("SEC", "Security");
    for (const d of [deptA, deptB, deptC, deptD]) {
      await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: d.id });
      await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: d.id });
    }
    floor1 = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "First floor" }))).resourceId;
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cats = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    shelfA = await aShelf("HSK-F1", deptA);

    const make = async (key: string, trackMode: "shelf" | "expensed" | "durable", pack?: number): Promise<void> => {
      ITEMS[key] = (await registerStoresItem(db, head.actor, {
        code: `HK-${key.toUpperCase().slice(0, 6)}-${String(Object.keys(ITEMS).length + 1).padStart(4, "0")}`, name: key, class: "consumable",
        baseUom: "piece", categoryId: cats.get("HSK")!, trackMode, ...(pack === undefined ? {} : { issuePack: { uom: "box", multiplier: pack } }),
      })).itemId;
    };
    for (const k of ["gloves", "mops", "soap", "warned", "unwarned", "duster", "cleaner", "cleaner2", "sanitiser", "learn1", "learn2", "learn3",
      "learn4", "learn5", "old", "idle", "late", "early", "spend1", "spend2", "edit1", "edit2"]) await make(k, "shelf");
    await make("bags", "shelf", 10);
    await make("tissue", "expensed");
    await make("bucket", "durable");
    // GEN-MAIN opens once, long ago, with enough of everything at one rate.
    await openStore(db, head.actor, "GEN-MAIN", Object.entries(ITEMS).map(([k, id]) => ({
      itemId: id, qty: ["cleaner", "cleaner2", "sanitiser"].includes(k) ? 760 : 5_000, unitCostPaise: RATE,
    })), at(-200));
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "support", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  async function aShelf(code: string, dept: { id: string }): Promise<string> {
    return (await createShelf(db, head.actor, { code, name: `${code} shelf`, floorId: floor1, departmentId: dept.id, suppliedBy: genMain })).shelfId;
  }
  /** The store issues `qty` to the shelf and its in-charge receives it, `days` from now. */
  async function deliver(shelfId: string, item: string, qty: number, days: number): Promise<void> {
    const { transferId } = await withTx(db, (tx) => issueStock(tx, keeper.actor, {
      fromResourceId: genMain, toResourceId: shelfId, lines: [{ itemId: ITEMS[item]!, qtyBase: qty }], occurredAt: at(days),
    }));
    await receiveAtShelf(db, inA.actor, transferId, at(days));
  }
  const use = async (shelfId: string, item: string, qty: number, days: number): Promise<void> => {
    await recordShelfUse(db, inA.actor, { shelfId, itemId: ITEMS[item]!, qty }, at(days));
  };
  /** Eight weeks of history: `first` received 57.5 days ago, then 42 used every 7 days (6 a day), the last 6.5 days ago. */
  async function eightWeeks(shelfId: string, item: string, first: number): Promise<void> {
    await deliver(shelfId, item, first, -57.5);
    for (let k = 0; k < 8; k++) await use(shelfId, item, 42, -55.5 + 7 * k);
  }
  const par = async (shelfId: string, item: string, minBase: number, reorderBase: number, maxBase: number): Promise<void> => {
    await setShelfPar(db, head.actor, { shelfId, itemId: ITEMS[item]!, minBase, reorderBase, maxBase }, at(-200));
  };
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  const warnings = (shelfId: string, item: string): Promise<number> =>
    count(sql`select count(*)::int as n from stores_planner_warnings where store_id = ${shelfId} and item_id = ${ITEMS[item]!} and kind = 'warn'`);
  const lineOf = async (deptId: string, shelfId: string, item: string, when: Date) => {
    const p = await topUpProposal(db, inA.actor, deptId, when);
    return p?.sections.find((s) => s.shelfId === shelfId)?.lines.find((l) => l.itemId === ITEMS[item]!);
  };
  /** A learning item at or under its reorder level: 8 received two days ago against par 5 / 10 / 60. */
  async function learningLow(shelfId: string, item: string, days = -2): Promise<void> {
    await par(shelfId, item, 5, 10, 60);
    await deliver(shelfId, item, 8, days);
  }

  /* ─────────────────────────────── D1 ─────────────────────────────── */

  it("spec #1117 D1: 9 on hand, using 6 a day, after 8 weeks: one warning and one draft line; the next night, unchanged, adds neither", async () => {
    await eightWeeks(shelfA, "gloves", 345);
    await par(shelfA, "gloves", 5, 10, 60);
    const f0 = await runPlannerNight(db, NOW);
    expect(f0.halted).toBe(false);
    const fc = await plannerForecast(db, shelfA, ITEMS.gloves!);
    expect(fc!.learning).toBe(false);
    expect(fc!.usePerDay).toBe(6);
    expect(fc!.onHand).toBe(9);
    expect(await warnings(shelfA, "gloves")).toBe(1);
    const line = await lineOf(deptA.id, shelfA, "gloves", NOW);
    expect(line!.qty).toBe(51);
    expect(line!.why).toEqual(["uses 6 a day, 9 left", "रोज़ 6, बचे 9"]);

    await runPlannerNight(db, at(1));
    expect(await warnings(shelfA, "gloves")).toBe(1);
    const p = await topUpProposal(db, inA.actor, deptA.id, at(1));
    expect(p!.sections.filter((s) => s.shelfId === shelfA)).toHaveLength(1);
    expect(p!.sections[0]!.lines.filter((l) => l.itemId === ITEMS.gloves!)).toHaveLength(1);
    expect(await count(sql`select count(*)::int as n from stores_planner_drafts where kind = 'open' and store_id = ${shelfA}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from stores_planner_drafts where kind = 'line' and store_id = ${shelfA}`)).toBe(1);
  });

  /* ─────────────────────────────── D2 ─────────────────────────────── */

  it("spec #1117 D2: an item not warned at night that one Used brings under 48 hours of its stored hourly use has one warning when the call returns, with no job run", async () => {
    await eightWeeks(shelfA, "mops", 400);
    await par(shelfA, "mops", 2, 5, 80);
    await runPlannerNight(db, NOW);
    expect(await warnings(shelfA, "mops")).toBe(0);
    // 64 on hand; 54 used now: 10 left at 6 a day is 40 hours — still above the reorder level (5).
    await use(shelfA, "mops", 54, 2 / 24);
    expect(await warnings(shelfA, "mops")).toBe(1);
    const [w] = (await db.execute(sql`select source, hours_to_zero, on_hand from stores_planner_warnings where item_id = ${ITEMS.mops!}`)).rows as
      { source: string; hours_to_zero: number; on_hand: number }[];
    expect(w!.source).toBe("use");
    expect(w!.on_hand).toBe(10);
    expect(Number(w!.hours_to_zero)).toBe(40);
  });

  /* ─────────────────────────────── D3 ─────────────────────────────── */

  it("spec #1117 D3: a line never exceeds max − on hand − on its way, rounded up to the issue pack only when that stays within max; expensed and durable items are never drafted", async () => {
    // Bags: issue pack 10; 9 on hand, 20 on its way on an open ticket, par 10 / 30 / 60: room for 31.
    await eightWeeks(shelfA, "bags", 345);
    await par(shelfA, "bags", 10, 30, 60);
    await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: ITEMS.bags!, qtyBase: 20 }], priority: "routine" }, at(-1));
    // An exact multiple rounds to itself: 10 on hand of max 50 with nothing on its way is 40.
    await deliver(shelfA, "early", 10, -2);
    await par(shelfA, "early", 5, 10, 50);
    // Tissue (expensed: used on receipt, 0 on hand) and a bucket (durable, under its reorder) are never drafted.
    for (let k = 0; k < 8; k++) await deliver(shelfA, "tissue", 40, -55.5 + 7 * k);
    await deliver(shelfA, "bucket", 1, -10);
    await par(shelfA, "bucket", 1, 2, 4);
    await runPlannerNight(db, NOW);

    const bags = await lineOf(deptA.id, shelfA, "bags", NOW);
    expect(bags!.onHand).toBe(9);
    expect(bags!.onWay).toBe(20);
    expect(bags!.qty).toBeLessThanOrEqual(60 - 9 - 20);
    expect(bags!.qty).toBe(30);
    expect((await lineOf(deptA.id, shelfA, "early", NOW))!.qty).toBe(40);
    expect(await lineOf(deptA.id, shelfA, "tissue", NOW)).toBeUndefined();
    expect(await lineOf(deptA.id, shelfA, "bucket", NOW)).toBeUndefined();
    expect(await warnings(shelfA, "tissue")).toBe(0);
    expect(await warnings(shelfA, "bucket")).toBe(0);
  });

  /* ─────────────────────────────── D4 ─────────────────────────────── */

  it("spec #1117 D4: 3 weeks of history is \"Learning, 3 of 8 weeks\" and is warned only at its reorder level", async () => {
    // 60 a week for three weeks (8.6 a day): 15 left would be 42 hours, but the par rule warns only at reorder (10).
    await deliver(shelfA, "soap", 195, -21.6);
    for (const d of [-20.5, -13.5, -6.5]) await use(shelfA, "soap", 60, d);
    await par(shelfA, "soap", 5, 10, 40);
    await runPlannerNight(db, NOW);
    const fc = await plannerForecast(db, shelfA, ITEMS.soap!);
    expect(fc!.learning).toBe(true);
    expect(fc!.weeks).toBe(3);
    expect(fc!.learningWords).toEqual(["Learning, 3 of 8 weeks", "सीख रहा, 8 में 3 हफ़्ते"]);
    expect(await warnings(shelfA, "soap")).toBe(0);

    await use(shelfA, "soap", 5, 0.1);
    expect(await warnings(shelfA, "soap")).toBe(1);
    const line = await lineOf(deptA.id, shelfA, "soap", at(0.1));
    expect(line!.word).toBe("learning");
    expect(line!.qty).toBe(30);
  });

  /* ─────────────────────────────── D5 ─────────────────────────────── */

  it("spec #1117 D5: a stock-out with no warning 24 h before is counted, one warned 30 h before is not, and the tower's red cards equal the count", async () => {
    await eightWeeks(shelfA, "warned", 348); // 12 left: 48 hours
    await eightWeeks(shelfA, "unwarned", 400); // 64 left
    await runPlannerNight(db, at(-30 / 24));
    expect(await warnings(shelfA, "warned")).toBe(1);
    expect(await warnings(shelfA, "unwarned")).toBe(0);
    await use(shelfA, "warned", 12, 0);
    await use(shelfA, "unwarned", 64, 0);

    const to = at(1 / 24);
    const from = new Date(to.getTime() - NO_WARNING_WINDOW_MS);
    const out = await stockOutsWithoutWarning(db, from, to);
    expect(out.count).toBe(1);
    expect(out.events.map((e) => e.itemId)).toEqual([ITEMS.unwarned!]);
    const tower = await towerView(db, head.actor, to);
    expect(tower.redCards.filter((c) => c.kind === "no_warning")).toHaveLength(out.count);
    expect(Object.keys(tower).sort()).toEqual(["at", "floors", "lanes", "numbers", "redCards"]);
  });

  /* ─────────────────────────────── D6 ─────────────────────────────── */

  it("spec #1117 D6: a central item with lead time 10 days and an order covering it is not drafted; without the order one planner PR line at the computed quantity; a dated item never beyond use before expiry − 30 days", async () => {
    // 70 a week issued to the shelf for 8 weeks (10 a day): 200 left at GEN-MAIN. Vital, class A: safety 15 days, cover 7.
    for (const item of ["cleaner", "cleaner2", "sanitiser"]) {
      for (let k = 0; k < 8; k++) {
        await withTx(db, (tx) => issueStock(tx, keeper.actor, {
          fromResourceId: genMain, toResourceId: shelfA, lines: [{ itemId: ITEMS[item]!, qtyBase: 70 }], occurredAt: at(-55.5 + 7 * k),
        }));
      }
      await db.execute(sql`update items set lead_time_days = 10, ved_class = 'V', abc_class = 'A' where id = ${ITEMS[item]!}`);
    }
    await db.execute(sql`update items set class = 'consumable_dated', shelf_life_days = 40 where id = ${ITEMS.sanitiser!}`);
    // Cleaner has 150 on order: 200 + 150 is above its reorder point 10 × (10 + 15) = 250.
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "CLEANCO", legalName: "Clean Co", pan: "CLNPA1234A", gstin: "10CLNPA1234A1Z5" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, at(-100)));
    await createPurchaseOrder(db, head.actor, { vendorId, storeResourceId: genMain, lines: [{ itemId: ITEMS.cleaner!, qtyPacks: 150, ratePaise: RATE }] }, { now: at(-1) });

    const run = await runPlannerNight(db, NOW);
    expect(run.centralPrs).toHaveLength(1);
    const lines = (await db.execute(sql`
      select l.item_id, l.qty_base, r.source, r.raised_by from stores_purchase_request_lines l join stores_purchase_requests r on r.id = l.pr_id`)).rows as
      { item_id: string; qty_base: number; source: string; raised_by: string }[];
    expect(lines.every((l) => l.source === "planner")).toBe(true);
    expect(lines.find((l) => l.item_id === ITEMS.cleaner!)).toBeUndefined();
    // Order up to = 250 + 10 × 7 = 320, less 200 on hand: 120.
    expect(lines.find((l) => l.item_id === ITEMS.cleaner2!)!.qty_base).toBe(120);
    // Dated: 40 days of shelf life less 30 leaves 10 days of use, 100.
    expect(lines.find((l) => l.item_id === ITEMS.sanitiser!)!.qty_base).toBeLessThanOrEqual(100);
    expect(lines.find((l) => l.item_id === ITEMS.sanitiser!)!.qty_base).toBe(100);
  });

  /* ─────────────────────────────── D7 ─────────────────────────────── */

  it("spec #1117 D7: par suggestions from 90 days of use equal decision 8's formula; the par changes only when the materials head accepts, with one par event", async () => {
    await par(shelfA, "duster", 5, 10, 30);
    await deliver(shelfA, "duster", 100, -90.5);
    for (let k = 1; k <= 12; k++) await deliver(shelfA, "duster", 21, -90.5 + 7 * k);
    for (let k = 0; k < 9; k++) await use(shelfA, "duster", 30, -89.5 + 10 * k);
    await suggestPars(db, NOW);

    // The test's own arithmetic, from the rows.
    const used = await count(sql`select coalesce(sum(case when reason = 'consume' or ref_type = 'reversal' then -qty_delta else 0 end), 0)::int as n
      from stock_ledger where resource_id = ${shelfA} and item_id = ${ITEMS.duster!} and occurred_at >= ${at(-90)} and occurred_at < ${NOW}`);
    const days = ((await db.execute(sql`select distinct (occurred_at at time zone 'Asia/Kolkata')::date as d from stock_ledger
      where resource_id = ${shelfA} and reason = 'receive' and qty_delta > 0 order by 1`)).rows as { d: string }[]).map((r) => new Date(r.d).getTime());
    const gaps = days.slice(1).map((d, i) => (d - days[i]!) / DAY_MS).sort((a, b) => a - b);
    const interval = gaps.length % 2 === 1 ? gaps[(gaps.length - 1) / 2]! : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2;
    const upd = used / 90;
    const min = Math.ceil(upd * 1);
    const reorder = Math.ceil(upd * (interval + 1));
    const max = reorder + Math.ceil(upd * interval);
    expect([min, reorder, max]).toEqual([3, 24, 45]);

    const rows = await parSuggestions(db, head.actor, NOW);
    const s = rows.find((r) => r.itemId === ITEMS.duster!)!;
    expect(s.now).toEqual({ minBase: 5, reorderBase: 10, maxBase: 30 });
    expect(s.suggested).toEqual({ minBase: min, reorderBase: reorder, maxBase: max });
    const level = async () => ((await db.execute(sql`select min_base, reorder_base, max_base from item_stock_levels
      where store_resource_id = ${shelfA} and item_id = ${ITEMS.duster!}`)).rows[0]) as { min_base: number; reorder_base: number; max_base: number };
    expect(await level()).toEqual({ min_base: 5, reorder_base: 10, max_base: 30 });
    await expect(acceptParSuggestion(db, inA.actor, s.id, null, NOW)).rejects.toMatchObject({ code: "not_permitted" });
    expect(await level()).toEqual({ min_base: 5, reorder_base: 10, max_base: 30 });

    await acceptParSuggestion(db, head.actor, s.id, null, at(0.01));
    expect(await level()).toEqual({ min_base: 3, reorder_base: 24, max_base: 45 });
    const acts = (await db.execute(sql`select payload from events where name = 'stores.act_recorded' and payload->>'act' = 'par'
      and payload->>'itemId' = ${ITEMS.duster!} and occurred_at >= ${at(0)}`)).rows as { payload: { before: unknown; after: unknown } }[];
    expect(acts).toHaveLength(1);
    expect(acts[0]!.payload.before).toEqual({ minBase: 5, reorderBase: 10, maxBase: 30 });
    expect(acts[0]!.payload.after).toEqual({ minBase: 3, reorderBase: 24, maxBase: 45 });
  });

  /* ─────────────────────────────── D8 ─────────────────────────────── */

  it("spec #1117 D8: five shelves with warned lines are one top-up proposal of five sections, not halted; a department holding 3 open proposals gets no fourth and the materials head is told once", async () => {
    const shelves = [shelfA];
    for (const n of [2, 3, 4, 5]) shelves.push(await aShelf(`HSK-F${String(n)}`, deptA));
    for (const [i, s] of shelves.entries()) await learningLow(s, `learn${String(i + 1)}`);
    const run = await runPlannerNight(db, NOW);
    const p = await topUpProposal(db, inA.actor, deptA.id, NOW);
    expect(p!.sections).toHaveLength(5);
    expect(run.halts.find((h) => h.departmentId === deptA.id)).toBeUndefined();

    // Laundry: a par set left open last quarter and this quarter's, and a slow-stock card: three open.
    const b1 = await aShelf("LDY-F1", deptB);
    await par(b1, "old", 1, 2, 3);
    await deliver(b1, "old", 300, -190);
    for (let k = 0; k < 18; k++) await use(b1, "old", 15, -185 + 10 * k);
    await deliver(b1, "idle", 5, -100);
    await suggestPars(db, at(-60)); // 2026-09: last quarter's set
    await runPlannerNight(db, at(-1)); // this quarter's set and the slow-stock card
    // Now a top-up would be a fourth.
    await learningLow(b1, "late", -0.5);
    await runPlannerNight(db, NOW);
    expect((await topUpProposal(db, inA.actor, deptB.id, NOW))?.sections ?? []).toHaveLength(0);
    expect(await warnings(b1, "late")).toBe(1);
    await runPlannerNight(db, at(1));
    const told = await count(sql`select count(*)::int as n from alerts where user_id = ${head.id} and title = 'Planner paused: 3 open'`);
    expect(told).toBe(1);
  });

  /* ─────────────────────────────── D9 ─────────────────────────────── */

  it("spec #1117 D9: a draft crossing 80 % of the budget says \"Budget 80% used\" and is sendable; one above 100 % is sendable and its ticket carries over budget", async () => {
    const c1 = await aShelf("KIT-F1", deptC);
    const d1 = await aShelf("SEC-F1", deptD);
    await learningLow(c1, "spend1"); // 8 received this month (8,000 paise spent); a 52-piece line is 52,000
    await learningLow(d1, "spend2");
    await setDepartmentBudget(db, acct.actor, { departmentId: deptC.id, month: "2026-11", amountPaise: 70_000 }, at(-5));
    await setDepartmentBudget(db, acct.actor, { departmentId: deptD.id, month: "2026-11", amountPaise: 50_000 }, at(-5));
    await runPlannerNight(db, NOW);

    const c = (await topUpProposal(db, inA.actor, deptC.id, NOW))!.sections[0]!;
    expect(c.budget!.words).toEqual(["Budget 80% used", "बजट 80% खर्च"]);
    expect(c.budget!.over).toBe(false);
    const sentC = await sendTopUp(db, inA.actor, c.draftId, {}, at(0.01));
    expect(sentC.ticket.stage).toBe("to_approve");

    const d = (await topUpProposal(db, inA.actor, deptD.id, NOW))!.sections[0]!;
    expect(d.budget!.over).toBe(true);
    const sentD = await sendTopUp(db, inA.actor, d.draftId, {}, at(0.01));
    expect((await getTicket(db, sentD.ticket.id, at(0.02)))!.approval.overBudget).toBe(true);
  });

  /* ─────────────────────────────── D10 ─────────────────────────────── */

  it("spec #1117 D10: with the model unavailable and the copilot halted for text, warnings and drafts still appear with the template why, every number equal to the forecast row's", async () => {
    await setHalt(db, owner.actor, "read", "model down");
    await eightWeeks(shelfA, "gloves", 345);
    await par(shelfA, "gloves", 5, 10, 60);
    await runPlannerNight(db, NOW);
    expect(await warnings(shelfA, "gloves")).toBe(1);
    const line = (await lineOf(deptA.id, shelfA, "gloves", NOW))!;
    const [f] = (await db.execute(sql`select use_per_day, on_hand from stores_planner_forecasts where id = ${line.forecastId}`)).rows as { use_per_day: number; on_hand: number }[];
    const nums = (line.why[0].match(/\d+(\.\d+)?/g) ?? []).map(Number);
    expect(nums).toEqual([Math.round(Number(f!.use_per_day) * 10) / 10, f!.on_hand]);
    expect((line.why[1].match(/\d+(\.\d+)?/g) ?? []).map(Number)).toEqual(nums);
  });

  /* ─────────────────────────────── D11 ─────────────────────────────── */

  it("spec #1117 D11: sending a section unchanged raises one S2 ticket with channel agent and one copilot_acts row naming the sender; an edit keeps both numbers; Not now needs a reason chip", async () => {
    const s2 = await aShelf("HSK-F2", deptA);
    const s3 = await aShelf("HSK-F3", deptA);
    await learningLow(shelfA, "edit1");
    await learningLow(s2, "edit2");
    await learningLow(s3, "learn3");
    await runPlannerNight(db, NOW);
    const p = (await topUpProposal(db, inA.actor, deptA.id, NOW))!;
    const one = p.sections.find((s) => s.shelfId === shelfA)!;
    const two = p.sections.find((s) => s.shelfId === s2)!;
    const three = p.sections.find((s) => s.shelfId === s3)!;

    const sent = await sendTopUp(db, inA.actor, one.draftId, {}, at(0.01));
    expect(sent.ticket.channel).toBe("agent");
    expect(sent.ticket.lines.map((l) => [l.itemId, l.qtyBase])).toEqual([[ITEMS.edit1!, 52]]);
    const acts = (await db.execute(sql`select actor_id, proposal_id from copilot_acts where proposal_id = ${one.draftId}`)).rows as { actor_id: string }[];
    expect(acts).toHaveLength(1);
    expect(acts[0]!.actor_id).toBe(inA.id);

    await sendTopUp(db, inA.actor, two.draftId, { lines: [{ itemId: ITEMS.edit2!, qty: 40 }] }, at(0.02));
    const [row] = (await db.execute(sql`select data from stores_planner_drafts where draft_id = ${two.draftId} and kind = 'sent'`)).rows as
      { data: { lines: { itemId: string; plannerQty: number; qty: number }[] } }[];
    expect(row!.data.lines).toEqual([{ itemId: ITEMS.edit2!, plannerQty: 52, qty: 40 }]);

    await expect(notNowTopUp(db, inA.actor, three.draftId, null, at(0.03))).rejects.toMatchObject({ code: "reason_required" });
    await notNowTopUp(db, inA.actor, three.draftId, "stock_arrived", at(0.03));
    expect((await topUpProposal(db, inA.actor, deptA.id, at(0.04)))).toBeNull();
  });

  /* ─────────────────────────────── D12 ─────────────────────────────── */

  it("spec #1117 D12: plannerScore over 4 weeks equals the share sent unchanged and the stock-outs without warning, from the rows; T3 needs the score and the owner's approval", async () => {
    // Kitchen: one draft, sent unchanged 30 days ago. Housekeeping: one unchanged, one edited.
    const c1 = await aShelf("KIT-F1", deptC);
    await learningLow(c1, "spend1", -31);
    await runPlannerNight(db, at(-30));
    const kc = (await topUpProposal(db, inA.actor, deptC.id, at(-30)))!.sections[0]!;
    await sendTopUp(db, inA.actor, kc.draftId, {}, at(-29.9));

    const s2 = await aShelf("HSK-F2", deptA);
    await learningLow(shelfA, "edit1", -31);
    await learningLow(s2, "edit2", -31);
    await runPlannerNight(db, at(-30));
    const pa = (await topUpProposal(db, inA.actor, deptA.id, at(-30)))!;
    await sendTopUp(db, inA.actor, pa.sections.find((s) => s.shelfId === shelfA)!.draftId, {}, at(-29.9));
    await sendTopUp(db, inA.actor, pa.sections.find((s) => s.shelfId === s2)!.draftId, { lines: [{ itemId: ITEMS.edit2!, qty: 10 }] }, at(-29.9));

    const from = at(-31);
    for (const dept of [deptA, deptC]) {
      const score = await plannerScore(db, dept.id, from, NOW);
      const sent = (await db.execute(sql`select data from stores_planner_drafts where kind = 'sent' and department_id = ${dept.id}
        and at >= ${from} and at < ${NOW}`)).rows as { data: { lines: { plannerQty: number; qty: number }[] } }[];
      const unchanged = sent.filter((r) => r.data.lines.every((l) => l.plannerQty === l.qty)).length;
      expect(score.sent).toBe(sent.length);
      expect(score.sentUnchanged).toBe(unchanged);
      expect(score.unchangedPct).toBe(Math.round((100 * unchanged) / sent.length));
      expect(score.stockOutsWithoutWarning).toBe((await stockOutsWithoutWarning(db, from, NOW)).events
        .filter((e) => e.departmentId === dept.id).length);
    }
    expect((await plannerScore(db, deptA.id, from, NOW)).passes).toBe(false);
    expect((await plannerScore(db, deptC.id, from, NOW)).passes).toBe(true);

    await expect(setPlannerSettings(db, head.actor, { departmentId: deptA.id, t3: true }, NOW)).rejects.toMatchObject({ code: "t3_not_earned" });
    await expect(setPlannerSettings(db, head.actor, { departmentId: deptC.id, t3: true }, NOW)).rejects.toMatchObject({ code: "owner_approval_needed" });
    await expect(approvePlannerT3(db, head.actor, deptC.id, NOW)).rejects.toMatchObject({ code: "not_permitted" });
    await approvePlannerT3(db, owner.actor, deptC.id, NOW);
    const on = await setPlannerSettings(db, head.actor, { departmentId: deptC.id, t3: true }, at(0.01));
    expect(on.t3).toBe(true);
  });

  /* ─────────────────────────────── D13 ─────────────────────────────── */

  it("spec #1117 D13: warnings, drafts, withdrawals and par suggestions are append-only rows with their forecast inputs; the audit pack and plannerTrail list warning → draft → ticket in order", async () => {
    await eightWeeks(shelfA, "gloves", 345);
    await par(shelfA, "gloves", 5, 10, 60);
    await runPlannerNight(db, NOW);
    const line = (await lineOf(deptA.id, shelfA, "gloves", NOW))!;
    const p = (await topUpProposal(db, inA.actor, deptA.id, NOW))!;
    const sent = await sendTopUp(db, inA.actor, p.sections[0]!.draftId, {}, at(0.01));
    await par(shelfA, "duster", 5, 10, 30);
    await deliver(shelfA, "duster", 100, -91);
    for (let k = 0; k < 9; k++) await use(shelfA, "duster", 10, -89.5 + 10 * k);
    await suggestPars(db, NOW);

    const [f] = (await db.execute(sql`select inputs from stores_planner_forecasts where id = ${line.forecastId}`)).rows as { inputs: Record<string, unknown> }[];
    expect(Object.keys(f!.inputs)).toEqual(expect.arrayContaining(["window", "weekly", "method", "error", "factor"]));
    const [w] = (await db.execute(sql`select forecast_id from stores_planner_warnings where id = ${line.warningId}`)).rows as { forecast_id: string }[];
    expect(w!.forecast_id).toBe(line.forecastId);

    for (const table of ["stores_planner_forecasts", "stores_planner_warnings", "stores_planner_drafts", "stores_par_suggestions", "stores_planner_settings"]) {
      if (table === "stores_planner_settings") await setPlannerSettings(db, head.actor, { departmentId: deptA.id, paused: false }, at(0.02));
      await expect(db.execute(sql.raw(`update ${table} set at = at`))).rejects.toThrow();
      await expect(db.execute(sql.raw(`delete from ${table}`))).rejects.toThrow();
    }

    const pack = await storesAuditPack(db, head.actor, { itemId: ITEMS.gloves!, from: at(-1), to: at(1) }, at(1));
    const chain = pack.rows.map((r) => r.what).filter((w) => ["planner_warning", "planner_draft", "raise_ticket"].includes(w));
    expect(chain).toEqual(["planner_warning", "planner_draft", "raise_ticket"]);
    const trail = await plannerTrail(db, head.actor, shelfA, ITEMS.gloves!);
    expect(trail.filter((t) => t.kind !== "forecast").map((t) => t.kind)).toEqual(["warning", "draft", "ticket"]);
    expect(trail.find((t) => t.kind === "ticket")!.refId).toBe(sent.ticket.id);
  });
});
