import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { alerts, events, orgDepartments, printJobs } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import {
  MaterialsError, activateVendor, addVendorDocument, balances, captureGrn, postGrn, postMovements, registerMaterialsApprovalTypes, registerVendor, runGateQc,
} from "../../materials";
import { RADIOLOGY_RESOURCE_KINDS } from "../../radiology";
import { storesManifest } from "../manifest";
import {
  StoresError, acceptUnitTransfer, addAssetDetails, approveTicket, assetAdditions, assetLedgerCheck, assetPassport, assetsCostUnknown, assetsDue,
  claimPicking, closeRepair, closeVerification, createShelf, deliverTicket, departmentSpendByMonth, equipmentReceivedByMonth, issueTicket,
  linkDevice, listCategories, openRepair, openStore, openUnit, proposeUnitTransfer, raiseGatePass, raiseTicket, recordShelfUse, registerStoresItem,
  reportFault, reportFoundHere, retag, runStoresChaser, scanGatePass, scanVerification, seedStoresMasters, startVerification, tagUnits, towerView,
  voidTag,
} from "../index";
import type { Actor, WireAssetPassportFull } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1114, spec docs/specs/1114-stores-asset-passport.md (owner APPROVED 2026-11-19, decision
 * 0100): Stores S4a, the asset passport. One test per server done-means id the build notes give S4a: D1–D10, D15,
 * D16, D18 (D19 and D20 are the web half, apps/web/src/screens/acceptance/stores-assets-1114.test.tsx; D11–D14 and
 * D17 are S4b's).
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S4a: the asset passport (spec #1114)", () => {
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

  /* ─────────────────────────────── D1–D10, D15, D16, D18 ─────────────────────────────── */

  it("spec #1114 D1: tagUnits on a GRN line of 3 medical-equipment units creates 3 units with 3 distinct tags and queues 3 labels; issuing that batch on a ticket without naming units is refused (units_required)", async () => {
    const { unitIds, tags } = await threeMonitors();
    expect(unitIds).toHaveLength(3);
    expect(new Set(tags).size).toBe(3);
    for (const t of tags) expect(t).toMatch(/^AST\d{10}$/);
    const labels = await db.select().from(printJobs).where(eq(printJobs.document, "stores_asset_label"));
    expect(labels).toHaveLength(3);
    const p = await passport(head, unitIds[0]!);
    expect(p).toMatchObject({ access: "full", status: "in_store", place: { id: genMain } });

    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: monitor, qtyBase: 1 }], priority: "routine", channel: "phone" }, at(10));
    await approveTicket(db, hodA.actor, t.id, {}, at(11));
    await claimPicking(db, keeper.actor, t.id, at(12));
    const before = await ledgerRows();
    expect(await refusal(issueTicket(db, keeper.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 1 }] }, at(13)))).toBe("units_required");
    expect(await ledgerRows()).toBe(before);
  });

  it("spec #1114 D2: a from-value line at ₹4,999 is counted (tagging refused), at ₹5,000 tagged (issue needs tags); medical equipment at ₹500 needs tags; both chair batches on one shelf keep the invariant and the counted one is used as a durable", async () => {
    const cheap = await grnLine(chair, 2, 499_900);
    const dear = await grnLine(chair, 1, 500_000);
    const lowMed = await grnLine(monitor, 1, 50_000);
    expect(await refusal(tagUnits(db, keeper.actor, { grnLineId: cheap.grnLineId, units: [{ serial: null }] }, at(-90)))).toBe("not_tagged_batch");
    expect(await decisionOf(cheap.grnLineId)).toBe("counted");
    const tagged = await tagUnits(db, keeper.actor, { grnLineId: dear.grnLineId, units: [{ serial: null }] }, at(-90));
    expect(await decisionOf(dear.grnLineId)).toBe("tagged");
    await tagUnits(db, keeper.actor, { grnLineId: lowMed.grnLineId, units: [{ serial: "LOW-1" }] }, at(-90));
    expect(await decisionOf(lowMed.grnLineId)).toBe("tagged");
    // The two chair batches are distinct even though nobody typed a batch number.
    const batches = (await db.execute(sql`select batch_id from grn_lines where id in (${cheap.grnLineId}, ${dear.grnLineId})`)).rows as { batch_id: string }[];
    expect(new Set(batches.map((b) => b.batch_id)).size).toBe(2);

    // The medical line at ₹500 still needs its tag.
    const tm = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: monitor, qtyBase: 1 }], priority: "routine", channel: "phone" }, at(1));
    await approveTicket(db, hodA.actor, tm.id, {}, at(2));
    await claimPicking(db, keeper.actor, tm.id, at(2));
    expect(await refusal(issueTicket(db, keeper.actor, tm.id, { lines: [{ lineIdx: 0, qtyBase: 1 }] }, at(3)))).toBe("units_required");

    // Three chairs to ICU: the tagged one by its tag, two counted. Without the tag, the third chair is refused.
    const t0 = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: chair, qtyBase: 3 }], priority: "routine", channel: "phone" }, at(5));
    await approveTicket(db, hodA.actor, t0.id, {}, at(6));
    await claimPicking(db, keeper.actor, t0.id, at(6));
    expect(await refusal(issueTicket(db, keeper.actor, t0.id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, at(7)))).toBe("units_required");
    await issueTicket(db, keeper.actor, t0.id, { lines: [{ lineIdx: 0, qtyBase: 3, unitIds: [tagged.units[0]!.id] }] }, at(8));
    await deliverTicket(db, inA.actor, t0.id, {}, at(10));
    expect(await onHand(shelfA, chair)).toBe(3);
    expect((await assetLedgerCheck(db, at(11))).differences).toEqual([]);
    expect((await passport(head, tagged.units[0]!.id)).place).toMatchObject({ id: shelfA });
    // The counted chairs are durable: they are never "Used".
    expect(await refusal(recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: chair, qty: 1 }, at(12)))).toBe("durable_not_used");
  });

  it("spec #1114 D3: binding a bound tag is refused (tag_bound); voidTag then retag leaves one live tag; scanning the voided tag returns the unit with Tag replaced", async () => {
    const { unitIds, tags } = await threeMonitors();
    const line2 = await grnLine(monitor, 1, 5_000_000);
    expect(await refusal(tagUnits(db, keeper.actor, { grnLineId: line2.grnLineId, units: [{ serial: "SN-009", tagNo: tags[0]! }] }, at(1)))).toBe("tag_bound");
    await voidTag(db, bme.actor, unitIds[1]!, { tagNo: tags[1]!, reason: "label torn" }, at(2));
    const { tagNo } = await retag(db, bme.actor, unitIds[1]!, { reason: "label torn" }, at(3));
    expect(tagNo).not.toBe(tags[1]);
    const live = await passport(head, unitIds[1]!, at(4));
    expect(live.unit).toMatchObject({ tagNo, liveTags: [tagNo] });
    const scanned = await assetPassport(db, head.actor, { code: tags[1]! }, at(5));
    expect(scanned).toMatchObject({ access: "full", tagReplaced: true, unit: { id: unitIds[1], tagNo } });
  });

  it("spec #1114 D4: after a ticket delivers a unit to shelf B the passport gives place B and B's department and nowhere else; the ledger check finds nothing, then exactly the batch and store of an extra ledger row, one tower card, no row changed", async () => {
    const { unitIds } = await threeMonitors();
    await deliverUnits(shelfB, inB, hodB, inB, monitor, 1, [unitIds[0]!], 0);
    const p = await passport(head, unitIds[0]!);
    expect(p).toMatchObject({ status: "in_use", place: { id: shelfB }, department: { id: deptB.id } });
    expect(await onHand(shelfB, monitor)).toBe(1);
    expect(await onHand(genMain, monitor)).toBe(2);
    expect((await assetLedgerCheck(db, at(30))).differences).toEqual([]);

    const [b] = await balances(db, { resourceId: shelfB, itemId: monitor });
    await withTx(db, (tx) => postMovements(tx, head.actor, [{ resourceId: shelfB, batchId: b!.batchId, qtyDelta: 1, reason: "adjust", refType: "test", refId: "x", occurredAt: at(31) }]));
    const rowsBefore = await ledgerRows();
    const eventsBefore = await unitEvents();
    const check = await assetLedgerCheck(db, at(32));
    expect(check.differences).toEqual([{ batchId: b!.batchId, storeId: shelfB, units: 1, ledger: 2 }]);
    const tower = await towerView(db, head.actor, at(33));
    expect(tower.redCards.filter((c) => c.kind === "units_ledger")).toHaveLength(1);
    expect(await ledgerRows()).toBe(rowsBefore);
    expect(await unitEvents()).toBe(eventsBefore);
  });

  it("spec #1114 D5: a returnable gate pass for a unit reads Out: repair with its due date, Overdue a day past it, and the entry scan brings it back to its store", async () => {
    const { unitIds } = await threeMonitors();
    const pass = await raiseGatePass(db, keeper.actor, {
      kind: "returnable", storeId: genMain, purpose: "repair", party: "Medequip service", dueBack: "2026-11-12", lines: [{ itemId: monitor, qty: 1, unitIds: [unitIds[0]!] }],
    }, NOW);
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit", clientKey: "k-out" }, at(5));
    expect(await passport(head, unitIds[0]!, at(6))).toMatchObject({ status: "out_repair", out: { dueBack: "2026-11-12", passId: pass.id } });
    expect((await passport(head, unitIds[0]!, at(3 * DAY))).status).toBe("overdue");
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry", clientKey: "k-in" }, at(3 * DAY + 5));
    expect(await passport(head, unitIds[0]!, at(3 * DAY + 6))).toMatchObject({ status: "in_store", place: { id: genMain } });
    expect((await assetLedgerCheck(db, at(3 * DAY + 7))).differences).toEqual([]);
  });

  it("spec #1114 D6: an AMC ending in 30 days sends one notice to biomedical and the materials head and none on the next sweep; a calibration past due is listed by assetsDue and as a tower red card", async () => {
    const { unitIds } = await threeMonitors();
    await addAssetDetails(db, bme.actor, unitIds[0]!, { contract: { kind: "amc", supplierId: vendorId, start: "2025-12-10", end: "2026-12-10" } }, at(1));
    await addAssetDetails(db, bme.actor, unitIds[1]!, { calibration: { doneOn: "2025-11-01", dueOn: "2026-11-05", agency: "NABL lab" } }, at(1));
    await runStoresChaser(db, at(10));
    expect(await noticesOf(bme, "AMC ends in 30 days")).toHaveLength(1);
    expect(await noticesOf(head, "AMC ends in 30 days")).toHaveLength(1);
    await runStoresChaser(db, at(11));
    expect(await noticesOf(bme, "AMC ends in 30 days")).toHaveLength(1);
    expect(await noticesOf(head, "AMC ends in 30 days")).toHaveLength(1);
    const due = await assetsDue(db, bme.actor, at(12));
    expect(due.rows.filter((r) => r.unitId === unitIds[1] && r.what === "calibration" && r.word === "overdue")).toHaveLength(1);
    const tower = await towerView(db, head.actor, at(13));
    expect(tower.redCards.filter((c) => c.kind === "calibration")).toHaveLength(1);
  });

  it("spec #1114 D7: the third fault within 30 days raises one Replace? card and two raise none; openRepair then closeRepair (repaired) gives In use again", async () => {
    const { unitIds } = await threeMonitors();
    await deliverUnits(shelfA, inA, hodA, inA, monitor, 2, [unitIds[0]!, unitIds[1]!], 0);
    await reportFault(db, inA.actor, unitIds[0]!, { text: "screen flickers" }, at(10));
    await reportFault(db, inA.actor, unitIds[0]!, { text: "screen flickers again" }, at(5 * DAY));
    expect(await noticesOf(head, "Replace?")).toHaveLength(0);
    expect((await assetsDue(db, head.actor, at(5 * DAY + 1))).rows.filter((r) => r.what === "replace")).toHaveLength(0);
    await reportFault(db, inA.actor, unitIds[0]!, { text: "no display" }, at(20 * DAY));
    expect(await noticesOf(head, "Replace?")).toHaveLength(1);
    expect((await assetsDue(db, head.actor, at(20 * DAY + 1))).rows.filter((r) => r.what === "replace" && r.unitId === unitIds[0])).toHaveLength(1);
    expect((await passport(head, unitIds[0]!, at(20 * DAY + 2))).replace).toBe(true);
    // Two faults on the other unit: no card.
    await reportFault(db, inA.actor, unitIds[1]!, { text: "alarm weak" }, at(10));
    await reportFault(db, inA.actor, unitIds[1]!, { text: "alarm weak" }, at(20));
    expect((await assetsDue(db, head.actor, at(30))).rows.filter((r) => r.what === "replace" && r.unitId === unitIds[1])).toHaveLength(0);

    await openRepair(db, bme.actor, unitIds[1]!, { note: "check speaker" }, at(40));
    expect((await passport(head, unitIds[1]!, at(41))).status).toBe("under_repair");
    await closeRepair(db, bme.actor, unitIds[1]!, { outcome: "repaired", note: "speaker replaced" }, at(50));
    expect((await passport(head, unitIds[1]!, at(51))).status).toBe("in_use");
  });

  it("spec #1114 D8: a unit linked to a radiology device shows the device's status read-only; the Stores manifest declares no device kind", async () => {
    const { unitIds } = await threeMonitors();
    const { resourceId: ct } = await withTx(db, (tx) => createResource(tx, head.actor, [...KERNEL_RESOURCE_KINDS, ...RADIOLOGY_RESOURCE_KINDS], {
      kind: "device", code: "CT-1", name: "CT scanner 1", attributes: { modality: "CT" },
    }));
    await linkDevice(db, bme.actor, unitIds[0]!, ct, at(1));
    expect((await passport(head, unitIds[0]!, at(2))).device).toEqual({ id: ct, code: "CT-1", name: "CT scanner 1", status: "available" });
    expect((storesManifest.resourceKinds ?? []).map((k) => k.kind)).not.toContain("device");
    const status = await count(sql`select count(*)::int as n from resources where id = ${ct} and status = 'available'`);
    expect(status).toBe(1);
  });

  it("spec #1114 D9: closeVerification lists units not scanned and units scanned away from their derived place; reportFoundHere by another department writes one event and one notice to the owner and no ledger row", async () => {
    const { unitIds } = await threeMonitors();
    await deliverUnits(shelfB, inB, hodB, inB, monitor, 3, unitIds, 0);
    const { roundId } = await startVerification(db, inB.actor, { departmentId: deptB.id }, at(30));
    await scanVerification(db, inB.actor, roundId, { unitId: unitIds[0]!, shelfId: shelfB }, at(31));
    await scanVerification(db, inB.actor, roundId, { unitId: unitIds[1]!, shelfId: shelfB2 }, at(32));
    const closed = await closeVerification(db, inB.actor, roundId, at(40));
    expect(closed.notSeen.map((u) => u.unitId)).toEqual([unitIds[2]]);
    expect(closed.wrongPlace.map((u) => u.unitId)).toEqual([unitIds[1]]);

    const rows = await ledgerRows();
    const ev = await unitEvents(unitIds[2]!);
    await reportFoundHere(db, inA.actor, unitIds[2]!, { shelfId: shelfA }, at(50));
    expect(await unitEvents(unitIds[2]!)).toBe(ev + 1);
    expect(await noticesOf(inB, "Your unit is elsewhere")).toHaveLength(1);
    expect(await ledgerRows()).toBe(rows);
  });

  it("spec #1114 D10: proposeUnitTransfer then acceptUnitTransfer by the receiving department moves place, ledger balance and cost centre together; acceptance by the proposer is refused (own_transfer)", async () => {
    const { unitIds, tags } = await threeMonitors();
    await deliverUnits(shelfB, inB, hodB, inB, monitor, 1, [unitIds[0]!], 0);
    await proposeUnitTransfer(db, both.actor, unitIds[0]!, { toShelfId: shelfA }, at(20));
    expect((await passport(head, unitIds[0]!, at(21))).status).toBe("on_its_way");
    expect(await refusal(acceptUnitTransfer(db, both.actor, { code: tags[0]! }, at(22)))).toBe("own_transfer");
    await acceptUnitTransfer(db, inA.actor, { code: tags[0]!.slice(-4) }, at(23));
    expect(await passport(head, unitIds[0]!, at(24))).toMatchObject({ status: "in_use", place: { id: shelfA }, department: { id: deptA.id } });
    expect(await onHand(shelfB, monitor)).toBe(0);
    expect(await onHand(shelfA, monitor)).toBe(1);
    const cc = (await db.execute(sql`select cost_center from stock_ledger where resource_id = ${shelfA} and reason = 'receive' and qty_delta > 0`)).rows as { cost_center: string }[];
    expect(cc.map((r) => r.cost_center)).toEqual([deptA.code]);
    expect((await assetLedgerCheck(db, at(25))).differences).toEqual([]);
  });

  it("spec #1114 D15: assetAdditions(month) lists every unit put to use that month with cost, GST, put-to-use date, category, department, GRN and bill; the cost adds up; each export writes one event", async () => {
    const { unitIds, grnNo } = await threeMonitors();
    await deliverUnits(shelfA, inA, hodA, inA, monitor, 2, [unitIds[0]!, unitIds[1]!], 0);
    const exportsBefore = await count(sql`select count(*)::int as n from events where name = 'stores.act_recorded' and payload->>'act' = 'asset_export'`);
    const r = await assetAdditions(db, accounts.actor, "2026-11", at(60));
    expect(r.rows.map((x) => x.unitId).sort()).toEqual([unitIds[0]!, unitIds[1]!].sort());
    for (const row of r.rows) {
      expect(row).toMatchObject({
        costPaise: 5_000_000, gstPaise: 600_000, putToUse: "2026-11-10", category: "Medical equipment", department: "ICU", grnNo, billNo: expect.stringMatching(/^INV-/), billDate: "2026-11-08",
      });
    }
    expect(r.rows.reduce((s, x) => s + (x.costPaise ?? 0), 0)).toBe(10_000_000);
    expect(r.csv.split("\n")[0]).toContain("Put to use");
    await assetAdditions(db, accounts.actor, "2026-11", at(61));
    const exportsAfter = await count(sql`select count(*)::int as n from events where name = 'stores.act_recorded' and payload->>'act' = 'asset_export'`);
    expect(exportsAfter - exportsBefore).toBe(2);
    expect(await refusal(assetAdditions(db, inA.actor, "2026-11", at(62)))).toBe("not_permitted");
  });

  it("spec #1114 D16: an opening-sweep unit posts one opening ledger row with no cost centre; cost unknown is accepted and listed; a second opening of the same unit is refused", async () => {
    const before = await ledgerRows();
    const u = await openUnit(db, bme.actor, { storeId: shelfA, itemId: monitor, serial: "OLD-77", make: "Philips", model: "MX450", unitCostPaise: null, putToUse: "2019-04-01" }, at(1));
    expect(await ledgerRows()).toBe(before + 1);
    const rows = (await db.execute(sql`select ref_type, cost_center, qty_delta from stock_ledger where resource_id = ${shelfA}`)).rows;
    expect(rows).toEqual([{ ref_type: "opening_balance", cost_center: null, qty_delta: 1 }]);
    expect((await assetsCostUnknown(db, head.actor)).rows.map((r) => r.unitId)).toEqual([u.unitId]);
    expect(await passport(head, u.unitId, at(2))).toMatchObject({ status: "in_use", putToUse: "2019-04-01", place: { id: shelfA } });
    expect(await refusal(openUnit(db, bme.actor, { storeId: shelfA, itemId: monitor, serial: "OLD-77", unitCostPaise: null }, at(3)))).toBe("already_opened");
    expect(await ledgerRows()).toBe(before + 1);
  });

  it("spec #1114 D18: department A's holder scanning B's unit sees only name, tag, Belongs to B and Found here; a tagged unit received by a department adds nothing to the month's spend and is listed under Equipment received", async () => {
    const { unitIds, tags } = await threeMonitors();
    const spendBefore = (await departmentSpendByMonth(db, "2026-11")).get(deptB.code) ?? 0;
    await deliverUnits(shelfB, inB, hodB, inB, monitor, 1, [unitIds[0]!], 0);
    expect((await departmentSpendByMonth(db, "2026-11")).get(deptB.code) ?? 0).toBe(spendBefore);
    const received = await equipmentReceivedByMonth(db, "2026-11");
    expect(received.filter((r) => r.unitId === unitIds[0] && r.departmentId === deptB.id)).toHaveLength(1);

    const foreign = await assetPassport(db, inA.actor, { code: tags[0]! }, at(30));
    expect(foreign).toEqual({
      access: "foreign", tagReplaced: false,
      unit: { id: unitIds[0], tagNo: tags[0], name: "Patient monitor" },
      belongsTo: { departmentId: deptB.id, departmentName: "Ward 4" },
    });
    const own = await assetPassport(db, inB.actor, { code: tags[0]! }, at(30));
    expect(own.access).toBe("full");
    expect(own).not.toHaveProperty("costPaise");
    const full = await passport(head, unitIds[0]!);
    expect(full).toHaveProperty("costPaise", 5_000_000);
    expect((await db.select().from(events).where(and(eq(events.name, "stores.act_recorded"), sql`${events.payload}->>'act' = 'tag_units'`)))).toHaveLength(1);
  });
});
