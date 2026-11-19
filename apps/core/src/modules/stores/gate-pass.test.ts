import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { alerts, events, stockWriteOffLines, stockWriteOffs, supplierReturnLines, supplierReturns } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { MaterialsError, OUT_ON_PASS_STORE_CODE, balances, findStoreByCode, registerMaterialsApprovalTypes, registerVendor } from "../materials";
import { storesManifest } from "./manifest";
import {
  StoresError, closeGatePass, gatePassForm, gatePassLookup, listCategories, listGatePasses, openStore, raiseGatePass, registerStoresItem,
  registerStoresPrinting, scanGatePass, seedStoresMasters,
} from "./index";
import { renderDocument } from "../../kernel/printing/render";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S2c (#1119) — the gate pass beyond the done-means checks: the overdue notice, the typed fallback's
 * ambiguity, what the guard is refused, a write-off behind a non-returnable pass, a late scan, close, and the print.
 */
describe("Stores S2c: gate pass details (#1119)", () => {
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

  /* ─────────────────────────────── details ─────────────────────────────── */

  it("tells the raiser once, 'Pass overdue', when a returnable pass is out past its due-back day", async () => {
    const pass = await returnable(2, "2026-11-12");
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit" }, at(5));
    await listGatePasses(db, keeper.actor, at(2 * DAY));
    const titles = async (): Promise<string[]> => (await db.select({ t: alerts.title }).from(alerts).where(eq(alerts.userId, keeper.id))).map((a) => a.t);
    expect(await titles()).toEqual([]);
    const list = await listGatePasses(db, keeper.actor, at(3 * DAY));
    expect(list[0]).toMatchObject({ id: pass.id, status: "overdue" });
    await listGatePasses(db, keeper.actor, at(4 * DAY));
    expect(await titles()).toEqual(["Pass overdue"]);
  });

  it("the typed last four digits find the live pass; a closed pass and an unknown number are not valid", async () => {
    const a = await returnable(1);
    const b = await returnable(1);
    expect((await gatePassLookup(db, guard.actor, a.passNo.slice(-4), at(1))).pass.id).toBe(a.id);
    await closeGatePass(db, keeper.actor, a.id, "not needed", at(2));
    expect(await refusal(gatePassLookup(db, guard.actor, a.passNo, at(3)))).toBe("pass_not_valid");
    expect(await refusal(gatePassLookup(db, guard.actor, "9999", at(3)))).toBe("pass_not_valid");
    expect((await gatePassLookup(db, guard.actor, b.passNo.slice(-4), at(3))).act).toBe("exit");
  });

  it("refuses an entry before the exit, more back than is out, a close once out, and a pass for more than the store holds", async () => {
    const pass = await returnable(2);
    expect(await refusal(scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry" }, at(1)))).toBe("not_out");
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit" }, at(2));
    expect(await refusal(scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry", lines: [{ itemId: drill, qty: 3 }] }, at(3)))).toBe("more_than_out");
    expect(await refusal(closeGatePass(db, keeper.actor, pass.id, "changed my mind", at(4)))).toBe("already_out");
    expect(await refusal(raiseGatePass(db, keeper.actor, { kind: "returnable", storeId: genMain, purpose: "loan", party: "Ward 4", dueBack: "2026-11-20", lines: [{ itemId: drill, qty: 2 }] }, at(5)))).toBe("more_than_on_hand");
    expect(await refusal(raiseGatePass(db, keeper.actor, { kind: "returnable", storeId: genMain, purpose: "loan", party: " ", dueBack: "2026-11-20", lines: [{ itemId: drill, qty: 1 }] }, at(5)))).toBe("party_required");
    expect(await refusal(raiseGatePass(db, keeper.actor, { kind: "returnable", storeId: genMain, purpose: "loan", party: "Ward 4", dueBack: "2026-11-09", lines: [{ itemId: drill, qty: 1 }] }, at(5)))).toBe("due_back_required");
    expect(await refusal(raiseGatePass(db, guard.actor, { kind: "returnable", storeId: genMain, purpose: "loan", party: "Ward 4", dueBack: "2026-11-20", lines: [{ itemId: drill, qty: 1 }] }, at(5)))).toBe("not_permitted");
  });

  it("a posted write-off carries a non-returnable pass to the disposal agency; one live pass per record; the form offers it until then", async () => {
    const [batch] = await balances(db, { resourceId: genMain, itemId: mop });
    const wo = newId();
    await db.insert(stockWriteOffs).values({
      id: wo, writeOffNo: "MWO2611100001", storeResourceId: genMain, reason: "damage", status: "posted", approvalId: newId(), disposalAgency: "Bio Waste Co",
      manifestNo: "BW-1", disposalDate: "2026-11-10", requestedBy: keeper.id, requestedAt: at(-50), postedBy: head.id, postedAt: at(-40),
    });
    await db.insert(stockWriteOffLines).values({ id: newId(), writeOffId: wo, itemId: mop, batchId: batch!.batchId, qtyBase: 4, valuePaise: 1000 });
    expect((await gatePassForm(db, keeper.actor)).sources.map((s) => s.no)).toEqual(["MWO2611100001"]);
    const pass = await raiseGatePass(db, keeper.actor, { kind: "non_returnable", refType: "write_off", refId: wo }, NOW);
    expect(pass).toMatchObject({ party: "Bio Waste Co", ref: { no: "MWO2611100001" }, lines: [expect.objectContaining({ itemId: mop, qty: 4 })] });
    expect((await gatePassForm(db, keeper.actor)).sources).toEqual([]);
    expect(await refusal(raiseGatePass(db, keeper.actor, { kind: "non_returnable", refType: "write_off", refId: wo }, NOW))).toBe("already_on_pass");
    expect(await refusal(scanGatePass(db, guard.actor, { code: pass.passNo, act: "entry" }, at(1)))).toBe("pass_not_valid");
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit" }, at(2));
    expect(await refusal(gatePassLookup(db, guard.actor, pass.passNo, at(3)))).toBe("already_out");
  });

  it("a scan older than 12 h is recorded at the phone's time and flagged late", async () => {
    const pass = await returnable(1);
    const r = await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit", scannedAt: at(10).toISOString() }, at(10 + 13 * 60));
    expect(r.flag).toBe("late");
    expect(r.pass.scans[0]).toMatchObject({ kind: "exit", at: at(10).toISOString(), recordedAt: at(10 + 13 * 60).toISOString(), flag: "late" });
  });

  it("prints the pass with its QR and its last four digits large, in English and Hindi", async () => {
    const off = registerStoresPrinting();
    try {
      const pass = await returnable(2);
      const doc = await renderDocument(db, "stores_gate_pass", { passId: pass.id }, at(1), null);
      expect(doc!.html).toContain(pass.passNo);
      expect(doc!.html).toContain(`<div class="last4">${pass.passNo.slice(-4)}</div>`);
      expect(doc!.html).toContain("Returnable / वापसी वाला");
      expect(doc!.html).toContain("Sharma Electricals");
      expect(doc!.html).toContain("<svg");
      expect(await db.execute(sql`select document from print_jobs`)).toMatchObject({ rows: [{ document: "stores_gate_pass" }] });
    } finally { off(); }
  });
});
