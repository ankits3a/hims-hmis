import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, hasPermission, syncPermissions } from "../../../kernel/auth/permissions";
import { withTx } from "../../../kernel/db/client";
import { alerts, events, orgDepartments, stockBatches } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import { MaterialsError, createStore, issueIndent, postMovements, raiseIndent, registerItem, setStoreCustodianRoles } from "../../materials";
import { storesManifest } from "../manifest";
import {
  NIGHT_STORE_CODE, STORES_ACT_EVENT, StoresError, approveTicket, claimPicking, createShelf, declineTicket, issueTicket, listCategories,
  openStore, overdueEmergencyReviews, raiseTicket, reRaiseTicket, registerStoresItem, seedStoresMasters, storesApproveDesk, storesAuditPack,
  storesPickDesk, storesReceiveDesk, ticketTimeline, ticketsToApprove, ticketsToPick, ticketsToReceive,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { DeskProvider } from "../../../kernel/desk/types";

/**
 * ACCEPTANCE — issue #1112, spec docs/specs/1112-stores-tickets-custody.md (owner APPROVED 2026-11-18, ruling
 * 0099): Stores S2a, request tickets, HOD approval and the superintendent's stand-in, re-raise, the picking
 * claim, the night store, the three Now cards and the audit pack. One test per done-means id the spec's
 * build notes give S2a: D1–D7, D18, D21, D23. D8–D17, D19, D20, D22 and D24 are S2b's.
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S2a: tickets, approval, picking, night store, Now cards, audit pack (spec #1112)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let keeperA: Who;
  let keeperB: Who;
  let inA: Who;
  let hodA: Who;
  let hodB: Who;
  let ms: Who;
  let nightSup: Who;
  let genMain: string;
  let genNight: string;
  let deptA: { id: string; code: string };
  let deptB: { id: string; code: string };
  let shelfA: string;
  let mop: string;
  let gloves: string;

  /** 12:00 IST — inside GEN-MAIN's 09:00–17:00. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  /** 23:00 IST — outside them. */
  const NIGHT = new Date("2026-11-10T17:30:00.000Z");
  const MIN = 60_000;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    const grants: Record<string, string[]> = {
      materials_head: ["stores.masters.manage", "stores.shelf.read", "stores.audit.read", "materials.items.read", "materials.stock.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
      medical_superintendent: ["stores.indents.approve", "stores.audit.read"],
      nursing_supervisor: ["stores.nightstore.issue"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeperA = await mkUser(db, "keeper.a", ["storekeeper"]);
    keeperB = await mkUser(db, "keeper.b", ["storekeeper"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    nightSup = await mkUser(db, "night.supervisor", ["nursing_supervisor"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);
    hodB = await mkUser(db, "hod.b", []);

    deptA = await anOrgDept("HSK", "Housekeeping");
    deptB = await anOrgDept("LAU", "Laundry");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodB.id, roleKey: "department_head", scopeType: "department", scopeId: deptB.id });

    const floor1 = await aFloor("F1", "First floor");
    ({ centralStoreId: genMain, nightStoreId: genNight } = await seedStoresMasters(db, head.actor));
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    mop = (await registerStoresItem(db, head.actor, { code: "HK-MOP-0001", name: "Wet mop refill", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    gloves = (await registerStoresItem(db, head.actor, { code: "HK-GLV-0002", name: "Household gloves", class: "consumable", baseUom: "pair", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    await openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 500, unitCostPaise: 250 }, { itemId: gloves, qty: 500, unitCostPaise: 40 }], NOW);
    await openStore(db, head.actor, NIGHT_STORE_CODE, [{ itemId: mop, qty: 40, unitCostPaise: 250 }], NOW);
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
  const routine = (who: Who = inA, at: Date = NOW) =>
    raiseTicket(db, who.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 20 }, { itemId: gloves, qtyBase: 10 }], priority: "routine", channel: "phone", deliverTo: "HSK pantry, first floor" }, at);
  const ctx = (who: Who, now: Date = NOW) => ({ db, actor: who.actor, reader: who.actor, date: "2026-11-10", now });
  const waitingCount = async (p: DeskProvider, who: Who, now: Date = NOW): Promise<number> =>
    (await p.waiting!(ctx(who, now))).reduce((s, i) => s + i.count, 0);
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }

  /* ─────────────────────────────── D1–D7, D18, D21, D23 ─────────────────────────────── */

  it("spec #1112 D1: raiseTicket by a shelf-grant holder with no materials grant creates a pending indent with its priority and details; an emergency with no reason and a line with no item id are refused", async () => {
    for (const p of ["materials.stock.receive", "materials.stock.issue", "materials.stock.read"]) {
      expect(await hasPermission(db, inA.id, p, "hospital")).toBe(false);
    }
    const t = await routine();
    expect(t).toMatchObject({
      status: "requested", stage: "to_approve", priority: "routine", channel: "phone", deliverTo: "HSK pantry, first floor", night: false,
      shelf: { id: shelfA }, source: { id: genMain }, department: { id: deptA.id }, requestedBy: { id: inA.id },
      approval: { state: "pending", by: null, forHod: false },
    });
    expect(t.indentNo).toMatch(/^MIN\d{10}$/);
    expect(t.lines.map((l) => [l.itemId, l.qtyBase, l.qtyApproved])).toEqual([[mop, 20, null], [gloves, 10, null]]);
    expect(await refusal(raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 5 }], priority: "emergency", emergencyReason: "  " }, NOW))).toBe("reason_required");
    expect(await refusal(raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: null, qtyBase: 5 }], priority: "routine" }, NOW))).toBe("item_id_required");
    expect(await refusal(raiseTicket(db, hodB.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 5 }], priority: "routine" }, NOW))).toBe("not_permitted");
  });

  it("spec #1112 D2: approveTicket by the department's approver stamps it and may reduce a line, never raise it; another department's approver and the requester are refused", async () => {
    const t = await routine();
    expect(await refusal(approveTicket(db, hodA.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 25 }] }, NOW))).toBe("more_than_asked");
    expect(await refusal(approveTicket(db, hodB.actor, t.id, {}, NOW))).toBe("not_permitted");
    const ok = await approveTicket(db, hodA.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, new Date(NOW.getTime() + 5 * MIN));
    expect(ok.approval).toMatchObject({ state: "approved", by: { id: hodA.id }, forHod: false });
    expect(ok.stage).toBe("to_pick");
    expect(ok.lines.map((l) => [l.qtyBase, l.qtyApproved])).toEqual([[20, 15], [10, 10]]);
    expect(await refusal(approveTicket(db, hodA.actor, t.id, {}, NOW))).toBe("already_decided");

    // The requester never approves their own ticket, even holding the grant.
    await assignRole(db, { userId: inA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });
    const own = await routine();
    expect(await refusal(approveTicket(db, inA.actor, own.id, {}, NOW))).toBe("own_ticket");
  });

  it("spec #1112 D3: the medical superintendent approves a ticket whose requester is the department's only approver, and the timeline shows the step 'for HOD'", async () => {
    const deptC = await anOrgDept("KIT", "Kitchen");
    const floor = await aFloor("F9", "Ninth floor");
    const { shelfId: shelfC } = await createShelf(db, head.actor, { code: "KIT-F9", name: "Kitchen F9", floorId: floor, departmentId: deptC.id, suppliedBy: genMain });
    const onlyHod = await mkUser(db, "hod.c", []);
    await assignRole(db, { userId: onlyHod.id, roleKey: "department_head", scopeType: "department", scopeId: deptC.id });
    await assignRole(db, { userId: onlyHod.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptC.id });
    const t = await raiseTicket(db, onlyHod.actor, { shelfId: shelfC, lines: [{ itemId: mop, qtyBase: 4 }], priority: "routine" }, NOW);
    expect(await refusal(approveTicket(db, onlyHod.actor, t.id, {}, NOW))).toBe("own_ticket");
    const ok = await approveTicket(db, ms.actor, t.id, {}, new Date(NOW.getTime() + 7 * MIN));
    expect(ok.approval).toMatchObject({ state: "approved", by: { id: ms.id }, forHod: true });
    const tl = await ticketTimeline(db, ms.actor, t.id);
    const step = tl.steps.find((s) => s.step === "approve");
    expect(step).toMatchObject({ forHod: true, who: { id: ms.id }, minutes: 7 });
    expect(step!.who!.roles).toContain("medical_superintendent");
  });

  it("spec #1112 D4: issuing a pending routine ticket is refused (indent_not_approved), after approval it issues; a pharmacy indent with no stamps issues as before", async () => {
    const t = await routine();
    expect(await refusal(issueTicket(db, keeperA.actor, t.id, {}, NOW))).toBe("indent_not_approved");
    expect(await refusal(issueIndent(db, keeperA.actor, t.id, {}, NOW))).toBe("indent_not_approved");
    await approveTicket(db, hodA.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, NOW);
    const issued = await issueTicket(db, keeperA.actor, t.id, {}, new Date(NOW.getTime() + 20 * MIN));
    expect(issued).toMatchObject({ status: "issued", stage: "to_receive" });
    expect(issued.lines.map((l) => l.qtyIssued)).toEqual([15, 10]);

    // The pharmacy's indent: no stamps, no approval, exactly the A6b behaviour.
    const { resourceId: pharm } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" }));
    const { resourceId: main } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-MAIN", name: "Pharmacy main" }));
    await ensureRole(db, "pharmacy");
    await withTx(db, (tx) => setStoreCustodianRoles(tx, head.actor, pharm, ["pharmacy"]));
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    for (const p of ["materials.stock.read", "materials.stock.receive"]) await grantPermissionToRole(db, registry, "pharmacy", p);
    const pharmacist = await mkUser(db, "the.pharmacist", ["pharmacy"]);
    const gauze = (await withTx(db, (tx) => registerItem(tx, head.actor, { code: "GAUZE", name: "Gauze", class: "consumable", baseUom: "piece", batchTracked: false }))).itemId;
    const batchId = newId();
    await db.insert(stockBatches).values({ id: batchId, itemId: gauze, batchNo: "G1", landedCostPaise: 100, ownership: "owned", createdBy: "t" });
    await withTx(db, (tx) => postMovements(tx, keeperA.actor, [{ resourceId: main, batchId, qtyDelta: 50, reason: "grn", occurredAt: NOW }]));
    const indent = await raiseIndent(db, pharmacist.actor, { fromResourceId: pharm, toResourceId: main, lines: [{ itemId: gauze, qtyBase: 10 }] }, NOW);
    const row = await db.execute(sql`select approval_required, approval_decision, approved_by from store_indents where id = ${indent.id}`);
    expect(row.rows[0]).toEqual({ approval_required: false, approval_decision: null, approved_by: null });
    expect((await issueIndent(db, keeperA.actor, indent.id, {}, NOW)).status).toBe("issued");
  });

  it("spec #1112 D5: an emergency ticket issues before approval; 24 h 1 min later with no review it is in overdueEmergencyReviews", async () => {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 6 }], priority: "emergency", emergencyReason: "Spill in ward 4B" }, NOW);
    expect(t).toMatchObject({ priority: "emergency", emergencyReason: "Spill in ward 4B", source: { id: genMain }, approval: { state: "pending" } });
    expect((await ticketsToPick(db, keeperA.actor, NOW)).map((x) => x.id)).toContain(t.id);
    const issued = await issueTicket(db, keeperA.actor, t.id, {}, new Date(NOW.getTime() + 3 * MIN));
    expect(issued.status).toBe("issued");
    expect((await overdueEmergencyReviews(db, new Date(NOW.getTime() + 24 * 60 * MIN - MIN))).map((x) => x.id)).not.toContain(t.id);
    expect((await overdueEmergencyReviews(db, new Date(NOW.getTime() + 24 * 60 * MIN + 4 * MIN))).map((x) => x.id)).toContain(t.id);
  });

  it("spec #1112 D6: an emergency raised outside GEN-MAIN's hours goes to the night store and a holder of stores.nightstore.issue issues it; a routine one stays on GEN-MAIN", async () => {
    const e = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 3 }], priority: "emergency", emergencyReason: "Night spill" }, NIGHT);
    expect(e).toMatchObject({ night: true, source: { id: genNight, kind: "night" } });
    const r = await routine(inA, NIGHT);
    expect(r).toMatchObject({ night: false, source: { id: genMain } });
    expect((await ticketsToPick(db, nightSup.actor, NIGHT)).map((x) => x.id)).toEqual([e.id]);
    expect(await refusal(issueTicket(db, keeperA.actor, e.id, {}, NIGHT))).toBe("not_store_keeper");
    const issued = await issueTicket(db, nightSup.actor, e.id, {}, new Date(NIGHT.getTime() + 4 * MIN));
    expect(issued).toMatchObject({ status: "issued", transfer: { status: "in_transit" } });
    expect(issued.lines[0]!.qtyIssued).toBe(3);
  });

  it("spec #1112 D7: keeper A claims, keeper B is refused; after 30 idle minutes B's claim succeeds", async () => {
    const t = await routine();
    await approveTicket(db, hodA.actor, t.id, {}, NOW);
    const a = await claimPicking(db, keeperA.actor, t.id, NOW);
    expect(a.claim).toMatchObject({ by: { id: keeperA.id } });
    expect(await refusal(claimPicking(db, keeperB.actor, t.id, new Date(NOW.getTime() + 29 * MIN)))).toBe("claimed_by_another");
    expect(await refusal(issueTicket(db, keeperB.actor, t.id, {}, new Date(NOW.getTime() + 29 * MIN)))).toBe("claimed_by_another");
    const b = await claimPicking(db, keeperB.actor, t.id, new Date(NOW.getTime() + 31 * MIN));
    expect(b.claim).toMatchObject({ by: { id: keeperB.id } });
    // A claim is only for an approved ticket.
    const pending = await routine();
    expect(await refusal(claimPicking(db, keeperA.actor, pending.id, NOW))).toBe("not_approved");
  });

  it("spec #1112 D18: a declined ticket re-raises in one call with its lines prefilled, linked, keeping the first raise time", async () => {
    const t = await routine();
    expect(await refusal(declineTicket(db, hodA.actor, t.id, " ", NOW))).toBe("reason_required");
    const declined = await declineTicket(db, hodA.actor, t.id, "Stock enough for this week", new Date(NOW.getTime() + 10 * MIN));
    expect(declined).toMatchObject({ stage: "declined", approval: { state: "declined", reason: "Stock enough for this week" } });
    const again = await reRaiseTicket(db, inA.actor, t.id, new Date(NOW.getTime() + 60 * MIN));
    expect(again.id).not.toBe(t.id);
    expect(again).toMatchObject({ stage: "to_approve", origin: { indentId: t.id, kind: "re_raise" }, clockFrom: NOW.toISOString(), priority: "routine" });
    expect(again.lines.map((l) => [l.itemId, l.qtyBase])).toEqual([[mop, 20], [gloves, 10]]);
    expect(await refusal(reRaiseTicket(db, inA.actor, t.id, NOW))).toBe("already_reraised");
    expect(await refusal(reRaiseTicket(db, inA.actor, again.id, NOW))).toBe("not_declined");
  });

  it("spec #1112 D21: on raise the department's approvers get one notice and the ticket is on 'Indents to approve'; on approval on 'To pick'; on issue on 'To receive'", async () => {
    const t = await routine();
    const noticesOf = (who: Who) => db.select().from(alerts).where(eq(alerts.userId, who.id));
    expect((await noticesOf(hodA)).map((n) => n.title)).toEqual(["Indent to approve"]);
    expect(await noticesOf(hodB)).toHaveLength(0);
    expect((await ticketsToApprove(db, hodA.actor, NOW)).map((x) => x.id)).toEqual([t.id]);
    expect(await ticketsToApprove(db, hodB.actor, NOW)).toHaveLength(0);
    expect(await waitingCount(storesApproveDesk, hodA)).toBe(1);
    expect(await waitingCount(storesApproveDesk, hodB)).toBe(0);
    expect((await ticketsToPick(db, keeperA.actor, NOW)).map((x) => x.id)).not.toContain(t.id);

    await approveTicket(db, hodA.actor, t.id, {}, NOW);
    expect(await ticketsToApprove(db, hodA.actor, NOW)).toHaveLength(0);
    expect((await ticketsToPick(db, keeperA.actor, NOW)).map((x) => x.id)).toEqual([t.id]);
    expect(await waitingCount(storesPickDesk, keeperA)).toBe(1);
    expect((await noticesOf(inA)).map((n) => n.title)).toEqual(["Approved"]);

    await issueTicket(db, keeperA.actor, t.id, {}, NOW);
    expect(await ticketsToPick(db, keeperA.actor, NOW)).toHaveLength(0);
    expect((await ticketsToReceive(db, inA.actor, NOW)).map((x) => x.id)).toEqual([t.id]);
    expect(await waitingCount(storesReceiveDesk, inA)).toBe(1);
    expect(await ticketsToReceive(db, hodB.actor, NOW)).toHaveLength(0);
    expect((await noticesOf(hodA))).toHaveLength(1);
  });

  it("spec #1112 D23: storesAuditPack returns every movement, approval and act in seq order with actor and role, the CSV has the same rows, each export writes one event, and a caller without stores.audit.read is refused", async () => {
    const t = await routine();
    await approveTicket(db, hodA.actor, t.id, {}, new Date(NOW.getTime() + MIN));
    await claimPicking(db, keeperA.actor, t.id, new Date(NOW.getTime() + 2 * MIN));
    await issueTicket(db, keeperA.actor, t.id, {}, new Date(NOW.getTime() + 3 * MIN));
    const window = { from: new Date(NOW.getTime() - 60 * MIN), to: new Date(NOW.getTime() + 60 * MIN) };
    const exports = async () => (await db.select().from(events).where(eq(events.name, STORES_ACT_EVENT)))
      .filter((e) => (e.payload as { act: string }).act === "audit_export").length;

    const pack = await storesAuditPack(db, head.actor, { ticketId: t.id, ...window }, NOW);
    const whats = pack.rows.map((r) => r.what);
    for (const w of ["raise_ticket", "approve_ticket", "claim_picking", "issue_ticket", "material.issued"]) expect(whats).toContain(w);
    expect(whats.indexOf("raise_ticket")).toBeLessThan(whats.indexOf("approve_ticket"));
    expect(whats.indexOf("approve_ticket")).toBeLessThan(whats.indexOf("issue_ticket"));
    const seqs = pack.rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const approve = pack.rows.find((r) => r.what === "approve_ticket")!;
    expect(approve.actor).toMatchObject({ id: hodA.id, name: "hod.a", roles: ["department_head"] });
    const csv = pack.csv.trim().split("\n");
    expect(csv).toHaveLength(pack.rows.length + 1);
    expect(csv[0]).toMatch(/^seq,at,what,actor,actor_name,roles,/);
    expect(await exports()).toBe(1);

    await storesAuditPack(db, ms.actor, { itemId: mop, ...window }, NOW);
    expect(await exports()).toBe(2);
    const byPerson = await storesAuditPack(db, ms.actor, { personId: keeperA.id, ...window }, NOW);
    expect(byPerson.rows.length).toBeGreaterThan(0);
    expect(byPerson.rows.every((r) => r.actor.id === keeperA.id)).toBe(true);
    const byStore = await storesAuditPack(db, ms.actor, { storeId: genMain, ...window }, NOW);
    expect(byStore.rows.map((r) => r.what)).toContain("issue_ticket");
    expect(await exports()).toBe(4);

    expect(await refusal(storesAuditPack(db, inA.actor, { ticketId: t.id, ...window }, NOW))).toBe("not_permitted");
    expect(await exports()).toBe(4);
    expect((await db.select().from(events).where(and(eq(events.name, STORES_ACT_EVENT), eq(events.actorId, inA.id)))).filter((e) => (e.payload as { act: string }).act === "audit_export")).toHaveLength(0);
  });
});
