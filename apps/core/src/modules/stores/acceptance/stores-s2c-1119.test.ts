import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { events, supplierReturnLines, supplierReturns } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { MaterialsError, OUT_ON_PASS_STORE_CODE, balances, findStoreByCode, registerMaterialsApprovalTypes, registerVendor } from "../../materials";
import { storesManifest } from "../manifest";
import {
  StoresError, closeGatePass, gatePassLookup, listCategories, openStore, overdueGatePasses, raiseGatePass, registerStoresItem, scanGatePass,
  seedStoresMasters, storesAuditPack,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1119, spec docs/specs/1119-stores-gate-passes.md (owner APPROVED 2026-11-18, ruling 0099):
 * Stores S2c, gate passes and the guard's scan. One test per server done-means id, D1–D5 (D6 is the web half,
 * apps/web/src/screens/acceptance/stores-gate-1119.test.tsx).
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S2c: gate passes and the guard scan (spec #1119)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let keeper: Who;
  let keeperGuard: Who;
  let guard: Who;
  let genMain: string;
  let drill: string;
  let mop: string;

  /** 12:00 IST on 2026-11-10. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
  const DAY = 24 * 60;

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
      materials_head: ["stores.masters.manage", "stores.audit.read", "stores.gatepass.raise", "materials.items.read", "materials.stock.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "stores.gatepass.raise"],
      security_guard: ["stores.gatepass.scan"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    // A keeper who also stands at the gate: still refused as the scanner of a pass they raised.
    keeperGuard = await mkUser(db, "keeper.guard", ["storekeeper"]);
    await assignRole(db, { userId: keeperGuard.id, roleKey: "security_guard", scopeType: "hospital" });
    guard = await mkUser(db, "guard.a", ["security_guard"]);

    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    mop = (await registerStoresItem(db, head.actor, { code: "HK-MOP-0001", name: "Wet mop refill", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    drill = (await registerStoresItem(db, head.actor, { code: "EL-DRL-0001", name: "Electric drill", class: "asset", baseUom: "piece", categoryId: cat.get("ELE")!, trackMode: "durable" })).itemId;
    await openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 50, unitCostPaise: 250 }, { itemId: drill, qty: 3, unitCostPaise: 450_000 }], at(-60));
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function onHand(resourceId: string, itemId: string): Promise<number> {
    return (await balances(db, { resourceId, itemId })).reduce((s, b) => s + b.qtyOnHand, 0);
  }
  async function totalOf(itemId: string): Promise<number> {
    return (await balances(db, { itemId })).reduce((s, b) => s + b.qtyOnHand, 0);
  }
  async function outOnPass(): Promise<string> {
    return (await findStoreByCode(db, OUT_ON_PASS_STORE_CODE))!.id;
  }
  const ledgerRows = async (): Promise<number> => Number((await db.execute(sql`select count(*)::int as n from stock_ledger`)).rows[0]!.n);
  const actsOf = async (passId: string): Promise<string[]> =>
    (await db.select({ p: events.payload }).from(events).where(and(eq(events.name, "stores.act_recorded"), sql`${events.payload}->>'refId' = ${passId}`))
      .orderBy(events.seq)).map((e) => (e.p as { act: string }).act);
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }
  const returnable = (qty = 2, dueBack = "2026-11-12") => raiseGatePass(db, keeper.actor, {
    kind: "returnable", storeId: genMain, purpose: "repair", party: "Sharma Electricals", dueBack, lines: [{ itemId: drill, qty }],
  }, NOW);

  /** A supplier return of 5 mops from GEN-MAIN, at the status given (written as the materials office leaves it). */
  async function supplierReturn(status: "draft" | "dispatched"): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: `V-${status}`, legalName: `Vendor ${status} Pvt Ltd` }));
    const [batch] = await balances(db, { resourceId: genMain, itemId: mop });
    const id = newId();
    await db.insert(supplierReturns).values({
      id, returnNo: `MRT261110000${status === "draft" ? "1" : "2"}`, vendorId, status, source: "manual",
      ...(status === "dispatched" ? { approvedBy: head.id, approvedAt: at(-30), dispatchedBy: keeper.id, dispatchedAt: at(-20), debitNoteNo: "MDN2611100001", debitNoteDate: "2026-11-10" } : {}),
      createdBy: keeper.id, updatedBy: keeper.id,
    });
    await db.insert(supplierReturnLines).values({
      id: newId(), returnId: id, itemId: mop, batchId: batch!.batchId, storeResourceId: genMain, reason: "damaged", qtyBase: 5, ratePaise: 0, taxablePaise: 0, gstRateBps: 0,
    });
    return id;
  }

  /* ─────────────────────────────── D1–D5 ─────────────────────────────── */

  it("spec #1119 D1: a returnable pass moves stock to OUT-ON-PASS on the guard's exit scan and back to the source on the entry scan; the item's total across stores is equal before and after", async () => {
    const total = await totalOf(drill);
    const pass = await returnable();
    expect(pass).toMatchObject({ kind: "returnable", status: "raised" });
    expect(await onHand(genMain, drill)).toBe(3);

    // The guard types the last four digits; the lookup names the act.
    const found = await gatePassLookup(db, guard.actor, pass.passNo.slice(-4), at(5));
    expect(found).toMatchObject({ act: "exit", pass: { id: pass.id } });
    const out = await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit", clientKey: "k-out" }, at(6));
    expect(out.pass.status).toBe("out");
    const oop = await outOnPass();
    expect(await onHand(genMain, drill)).toBe(1);
    expect(await onHand(oop, drill)).toBe(2);
    expect(await totalOf(drill)).toBe(total);

    expect((await gatePassLookup(db, guard.actor, pass.passNo, at(60))).act).toBe("entry");
    const back = await scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry", clientKey: "k-in" }, at(61));
    expect(back.pass.status).toBe("back");
    expect(await onHand(genMain, drill)).toBe(3);
    expect(await onHand(oop, drill)).toBe(0);
    expect(await totalOf(drill)).toBe(total);
  });

  it("spec #1119 D2: an entry scan of 1 of 2 units leaves 1 in OUT-ON-PASS and the pass open; after its due-back date an open pass is listed in overdueGatePasses", async () => {
    const pass = await returnable(2, "2026-11-12");
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit" }, at(5));
    const part = await scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry", lines: [{ itemId: drill, qty: 1 }] }, at(DAY));
    expect(part.pass.status).toBe("out");
    expect(part.pass.lines[0]).toMatchObject({ itemId: drill, qty: 2, out: 1, back: 1 });
    expect(await onHand(await outOnPass(), drill)).toBe(1);
    // On the due-back day it is not yet overdue; the day after, it is.
    expect((await overdueGatePasses(db, at(2 * DAY))).map((p) => p.id)).toEqual([]);
    const overdue = await overdueGatePasses(db, at(3 * DAY));
    expect(overdue.map((p) => p.id)).toEqual([pass.id]);
    expect(overdue[0]!.status).toBe("overdue");
  });

  it("spec #1119 D3: a non-returnable pass with no supplier return or write-off reference is refused; with a dispatched supplier return it is accepted, and its exit scan posts no ledger row", async () => {
    expect(await refusal(raiseGatePass(db, keeper.actor, { kind: "non_returnable" }, NOW))).toBe("ref_required");
    const draft = await supplierReturn("draft");
    expect(await refusal(raiseGatePass(db, keeper.actor, { kind: "non_returnable", refType: "supplier_return", refId: draft }, NOW))).toBe("ref_required");

    const sent = await supplierReturn("dispatched");
    const pass = await raiseGatePass(db, keeper.actor, { kind: "non_returnable", refType: "supplier_return", refId: sent }, NOW);
    expect(pass).toMatchObject({ kind: "non_returnable", status: "raised", ref: { type: "supplier_return", id: sent }, dueBack: null });
    expect(pass.lines).toEqual([expect.objectContaining({ itemId: mop, qty: 5 })]);
    const rows = await ledgerRows();
    const r = await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit" }, at(5));
    expect(r.pass.status).toBe("closed");
    expect(await ledgerRows()).toBe(rows);
  });

  it("spec #1119 D4: an exit scan sent twice with one key records once; a second exit of a pass already out is refused; the raiser and anyone without stores.gatepass.scan are refused as scanner", async () => {
    const pass = await returnable();
    const scans = async (): Promise<number> =>
      Number((await db.execute(sql`select count(*)::int as n from stores_gate_pass_scans where pass_id = ${pass.id}`)).rows[0]!.n);

    expect(await refusal(scanGatePass(db, keeper.actor, { code: pass.passNo, act: "exit" }, at(2)))).toBe("not_permitted");
    expect(await refusal(gatePassLookup(db, keeper.actor, pass.passNo, at(2)))).toBe("not_permitted");
    const mine = await raiseGatePass(db, keeperGuard.actor, {
      kind: "returnable", storeId: genMain, purpose: "calibration", party: "Lab Cal Services", dueBack: "2026-11-20", lines: [{ itemId: drill, qty: 1 }],
    }, NOW);
    expect(await refusal(scanGatePass(db, keeperGuard.actor, { code: mine.passNo, act: "exit" }, at(2)))).toBe("own_pass");
    expect(await scans()).toBe(0);

    const first = await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit", clientKey: "same-key" }, at(3));
    const again = await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit", clientKey: "same-key" }, at(4));
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(await scans()).toBe(1);
    expect(await onHand(await outOnPass(), drill)).toBe(2);

    expect(await refusal(scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit", clientKey: "other-key" }, at(5)))).toBe("already_out");
    expect(await scans()).toBe(1);
  });

  it("spec #1119 D5: every pass act appends one domain event; UPDATE and DELETE on stores_gate_pass_scans are refused by the database; storesAuditPack({store: OUT-ON-PASS}) lists each pass's raise and scans in order", async () => {
    const pass = await returnable();
    expect(await actsOf(pass.id)).toEqual(["raise_gate_pass"]);
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit" }, at(5));
    expect(await actsOf(pass.id)).toEqual(["raise_gate_pass", "gate_pass_out"]);
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry", lines: [{ itemId: drill, qty: 1 }] }, at(30));
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry" }, at(40));
    expect(await actsOf(pass.id)).toEqual(["raise_gate_pass", "gate_pass_out", "gate_pass_in", "gate_pass_in"]);

    const unused = await returnable(1, "2026-11-15");
    await closeGatePass(db, keeper.actor, unused.id, "repair cancelled", at(50));
    expect(await actsOf(unused.id)).toEqual(["raise_gate_pass", "close_gate_pass"]);

    await expect(db.execute(sql`update stores_gate_pass_scans set reason = 'edited' where pass_id = ${pass.id}`)).rejects.toThrow(/append_only/);
    await expect(db.execute(sql`delete from stores_gate_pass_scans where pass_id = ${pass.id}`)).rejects.toThrow(/append_only/);

    const pack = await storesAuditPack(db, head.actor, { storeId: await outOnPass(), from: at(-60), to: at(60) }, at(61));
    const of = (id: string): string[] => pack.rows.filter((r) => r.ref === id).map((r) => r.what);
    expect(of(pass.id)).toEqual(["raise_gate_pass", "gate_pass_out", "gate_pass_in", "gate_pass_in"]);
    expect(of(unused.id)).toEqual(["raise_gate_pass", "close_gate_pass"]);
    const seqs = pack.rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const out = pack.rows.find((r) => r.ref === pass.id && r.what === "gate_pass_out")!;
    expect(out.actor.id).toBe(guard.id);
  });
});
