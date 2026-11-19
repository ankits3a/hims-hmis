import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { withTx } from "../../../kernel/db/client";
import { alerts, events, opdDepartments, opdEncounters, orgDepartments, patients, stockLedger } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import { addMedicine, addSalt } from "../../formulary";
import {
  MaterialsError, balances, createStore, getTransfer, issueIndent, issueStock, postMovements, raiseIndent, receiveStock, registerItem,
  setStoreCustodianRoles,
} from "../../materials";
import { storesManifest } from "../manifest";
import {
  STORES_ACT_EVENT, StoresError, createShelf, departmentChargeOn, floorShelfUseByMonth, importStoresItems, listCategories, listShelves,
  listStoresItems, openShelf, openStore, overBookCards, receiveAtShelf, recordShelfCheck, recordShelfUse, registerStoresItem,
  requestNewItem, resolveNewItemRequest, reverseShelfUse, saveReorderDraft, searchStoresItems, seedStoresMasters, setShelfPar,
  shelfReorderDraft, shelfView, updateStoresItem,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1111, spec docs/specs/1111-stores-masters-shelves.md (owner APPROVED 2026-11-18, ruling
 * 0099): Stores S1, the non-drug master, stores and department shelves. One test per done-means id, D1–D19
 * here; D20 (the 390 px shelf) is the web half, apps/web/src/screens/acceptance/stores-shelf-1111.test.tsx.
 *
 * Every intent is handed the clock it runs on (`NOW`): nothing here reads the real clock.
 */
describe("Stores S1: masters, stores and department shelves (spec #1111)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let inA: { id: string; actor: Actor };
  let inB: { id: string; actor: Actor };
  let genMain: string;
  let floor1: string;
  let floor2: string;
  let deptA: { id: string; code: string };
  let deptB: { id: string; code: string };
  let opdDept: { id: string; code: string; opdId: string };
  let cat: Map<string, string>;
  let shelfA: string;
  let shelfB: string;
  let mop: string;
  let paper: string;
  let dustbin: string;
  let gloves: string;

  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const DAY = "2026-11-10";
  const MOP_COST = 250;
  const GLOVE_COST = 40;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    const grants: Record<string, string[]> = {
      materials_head: ["stores.masters.manage", "stores.shelf.read", "materials.items.read", "materials.stock.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    inA = await mkUser(db, "incharge.a", []);
    inB = await mkUser(db, "incharge.b", []);

    deptA = await anOrgDept("HSK", "Housekeeping", null);
    deptB = await anOrgDept("LAU", "Laundry", null);
    const opdId = newId();
    await db.insert(opdDepartments).values({ id: opdId, code: "ENT", name: "ENT", createdBy: "t", updatedBy: "t" });
    opdDept = { ...(await anOrgDept("ENT", "ENT", opdId)), opdId };
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: inB.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptB.id });

    floor1 = await aFloor("F1", "First floor");
    floor2 = await aFloor("F2", "Second floor");

    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));

    mop = (await registerStoresItem(db, head.actor, { code: "HK-MOP-0001", name: "Wet mop refill", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    gloves = (await registerStoresItem(db, head.actor, { code: "HK-GLV-0002", name: "Household gloves", class: "consumable", baseUom: "pair", categoryId: cat.get("HSK")!, trackMode: "shelf", issuePack: { uom: "pack5", multiplier: 5 } })).itemId;
    paper = (await registerStoresItem(db, head.actor, { code: "ST-A4-0003", name: "A4 paper ream", class: "stationery", baseUom: "ream", categoryId: cat.get("STN")!, trackMode: "expensed" })).itemId;
    dustbin = (await registerStoresItem(db, head.actor, { code: "HK-BIN-0042", name: "Dustbin 20 L", class: "asset", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "durable", searchAliases: ["kachra dabba", "dabba"] })).itemId;
    await openStore(db, head.actor, "GEN-MAIN", [
      { itemId: mop, qty: 500, unitCostPaise: MOP_COST }, { itemId: gloves, qty: 500, unitCostPaise: GLOVE_COST },
      { itemId: paper, qty: 200, unitCostPaise: 30_000 }, { itemId: dustbin, qty: 50, unitCostPaise: 45_000 },
    ], NOW);

    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "HSK-F1", name: "Housekeeping F1", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
    ({ shelfId: shelfB } = await createShelf(db, head.actor, { code: "LAU-F1", name: "Laundry F1", floorId: floor1, departmentId: deptB.id, suppliedBy: genMain }));
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string, opdDepartmentId: string | null): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: opdDepartmentId === null ? "support" : "clinical", opdDepartmentId, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  async function aFloor(code: string, name: string): Promise<string> {
    return (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code, name }))).resourceId;
  }
  /** The central store pushes `qty` to a shelf (existing `issueStock`); the shelf's in-charge receives it through Stores. */
  async function issueTo(shelfId: string, itemId: string, qty: number): Promise<string> {
    const { transferId } = await withTx(db, (tx) => issueStock(tx, keeper.actor, {
      fromResourceId: genMain, toResourceId: shelfId, lines: [{ itemId, qtyBase: qty }], occurredAt: NOW,
    }));
    return transferId;
  }
  async function stock(shelfId: string, itemId: string, qty: number, who: Actor): Promise<string> {
    const transferId = await issueTo(shelfId, itemId, qty);
    await receiveAtShelf(db, who, transferId, NOW);
    return transferId;
  }
  const onHand = async (store: string, itemId: string): Promise<number> =>
    (await balances(db, { resourceId: store, itemId })).reduce((s, b) => s + b.qtyOnHand, 0);
  const ledgerAt = (store: string) => db.select().from(stockLedger).where(eq(stockLedger.resourceId, store)).orderBy(stockLedger.seq);
  const actEvents = async (act?: string) => (await db.select().from(events).where(eq(events.name, STORES_ACT_EVENT)).orderBy(events.seq))
    .filter((e) => act === undefined || (e.payload as { act: string }).act === act);
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }

  /* ─────────────────────────────── D1–D20 ─────────────────────────────── */

  it("spec #1111 D1: registerStoresItem takes each Stores class with a category and a tracking mode, and refuses drug and no category", async () => {
    const classes = ["consumable", "consumable_dated", "stationery", "asset", "service"];
    for (const [i, c] of classes.entries()) {
      const { itemId } = await registerStoresItem(db, head.actor, { code: `D1-${String(i)}`, name: `D1 item ${c}`, class: c, baseUom: "piece", categoryId: cat.get("GEN")!, trackMode: "shelf" });
      const [view] = (await listStoresItems(db)).filter((x) => x.id === itemId);
      expect(view).toMatchObject({ class: c, categoryId: cat.get("GEN"), trackMode: "shelf" });
    }
    expect(await refusal(registerStoresItem(db, head.actor, { code: "D1-DRUG", name: "A drug", class: "drug", baseUom: "tablet", categoryId: cat.get("GEN")!, trackMode: "shelf" }))).toBe("not_stores_class");
    expect(await refusal(registerStoresItem(db, head.actor, { code: "D1-NOCAT", name: "No category", class: "consumable", baseUom: "piece", categoryId: null, trackMode: "shelf" }))).toBe("category_required");
  });

  it("spec #1111 D2: Stores lists only its own stores and never a drug item", async () => {
    const { resourceId: pharmacy } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" }));
    const drugItem = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, head.actor, { name: "Paracetamol" });
      const med = await addMedicine(tx, head.actor, { brandName: "Crocin 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "OTC", salts: [{ saltId: salt.saltId, strength: "500 mg" }] });
      return (await registerItem(tx, head.actor, { code: "CROCIN", name: "Crocin 500", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: med.medicineId })).itemId;
    });
    const plain = (await withTx(db, (tx) => registerItem(tx, head.actor, { code: "GAUZE", name: "Gauze", class: "consumable", baseUom: "piece", batchTracked: false }))).itemId;
    const listed = (await listStoresItems(db)).map((i) => i.id);
    expect(listed).toEqual(expect.arrayContaining([mop, gloves, paper, dustbin]));
    expect(listed).not.toContain(drugItem);
    expect(listed).not.toContain(plain);
    expect((await searchStoresItems(db, "crocin")).map((i) => i.id)).not.toContain(drugItem);
    const shelves = (await listShelves(db)).map((s) => s.id);
    expect(shelves.sort()).toEqual([shelfA, shelfB].sort());
    expect(shelves).not.toContain(pharmacy);
  });

  it("spec #1111 D3: a new-item request reaches the head's queue once, the requester gets exactly one notice, and a line with no item id is refused", async () => {
    const { requestId } = await requestNewItem(db, inA.actor, { name: "Toilet brush long handle", shelfId: shelfA });
    const notices = () => db.select().from(alerts).where(eq(alerts.userId, inA.id));
    expect(await notices()).toHaveLength(0);
    await resolveNewItemRequest(db, head.actor, requestId, { outcome: "use_existing", itemId: mop }, NOW);
    expect(await notices()).toHaveLength(1);
    expect(await refusal(resolveNewItemRequest(db, head.actor, requestId, { outcome: "created", itemId: mop }, NOW))).toBe("request_closed");
    expect(await notices()).toHaveLength(1);
    const { requestId: second } = await requestNewItem(db, inA.actor, { name: "Floor squeegee", shelfId: shelfA });
    await resolveNewItemRequest(db, head.actor, second, { outcome: "created", itemId: gloves }, NOW);
    expect(await notices()).toHaveLength(2);
    expect(await refusal(saveReorderDraft(db, inA.actor, shelfA, [{ itemId: null, qty: 3 }], NOW))).toBe("item_id_required");
  });

  it("spec #1111 D4: a shelf is a store under its floor with department, supplier and domain; two floors for one department; a non-Stores supplier is refused", async () => {
    const { shelfId } = await createShelf(db, head.actor, { code: "HSK-F2", name: "Housekeeping F2", floorId: floor2, departmentId: deptA.id, suppliedBy: genMain });
    const mine = (await listShelves(db, { departmentId: deptA.id })).map((s) => s.id).sort();
    expect(mine).toEqual([shelfA, shelfId].sort());
    const [row] = (await listShelves(db)).filter((s) => s.id === shelfId);
    expect(row).toMatchObject({ kind: "shelf", parentId: floor2, departmentId: deptA.id, suppliedBy: genMain });
    const [res] = await db.execute(sql`select kind, parent_id, attributes from resources where id = ${shelfId}`).then((r) => r.rows as { kind: string; parent_id: string; attributes: Record<string, unknown> }[]);
    expect(res).toMatchObject({ kind: "store", parent_id: floor2, attributes: expect.objectContaining({ domain: "stores", kind: "shelf", departmentId: deptA.id, suppliedBy: genMain }) });
    const { resourceId: pharmacy } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" }));
    expect(await refusal(createShelf(db, head.actor, { code: "HSK-F3", name: "x", floorId: floor2, departmentId: deptA.id, suppliedBy: pharmacy }))).toBe("supplier_not_stores");
  });

  it("spec #1111 D5: a receipt into a department shelf carries the department's cost centre, and the day's charge is Σ quantity × batch cost", async () => {
    const t1 = await stock(shelfA, mop, 12, inA.actor);
    const t2 = await stock(shelfA, gloves, 20, inA.actor);
    const rows = await db.select().from(stockLedger).where(and(eq(stockLedger.reason, "receive"), sql`${stockLedger.refId} in (${t1}, ${t2})`));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r.costCenter).toBe(deptA.code);
    expect(await departmentChargeOn(db, deptA.code, DAY)).toMatchObject({ chargePaise: 12 * MOP_COST + 20 * GLOVE_COST });
    expect((await departmentChargeOn(db, deptB.code, DAY)).chargePaise).toBe(0);
  });

  it("spec #1111 D6: an expensed item received at a shelf leaves the balance at 0 with one consume row on the same cost centre", async () => {
    const t = await stock(shelfA, paper, 4, inA.actor);
    expect(await onHand(shelfA, paper)).toBe(0);
    const consumed = (await ledgerAt(shelfA)).filter((r) => r.reason === "consume" && r.itemId === paper);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ qtyDelta: -4, costCenter: deptA.code, refId: t });
  });

  it("spec #1111 D7: Used posts one consume row with the cost centre; above on hand and durable items are refused", async () => {
    await stock(shelfA, mop, 10, inA.actor);
    const { ledgerEntryIds } = await recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: mop, qty: 3 }, NOW);
    expect(ledgerEntryIds).toHaveLength(1);
    const [row] = await db.select().from(stockLedger).where(eq(stockLedger.id, ledgerEntryIds[0]!));
    expect(row).toMatchObject({ reason: "consume", qtyDelta: -3, costCenter: deptA.code, resourceId: shelfA });
    expect(await onHand(shelfA, mop)).toBe(7);
    expect(await refusal(recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: mop, qty: 8 }, NOW))).toBe("more_than_on_hand");
    await stock(shelfA, dustbin, 2, inA.actor);
    expect(await refusal(recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: dustbin, qty: 1 }, NOW))).toBe("durable_not_used");
  });

  it("spec #1111 D8: a check of 14 against book 20 posts one consume of 6; a count of 23 posts nothing and raises one More-than-book card", async () => {
    await stock(shelfA, mop, 20, inA.actor);
    const before = (await ledgerAt(shelfA)).length;
    const r = await recordShelfCheck(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, counted: 14 }] }, NOW);
    const after = await ledgerAt(shelfA);
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]).toMatchObject({ reason: "consume", qtyDelta: -6, refType: "shelf_check", refId: r.checkId, costCenter: deptA.code });
    const mid = after.length;
    const over = await recordShelfCheck(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, counted: 23 }] }, NOW);
    expect(await ledgerAt(shelfA)).toHaveLength(mid);
    expect(over.overBook).toEqual([{ itemId: mop, book: 14, counted: 23 }]);
    const cards = await overBookCards(db, head.actor);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ shelfId: shelfA, checkId: over.checkId, lines: [expect.objectContaining({ itemId: mop, book: 14, counted: 23 })] });
  });

  it("spec #1111 D9: openShelf posts opening balances with no cost centre, once", async () => {
    await openShelf(db, inA.actor, shelfA, [{ itemId: mop, qty: 6 }, { itemId: dustbin, qty: 3 }], NOW);
    expect(await onHand(shelfA, mop)).toBe(6);
    expect(await onHand(shelfA, dustbin)).toBe(3);
    const rows = await ledgerAt(shelfA);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.costCenter).toBeNull();
    expect((await departmentChargeOn(db, deptA.code, DAY)).chargePaise).toBe(0);
    expect(await refusal(openShelf(db, inA.actor, shelfA, [{ itemId: gloves, qty: 1 }], NOW))).toBe("already_opened");
  });

  it("spec #1111 D10: the department grant does not cross departments, and a materials-only storekeeper cannot receive into a shelf", async () => {
    await stock(shelfB, mop, 10, inB.actor);
    const tA = await issueTo(shelfB, mop, 2);
    expect(await refusal(receiveAtShelf(db, inA.actor, tA, NOW))).toBe("not_permitted");
    expect(await refusal(recordShelfUse(db, inA.actor, { shelfId: shelfB, itemId: mop, qty: 1 }, NOW))).toBe("not_permitted");
    expect(await refusal(recordShelfCheck(db, inA.actor, { shelfId: shelfB, lines: [{ itemId: mop, counted: 1 }] }, NOW))).toBe("not_permitted");
    expect(await refusal(shelfReorderDraft(db, inA.actor, shelfB))).toBe("not_permitted");
    expect(await refusal(saveReorderDraft(db, inA.actor, shelfB, [{ itemId: mop, qty: 1 }], NOW))).toBe("not_permitted");
    const helper = await mkUser(db, "another.keeper", ["storekeeper"]);
    expect(await refusal(receiveAtShelf(db, helper.actor, tA, NOW))).toBe("not_permitted");
    const t = (await getTransfer(db, tA))!;
    expect(await refusal(withTx(db, (tx) => receiveStock(tx, helper.actor, tA, t.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued })), NOW)))).toBe("shelf_receives_through_stores");
  });

  it("spec #1111 D11: the reorder draft proposes max − on hand rounded up to the issue pack, skips items above reorder, expensed and durable; no par on an expensed item", async () => {
    await stock(shelfA, mop, 8, inA.actor);
    await stock(shelfA, gloves, 8, inA.actor);
    await stock(shelfA, dustbin, 1, inA.actor);
    await setShelfPar(db, head.actor, { shelfId: shelfA, itemId: mop, minBase: 5, reorderBase: 10, maxBase: 30 }, NOW);
    await setShelfPar(db, head.actor, { shelfId: shelfA, itemId: gloves, minBase: 5, reorderBase: 10, maxBase: 30 }, NOW);
    await setShelfPar(db, head.actor, { shelfId: shelfA, itemId: dustbin, minBase: 2, reorderBase: 3, maxBase: 6 }, NOW);
    const draft = await shelfReorderDraft(db, inA.actor, shelfA);
    expect(draft.lines.find((l) => l.itemId === mop)).toMatchObject({ onHand: 8, proposed: 22 });
    expect(draft.lines.find((l) => l.itemId === gloves)).toMatchObject({ onHand: 8, proposed: 25 });
    expect(draft.lines.map((l) => l.itemId)).not.toContain(dustbin);
    expect(draft.lines.map((l) => l.itemId)).not.toContain(paper);
    await stock(shelfA, mop, 3, inA.actor);
    expect((await shelfReorderDraft(db, inA.actor, shelfA)).lines.map((l) => l.itemId)).not.toContain(mop);
    expect(await refusal(setShelfPar(db, head.actor, { shelfId: shelfA, itemId: paper, minBase: 1, reorderBase: 2, maxBase: 5 }, NOW))).toBe("par_on_expensed");
  });

  it("spec #1111 D12: the shelf view gives on hand, the status word, the last check and use per day; per OPD visit for an OPD department; null per bed-day", async () => {
    const { shelfId: entShelf } = await createShelf(db, head.actor, { code: "ENT-F2", name: "ENT OPD", floorId: floor2, departmentId: opdDept.id, suppliedBy: genMain });
    const inEnt = await mkUser(db, "incharge.ent", []);
    await assignRole(db, { userId: inEnt.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: opdDept.id });
    await stock(entShelf, mop, 40, inEnt.actor);
    await setShelfPar(db, head.actor, { shelfId: entShelf, itemId: mop, minBase: 5, reorderBase: 10, maxBase: 60 }, NOW);
    await recordShelfUse(db, inEnt.actor, { shelfId: entShelf, itemId: mop, qty: 30 }, new Date(NOW.getTime() - 3_600_000));
    await recordShelfCheck(db, inEnt.actor, { shelfId: entShelf, lines: [{ itemId: mop, counted: 10 }] }, NOW);
    for (let i = 0; i < 4; i++) {
      const patientId = newId();
      await db.insert(patients).values({ id: patientId, uhid: `HMS-1111000${String(i)}-1`, name: `P ${String(i)}`, sex: "male", administrativeGender: "male", dob: new Date(Date.UTC(1980, 0, 1)), createdBy: "t", updatedBy: "t" });
      await db.insert(opdEncounters).values({ id: newId(), visitNo: `V1111${String(i)}`, patientId, workflowInstanceId: newId(), departmentId: opdDept.opdId, serviceDate: "2026-11-05", visitType: "new", openedBy: "t", updatedBy: "t" });
    }
    const view = await shelfView(db, inEnt.actor, entShelf, NOW);
    const row = view.items.find((x) => x.itemId === mop)!;
    expect(row).toMatchObject({ onHand: 10, status: "low", lastCheckAt: NOW.toISOString(), usePerDay30: 1, usePerOpdVisit: 7.5, usePerBedDay: null });
    const viewA = await shelfView(db, inA.actor, shelfA, NOW);
    expect(viewA.items.every((x) => x.usePerOpdVisit === null && x.usePerBedDay === null)).toBe(true);
  });

  it("spec #1111 D13: a housekeeping floor shelf's month of use equals the sum of that month's consume rows there", async () => {
    await stock(shelfA, mop, 30, inA.actor);
    await stock(shelfA, gloves, 30, inA.actor);
    await recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: mop, qty: 4 }, NOW);
    await recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: mop, qty: 5 }, NOW);
    await recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: gloves, qty: 2 }, NOW);
    await recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: gloves, qty: 7 }, new Date("2026-10-20T06:00:00.000Z"));
    const month = await floorShelfUseByMonth(db, inA.actor, shelfA, "2026-11");
    const byItem = Object.fromEntries(month.map((m) => [m.itemId, m.used]));
    const sums = await db.execute(sql`select item_id, sum(-qty_delta)::int as used from stock_ledger where resource_id = ${shelfA} and reason = 'consume'
      and (occurred_at at time zone 'Asia/Kolkata') >= '2026-11-01' and (occurred_at at time zone 'Asia/Kolkata') < '2026-12-01' group by item_id`);
    expect(byItem).toEqual(Object.fromEntries((sums.rows as { item_id: string; used: number }[]).map((r) => [r.item_id, r.used])));
    expect(byItem).toEqual({ [mop]: 9, [gloves]: 2 });
  });

  it("spec #1111 D14: a pharmacy indent and a pharmacy transfer behave as before S1", async () => {
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
    await db.execute(sql`insert into stock_batches (id, item_id, batch_no, landed_cost_paise, ownership, created_by) values (${batchId}, ${gauze}, 'G1', 100, 'owned', 't')`);
    await withTx(db, (tx) => postMovements(tx, keeper.actor, [{ resourceId: main, batchId, qtyDelta: 50, reason: "grn", occurredAt: NOW }]));
    const indent = await raiseIndent(db, pharmacist.actor, { fromResourceId: pharm, toResourceId: main, lines: [{ itemId: gauze, qtyBase: 10 }] }, NOW);
    expect(indent.status).toBe("requested");
    const issued = await issueIndent(db, keeper.actor, indent.id, {}, NOW);
    expect(issued.status).toBe("issued");
    const t = (await getTransfer(db, issued.transfer!.id))!;
    const lines = t.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued }));
    expect(await refusal(withTx(db, (tx) => receiveStock(tx, keeper.actor, t.id, lines, NOW)))).toBe("transfer_self_receipt");
    const got = await withTx(db, (tx) => receiveStock(tx, pharmacist.actor, t.id, lines, NOW));
    expect(got.status).toBe("received");
    const rows = await db.select().from(stockLedger).where(eq(stockLedger.refId, t.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.costCenter).toBeNull();
  });

  it("spec #1111 D15: an implant or a patient-billable item is refused; reagent, gas and linen under their categories are accepted", async () => {
    expect(await refusal(registerStoresItem(db, head.actor, { code: "D15-IMP", name: "Bone screw", class: "implant", baseUom: "piece", categoryId: cat.get("BME")!, trackMode: "shelf" }))).toBe("patient_billable_refused");
    expect(await refusal(registerStoresItem(db, head.actor, { code: "D15-PB", name: "Billed dressing", class: "consumable", baseUom: "piece", categoryId: cat.get("PCC")!, trackMode: "shelf", patientBillable: true }))).toBe("patient_billable_refused");
    for (const [code, klass, category] of [["D15-RG", "reagent", "GAS"], ["D15-O2", "gas", "GAS"], ["D15-LN", "linen", "LIN"]] as const) {
      const { itemId } = await registerStoresItem(db, head.actor, { code, name: `${klass} item`, class: klass, baseUom: "piece", categoryId: cat.get(category)!, trackMode: "shelf" });
      expect((await listStoresItems(db)).find((i) => i.id === itemId)).toMatchObject({ class: klass, categoryId: cat.get(category) });
    }
  });

  it("spec #1111 D16: every state-changing intent appends one event with actor, time, store, item, before/after and reason; the ledger refuses UPDATE and DELETE; a use is reversed once", async () => {
    const shape = { actorId: expect.any(String), occurredAt: expect.any(Date) };
    const one = async (act: string, run: () => Promise<unknown>, expectPayload: Record<string, unknown>): Promise<void> => {
      const before = (await actEvents(act)).length;
      await run();
      const after = await actEvents(act);
      expect(after).toHaveLength(before + 1);
      const e = after[after.length - 1]!;
      expect(e).toMatchObject(shape);
      expect(e.payload).toMatchObject({ act, ...expectPayload });
      expect(e.payload).toHaveProperty("storeId");
      expect(e.payload).toHaveProperty("itemId");
      expect(e.payload).toHaveProperty("before");
      expect(e.payload).toHaveProperty("after");
      expect(e.payload).toHaveProperty("reason");
    };
    await one("register_item", () => registerStoresItem(db, head.actor, { code: "D16-1", name: "Broom", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" }), {});
    let shelf2 = "";
    await one("create_shelf", async () => { shelf2 = (await createShelf(db, head.actor, { code: "HSK-F2", name: "HSK F2", floorId: floor2, departmentId: deptA.id, suppliedBy: genMain })).shelfId; }, {});
    await one("open", () => openShelf(db, inA.actor, shelf2, [{ itemId: mop, qty: 2 }], NOW), { storeId: shelf2 });
    await one("receive", () => stock(shelfA, mop, 10, inA.actor), { storeId: shelfA, itemId: mop, before: 0, after: 10 });
    let used: string[] = [];
    await one("use", async () => { used = (await recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: mop, qty: 2 }, NOW)).ledgerEntryIds; }, { storeId: shelfA, itemId: mop, before: 10, after: 8 });
    await one("check", () => recordShelfCheck(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, counted: 7 }] }, NOW), { storeId: shelfA });
    await one("import", () => importStoresItems(db, head.actor, [{ code: "D16-IMP", name: "Phenyl 5 L", class: "consumable", baseUom: "can", category: "HSK", trackMode: "shelf" }], { dryRun: false }), {});
    await one("new_item_request", () => requestNewItem(db, inA.actor, { name: "Spray bottle", shelfId: shelfA }), { storeId: shelfA });
    await one("par", () => setShelfPar(db, head.actor, { shelfId: shelfA, itemId: mop, minBase: 2, reorderBase: 4, maxBase: 9 }, NOW), { storeId: shelfA, itemId: mop, after: { minBase: 2, reorderBase: 4, maxBase: 9 } });
    await one("category", () => updateStoresItem(db, head.actor, mop, { categoryId: cat.get("GEN")! }, "re-filed"), { itemId: mop, before: cat.get("HSK"), after: cat.get("GEN"), reason: "re-filed" });
    await one("track_mode", () => updateStoresItem(db, head.actor, mop, { trackMode: "durable" }, "kept"), { itemId: mop, before: "shelf", after: "durable" });
    await one("reverse", () => reverseShelfUse(db, inA.actor, used[0]!, "wrong item tapped", NOW), { storeId: shelfA, reason: "wrong item tapped" });

    const [last] = await db.select().from(stockLedger).orderBy(sql`${stockLedger.seq} desc`).limit(1);
    expect(last).toMatchObject({ reason: "adjust", refType: "reversal", refId: used[0], qtyDelta: 2 });
    expect(await refusal(reverseShelfUse(db, inA.actor, used[0]!, "again", NOW))).toBe("already_reversed");
    await expect(db.execute(sql`update stock_ledger set qty_delta = 99 where id = ${used[0]!}`)).rejects.toThrow(/append-only|stock_ledger_append_only/);
    await expect(db.execute(sql`delete from stock_ledger where id = ${used[0]!}`)).rejects.toThrow(/append-only|stock_ledger_append_only/);
  });

  it("spec #1111 D17: the materials receive route into a department shelf is refused for every caller; into PHARM-OPD it behaves as before", async () => {
    const tA = await issueTo(shelfA, mop, 2);
    const t = (await getTransfer(db, tA))!;
    const lines = t.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued }));
    for (const who of [inA.actor, head.actor, keeper.actor]) {
      expect(await refusal(withTx(db, (tx) => receiveStock(tx, who, tA, lines, NOW)))).toBe("shelf_receives_through_stores");
    }
    const { resourceId: pharm } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" }));
    const { transferId } = await withTx(db, (tx) => issueStock(tx, keeper.actor, { fromResourceId: genMain, toResourceId: pharm, lines: [{ itemId: mop, qtyBase: 3 }], occurredAt: NOW }));
    const pt = (await getTransfer(db, transferId))!;
    const got = await withTx(db, (tx) => receiveStock(tx, head.actor, transferId, pt.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued })), NOW));
    expect(got.status).toBe("received");
    expect(await onHand(pharm, mop)).toBe(3);
  });

  it("spec #1111 D18: the dustbin is found by its Hinglish alias and by the last four digits of its code", async () => {
    expect((await searchStoresItems(db, "kachra dabba")).map((i) => i.id)).toContain(dustbin);
    expect((await searchStoresItems(db, "0042")).map((i) => i.id)).toEqual([dustbin]);
  });

  it("spec #1111 D19: import runs the duplicate check per row, creates nothing on a dry run, names each refusal's row; GEN-MAIN opens once", async () => {
    const rows = [
      { code: "IMP-1", name: "Floor wiper 18 inch", class: "consumable", baseUom: "piece", category: "HSK", trackMode: "shelf" },
      { code: "IMP-2", name: "Wet mop refil", class: "consumable", baseUom: "piece", category: "HSK", trackMode: "shelf" },
      { code: "IMP-3", name: "Tablet", class: "drug", baseUom: "tablet", category: "GEN", trackMode: "shelf" },
      { code: "IMP-4", name: "Register 200 pages", class: "stationery", baseUom: "piece", category: "NOPE", trackMode: "expensed" },
    ];
    const countItems = async () => (await listStoresItems(db)).length;
    const n0 = await countItems();
    const dry = await importStoresItems(db, head.actor, rows, { dryRun: true });
    expect(await countItems()).toBe(n0);
    expect(dry).toMatchObject({ dryRun: true, created: 0, wouldCreate: 1 });
    expect(dry.refusals.map((r) => [r.row, r.code])).toEqual([[2, "duplicate_item"], [3, "not_stores_class"], [4, "unknown_category"]]);
    const real = await importStoresItems(db, head.actor, rows, { dryRun: false });
    expect(real.created).toBe(1);
    expect(await countItems()).toBe(n0 + 1);
    expect(await refusal(openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 1, unitCostPaise: 1 }], NOW))).toBe("already_opened");
    expect(await onHand(genMain, mop)).toBe(500);
  });
});
