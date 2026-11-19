import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { alerts, events, orgDepartments, printJobs } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { createResource } from "../../kernel/resources/registry";
import {
  MaterialsError, activateVendor, addVendorDocument, balances, captureGrn, postGrn, postMovements, registerMaterialsApprovalTypes, registerVendor, runGateQc,
} from "../materials";
import { RADIOLOGY_RESOURCE_KINDS } from "../radiology";
import { storesManifest } from "./manifest";
import {
  StoresError, acceptUnitTransfer, addAssetDetails, approveTicket, assetAdditions, assetLedgerCheck, assetPassport, assetsCostUnknown, assetsDue,
  claimPicking, closeRepair, closeVerification, createShelf, deliverTicket, departmentSpendByMonth, equipmentReceivedByMonth, issueTicket,
  linkDevice, listCategories, openRepair, openStore, openUnit, proposeUnitTransfer, raiseGatePass, raiseTicket, recordShelfUse, registerStoresItem,
  reportFault, reportFoundHere, retag, runStoresChaser, scanGatePass, scanVerification, seedStoresMasters, startVerification, tagUnits, towerView,
  voidTag,
} from "./index";
import type { Actor, WireAssetPassportFull } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * NOT AN ACCEPTANCE FILE — the S4a passport's own checks beyond the done-means (the fixture is the acceptance file's).
 * ACCEPTANCE lives in acceptance/stores-s4a-1114.test.ts — issue #1114, spec docs/specs/1114-stores-asset-passport.md (owner APPROVED 2026-11-19, decision
 * 0101): Stores S4a, the asset passport. One test per server done-means id the build notes give S4a: D1–D10, D15,
 * D16, D18 (D19 and D20 are the web half, apps/web/src/screens/acceptance/stores-assets-1114.test.tsx; D11–D14 and
 * D17 are S4b's).
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S4a: the passport, beyond the done-means (#1114)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let keeper: Who;
  let bme: Who;
  let accounts: Who;
  let guard: Who;
  let inA: Who;
  let inB: Who;
  let hodA: Who;
  let hodB: Who;
  let both: Who;
  let deptA: { id: string; code: string };
  let deptB: { id: string; code: string };
  let genMain: string;
  let shelfA: string;
  let shelfB: string;
  let shelfB2: string;
  let monitor: string;
  let chair: string;
  let vendorId: string;
  let cat: Map<string, string>;

  /** 12:00 IST on 2026-11-10 — inside GEN-MAIN's 09:00–17:00. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const DAY = 24 * 60;
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
      materials_head: ["stores.masters.manage", "stores.shelf.read", "stores.audit.read", "stores.assets.manage", "stores.assets.read", "stores.tower.read", "stores.spend.read", "stores.gatepass.raise", "materials.items.read", "materials.stock.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "stores.gatepass.raise"],
      biomedical_engineer: ["stores.assets.manage", "stores.assets.read"],
      accounts_officer: ["stores.assets.export"],
      security_guard: ["stores.gatepass.scan"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    bme = await mkUser(db, "bme.a", ["biomedical_engineer"]);
    accounts = await mkUser(db, "accounts.a", ["accounts_officer"]);
    guard = await mkUser(db, "guard.a", ["security_guard"]);
    inA = await mkUser(db, "incharge.a", []);
    inB = await mkUser(db, "incharge.b", []);
    hodA = await mkUser(db, "hod.a", []);
    hodB = await mkUser(db, "hod.b", []);
    both = await mkUser(db, "incharge.both", []);

    deptA = await anOrgDept("ICU", "ICU");
    deptB = await anOrgDept("WARD4", "Ward 4");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: inB.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptB.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodB.id, roleKey: "department_head", scopeType: "department", scopeId: deptB.id });
    await assignRole(db, { userId: both.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: both.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptB.id });

    const floor1 = await aFloor("F1", "First floor");
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    monitor = (await registerStoresItem(db, head.actor, {
      code: "ME-MON-0001", name: "Patient monitor", class: "asset", baseUom: "piece", categoryId: cat.get("MEQ")!, trackMode: "tagged", gstRateBps: 1200,
    })).itemId;
    chair = (await registerStoresItem(db, head.actor, {
      code: "FU-CHR-0001", name: "Office chair", class: "asset", baseUom: "piece", categoryId: cat.get("FUR")!, trackMode: "durable", gstRateBps: 1800,
    })).itemId;
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
    ({ shelfId: shelfB } = await createShelf(db, head.actor, { code: "W4-F1", name: "Ward 4 shelf", floorId: floor1, departmentId: deptB.id, suppliedBy: genMain }));
    ({ shelfId: shelfB2 } = await createShelf(db, head.actor, { code: "W4-F1B", name: "Ward 4 nurses' station", floorId: floor1, departmentId: deptB.id, suppliedBy: genMain }));
    ({ vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "V-MEDEQ", legalName: "Medequip Pvt Ltd" })));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, at(-200)));
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "clinical", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  async function aFloor(code: string, name: string): Promise<string> {
    return (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code, name }))).resourceId;
  }
  /** A posted GRN into GEN-MAIN: one line of `qty` units at `unitCostPaise` each (before GST). Returns the line. */
  async function grnLine(itemId: string, qty: number, unitCostPaise: number, challanNo = `CH-${newId().slice(-6)}`): Promise<{ grnId: string; grnNo: string; grnLineId: string }> {
    const { grnId, grnNo } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId, source: "challan", storeResourceId: genMain, challanNo, challanDate: "2026-11-09", invoiceNo: `INV-${challanNo}`, invoiceDate: "2026-11-08",
      lines: [{ itemId, uom: "piece", qtyInUom: qty, unitCostPaise }], now: at(-120),
    }));
    await withTx(db, (tx) => runGateQc(tx, keeper.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, keeper.actor, grnId, at(-110)));
    const [row] = (await db.execute(sql`select id from grn_lines where grn_id = ${grnId}`)).rows as { id: string }[];
    return { grnId, grnNo, grnLineId: row!.id };
  }
  /** Three monitors received and tagged at GEN-MAIN. */
  async function threeMonitors(): Promise<{ unitIds: string[]; tags: string[]; grnLineId: string; grnNo: string }> {
    const line = await grnLine(monitor, 3, 5_000_000);
    const r = await tagUnits(db, keeper.actor, { grnLineId: line.grnLineId, units: [{ serial: "SN-001" }, { serial: "SN-002" }, { serial: "SN-003" }] }, at(-100));
    return { unitIds: r.units.map((u) => u.id), tags: r.units.map((u) => u.tagNo), grnLineId: line.grnLineId, grnNo: line.grnNo };
  }
  /** A ticket for `shelf` raised, approved, claimed and issued (with `units` named on line 0), then delivered by `receiver`. */
  async function deliverUnits(shelf: string, raiser: Who, approver: Who, receiver: Who, itemId: string, qty: number, unitIds: string[], t0: number): Promise<string> {
    const t = await raiseTicket(db, raiser.actor, { shelfId: shelf, lines: [{ itemId, qtyBase: qty }], priority: "routine", channel: "phone" }, at(t0));
    await approveTicket(db, approver.actor, t.id, {}, at(t0 + 1));
    await claimPicking(db, keeper.actor, t.id, at(t0 + 2));
    await issueTicket(db, keeper.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: qty, unitIds }] }, at(t0 + 3));
    await deliverTicket(db, receiver.actor, t.id, {}, at(t0 + 5));
    return t.id;
  }
  async function onHand(resourceId: string, itemId: string): Promise<number> {
    return (await balances(db, { resourceId, itemId })).reduce((s, b) => s + b.qtyOnHand, 0);
  }
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  const ledgerRows = (): Promise<number> => count(sql`select count(*)::int as n from stock_ledger`);
  const unitEvents = (unitId?: string): Promise<number> =>
    unitId === undefined ? count(sql`select count(*)::int as n from stores_asset_unit_events`) : count(sql`select count(*)::int as n from stores_asset_unit_events where unit_id = ${unitId}`);
  const noticesOf = async (who: Who, title?: string): Promise<{ title: string; body: string | null }[]> =>
    (await db.select({ title: alerts.title, body: alerts.body }).from(alerts).where(eq(alerts.userId, who.id))).filter((n) => title === undefined || n.title === title);
  const decisionOf = async (grnLineId: string): Promise<string | undefined> =>
    ((await db.execute(sql`select result from stores_tag_decisions where grn_line_id = ${grnLineId}`)).rows[0] as { result: string } | undefined)?.result;
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }
  /** The full passport (these readers all see it in full; D18 pins the foreign view). */
  const passport = async (who: Who, unitId: string, when: Date = at(60)): Promise<WireAssetPassportFull> =>
    (await assetPassport(db, who.actor, { unitId }, when)) as WireAssetPassportFull;

  it("units, unit events, tag decisions and rounds refuse UPDATE and DELETE in the database", async () => {
    const { unitIds, grnLineId } = await threeMonitors();
    await startVerification(db, inA.actor, { departmentId: deptA.id }, at(1));
    for (const q of [
      sql`update stores_asset_units set serial = 'X' where id = ${unitIds[0]!}`,
      sql`delete from stores_asset_units where id = ${unitIds[0]!}`,
      sql`update stores_asset_unit_events set data = '{}'::jsonb where unit_id = ${unitIds[0]!}`,
      sql`delete from stores_asset_unit_events where unit_id = ${unitIds[0]!}`,
      sql`update stores_tag_decisions set result = 'counted' where grn_line_id = ${grnLineId}`,
      sql`delete from stores_asset_verifications`,
    ]) {
      await expect(db.execute(q)).rejects.toThrow(/stores_assets_append_only/);
    }
  });

  it("medical equipment must be tagged, and only medical equipment is", async () => {
    expect(await refusal(registerStoresItem(db, head.actor, { code: "ME-X-1", name: "Syringe pump", class: "asset", baseUom: "piece", categoryId: cat.get("MEQ")!, trackMode: "durable" }))).toBe("track_mode_required");
    expect(await refusal(registerStoresItem(db, head.actor, { code: "FU-X-1", name: "Desk", class: "asset", baseUom: "piece", categoryId: cat.get("FUR")!, trackMode: "tagged" }))).toBe("track_mode_required");
  });

  it("a tagged line received short by scan places only the scanned unit; the other stays on its way and the books still agree", async () => {
    const { unitIds } = await threeMonitors();
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: monitor, qtyBase: 2 }], priority: "routine", channel: "phone" }, at(0));
    await approveTicket(db, hodA.actor, t.id, {}, at(1));
    await claimPicking(db, keeper.actor, t.id, at(2));
    await issueTicket(db, keeper.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 2, unitIds: [unitIds[0]!, unitIds[1]!] }] }, at(3));
    expect(await refusal(deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 1, short: 1 }] }, at(5)))).toBe("units_required");
    await deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 1, short: 1, unitIds: [unitIds[1]!] }] }, at(6));
    expect((await passport(head, unitIds[1]!, at(7))).place).toMatchObject({ id: shelfA });
    expect((await passport(head, unitIds[0]!, at(7))).status).toBe("on_its_way");
    expect((await assetLedgerCheck(db, at(8))).differences).toEqual([]);
  });

  it("a counted gate-pass line never takes a tagged unit's batch", async () => {
    // The dear line first: a later cheaper line needs no price reason (#1061's 2% check is on a rise).
    const dear = await grnLine(chair, 1, 600_000);
    const cheap = await grnLine(chair, 2, 300_000);
    const tagged = await tagUnits(db, keeper.actor, { grnLineId: dear.grnLineId, units: [{ serial: null }] }, at(-90));
    const pass = await raiseGatePass(db, keeper.actor, { kind: "returnable", storeId: genMain, purpose: "repair", party: "Carpenter", dueBack: "2026-11-12", lines: [{ itemId: chair, qty: 2 }] }, NOW);
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit", clientKey: "k1" }, at(5));
    expect((await passport(head, tagged.units[0]!.id, at(6))).status).toBe("in_store");
    expect((await assetLedgerCheck(db, at(7))).differences).toEqual([]);
    // A third chair can only go out by its tag.
    expect(await refusal(raiseGatePass(db, keeper.actor, { kind: "returnable", storeId: genMain, purpose: "repair", party: "Carpenter", dueBack: "2026-11-12", lines: [{ itemId: chair, qty: 1 }] }, NOW))).toBe("units_required");
    void cheap;
  });

  it("the typed last four opens the unit; four digits no tag ends in are refused", async () => {
    const { unitIds, tags } = await threeMonitors();
    const p = await assetPassport(db, head.actor, { code: tags[0]!.slice(-4) }, at(1));
    expect(p).toMatchObject({ access: "full", unit: { id: unitIds[0] } });
    expect(await refusal(assetPassport(db, head.actor, { code: "9999" }, at(1)))).toBe("unknown_unit");
  });
});
