import { HttpException } from "@nestjs/common";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { withTx } from "../../kernel/db/client";
import { orgDepartments } from "../../kernel/db/schema";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { createResource } from "../../kernel/resources/registry";
import { createStore, ensureOutOnPassStore, ensureQuarantineStore, listStores } from "./stores";
import { MaterialsController } from "./materials.controller";
import { createShelf, listShelves, listStoresStores, seedStoresMasters, storesManifest } from "../stores";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * Pre-merge review S1: the Stores places (GEN-MAIN, GEN-NIGHT, every department shelf) share the `resources`
 * table with pharmacy's stores. Pharmacy's lists and pickers must not change when Stores rows exist, and the
 * `/materials/transfers` issue route must not move stock out of (or into) a Stores place.
 */
describe("Stores places stay out of pharmacy's lists and the materials transfer route", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let pharmMain: string;
  let pharmCounter: string;
  let genMain: string;
  let shelfId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "materials_head");
    await grantPermissionToRole(db, registry, "materials_head", "stores.masters.manage");
    head = await mkUser(db, "stores.head", ["materials_head"]);
    pharmMain = (await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN", name: "Pharmacy main" }))).resourceId;
    pharmCounter = (await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM", name: "Pharmacy counter" }))).resourceId;
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    const deptId = newId();
    await db.insert(orgDepartments).values({ id: deptId, code: "HSK", name: "Housekeeping", kind: "support", createdBy: "t", updatedBy: "t" });
    const floor = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "First floor" }))).resourceId;
    ({ shelfId } = await createShelf(db, head.actor, { code: "HSK-F1", name: "Housekeeping F1", floorId: floor, departmentId: deptId, suppliedBy: genMain }));
  });

  it("listStores, as pharmacy calls it, is unchanged by Stores rows; Stores still sees its own", async () => {
    expect((await listStores(db)).map((s) => s.code)).toEqual(["MAIN", "PHARM"]);
    expect((await listStores(db, { includeStoresDomain: true })).map((s) => s.code)).toEqual(["GEN-MAIN", "GEN-NIGHT", "HSK-F1", "MAIN", "PHARM"]);
    expect((await listStoresStores(db)).map((s) => s.code)).toEqual(["GEN-MAIN", "GEN-NIGHT"]);
    expect((await listShelves(db)).map((s) => s.code)).toEqual(["HSK-F1"]);
  });

  it("the central and night stores name their keepers", async () => {
    const rows = await listStoresStores(db);
    expect(rows.find((s) => s.code === "GEN-MAIN")?.custodianRoles).toEqual(["storekeeper"]);
    expect(rows.find((s) => s.code === "GEN-NIGHT")?.custodianRoles.length).toBeGreaterThan(0);
  });

  it("POST /materials/transfers refuses a Stores place as source or destination; pharmacy to pharmacy is untouched", async () => {
    const ctl = new MaterialsController(db);
    const line = { itemId: newId(), qtyBase: 1 };
    const codeOf = async (p: Promise<unknown>): Promise<string> => {
      try { await p; return "ok"; } catch (e) { return ((e as HttpException).getResponse() as { code?: string }).code ?? String(e); }
    };
    for (const [from, to] of [[genMain, pharmCounter], [pharmMain, shelfId], [pharmMain, genMain]] as const) {
      expect(await codeOf(ctl.issue(head.actor, { fromResourceId: from, toResourceId: to, lines: [line] }))).toBe("moves_through_stores");
    }
    // Pharmacy to pharmacy goes past the new refusal (and stops later, at the unknown item, as before).
    expect(await codeOf(ctl.issue(head.actor, { fromResourceId: pharmMain, toResourceId: pharmCounter, lines: [line] }))).not.toBe("moves_through_stores");
  });

  it("the quarantine store (a Stores system store) is out of pharmacy's lists and refused on the transfer route", async () => {
    const q = await withTx(db, (tx) => ensureQuarantineStore(tx));
    expect((await listStores(db)).map((s) => s.code)).toEqual(["MAIN", "PHARM"]);
    expect((await listStores(db, { includeStoresDomain: true })).map((s) => s.code)).toContain("QUARANTINE");
    const ctl = new MaterialsController(db);
    let code = "ok";
    try { await ctl.issue(head.actor, { fromResourceId: q, toResourceId: pharmMain, lines: [{ itemId: newId(), qtyBase: 1 }] }); } catch (e) { code = ((e as HttpException).getResponse() as { code?: string }).code ?? String(e); }
    expect(code).toBe("moves_through_stores");
  });

  it("the out-on-pass store (a Stores system store) is out of pharmacy's lists and refused on the transfer route", async () => {
    const out = await withTx(db, (tx) => ensureOutOnPassStore(tx));
    expect((await listStores(db)).map((s) => s.code)).toEqual(["MAIN", "PHARM"]);
    expect((await listStores(db, { includeStoresDomain: true })).map((s) => s.code)).toContain("OUT-ON-PASS");
    const ctl = new MaterialsController(db);
    let code = "ok";
    try { await ctl.issue(head.actor, { fromResourceId: out, toResourceId: pharmMain, lines: [{ itemId: newId(), qtyBase: 1 }] }); } catch (e) { code = ((e as HttpException).getResponse() as { code?: string }).code ?? String(e); }
    expect(code).toBe("moves_through_stores");
  });
});
