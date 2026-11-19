import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { alerts, approvals, orgDepartments, stockBatches, stockLedger } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import {
  MaterialsError, STOCK_ADJUSTMENT_APPROVAL_TYPE, TRANSIT_STORE_CODE, balances, findStoreByCode, getTransfer, postMovements, registerMaterialsApprovalTypes,
} from "../../materials";
import { storesManifest } from "../manifest";
import {
  StoresError, acceptReturn, approveTicket, claimPicking, createShelf, declineTicket, deliverTicket, departmentChargeOn, getTicket, handOver,
  issueTicket, lateScansToConfirm, listCategories, openStore, raiseReturn, raiseTicket, reAskShort, receiveReturn, registerStoresItem,
  resolveShort, returnUndelivered, seedStoresMasters, takeCustody, takeOverCustody, ticketTimeline, ticketsToPick, ticketsToReceive,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { TicketView } from "../types";

/**
 * ACCEPTANCE — issue #1112, spec docs/specs/1112-stores-tickets-custody.md (owner APPROVED 2026-11-18, ruling
 * 0099): Stores S2b, the custody chain and the porter's scan, counter collection, the take-over, delivery with
 * wrong and damaged lines, shorts and their three resolutions, the back-order, undelivered and department
 * returns, late scans, the delivered ticket's notices and the append-only hand-off log. One test per done-means
 * id the spec's build notes give S2b: D8–D17, D19, D20, D22 (D24 is the web half,
 * apps/web/src/screens/acceptance/stores-receive-1112.test.tsx). S2a's ids are in stores-s2a-1112.test.ts.
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S2b: custody chain, delivery, shorts, returns, late scans (spec #1112)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let keeperA: Who;
  let keeperB: Who;
  let inA: Who;
  let hodA: Who;
  let porterA: Who;
  let porterB: Who;
  let porterC: Who;
  let genMain: string;
  let shelfA: string;
  let mop: string;
  let gloves: string;

  /** 12:00 IST on 2026-11-10 — inside GEN-MAIN's 09:00–17:00. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const DAY = "2026-11-10";
  const MIN = 60_000;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const grants: Record<string, string[]> = {
      materials_head: ["stores.masters.manage", "stores.shelf.read", "stores.audit.read", "materials.items.read", "materials.stock.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
      support_staff: ["stores.carry"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeperA = await mkUser(db, "keeper.a", ["storekeeper"]);
    keeperB = await mkUser(db, "keeper.b", ["storekeeper"]);
    porterA = await mkUser(db, "porter.a", ["support_staff"]);
    porterB = await mkUser(db, "porter.b", ["support_staff"]);
    porterC = await mkUser(db, "porter.c", ["support_staff"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);

    const deptA = await anOrgDept("HSK", "Housekeeping");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });
    // A porter who also works the department's shelf: the chain still refuses them as receiver.
    await assignRole(db, { userId: porterB.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });

    const floor1 = await aFloor("F1", "First floor");
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    mop = (await registerStoresItem(db, head.actor, { code: "HK-MOP-0001", name: "Wet mop refill", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    gloves = (await registerStoresItem(db, head.actor, { code: "HK-GLV-0002", name: "Household gloves", class: "consumable", baseUom: "pair", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    await openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 500, unitCostPaise: 250 }, { itemId: gloves, qty: 500, unitCostPaise: 40 }], at(-60));
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "HSK-F1", name: "Housekeeping F1", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "support", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  async function aFloor(code: string, name: string): Promise<string> {
    return (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code, name }))).resourceId;
  }
  /** Raised, approved, claimed and issued: on its way, in the issuer's hands. */
  async function issued(lines: { itemId: string; qtyBase: number }[] = [{ itemId: mop, qtyBase: 20 }, { itemId: gloves, qtyBase: 10 }]): Promise<TicketView> {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines, priority: "routine", channel: "phone" }, NOW);
    await approveTicket(db, hodA.actor, t.id, {}, at(1));
    await claimPicking(db, keeperA.actor, t.id, at(2));
    return issueTicket(db, keeperA.actor, t.id, {}, at(3));
  }
  async function storeId(code: string): Promise<string> {
    return (await findStoreByCode(db, code))!.id;
  }
  async function onHand(resourceId: string, itemId: string): Promise<number> {
    return (await balances(db, { resourceId, itemId })).reduce((s, b) => s + b.qtyOnHand, 0);
  }
  const allBalances = async (): Promise<unknown[]> =>
    (await db.execute(sql`select resource_id, batch_id, qty_on_hand from stock_balances order by resource_id, batch_id`)).rows;
  const charge = async (): Promise<number> => (await departmentChargeOn(db, "HSK", DAY)).chargePaise;
  const handoffCount = async (indentId: string): Promise<number> =>
    Number((await db.execute(sql`select count(*)::int as n from stores_custody_handoffs where indent_id = ${indentId}`)).rows[0]!.n);
  const noticesOf = async (who: Who): Promise<{ title: string; body: string | null }[]> =>
    (await db.select({ title: alerts.title, body: alerts.body, at: alerts.createdAt }).from(alerts).where(eq(alerts.userId, who.id)))
      .map((n) => ({ title: n.title, body: n.body }));
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }

  /* ─────────────────────────────── D8–D17, D19, D20, D22 ─────────────────────────────── */

  it("spec #1112 D8: takeCustody moves the holder from issuer to porter and leaves every ledger balance unchanged; the typed last four digits work as the scan", async () => {
    const t = await issued();
    expect((await getTicket(db, t.id, at(4)))!.custody).toMatchObject({ holder: { id: keeperA.id }, legs: 0 });
    const transit = await storeId(TRANSIT_STORE_CODE);
    const transitBefore = await onHand(transit, mop);
    const before = await allBalances();
    const r = await takeCustody(db, porterA.actor, { code: t.indentNo.slice(-4) }, at(5));
    expect(r.ticket.id).toBe(t.id);
    expect(r.ticket.custody).toMatchObject({ holder: { id: porterA.id }, legs: 1 });
    expect(await allBalances()).toEqual(before);
    expect(await onHand(transit, mop)).toBe(transitBefore);
    expect(transitBefore).toBe(20);
    // Someone without the carry grant cannot take it.
    expect(await refusal(takeCustody(db, inA.actor, { code: t.indentNo }, at(6)))).toBe("not_permitted");
  });

  it("spec #1112 D9: handOver from porter A to porter B with B's scan records one hand-off; a hand-off by someone who is not the current holder is refused", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    const r = await handOver(db, porterB.actor, { code: t.indentNo, fromUserId: porterA.id }, at(12));
    expect(r.ticket.custody).toMatchObject({ holder: { id: porterB.id }, legs: 2 });
    expect(await handoffCount(t.id)).toBe(2);
    // Porter A no longer holds it: a hand-off from A is refused, and nothing is recorded.
    expect(await refusal(handOver(db, porterC.actor, { code: t.indentNo, fromUserId: porterA.id }, at(14)))).toBe("not_in_your_hands");
    expect(await handoffCount(t.id)).toBe(2);
  });

  it("spec #1112 D10: deliverTicket by a department receiver closes the chain; the issuer and a porter on the chain are refused; the timeline runs raise → approve → claim → issue → each hand-off → delivered", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    await handOver(db, porterB.actor, { code: t.indentNo, fromUserId: porterA.id }, at(12));
    expect(await refusal(deliverTicket(db, keeperA.actor, t.id, {}, at(20)))).toBe("you_issued_it");
    expect(await refusal(deliverTicket(db, porterB.actor, t.id, {}, at(20)))).toBe("you_carried_it");
    const r = await deliverTicket(db, inA.actor, t.id, {}, at(21));
    expect(r.ticket).toMatchObject({ stage: "delivered", custody: { holder: null, legs: 2 }, delivery: { by: { id: inA.id }, atCounter: false } });
    const tl = await ticketTimeline(db, inA.actor, t.id);
    expect(tl.steps.map((s) => s.step)).toEqual(["raise", "approve", "claim", "issue", "take", "hand_over", "deliver"]);
    const take = tl.steps.find((s) => s.step === "take")!;
    expect(take).toMatchObject({ who: { id: porterA.id }, at: at(5).toISOString(), minutes: 2 });
    expect(take.from!.id).toBe(genMain);
    const hand = tl.steps.find((s) => s.step === "hand_over")!;
    expect(hand).toMatchObject({ who: { id: porterB.id }, minutes: 7 });
    expect(hand.note).toContain("porter.a");
    const deliver = tl.steps.at(-1)!;
    expect(deliver).toMatchObject({ who: { id: inA.id }, at: at(21).toISOString(), minutes: 9 });
    expect(deliver.to!.id).toBe(shelfA);
  });

  it("spec #1112 D11: a shelf-grant holder collecting at the counter receives with zero hand-offs, and the timeline reads 'Collected at store'", async () => {
    const t = await issued();
    const r = await deliverTicket(db, inA.actor, t.id, {}, at(10));
    expect(r.ticket).toMatchObject({ stage: "delivered", custody: { legs: 0 }, delivery: { atCounter: true } });
    expect(await handoffCount(t.id)).toBe(0);
    const steps = (await ticketTimeline(db, inA.actor, t.id)).steps.map((s) => s.step);
    expect(steps).toContain("collect");
    expect(steps).not.toContain("take");
    expect(steps).not.toContain("deliver");
    expect(await onHand(shelfA, mop)).toBe(20);
  });

  it("spec #1112 D12: takeOverCustody by the source storekeeper or the materials head, with a reason, records a forced hand-off naming the previous holder; anyone else is refused", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    expect(await refusal(takeOverCustody(db, porterB.actor, t.id, "Porter went home", at(50)))).toBe("not_permitted");
    expect(await refusal(takeOverCustody(db, inA.actor, t.id, "Porter went home", at(50)))).toBe("not_permitted");
    expect(await refusal(takeOverCustody(db, keeperB.actor, t.id, "  ", at(50)))).toBe("reason_required");
    const r = await takeOverCustody(db, keeperB.actor, t.id, "Porter went home", at(51));
    expect(r.ticket.custody).toMatchObject({ holder: { id: keeperB.id }, legs: 2 });
    const step = (await ticketTimeline(db, head.actor, t.id)).steps.find((s) => s.step === "take_over")!;
    expect(step.who!.id).toBe(keeperB.id);
    expect(step.note).toContain("porter.a");
    expect(step.note).toContain("Porter went home");
    const again = await takeOverCustody(db, head.actor, t.id, "Keeper off shift", at(60));
    expect(again.ticket.custody).toMatchObject({ holder: { id: head.id }, legs: 3 });
  });

  it("spec #1112 D13: delivery takes accepted / short / wrong / damaged per line; wrong and damaged are never charged and go back to the source (damaged into quarantine); the notice reads 'Delivered, 2 sent back'", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    expect(await refusal(deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 18, wrong: 1, damaged: 2 }] }, at(20)))).toBe("bad_quantity");
    const r = await deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 18, wrong: 1, damaged: 1 }] }, at(20));
    expect(r.ticket.delivery).toMatchObject({ sentBack: 2, sentBackAccepted: false });
    expect(r.ticket.delivery!.lines).toEqual([
      { lineIdx: 0, itemId: mop, accepted: 18, short: 0, wrong: 1, damaged: 1 },
      { lineIdx: 1, itemId: gloves, accepted: 10, short: 0, wrong: 0, damaged: 0 },
    ]);
    expect(await charge()).toBe(18 * 250 + 10 * 40);
    expect(await onHand(shelfA, mop)).toBe(18);
    const titles = (await noticesOf(inA)).map((n) => n.title);
    expect(titles).toContain("Delivered, 2 sent back");

    // They go back on the same chain; the source keeper takes them in.
    const mainBefore = await onHand(genMain, mop);
    expect(await refusal(acceptReturn(db, inA.actor, t.id, at(40)))).toBe("not_permitted");
    const back = await acceptReturn(db, keeperA.actor, t.id, at(40));
    expect(back.delivery).toMatchObject({ sentBackAccepted: true });
    expect(await onHand(genMain, mop)).toBe(mainBefore + 1);
    expect(await onHand(await storeId("QUARANTINE"), mop)).toBe(1);
    expect(await onHand(await storeId(TRANSIT_STORE_CODE), mop)).toBe(0);
    expect(await charge()).toBe(18 * 250 + 10 * 40);
  });

  it("spec #1112 D14: receiving 7 of 10 leaves 3 in IN-TRANSIT against the last custodian; found receives them, returned puts them back, lost asks the existing approver and posts nothing", async () => {
    const shortTicket = async (): Promise<TicketView> => {
      const t = await issued([{ itemId: mop, qtyBase: 10 }]);
      await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
      return (await deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 7, short: 3 }] }, at(20))).ticket;
    };
    const found = await shortTicket();
    const transit = await storeId(TRANSIT_STORE_CODE);
    expect(await onHand(transit, mop)).toBe(3);
    expect(found.shorts).toEqual([{ lineIdx: 0, itemId: mop, qty: 3, with: { id: porterA.id, name: "porter.a" }, resolution: null }]);
    expect((await noticesOf(inA)).map((n) => n.title)).toContain("Delivered, 3 short");
    expect(await refusal(resolveShort(db, inA.actor, found.id, { lineIdx: 0, resolution: "found" }, at(30)))).toBe("not_permitted");
    const f = await resolveShort(db, head.actor, found.id, { lineIdx: 0, resolution: "found" }, at(30));
    expect(f.ticket.shorts[0]!.resolution).toMatchObject({ kind: "found", by: { id: head.id }, posted: true });
    expect(await onHand(shelfA, mop)).toBe(10);
    expect(await onHand(transit, mop)).toBe(0);
    expect(await charge()).toBe(10 * 250);
    expect(await refusal(resolveShort(db, head.actor, found.id, { lineIdx: 0, resolution: "returned" }, at(31)))).toBe("already_resolved");

    const returned = await shortTicket();
    const mainBefore = await onHand(genMain, mop);
    await resolveShort(db, head.actor, returned.id, { lineIdx: 0, resolution: "returned" }, at(32));
    expect(await onHand(genMain, mop)).toBe(mainBefore + 3);
    expect(await onHand(transit, mop)).toBe(0);

    const lost = await shortTicket();
    const ledgerBefore = (await db.select().from(stockLedger)).length;
    const l = await resolveShort(db, head.actor, lost.id, { lineIdx: 0, resolution: "lost", note: "Not found on the floor" }, at(33));
    expect(l.approvalId).not.toBeNull();
    const asked = await db.select().from(approvals).where(and(eq(approvals.typeKey, STOCK_ADJUSTMENT_APPROVAL_TYPE), eq(approvals.status, "pending")));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.id).toBe(l.approvalId);
    expect(l.ticket.shorts[0]!.resolution).toMatchObject({ kind: "lost", posted: false, approvalId: l.approvalId });
    expect((await db.select().from(stockLedger)).length).toBe(ledgerBefore);
    expect(await onHand(transit, mop)).toBe(3);
  });

  it("spec #1112 D15: a short line re-asked as a linked ticket keeps the first raise time; when stock arrives at the store it appears prefilled on 'To pick'", async () => {
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    const liners = (await registerStoresItem(db, head.actor, { code: "HK-BAG-0003", name: "Bin liners", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    const first = newId();
    await db.insert(stockBatches).values({ id: first, itemId: liners, batchNo: "BL-1", landedCostPaise: 10, ownership: "owned", createdBy: "t" });
    await withTx(db, (tx) => postMovements(tx, keeperA.actor, [{ resourceId: genMain, batchId: first, qtyDelta: 5, reason: "grn", occurredAt: at(-30) }]));
    const t = await issued([{ itemId: liners, qtyBase: 12 }]);
    expect(t.lines[0]!.qtyIssued).toBe(5);
    const again = await reAskShort(db, inA.actor, t.id, at(30));
    expect(again).toMatchObject({ origin: { indentId: t.id, kind: "re_ask" }, clockFrom: NOW.toISOString() });
    expect(again.lines.map((l) => [l.itemId, l.qtyBase])).toEqual([[liners, 7]]);
    expect(await refusal(reAskShort(db, inA.actor, t.id, at(31)))).toBe("already_reasked");
    expect((await ticketsToPick(db, keeperA.actor, at(31))).map((x) => x.id)).not.toContain(again.id);

    // Stock for it arrives at the store: the linked ticket is on "To pick", prefilled.
    const batchId = newId();
    await db.insert(stockBatches).values({ id: batchId, itemId: liners, batchNo: "BL-2", landedCostPaise: 10, ownership: "owned", createdBy: "t" });
    await withTx(db, (tx) => postMovements(tx, keeperA.actor, [{ resourceId: genMain, batchId, qtyDelta: 50, reason: "grn", occurredAt: at(60) }]));
    const pick = (await ticketsToPick(db, keeperA.actor, at(61))).find((x) => x.id === again.id);
    expect(pick).toBeDefined();
    expect(pick!.lines.map((l) => [l.itemId, l.qtyBase])).toEqual([[liners, 7]]);
    expect((await issueTicket(db, keeperA.actor, again.id, {}, at(62))).lines[0]!.qtyIssued).toBe(7);
  });

  it("spec #1112 D16: returnUndelivered by the porter, accepted by the source keeper, moves the whole transfer IN-TRANSIT → source and the ticket reads 'Returned undelivered'", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    expect(await refusal(returnUndelivered(db, porterB.actor, t.id, {}, at(40)))).toBe("not_in_your_hands");
    const r = await returnUndelivered(db, porterA.actor, t.id, {}, at(40));
    expect(r.ticket.stage).toBe("returning");
    expect((await ticketsToReceive(db, inA.actor, at(41))).map((x) => x.id)).not.toContain(t.id);
    expect(await refusal(acceptReturn(db, porterA.actor, t.id, at(45)))).toBe("not_permitted");
    const back = await acceptReturn(db, keeperA.actor, t.id, at(45));
    expect(back.stage).toBe("returned");
    expect(back.transfer!.status).toBe("returned");
    expect(await onHand(genMain, mop)).toBe(500);
    expect(await onHand(genMain, gloves)).toBe(500);
    expect(await onHand(await storeId(TRANSIT_STORE_CODE), mop)).toBe(0);
    expect(await charge()).toBe(0);
    expect((await noticesOf(inA)).map((n) => n.title)).toContain("Returned undelivered");
    expect(await refusal(deliverTicket(db, inA.actor, t.id, {}, at(50)))).toBe("not_in_transit");
  });

  it("spec #1112 D17: a return ticket from a department, received by the store, credits that department's cost centre with the negative of the original charge at batch cost", async () => {
    const t = await issued([{ itemId: mop, qtyBase: 20 }]);
    await deliverTicket(db, inA.actor, t.id, {}, at(10));
    expect(await charge()).toBe(20 * 250);
    expect(await refusal(raiseReturn(db, porterA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 4, reason: "unused" }] }, at(20)))).toBe("not_permitted");
    const made = await raiseReturn(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 4, reason: "unused" }, { itemId: mop, qtyBase: 2, reason: "defective" }] }, at(20));
    expect(made.map((m) => [m.to.id === genMain, m.quarantine])).toEqual([[true, false], [false, true]]);
    expect(await onHand(shelfA, mop)).toBe(14);
    expect(await charge()).toBe(20 * 250);
    for (const m of made) {
      expect(await refusal(receiveReturn(db, inA.actor, m.transferId, at(30)))).toBe("not_permitted");
      expect((await receiveReturn(db, keeperA.actor, m.transferId, at(30))).status).toBe("received");
    }
    expect(await charge()).toBe(20 * 250 - 6 * 250);
    expect(await onHand(genMain, mop)).toBe(500 - 20 + 4);
    expect(await onHand(await storeId("QUARANTINE"), mop)).toBe(2);
    const tr = await getTransfer(db, made[0]!.transferId);
    expect(tr!.receivedBy).toBe(keeperA.id);
  });

  it("spec #1112 D19: a scan sent twice with one idempotency key records once; a scan keeps its scan time; one 13 h old is accepted and flagged for the keeper's confirmation", async () => {
    const t = await issued();
    const first = await takeCustody(db, porterA.actor, { code: t.indentNo, clientKey: "scan-1", scannedAt: at(5).toISOString() }, at(6));
    const twice = await takeCustody(db, porterA.actor, { code: t.indentNo, clientKey: "scan-1", scannedAt: at(5).toISOString() }, at(7));
    expect([first.duplicate, twice.duplicate]).toEqual([false, true]);
    expect(await handoffCount(t.id)).toBe(1);
    const row = (await db.execute(sql`select occurred_at, flag from stores_custody_handoffs where indent_id = ${t.id}`)).rows[0] as { occurred_at: Date; flag: string | null };
    expect(new Date(row.occurred_at).toISOString()).toBe(at(5).toISOString());
    expect(row.flag).toBeNull();

    // Porter B's phone held the hand-off scan for 13 hours: accepted, dated by the scan, flagged.
    const late = await handOver(db, porterB.actor, { code: t.indentNo, fromUserId: porterA.id, clientKey: "scan-2", scannedAt: at(10).toISOString() }, at(10 + 13 * 60));
    expect(late.flag).toBe("late");
    expect(late.ticket.custody!.holder!.id).toBe(porterB.id);
    const flagged = await lateScansToConfirm(db, keeperA.actor);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ indentId: t.id, kind: "hand_over", by: { id: porterB.id }, phoneAt: at(10).toISOString(), flag: "late" });
    expect((await noticesOf(keeperA)).map((n) => n.title)).toContain("Late scan to confirm");
    // A scan dated in the future is stored at server time and flagged.
    const t2 = await issued([{ itemId: gloves, qtyBase: 2 }]);
    const future = await takeCustody(db, porterC.actor, { code: t2.indentNo, scannedAt: at(90).toISOString() }, at(9));
    expect(future.flag).toBe("future");
    const f = (await db.execute(sql`select occurred_at from stores_custody_handoffs where indent_id = ${t2.id}`)).rows[0] as { occurred_at: Date };
    expect(new Date(f.occurred_at).toISOString()).toBe(at(9).toISOString());
  });

  it("spec #1112 D20: a delivered ticket sends its requester exactly three notices; a declined one sends exactly one, 'Not approved', without the reason", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    await handOver(db, porterB.actor, { code: t.indentNo, fromUserId: porterA.id }, at(8));
    await deliverTicket(db, inA.actor, t.id, {}, at(20));
    expect((await noticesOf(inA)).map((n) => n.title).sort()).toEqual(["Approved", "Delivered", "On the way"]);

    await db.delete(alerts);
    const d = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 3 }], priority: "routine" }, at(30));
    await declineTicket(db, hodA.actor, d.id, "Enough stock on the floor", at(31));
    const told = await noticesOf(inA);
    expect(told.map((n) => n.title)).toEqual(["Not approved"]);
    expect(told[0]!.body ?? "").not.toContain("Enough stock");
  });

  it("spec #1112 D22: UPDATE and DELETE on stores_custody_handoffs are refused; an approval stamp cannot be changed or cleared and a stamped indent cannot be deleted; a late scan keeps phone and server time and the timeline shows both past 5 minutes", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo, scannedAt: at(4).toISOString() }, at(5));
    await expect(db.execute(sql`update stores_custody_handoffs set to_user_id = ${porterC.id} where indent_id = ${t.id}`)).rejects.toThrow(/append_only/);
    await expect(db.execute(sql`delete from stores_custody_handoffs where indent_id = ${t.id}`)).rejects.toThrow(/append_only/);
    await expect(db.execute(sql`update store_indents set approval_decision = null, approval_by = null, approval_at = null, approval_for_hod = null where id = ${t.id}`)).rejects.toThrow(/write_once/);
    await expect(db.execute(sql`update store_indents set approval_by = ${keeperB.id} where id = ${t.id}`)).rejects.toThrow(/write_once/);
    await expect(db.execute(sql`delete from store_indents where id = ${t.id}`)).rejects.toThrow(/store_indent_immutable/);

    // Phone 4 minutes behind: one time on the timeline. Phone 40 minutes behind: both, "Synced late".
    await handOver(db, porterB.actor, { code: t.indentNo, fromUserId: porterA.id, scannedAt: at(10).toISOString() }, at(50));
    const row = (await db.execute(sql`select phone_at, recorded_at from stores_custody_handoffs where indent_id = ${t.id} and kind = 'hand_over'`)).rows[0] as { phone_at: Date; recorded_at: Date };
    expect(new Date(row.phone_at).toISOString()).toBe(at(10).toISOString());
    expect(new Date(row.recorded_at).toISOString()).toBe(at(50).toISOString());
    const steps = (await ticketTimeline(db, head.actor, t.id)).steps;
    const take = steps.find((s) => s.step === "take")!;
    const hand = steps.find((s) => s.step === "hand_over")!;
    expect([take.phoneAt ?? null, take.recordedAt ?? null]).toEqual([null, null]);
    expect([hand.phoneAt, hand.recordedAt]).toEqual([at(10).toISOString(), at(50).toISOString()]);
  });
});
