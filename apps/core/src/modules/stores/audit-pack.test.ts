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
import { createStore, raiseIndent } from "../materials";
import { csvCell } from "./audit-pack";
import {
  approveTicket, createShelf, issueTicket, listCategories, openStore, raiseTicket, registerStoresItem, seedStoresMasters, storesAuditPack,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * Pre-merge review S2/S3: the audit pack holds Stores' own movements only (pharmacy's share the event stream), says
 * when it stopped short and where to go on, and writes CSV cells no spreadsheet runs as a formula.
 */
describe("Stores audit pack: Stores places only, paged, spreadsheet-safe", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who; let keeper: Who; let inA: Who; let hod: Who; let pharmacist: Who;
  let shelf: string; let mop: string; let pharmMain: string; let pharmCounter: string;
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const window = { from: new Date(NOW.getTime() - 60 * MIN), to: new Date(NOW.getTime() + 60 * MIN) };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const grants: Record<string, string[]> = {
      materials_head: ["stores.masters.manage", "stores.shelf.read", "stores.audit.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive"],
      pharmacist: ["materials.stock.read", "materials.stock.receive"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "head", ["materials_head"]);
    keeper = await mkUser(db, "keeper", ["storekeeper"]);
    pharmacist = await mkUser(db, "pharmacist", ["pharmacist"]);
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
    pharmMain = (await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN", name: "Pharmacy main" }))).resourceId;
    pharmCounter = (await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM", name: "Pharmacy counter" }))).resourceId;
  });

  async function aTicket(at: Date): Promise<string> {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelf, lines: [{ itemId: mop, qtyBase: 2 }], priority: "routine" }, at);
    await approveTicket(db, hod.actor, t.id, {}, new Date(at.getTime() + MIN));
    await issueTicket(db, keeper.actor, t.id, {}, new Date(at.getTime() + 2 * MIN));
    return t.id;
  }

  it("a pharmacy indent between pharmacy stores is not in the Stores pack; the Stores ticket's materials events are", async () => {
    await aTicket(NOW);
    const pharm = await raiseIndent(db, pharmacist.actor, { fromResourceId: pharmCounter, toResourceId: pharmMain, lines: [{ itemId: mop, qtyBase: 1 }] }, NOW);
    const pack = await storesAuditPack(db, head.actor, { ...window }, NOW);
    expect(pack.rows.map((r) => r.what)).toEqual(expect.arrayContaining(["raise_ticket", "material.indent_raised", "material.issued"]));
    expect(pack.rows.some((r) => r.ref === pharm.id)).toBe(false);
    expect(pack.rows.every((r) => r.storeId !== pharmMain && r.storeId !== pharmCounter)).toBe(true);
    expect(pack.truncated).toBe(false);
    expect(pack.nextAfterSeq).toBeNull();
  });

  it("a pack cut at its limit says so, names where to go on, and the next page holds the rest with no gap or repeat", async () => {
    await aTicket(NOW);
    await aTicket(new Date(NOW.getTime() + 5 * MIN));
    const all = await storesAuditPack(db, head.actor, { ...window }, NOW);
    const first = await storesAuditPack(db, head.actor, { ...window, limit: 3 }, NOW);
    expect(first.rows).toHaveLength(3);
    expect(first.truncated).toBe(true);
    expect(first.nextAfterSeq).toBe(first.rows[2]!.seq);
    expect(first.csv.trim().split("\n").at(-1)).toMatch(/^# truncated at 3 rows; ask again with afterSeq=\d+$/);
    const rest = await storesAuditPack(db, head.actor, { ...window, afterSeq: first.nextAfterSeq! }, NOW);
    expect([...first.rows, ...rest.rows].map((r) => r.seq).slice(0, all.rows.length)).toEqual(all.rows.map((r) => r.seq));
  });

  it("a CSV cell that starts like a formula is written with a leading quote", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(v).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });
});
