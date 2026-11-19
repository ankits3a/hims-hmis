import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { orgDepartments } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { createResource } from "../../kernel/resources/registry";
import {
  MaterialsError, activateVendor, addVendorDocument, captureGrn, createStore, postGrn, postOpeningBalances, raiseWriteOff, registerMaterialsApprovalTypes,
  registerVendor, runGateQc,
} from "../materials";
import { storesManifest } from "./manifest";
import {
  StoresError, addRegulatorPaper, approveTicket, assetLedgerCheck, assetPassport, assetRemovals, claimPicking, closeVerification, createShelf, deliverTicket,
  disposeUnit, getCondemnation, issueTicket, listCategories, markFound, objectCondemnation, proposeCondemnation, proposeUnitTransfer, raiseGatePass,
  raiseTicket, registerStoresItem, retag, runStoresChaser, scanGatePass, scanVerification, seedStoresMasters, setItemRegulation, signCondemnation, startVerification,
  storesAuditPack, tagUnits, withdrawUnit, writeOffLoss, reportFault, openRepair, resolveShort, takeCustody, condemnationsToSign, returnToUse,
} from "./index";
import { storesCondemnDesk, storesFaultsDesk } from "./desk";
import type { Actor, WireAssetPassportFull } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * NOT ACCEPTANCE (a unit test beside it) — S4b's edges that close S4a's "not done" list, spec docs/specs/1114-stores-asset-passport.md (owner APPROVED 2026-11-19, decision
 * 0101): Stores S4b, the end of a unit's life. One test per done-means id the build notes give S4b: D11 (the
 * committee and the approvals), D12 (what a condemned, data-holding or regulated unit is refused), D13 (disposal by
 * scrap sale), D14 (loss after a round) and D17 (audit). D1–D10, D15, D16, D18–D20 are S4a's
 * (`stores-s4a-1114.test.ts` and the web acceptance file).
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S4b: the edges around condemnation (#1114)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let keeper: Who;
  let bme: Who;
  let guard: Who;
  let inA: Who;
  let hodA: Who;
  let ms: Who;
  let owner: Who;
  let deptA: { id: string; code: string };
  let genMain: string;
  let shelfA: string;
  let monitor: string;
  let laptop: string;
  let xray: string;
  let vendorId: string;
  let buyerId: string;
  let registry: ModuleRegistry;

  /** 12:00 IST on 2026-11-10 — inside GEN-MAIN's 09:00–17:00. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const DAY = 24 * 60;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const grants: Record<string, string[]> = {
      materials_head: [
        "stores.masters.manage", "stores.shelf.read", "stores.audit.read", "stores.assets.manage", "stores.assets.read", "stores.assets.condemn",
        "stores.tower.read", "stores.gatepass.raise", "materials.items.read", "materials.stock.read", "materials.writeoffs.manage",
      ],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "stores.gatepass.raise"],
      biomedical_engineer: ["stores.assets.manage", "stores.assets.read", "stores.assets.condemn"],
      accounts_officer: ["stores.assets.export", "stores.assets.condemn"],
      security_guard: ["stores.gatepass.scan"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve", "stores.assets.condemn"],
      medical_superintendent: ["approvals.requests.decide", "approvals.requests.read"],
      owner: ["approvals.requests.decide", "approvals.requests.read"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    bme = await mkUser(db, "bme.a", ["biomedical_engineer"]);
    guard = await mkUser(db, "guard.a", ["security_guard"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);

    deptA = await anOrgDept("ICU", "ICU");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });

    const floor1 = await aFloor("F1", "First floor");
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    monitor = (await registerStoresItem(db, head.actor, {
      code: "ME-MON-0001", name: "Patient monitor", class: "asset", baseUom: "piece", categoryId: cat.get("MEQ")!, trackMode: "tagged", gstRateBps: 1200,
    })).itemId;
    xray = (await registerStoresItem(db, head.actor, {
      code: "ME-XRY-0001", name: "Mobile X-ray", class: "asset", baseUom: "piece", categoryId: cat.get("MEQ")!, trackMode: "tagged", gstRateBps: 1200,
    })).itemId;
    laptop = (await registerStoresItem(db, head.actor, {
      code: "IT-LAP-0001", name: "Laptop", class: "asset", baseUom: "piece", categoryId: cat.get("ITP")!, trackMode: "durable", gstRateBps: 1800,
    })).itemId;
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
    vendorId = await aVendor("V-MEDEQ", "Medequip Pvt Ltd");
    buyerId = await aVendor("V-SCRAP", "Hajipur Scrap Traders");
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
  async function aVendor(code: string, legalName: string): Promise<string> {
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, v, at(-200)));
    return v;
  }
  /** `qty` units of `itemId` received at GEN-MAIN at `unitCostPaise` each (before GST) and tagged. */
  async function units(itemId: string, qty: number, unitCostPaise: number): Promise<string[]> {
    const challanNo = `CH-${newId().slice(-6)}`;
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId, source: "challan", storeResourceId: genMain, challanNo, challanDate: "2026-11-09", invoiceNo: `INV-${challanNo}`, invoiceDate: "2026-11-08",
      lines: [{ itemId, uom: "piece", qtyInUom: qty, unitCostPaise }], now: at(-120),
    }));
    await withTx(db, (tx) => runGateQc(tx, keeper.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, keeper.actor, grnId, at(-110)));
    const [row] = (await db.execute(sql`select id from grn_lines where grn_id = ${grnId}`)).rows as { id: string }[];
    const r = await tagUnits(db, keeper.actor, { grnLineId: row!.id, units: Array.from({ length: qty }, (_, i) => ({ serial: `${itemId.slice(-4)}-${challanNo}-${String(i)}` })) }, at(-100));
    return r.units.map((u) => u.id);
  }
  /** A ticket to ICU naming `unitIds`, delivered. */
  async function toIcu(itemId: string, unitIds: string[], t0: number): Promise<void> {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId, qtyBase: unitIds.length }], priority: "routine", channel: "phone" }, at(t0));
    await approveTicket(db, hodA.actor, t.id, {}, at(t0 + 1));
    await claimPicking(db, keeper.actor, t.id, at(t0 + 2));
    await issueTicket(db, keeper.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: unitIds.length, unitIds }] }, at(t0 + 3));
    await deliverTicket(db, inA.actor, t.id, {}, at(t0 + 5));
  }
  /** A ticket to ICU raised, approved and claimed, issue still to come. */
  async function claimed(itemId: string, t0: number): Promise<string> {
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId, qtyBase: 1 }], priority: "routine", channel: "phone" }, at(t0));
    await approveTicket(db, hodA.actor, t.id, {}, at(t0 + 1));
    await claimPicking(db, keeper.actor, t.id, at(t0 + 2));
    return t.id;
  }
  /** The accounts seat has a holder (D11 proves the refusal without one). */
  async function accountsSeat(): Promise<Who> { return mkUser(db, "accounts.a", ["accounts_officer"]); }
  /** Every seat a unit's condemnation names signs, in the order given. */
  async function signAll(condemnationId: string, signers: Who[], t: number): Promise<void> {
    for (const [i, s] of signers.entries()) await signCondemnation(db, s.actor, condemnationId, at(t + i));
  }
  /** The approvals pending on a condemnation, each granted by the role that decides it. */
  async function grant(condemnationId: string, t: number): Promise<void> {
    const c = await getCondemnation(db, head.actor, condemnationId, at(t));
    if (c.approvals.ms?.status === "pending") await approveRequest(db, ms.actor, { approvalId: c.approvals.ms.approvalId, note: "Condemned" });
    if (c.approvals.owner?.status === "pending") await approveRequest(db, owner.actor, { approvalId: c.approvals.owner.approvalId, note: "Yes" });
  }

  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  const ledgerRows = (): Promise<number> => count(sql`select count(*)::int as n from stock_ledger`);
  const writeOffs = (): Promise<{ id: string; status: string; reason: string; disposal_agency: string | null; manifest_no: string | null; disposal_date: string | null }[]> =>
    db.execute(sql`select id, status, reason, disposal_agency, manifest_no, disposal_date::text from stock_write_offs order by requested_at`)
      .then((r) => r.rows as { id: string; status: string; reason: string; disposal_agency: string | null; manifest_no: string | null; disposal_date: string | null }[]);
  const acts = (): Promise<number> => count(sql`select count(*)::int as n from events where name = 'stores.act_recorded'`);
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }
  const passport = async (unitId: string, when: Date = at(60)): Promise<WireAssetPassportFull> =>
    (await assetPassport(db, head.actor, { unitId }, when)) as WireAssetPassportFull;

  it("S4a's lost short of a tagged unit is no longer refused: each unit still on its way becomes one loss proposal, and nothing posts", async () => {
    await accountsSeat();
    const ids = await units(monitor, 2, 3_000_000);
    const t = await raiseTicket(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: monitor, qtyBase: 2 }], priority: "routine", channel: "phone" }, at(0));
    await approveTicket(db, hodA.actor, t.id, {}, at(1));
    await claimPicking(db, keeper.actor, t.id, at(2));
    await issueTicket(db, keeper.actor, t.id, { lines: [{ lineIdx: 0, qtyBase: 2, unitIds: ids }] }, at(3));
    await deliverTicket(db, inA.actor, t.id, { lines: [{ lineIdx: 0, accepted: 1, short: 1, unitIds: [ids[0]!] }] }, at(10));
    const rows = await ledgerRows();
    const r = await resolveShort(db, head.actor, t.id, { lineIdx: 0, resolution: "lost", note: "not on the trolley" }, at(20));
    expect(r.approvalId).toBeNull();
    const props = (await db.execute(sql`select unit_id, kind, reason, department_id from stores_condemnations`)).rows;
    expect(props).toEqual([{ unit_id: ids[1], kind: "loss", reason: "lost", department_id: deptA.id }]);
    expect(await ledgerRows()).toBe(rows);
    expect(await refusal(resolveShort(db, head.actor, t.id, { lineIdx: 0, resolution: "lost" }, at(21)))).toBe("already_proposed");
    // The committee's HOD sees it on the waiting line (department-scoped seat).
    const waiting = await storesCondemnDesk.waiting!({ db, actor: hodA.actor, now: at(22) } as never);
    expect(waiting).toEqual([expect.objectContaining({ kind: "stores.condemnToSign", count: 1 })]);
    expect((await condemnationsToSign(db, hodA.actor, at(22))).map((c) => c.unit.id)).toEqual([ids[1]]);
  });

  it("Faults to see: a fault is biomedical's card until a repair opens; Withdrawn and back in use move no ledger row", async () => {
    const [m] = await units(monitor, 1, 3_000_000);
    await toIcu(monitor, [m!], 0);
    await reportFault(db, inA.actor, m!, { text: "SpO2 drops" }, at(10));
    const cards = await storesFaultsDesk.load({ db, actor: bme.actor, now: at(11) } as never);
    expect(cards[0]!.rows!.map((r) => r.id)).toEqual([m]);
    await openRepair(db, bme.actor, m!, {}, at(12));
    expect(await storesFaultsDesk.load({ db, actor: bme.actor, now: at(13) } as never)).toEqual([]);
    const rows = await ledgerRows();
    expect((await withdrawUnit(db, hodA.actor, m!, { reason: "alarm faulty" }, at(14)) as WireAssetPassportFull).status).toBe("under_repair");
    expect(((await returnToUse(db, inA.actor, m!, at(15))) as WireAssetPassportFull).can.withdraw).toBe(true);
    expect(await ledgerRows()).toBe(rows);
  });

  it("a passport refused to an outsider names who to ask (the department's in-charges)", async () => {
    const [m] = await units(monitor, 1, 3_000_000);
    await toIcu(monitor, [m!], 0);
    const outsider = await mkUser(db, "outsider", []);
    try {
      await assetPassport(db, outsider.actor, { unitId: m! }, at(10));
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(StoresError);
      expect((e as StoresError).detail).toMatchObject({ ask: [expect.any(String)] });
    }
  });
});
