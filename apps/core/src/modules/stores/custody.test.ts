import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { alerts, approvals, orgDepartments, stockBatches, stockLedger } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { createResource } from "../../kernel/resources/registry";
import { approveRequest } from "../../kernel/approvals/decisions";
import { renderDocument } from "../../kernel/printing/render";
import {
  MaterialsError, STOCK_ADJUSTMENT_APPROVAL_TYPE, TRANSIT_STORE_CODE, balances, findStoreByCode, getTransfer, postMovements, registerMaterialsApprovalTypes,
} from "../materials";
import { storesManifest } from "./manifest";
import {
  StoresError, addToOpenTicket, confirmLateScan, myCustody, openTicketFor, postTransitLoss, registerStoresPrinting, acceptReturn, approveTicket, claimPicking, createShelf, declineTicket, deliverTicket, departmentChargeOn, getTicket, handOver,
  issueTicket, lateScansToConfirm, listCategories, openStore, raiseReturn, raiseTicket, reAskShort, receiveReturn, registerStoresItem,
  resolveShort, returnUndelivered, seedStoresMasters, takeCustody, takeOverCustody, ticketTimeline, ticketsToPick, ticketsToReceive,
  custodyLookup, storesTakeBackDesk, ticketsComingBack,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TicketView } from "./types";

