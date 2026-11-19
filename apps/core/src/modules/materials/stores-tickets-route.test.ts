import { HttpException } from "@nestjs/common";
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
import { createShelf, departmentChargeOn, listCategories, openStore, raiseReturn, raiseTicket, receiveAtShelf, receiveReturn, registerStoresItem, seedStoresMasters } from "../stores";
import { getIndent } from "./indents";
import { MaterialsIndentsController } from "./materials-indents.controller";
import { MaterialsController } from "./materials.controller";
import { getTransfer, issueStock } from "./transfers";
import { createStore } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * Pre-merge review S5: a Stores ticket is a `store_indents` row, and `/materials/indents` must not raise, issue,
 * reject or cancel one (that would skip the HOD stamp, the picking claim and the department grant). Pharmacy
 * indents are untouched.
 */
describe("the materials indent routes leave Stores tickets to Stores", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who; let keeper: Who; let inA: Who;
  let shelf: string; let mop: string; let genMain: string; let pharmMain: string; let pharmCounter: string;
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
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "head", ["materials_head"]);
    keeper = await mkUser(db, "keeper", ["storekeeper"]);
    inA = await mkUser(db, "incharge", []);
    const dept = newId();
    await db.insert(orgDepartments).values({ id: dept, code: "HSK", name: "Housekeeping", kind: "support", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: dept });
    const floor = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "F1" }))).resourceId;
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    mop = (await registerStoresItem(db, head.actor, { code: "MOP", name: "Mop", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    await openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 100, unitCostPaise: 250 }], NOW);
    ({ shelfId: shelf } = await createShelf(db, head.actor, { code: "HSK-F1", name: "HSK F1", floorId: floor, departmentId: dept, suppliedBy: genMain }));
    pharmMain = (await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN", name: "Pharmacy main" }))).resourceId;
    pharmCounter = (await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM", name: "Pharmacy counter" }))).resourceId;
  });

  async function codeOf(p: Promise<unknown>): Promise<string> {
    try { await p; return "ok"; } catch (e) { return ((e as HttpException).getResponse() as { code?: string }).code ?? String(e); }
  }

  it("issue, reject and cancel of a Stores ticket and a raise naming a Stores place are refused; the ticket is unchanged", async () => {
    const ctl = new MaterialsIndentsController(db);
    const t = await raiseTicket(db, inA.actor, { shelfId: shelf, lines: [{ itemId: mop, qtyBase: 2 }], priority: "emergency", emergencyReason: "Spill" }, NOW);
    expect(await codeOf(ctl.issue(keeper.actor, t.id, {}))).toBe("moves_through_stores");
    expect(await codeOf(ctl.reject(keeper.actor, t.id, { reason: "no" }))).toBe("moves_through_stores");
    expect(await codeOf(ctl.cancel(keeper.actor, t.id, { reason: "no" }))).toBe("moves_through_stores");
    expect(await codeOf(ctl.raise(keeper.actor, { fromResourceId: shelf, toResourceId: genMain, lines: [{ itemId: mop, qtyBase: 1 }] }))).toBe("moves_through_stores");
    expect((await getIndent(db, t.id))!.status).toBe("requested");
  });

  it("a pharmacy indent still raises and cancels through the route", async () => {
    const ctl = new MaterialsIndentsController(db);
    const { indent } = await ctl.raise(keeper.actor, { fromResourceId: pharmCounter, toResourceId: pharmMain, lines: [{ itemId: mop, qtyBase: 1 }] });
    expect((await ctl.cancel(keeper.actor, indent.id, { reason: "not needed" })).indent.status).toBe("cancelled");
  });

  async function openShelfStock(): Promise<void> {
    const { transferId } = await withTx(db, (tx) => issueStock(tx, keeper.actor, { fromResourceId: genMain, toResourceId: shelf, lines: [{ itemId: mop, qtyBase: 5 }], occurredAt: NOW }));
    await receiveAtShelf(db, inA.actor, transferId, NOW);
  }

  it("pre-merge review S5: a department return is received through Stores, never the materials route, so the department's credit is never skipped", async () => {
    await openShelfStock();
    const [ret] = await raiseReturn(db, inA.actor, { shelfId: shelf, lines: [{ itemId: mop, qtyBase: 2, reason: "unused" }] }, NOW);
    const tr = (await getTransfer(db, ret!.transferId))!;
    const ctl = new MaterialsController(db);
    expect(await codeOf(ctl.receive(keeper.actor, tr.id, { lines: tr.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued })) }))).toBe("moves_through_stores");
    expect((await getTransfer(db, tr.id))!.status).toBe("in_transit");
    await receiveReturn(db, keeper.actor, tr.id, NOW);
    expect((await departmentChargeOn(db, "HSK", "2026-11-10")).chargePaise).toBe(5 * 250 - 2 * 250);
  });
});
