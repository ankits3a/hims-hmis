import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { orgDepartments } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { createResource } from "../../kernel/resources/registry";
import { MaterialsError } from "../materials";
import {
  StoresError, approveTicket, createShelf, issueTicket, listCategories, openStore, overdueEmergencyReviews, raiseTicket, registerStoresItem,
  reviewEmergency, seedStoresMasters, ticketTimeline, withinServiceHours,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S2a (#1112) — beyond the done-means: the write-once stamp trigger (migration 0238, which S2b's D22
 * acceptance pins), the emergency review, and the service-hours clock.
 */
describe("Stores S2a tickets: write-once stamps, emergency review, hours", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who; let keeper: Who; let inA: Who; let hod: Who;
  let shelf: string; let mop: string;
  const NOW = new Date("2026-11-10T06:30:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const grants: Record<string, string[]> = {
      materials_head: ["stores.masters.manage", "stores.shelf.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "head", ["materials_head"]);
    keeper = await mkUser(db, "keeper", ["storekeeper"]);
    inA = await mkUser(db, "incharge", []);
    hod = await mkUser(db, "hod", []);
    const dept = newId();
    await db.insert(orgDepartments).values({ id: dept, code: "HSK", name: "Housekeeping", kind: "support", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: dept });
    await assignRole(db, { userId: hod.id, roleKey: "department_head", scopeType: "department", scopeId: dept });
    const floor = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "F1" }))).resourceId;
    const { centralStoreId } = await seedStoresMasters(db, head.actor);
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    mop = (await registerStoresItem(db, head.actor, { code: "MOP", name: "Mop", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    await openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 100, unitCostPaise: 250 }], NOW);
    ({ shelfId: shelf } = await createShelf(db, head.actor, { code: "HSK-F1", name: "HSK F1", floorId: floor, departmentId: dept, suppliedBy: centralStoreId }));
  });

  async function dbRefusal(q: Promise<unknown>): Promise<string> {
    try { await q; } catch (e) { return String((e as { cause?: { message?: string }; message?: string }).cause?.message ?? (e as Error).message); }
    throw new Error("expected the database to refuse");
  }
  async function code(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) { if (e instanceof StoresError || e instanceof MaterialsError) return e.code; throw e; }
    throw new Error("expected a refusal");
  }

  it("an approval stamp, once set, cannot be changed or cleared; an approved quantity is write-once; a stamped indent is never deleted", async () => {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelf, lines: [{ itemId: mop, qtyBase: 10 }], priority: "routine" }, NOW);
    await approveTicket(db, hod.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 8 }] }, NOW);
    expect(await dbRefusal(db.execute(sql`update store_indents set approval_decision = 'declined', approval_reason = 'x' where id = ${t.id}`))).toMatch(/store_indent_stamp_write_once/);
    expect(await dbRefusal(db.execute(sql`update store_indents set approval_by = null, approval_at = null, approval_decision = null, approval_for_hod = null where id = ${t.id}`))).toMatch(/store_indent_stamp_write_once/);
    expect(await dbRefusal(db.execute(sql`update store_indents set approval_required = false where id = ${t.id}`))).toMatch(/store_indent_immutable/);
    expect(await dbRefusal(db.execute(sql`update store_indent_lines set qty_approved = 9 where indent_id = ${t.id}`))).toMatch(/store_indent_stamp_write_once/);
    expect(await dbRefusal(db.execute(sql`delete from store_indents where id = ${t.id}`))).toMatch(/store_indent_immutable/);
    // The ordinary lane still moves: the issue is its one decision, issued up to the approved 8.
    const issued = await issueTicket(db, keeper.actor, t.id, {}, NOW);
    expect(issued.lines[0]!.qtyIssued).toBe(8);
    expect(await code(issueTicket(db, keeper.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 9 }] }, NOW))).toBe("indent_closed");
  });

  it("an emergency issued first is reviewed once (agree / query), leaves the overdue list, and the review is on the timeline", async () => {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelf, lines: [{ itemId: mop, qtyBase: 2 }], priority: "emergency", emergencyReason: "Spill" }, NOW);
    expect(await code(reviewEmergency(db, hod.actor, t.id, { decision: "agree" }, NOW))).toBe("not_emergency");
    await issueTicket(db, keeper.actor, t.id, {}, NOW);
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    expect((await overdueEmergencyReviews(db, later)).map((x) => x.id)).toEqual([t.id]);
    const reviewed = await reviewEmergency(db, hod.actor, t.id, { decision: "query", note: "Why two?" }, later);
    expect(reviewed.review).toMatchObject({ decision: "query", by: { id: hod.id }, note: "Why two?" });
    expect(await overdueEmergencyReviews(db, later)).toHaveLength(0);
    expect(await code(reviewEmergency(db, hod.actor, t.id, { decision: "agree" }, later))).toBe("already_reviewed");
    const steps = (await ticketTimeline(db, hod.actor, t.id)).steps.map((s) => s.step);
    expect(steps).toEqual(["raise", "issue", "review"]);
  });

  it("service hours are read on the IST clock and an overnight span wraps", () => {
    expect(withinServiceHours("09:00-17:00", new Date("2026-11-10T03:30:00.000Z"))).toBe(true); // 09:00 IST
    expect(withinServiceHours("09:00-17:00", new Date("2026-11-10T11:30:00.000Z"))).toBe(false); // 17:00 IST
    expect(withinServiceHours("22:00-06:00", new Date("2026-11-10T20:00:00.000Z"))).toBe(true); // 01:30 IST
    expect(withinServiceHours(null, new Date("2026-11-10T20:00:00.000Z"))).toBe(true);
  });
});