/**
 * NOT an acceptance file: the S2b paths the done-means ids do not name — a lost short booked after its
 * approval, "Add to open ticket?", the issue voucher, a late scan confirmed, and the refusals around them.
 * The fixture is the acceptance suite's.
 *
 * (was) ACCEPTANCE — issue #1112, spec docs/specs/1112-stores-tickets-custody.md (owner APPROVED 2026-11-18, ruling
 * 0099): Stores S2b, the custody chain and the porter's scan, counter collection, the take-over, delivery with
 * wrong and damaged lines, shorts and their three resolutions, the back-order, undelivered and department
 * returns, late scans, the delivered ticket's notices and the append-only hand-off log. One test per done-means
 * id the spec's build notes give S2b: D8–D17, D19, D20, D22 (D24 is the web half,
 * apps/web/src/screens/acceptance/stores-receive-1112.test.tsx). S2a's ids are in stores-s2a-1112.test.ts.
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S2b: the paths beside the done-means", () => {
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

  it("a lost short posts nothing until the superintendent grants it; then one adjust row leaves IN-TRANSIT", async () => {
    await ensureRole(db, "medical_superintendent");
    const reg = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) reg.install(m);
    for (const p of ["approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, reg, "medical_superintendent", p);
    const ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    const t = await issued([{ itemId: mop, qtyBase: 10 }]);
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    await deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 7, short: 3 }] }, at(20));
    const { approvalId } = await resolveShort(db, head.actor, t.id, { lineIdx: 0, resolution: "lost" }, at(30));
    expect(await refusal(postTransitLoss(db, head.actor, approvalId!, at(31)))).toBe("not_approved");
    expect(await refusal(postTransitLoss(db, inA.actor, approvalId!, at(31)))).toBe("not_permitted");
    await approveRequest(db, ms.actor, { approvalId: approvalId!, note: "Written off" });
    expect(await postTransitLoss(db, head.actor, approvalId!, at(40))).toEqual({ posted: 1, refused: 0 });
    expect(await onHand(await storeId(TRANSIT_STORE_CODE), mop)).toBe(0);
    const losses = (await db.select().from(stockLedger)).filter((r) => r.refType === "transit_loss");
    expect(losses.map((r) => r.qtyDelta)).toEqual([-3]);
    expect((await getTicket(db, t.id, at(41)))!.shorts[0]!.resolution).toMatchObject({ kind: "lost", posted: true });
  });

  it("Add to open ticket: the shelf's ticket waiting for its HOD takes new items; an item already on it is left off", async () => {
    expect(await openTicketFor(db, inA.actor, shelfA, NOW)).toBeNull();
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 5 }], priority: "routine" }, NOW);
    expect((await openTicketFor(db, inA.actor, shelfA, NOW))!.id).toBe(t.id);
    const r = await addToOpenTicket(db, inA.actor, t.id, { lines: [{ itemId: mop, qtyBase: 2 }, { itemId: gloves, qtyBase: 4 }] }, at(2));
    expect(r).toMatchObject({ added: [gloves], alreadyOn: [mop] });
    expect(r.ticket.lines.map((l) => [l.itemId, l.qtyBase])).toEqual([[mop, 5], [gloves, 4]]);
    expect(await refusal(addToOpenTicket(db, inA.actor, t.id, { lines: [{ itemId: gloves, qtyBase: 1 }] }, at(3)))).toBe("already_on_ticket");
    expect(await refusal(addToOpenTicket(db, porterA.actor, t.id, { lines: [{ itemId: gloves, qtyBase: 1 }] }, at(3)))).toBe("not_permitted");
    await approveTicket(db, hodA.actor, t.id, {}, at(4));
    expect(await openTicketFor(db, inA.actor, shelfA, at(5))).toBeNull();
    expect(await refusal(addToOpenTicket(db, inA.actor, t.id, { lines: [{ itemId: gloves, qtyBase: 1 }] }, at(5)))).toBe("already_decided");
  });

  it("the issue queues one voucher whose label QR carries the ticket number and its last four digits", async () => {
    const off = registerStoresPrinting();
    try {
      const t = await issued();
      const jobs = (await db.execute(sql`select document, params from print_jobs`)).rows as { document: string; params: { indentId: string } }[];
      expect(jobs).toEqual([{ document: "stores_issue_voucher", params: { indentId: t.id } }]);
      const doc = await renderDocument(db, "stores_issue_voucher", { indentId: t.id }, at(5), null);
      expect(doc!.html).toContain(t.indentNo);
      expect(doc!.html).toContain(`>${t.indentNo.slice(-4)}<`);
      expect(doc!.html).toContain("<svg");
      expect(doc!.html).toContain("Wet mop refill");
    } finally { off(); }
  });

  it("a late scan is confirmed once by a source keeper; the porter's card lists what is in their hands", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo, scannedAt: at(5).toISOString() }, at(5 + 13 * 60));
    expect((await myCustody(db, porterA.actor, at(5 + 13 * 60))).map((r) => r.ticket.id)).toEqual([t.id]);
    expect(await myCustody(db, porterB.actor, at(5 + 13 * 60))).toEqual([]);
    const [late] = await lateScansToConfirm(db, keeperB.actor);
    expect(await refusal(confirmLateScan(db, porterA.actor, late!.handoffId, at(800)))).toBe("not_permitted");
    await confirmLateScan(db, keeperB.actor, late!.handoffId, at(800));
    expect(await refusal(confirmLateScan(db, keeperA.actor, late!.handoffId, at(801)))).toBe("already_confirmed");
    expect(await lateScansToConfirm(db, keeperA.actor)).toEqual([]);
  });

  it("refusals around the chain: a take of a ticket already with a porter, a hand-off to oneself, digits that name nothing, a full line, nothing coming back", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    expect(await refusal(takeCustody(db, porterB.actor, { code: t.indentNo }, at(6)))).toBe("not_in_your_hands");
    expect(await refusal(handOver(db, porterA.actor, { code: t.indentNo, fromUserId: porterA.id }, at(6)))).toBe("not_in_your_hands");
    expect(await refusal(takeCustody(db, porterB.actor, { code: "9999" }, at(6)))).toBe("unknown_ticket");
    expect(await refusal(resolveShort(db, head.actor, t.id, { lineIdx: 0, resolution: "found" }, at(7)))).toBe("nothing_short");
    expect(await refusal(acceptReturn(db, keeperA.actor, t.id, at(7)))).toBe("nothing_to_return");
  });
  it("the porter's lookup names whose hands the label is in, so nobody types an id: the store's keeper, then the porter", async () => {
    const t = await issued();
    const atStore = await custodyLookup(db, porterA.actor, t.indentNo.slice(-4), at(4));
    expect(atStore).toMatchObject({ act: "take", holder: { id: keeperA.id }, ticket: { id: t.id } });
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    const onTheWay = await custodyLookup(db, porterB.actor, t.indentNo, at(6));
    expect(onTheWay).toMatchObject({ act: "hand_over", holder: { id: porterA.id } });
    expect(onTheWay.holder.name).not.toBe(porterA.id);
    await handOver(db, porterB.actor, { code: t.indentNo, fromUserId: onTheWay.holder.id }, at(7));
    expect((await myCustody(db, porterB.actor, at(8))).map((r) => r.ticket.id)).toEqual([t.id]);
    expect(await refusal(custodyLookup(db, porterB.actor, t.indentNo, at(8)))).toBe("already_yours");
    expect(await refusal(custodyLookup(db, inA.actor, t.indentNo, at(8)))).toBe("not_permitted");
    expect(await refusal(custodyLookup(db, porterC.actor, "9999", at(8)))).toBe("unknown_ticket");
  });

  it("the keeper's take-back list: a ticket coming back undelivered, one tap to accept; the Now card counts it with the late scans", async () => {
    const t = await issued();
    await takeCustody(db, porterA.actor, { code: t.indentNo, scannedAt: at(5).toISOString() }, at(5 + 13 * 60));
    await returnUndelivered(db, porterA.actor, t.id, {}, at(5 + 13 * 60 + 1));
    const later = at(5 + 13 * 60 + 2);
    expect((await ticketsComingBack(db, keeperB.actor, later)).map((x) => x.id)).toEqual([t.id]);
    expect(await ticketsComingBack(db, inA.actor, later)).toEqual([]);
    const ctx = { db, actor: keeperB.actor, reader: keeperB.actor, date: DAY, now: later } as unknown as Parameters<typeof storesTakeBackDesk.load>[0];
    const [card] = await storesTakeBackDesk.load(ctx);
    expect(card).toMatchObject({ key: "stores.back", titleKey: "stores.now.toTakeBack", stats: [{ key: "count", value: "2", href: "/stores/pick" }] });
    await acceptReturn(db, keeperB.actor, t.id, later);
    expect(await ticketsComingBack(db, keeperB.actor, later)).toEqual([]);
    const [late] = await lateScansToConfirm(db, keeperB.actor);
    await confirmLateScan(db, keeperB.actor, late!.handoffId, later);
    expect(await storesTakeBackDesk.load(ctx)).toEqual([]);
  });

  it("pre-merge review M1: a receipt scanned with a phone time before the issue or a month back is dated and charged at the server's time, flagged, and on the keeper's list", async () => {
    const t = await issued([{ itemId: mop, qtyBase: 10 }]);
    await takeCustody(db, porterA.actor, { code: t.indentNo, scannedAt: at(5).toISOString() }, at(5));
    const backdated = "2026-10-01T06:30:00.000Z";
    const r = await deliverTicket(db, inA.actor, t.id, { scannedAt: backdated }, at(20));
    expect(r.flag).toBe("late");
    const shelfRows = (await db.select().from(stockLedger)).filter((x) => x.resourceId === shelfA);
    expect(shelfRows.length).toBeGreaterThan(0);
    for (const x of shelfRows) expect(x.occurredAt.toISOString()).toBe(at(20).toISOString());
    expect((await departmentChargeOn(db, "HSK", "2026-10-01")).chargePaise).toBe(0);
    expect(await charge()).toBe(10 * 250);
    const lines = (await db.execute(sql`select received_at, phone_at, flag from stores_delivery_lines where indent_id = ${t.id}`)).rows as { received_at: Date; phone_at: Date; flag: string }[];
    expect(lines.map((l) => [new Date(l.received_at).toISOString(), new Date(l.phone_at).toISOString(), l.flag])).toEqual([[at(20).toISOString(), backdated, "late"]]);
    const flagged = await lateScansToConfirm(db, keeperA.actor);
    expect(flagged).toEqual([expect.objectContaining({ indentId: t.id, kind: "deliver", phoneAt: backdated, flag: "late" })]);
    await confirmLateScan(db, keeperA.actor, flagged[0]!.handoffId, at(30));
    expect(await lateScansToConfirm(db, keeperA.actor)).toEqual([]);
    expect(await refusal(confirmLateScan(db, keeperA.actor, flagged[0]!.handoffId, at(31)))).toBe("already_confirmed");
  });

  it("pre-merge review M1: a hand-over whose phone time is before the take it follows is dated at the server's time and flagged; one inside the window keeps the phone's time", async () => {
    const t = await issued([{ itemId: mop, qtyBase: 4 }]);
    await takeCustody(db, porterA.actor, { code: t.indentNo, scannedAt: at(6).toISOString() }, at(7));
    const r = await handOver(db, porterB.actor, { code: t.indentNo, fromUserId: porterA.id, scannedAt: at(4).toISOString() }, at(9));
    expect(r.flag).toBe("late");
    const rows = (await db.execute(sql`select kind, occurred_at, phone_at, flag from stores_custody_handoffs where indent_id = ${t.id} order by recorded_at`)).rows as { kind: string; occurred_at: Date; phone_at: Date; flag: string | null }[];
    expect(rows.map((h) => [h.kind, new Date(h.occurred_at).toISOString(), new Date(h.phone_at).toISOString(), h.flag])).toEqual([
      ["take", at(6).toISOString(), at(6).toISOString(), null],
      ["hand_over", at(9).toISOString(), at(4).toISOString(), "late"],
    ]);
  });

  it("pre-merge review S6: a delivery line is never changed or deleted; a transit resolution takes only pending to posted or refused", async () => {
    const t = await issued([{ itemId: mop, qtyBase: 10 }]);
    await takeCustody(db, porterA.actor, { code: t.indentNo }, at(5));
    await deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 8, wrong: 2 }] }, at(20));
    const dbRefusal = async (q: Promise<unknown>): Promise<string> => {
      try { await q; } catch (e) { return String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message); }
      throw new Error("expected the database to refuse");
    };
    expect(await dbRefusal(db.execute(sql`update stores_delivery_lines set accepted = 10, wrong = 0 where indent_id = ${t.id}`))).toMatch(/stores_delivery_lines_append_only/);
    expect(await dbRefusal(db.execute(sql`delete from stores_delivery_lines where indent_id = ${t.id}`))).toMatch(/stores_delivery_lines_append_only/);
    expect(await dbRefusal(db.execute(sql`update stores_transit_resolutions set qty = 1 where indent_id = ${t.id}`))).toMatch(/stores_transit_resolution_immutable/);
    expect(await dbRefusal(db.execute(sql`delete from stores_transit_resolutions where indent_id = ${t.id}`))).toMatch(/stores_transit_resolution_immutable/);
    await acceptReturn(db, keeperA.actor, t.id, at(30));
    expect(await dbRefusal(db.execute(sql`update stores_transit_resolutions set status = 'refused', posted_by = null, posted_at = null where indent_id = ${t.id}`))).toMatch(/stores_transit_resolution_immutable/);
  });
});
