import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { orgDepartments } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import {
  MaterialsError, activateVendor, addVendorDocument, captureGrn, createStore, postGrn, postOpeningBalances, raiseWriteOff, registerMaterialsApprovalTypes,
  registerVendor, runGateQc,
} from "../../materials";
import { storesManifest } from "../manifest";
import {
  StoresError, addRegulatorPaper, approveTicket, assetLedgerCheck, assetPassport, assetRemovals, claimPicking, closeVerification, createShelf, deliverTicket,
  disposeUnit, getCondemnation, issueTicket, listCategories, markFound, objectCondemnation, proposeCondemnation, proposeUnitTransfer, raiseGatePass,
  raiseTicket, registerStoresItem, retag, runStoresChaser, scanGatePass, scanVerification, seedStoresMasters, setItemRegulation, signCondemnation, startVerification,
  storesAuditPack, tagUnits, withdrawUnit, writeOffLoss,
} from "../index";
import type { Actor, WireAssetPassportFull } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1114, spec docs/specs/1114-stores-asset-passport.md (owner APPROVED 2026-11-19, decision
 * 0100): Stores S4b, the end of a unit's life. One test per done-means id the build notes give S4b: D11 (the
 * committee and the approvals), D12 (what a condemned, data-holding or regulated unit is refused), D13 (disposal by
 * scrap sale), D14 (loss after a round) and D17 (audit). D1–D10, D15, D16, D18–D20 are S4a's
 * (`stores-s4a-1114.test.ts` and the web acceptance file).
 *
 * Every intent is handed the clock it runs on: nothing here reads the real clock.
 */
describe("Stores S4b: condemnation, loss and disposal (spec #1114)", () => {
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

  /* ─────────────────────────────── D11–D14, D17 ─────────────────────────────── */

  it("spec #1114 D11: a condemnation with a seat unsigned, without the superintendent's grant, or (above ₹50,000 or cost unknown) without the owner stays pending and posts nothing; a second signature by one person is refused; no accounts holder refuses the proposal (committee_seat_empty); an objection sets Objected and the unit can still be issued", async () => {
    const [dear] = await units(monitor, 1, 6_000_000);
    const [cheap, spare] = await units(monitor, 2, 4_000_000);
    await toIcu(monitor, [dear!, cheap!], 0);

    // No accounts member yet: the proposal is refused, naming the seat, and nothing is written.
    expect(await refusal(proposeCondemnation(db, bme.actor, { unitId: dear!, reason: "beyond_repair" }, at(10)))).toBe("committee_seat_empty");
    expect(await count(sql`select count(*)::int as n from stores_condemnations`)).toBe(0);
    const accounts = await accountsSeat();

    // Above the line: HOD, accounts, materials head, biomedical, then the superintendent, then the owner.
    const c = await proposeCondemnation(db, bme.actor, { unitId: dear!, reason: "beyond_repair", note: "board burnt" }, at(11));
    expect(c).toMatchObject({ status: "pending", needsOwner: true, reason: "beyond_repair" });
    expect(c.seats.map((s) => s.seat).sort()).toEqual(["accounts", "biomedical", "hod", "materials"]);
    const ledger0 = await ledgerRows();
    await signAll(c.id, [hodA, accounts, head], 12);
    expect(await refusal(signCondemnation(db, head.actor, c.id, at(15)))).toBe("already_signed");
    expect((await getCondemnation(db, head.actor, c.id, at(16))).status).toBe("pending");
    expect(await writeOffs()).toEqual([]);
    expect(await ledgerRows()).toBe(ledger0);

    await signCondemnation(db, bme.actor, c.id, at(17));
    const signed = await getCondemnation(db, head.actor, c.id, at(18));
    expect(signed.status).toBe("pending");
    expect(signed.approvals.ms?.status).toBe("pending");
    expect(signed.approvals.owner?.status).toBe("pending");
    // The write-off is raised (the approval that exists today) but nothing is destroyed.
    expect((await writeOffs()).map((w) => [w.status, w.reason])).toEqual([["requested", "condemned"]]);
    expect(await refusal(disposeUnit(db, head.actor, c.id, { method: "scrap_sale", buyerId, amountPaise: 300_000, invoiceNo: "SI-1", receiptRef: "R-1" }, at(19))))
      .toBe("not_approved");

    // The superintendent alone is not enough above the line.
    await approveRequest(db, ms.actor, { approvalId: signed.approvals.ms!.approvalId, note: "ok" });
    expect((await getCondemnation(db, head.actor, c.id, at(20))).status).toBe("pending");
    expect(await refusal(disposeUnit(db, head.actor, c.id, { method: "scrap_sale", buyerId, amountPaise: 300_000, invoiceNo: "SI-1", receiptRef: "R-1" }, at(21))))
      .toBe("not_approved");
    expect((await writeOffs()).map((w) => w.status)).toEqual(["requested"]);
    await approveRequest(db, owner.actor, { approvalId: signed.approvals.owner!.approvalId, note: "ok" });
    expect((await getCondemnation(db, head.actor, c.id, at(22))).status).toBe("approved");
    expect((await passport(dear!, at(23))).status).toBe("condemned");

    // Below the line the owner is not asked; an objection stops it and the unit is still issued.
    const low = await proposeCondemnation(db, hodA.actor, { unitId: cheap!, reason: "obsolete" }, at(30));
    expect(low.needsOwner).toBe(false);
    expect(low.seats.map((s) => s.seat).sort()).toEqual(["accounts", "biomedical", "hod", "materials"]);
    const away = await proposeCondemnation(db, bme.actor, { unitId: spare!, reason: "obsolete" }, at(31));
    expect(away.seats.map((s) => s.seat).sort()).toEqual(["accounts", "biomedical", "materials"]);
    await signCondemnation(db, accounts.actor, away.id, at(32));
    const objected = await objectCondemnation(db, head.actor, away.id, { reason: "still works on the ward" }, at(33));
    expect(objected.status).toBe("objected");
    expect((await passport(spare!, at(34))).status).toBe("in_store");
    const t = await claimed(monitor, 40);
    await issueTicket(db, keeper.actor, t, { lines: [{ lineIdx: 0, qtyBase: 1, unitIds: [spare!] }] }, at(43));
    expect((await passport(spare!, at(44))).status).toBe("on_its_way");
  });

  it("spec #1114 D12: a condemned unit is refused for issue, transfer, tag and returnable pass; an IT unit holding data is refused disposal without a wipe certificate; a regulated unit is refused disposal and a returnable pass without the regulator's paper", async () => {
    const accounts = await accountsSeat();
    const [m1, m2] = await units(monitor, 2, 3_000_000);
    await toIcu(monitor, [m2!], 0);
    // m1 sits in GEN-MAIN (no user department, so no HOD seat); m2 is ICU's.
    const c1 = await proposeCondemnation(db, bme.actor, { unitId: m1!, reason: "obsolete" }, at(10));
    await signAll(c1.id, [accounts, head, bme], 11);
    await grant(c1.id, 15);
    const c2 = await proposeCondemnation(db, hodA.actor, { unitId: m2!, reason: "damaged" }, at(16));
    await signAll(c2.id, [hodA, accounts, head, bme], 17);
    await grant(c2.id, 22);
    expect((await passport(m1!, at(23))).status).toBe("condemned");
    expect((await passport(m2!, at(23))).status).toBe("condemned");

    const t = await claimed(monitor, 30);
    expect(await refusal(issueTicket(db, keeper.actor, t, { lines: [{ lineIdx: 0, qtyBase: 1, unitIds: [m1!] }] }, at(33)))).toBe("unit_ended");
    expect(await refusal(proposeUnitTransfer(db, inA.actor, m2!, { toShelfId: shelfA }, at(34)))).toBe("unit_ended");
    expect(await refusal(retag(db, bme.actor, m1!, { reason: "lost label" }, at(35)))).toBe("unit_ended");
    expect(await refusal(raiseGatePass(db, keeper.actor, {
      kind: "returnable", storeId: genMain, purpose: "repair", party: "Medequip service", dueBack: "2026-11-12", lines: [{ itemId: monitor, qty: 1, unitIds: [m1!] }],
    }, at(36)))).toBe("unit_ended");

    // An IT unit that held data: no disposal without the wipe certificate.
    const [lap] = await units(laptop, 1, 4_500_000);
    const cl = await proposeCondemnation(db, head.actor, { unitId: lap!, reason: "obsolete", holdsData: true }, at(40));
    expect(cl.seats.map((s) => s.seat).sort()).toEqual(["accounts", "materials"]);
    await signAll(cl.id, [accounts, head], 41);
    await grant(cl.id, 45);
    const rows0 = await ledgerRows();
    expect(await refusal(disposeUnit(db, head.actor, cl.id, { method: "e_waste", buyerId, amountPaise: 0, invoiceNo: "EW-1", certificateNo: "EWC-9" }, at(46))))
      .toBe("wipe_certificate_needed");
    expect(await ledgerRows()).toBe(rows0);
    await disposeUnit(db, head.actor, cl.id, { method: "e_waste", buyerId, amountPaise: 0, invoiceNo: "EW-1", certificateNo: "EWC-9", wipeCertificateNo: "WIPE-3" }, at(47));

    // A regulated unit: no returnable pass and no disposal without the regulator's paper.
    await setItemRegulation(db, bme.actor, xray, "radiation", at(50));
    const [x] = await units(xray, 1, 2_000_000);
    const pass = (): Promise<unknown> => raiseGatePass(db, keeper.actor, {
      kind: "returnable", storeId: genMain, purpose: "repair", party: "Medequip service", dueBack: "2026-11-12", lines: [{ itemId: xray, qty: 1, unitIds: [x!] }],
    }, at(51));
    expect(await refusal(pass())).toBe("regulator_paper_needed");
    const cx = await proposeCondemnation(db, bme.actor, { unitId: x!, reason: "beyond_repair" }, at(52));
    await signAll(cx.id, [accounts, head, bme], 53);
    await grant(cx.id, 57);
    expect(await refusal(disposeUnit(db, head.actor, cx.id, { method: "scrap_sale", buyerId, amountPaise: 100_000, invoiceNo: "SI-7", receiptRef: "R-7" }, at(58))))
      .toBe("regulator_paper_needed");
    await addRegulatorPaper(db, bme.actor, x!, { kind: "decommission", refNo: "AERB/DEC/77" }, at(59));
    await disposeUnit(db, head.actor, cx.id, { method: "scrap_sale", buyerId, amountPaise: 100_000, invoiceNo: "SI-7", receiptRef: "R-7" }, at(60));
    // And a second X-ray with its paper on file may go out for repair.
    const [x2] = await units(xray, 1, 2_000_000);
    await addRegulatorPaper(db, bme.actor, x2!, { kind: "transfer", refNo: "AERB/TR/12" }, at(61));
    await raiseGatePass(db, keeper.actor, {
      kind: "returnable", storeId: genMain, purpose: "repair", party: "Medequip service", dueBack: "2026-11-12", lines: [{ itemId: xray, qty: 1, unitIds: [x2!] }],
    }, at(62));
  });

  it("spec #1114 D13: disposal by scrap sale posts one write-off (condemned, buyer, invoice, date) and allows one non-returnable scrap_sale pass; after the exit scan the passport reads Disposed and assetRemovals lists it with reason and amount; condemned is refused on a pharmacy store and an expiry write-off there reads as before", async () => {
    const accounts = await accountsSeat();
    const [m] = await units(monitor, 1, 3_000_000);
    await toIcu(monitor, [m!], 0);
    const c = await proposeCondemnation(db, hodA.actor, { unitId: m!, reason: "beyond_repair" }, at(10));
    await signAll(c.id, [hodA, accounts, head, bme], 11);
    await grant(c.id, 16);
    const d = await disposeUnit(db, head.actor, c.id, { method: "scrap_sale", buyerId, amountPaise: 1_500_000, invoiceNo: "SI-42", receiptRef: "RCPT-9" }, at(20));
    const wo = await writeOffs();
    expect(wo).toHaveLength(1);
    expect(wo[0]).toMatchObject({ status: "posted", reason: "condemned", disposal_agency: "Hajipur Scrap Traders", manifest_no: "SI-42", disposal_date: "2026-11-10" });
    expect(d.passId).not.toBeNull();
    const passes = (await db.execute(sql`select id, pass_no, kind, ref_type from stores_gate_passes`)).rows as { id: string; pass_no: string; kind: string; ref_type: string }[];
    expect(passes.map((p) => [p.kind, p.ref_type])).toEqual([["non_returnable", "scrap_sale"]]);
    expect(await refusal(raiseGatePass(db, head.actor, { kind: "non_returnable", refType: "scrap_sale", refId: d.saleId }, at(21)))).toBe("already_on_pass");
    expect((await passport(m!, at(22))).status).toBe("condemned");
    await scanGatePass(db, guard.actor, { code: passes[0]!.pass_no, act: "exit", clientKey: "k-scrap" }, at(25));
    expect((await passport(m!, at(26))).status).toBe("disposed");
    expect((await assetLedgerCheck(db, at(27))).differences).toEqual([]);
    const removals = await assetRemovals(db, accounts.actor, "2026-11", at(30));
    expect(removals.rows).toEqual([expect.objectContaining({ unitId: m, reason: "beyond_repair", method: "scrap_sale", amountPaise: 1_500_000, invoiceNo: "SI-42", condemnationNo: c.condNo })]);
    expect(removals.csv.split("\n")[0]).toContain("Condemnation");

    // Pharmacy never sees `condemned`: refused off a Stores store, and its expiry write-off is what it was.
    const pharmacy = (await withTx(db, (tx) => createStore(tx, head.actor, { code: "PH-MAIN", name: "Main pharmacy" }))).resourceId;
    const { batchIds } = await withTx(db, (tx) => postOpeningBalances(tx, head.actor, {
      resourceId: pharmacy, refId: newId(), occurredAt: at(-300), lines: [{ itemId: laptop, qtyBase: 4, unitCostPaise: 100, batchNo: "EXP-1", expiryDate: "2026-01-31" }],
    }));
    expect(await refusal(raiseWriteOff(db, head.actor, { storeResourceId: pharmacy, reason: "condemned" as never, lines: [{ batchId: batchIds[0]!, qtyBase: 1 }] }, at(40))))
      .toBe("writeoff_invalid");
    const expiry = await raiseWriteOff(db, head.actor, { storeResourceId: pharmacy, reason: "expiry", lines: [{ batchId: batchIds[0]!, qtyBase: 4 }] }, at(41));
    expect(Object.keys(expiry).sort()).toEqual([
      "approval", "approvalId", "approvalStatus", "disposalAgency", "disposalDate", "id", "lineCount", "lines", "manifestNo", "names", "note", "postedAt", "postedBy",
      "reason", "requestedAt", "requestedBy", "status", "storeCode", "storeName", "storeResourceId", "totalValuePaise", "writeOffNo",
    ]);
    expect(expiry).toMatchObject({ reason: "expiry", status: "requested", totalValuePaise: 400, lineCount: 1, storeCode: "PH-MAIN" });
  });

  it("spec #1114 D14: thirty days after a round each unseen unit has one loss_proposed card and no ledger row; after the seats and approvals one write-off posts, the passport reads Written off and no gate pass exists; markFound adds found and one opening row naming the write-off, which is unchanged", async () => {
    const accounts = await accountsSeat();
    const [seen, lost] = await units(monitor, 2, 3_000_000);
    await toIcu(monitor, [seen!, lost!], 0);
    const { roundId } = await startVerification(db, inA.actor, { departmentId: deptA.id }, at(20));
    await scanVerification(db, inA.actor, roundId, { unitId: seen!, shelfId: shelfA }, at(21));
    await closeVerification(db, inA.actor, roundId, at(30));

    const rows0 = await ledgerRows();
    await runStoresChaser(db, at(30 + 29 * DAY));
    expect(await count(sql`select count(*)::int as n from stores_asset_unit_events where kind = 'loss_proposed'`)).toBe(0);
    await runStoresChaser(db, at(30 + 31 * DAY));
    await runStoresChaser(db, at(30 + 31 * DAY + 1));
    const proposals = (await db.execute(sql`select unit_id from stores_asset_unit_events where kind = 'loss_proposed'`)).rows as { unit_id: string }[];
    expect(proposals.map((p) => p.unit_id)).toEqual([lost]);
    expect(await count(sql`select count(*)::int as n from stores_condemnations where kind = 'loss'`)).toBe(1);
    expect(await ledgerRows()).toBe(rows0);
    expect((await passport(lost!, at(30 + 31 * DAY + 2))).status).toBe("missing");

    const later = 30 + 32 * DAY;
    const [loss] = (await db.execute(sql`select id from stores_condemnations where kind = 'loss'`)).rows as { id: string }[];
    await signAll(loss!.id, [hodA, accounts, head, bme], later);
    await grant(loss!.id, later + 5);
    await writeOffLoss(db, head.actor, loss!.id, { inquiryNo: "INQ-2026-7" }, at(later + 10));
    const wo = await writeOffs();
    expect(wo).toHaveLength(1);
    expect(wo[0]).toMatchObject({ status: "posted", reason: "condemned", disposal_agency: "lost", manifest_no: "INQ-2026-7" });
    expect((await passport(lost!, at(later + 11))).status).toBe("written_off");
    expect(await count(sql`select count(*)::int as n from stores_gate_passes`)).toBe(0);

    const before = (await db.execute(sql`select * from stock_write_offs`)).rows;
    await markFound(db, head.actor, lost!, { storeId: shelfA }, at(later + 20));
    expect(await count(sql`select count(*)::int as n from stores_asset_unit_events where unit_id = ${lost!} and kind = 'found'`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from stock_ledger where ref_type = 'opening_balance' and ref_id = ${wo[0]!.id}`)).toBe(1);
    expect((await db.execute(sql`select * from stock_write_offs`)).rows).toEqual(before);
    expect((await passport(lost!, at(later + 21))).status).toBe("in_use");
    expect((await assetLedgerCheck(db, at(later + 22))).differences).toEqual([]);
  });

  it("spec #1114 D17: every S4 act appends one event; UPDATE and DELETE on units, unit events, tag decisions and condemnation signatures are refused by the database; storesAuditPack({unit}) lists the unit's life in seq order with actor and role", async () => {
    const accounts = await accountsSeat();
    const [m, w] = await units(monitor, 2, 3_000_000);
    await toIcu(monitor, [m!, w!], 0);
    const one = async <T>(p: () => Promise<T>): Promise<T> => {
      const before = await acts();
      const out = await p();
      expect(await acts()).toBe(before + 1);
      return out;
    };
    await one(() => withdrawUnit(db, inA.actor, w!, { reason: "alarm faulty" }, at(9)));
    expect((await passport(w!, at(9))).status).toBe("withdrawn");
    const c = await one(() => proposeCondemnation(db, hodA.actor, { unitId: m!, reason: "damaged" }, at(10)));
    await one(() => signCondemnation(db, hodA.actor, c.id, at(11)));
    await one(() => signCondemnation(db, accounts.actor, c.id, at(12)));
    await one(() => signCondemnation(db, head.actor, c.id, at(13)));
    await one(() => signCondemnation(db, bme.actor, c.id, at(14)));
    await grant(c.id, 15);
    await one(() => setItemRegulation(db, bme.actor, laptop, null, at(16)));
    await one(() => addRegulatorPaper(db, bme.actor, w!, { kind: "transfer", refNo: "N/A-1" }, at(17)));
    const o = await one(() => proposeCondemnation(db, bme.actor, { unitId: w!, reason: "obsolete" }, at(18)));
    await one(() => objectCondemnation(db, accounts.actor, o.id, { reason: "repairable" }, at(19)));
    await one(() => disposeUnit(db, head.actor, c.id, { method: "buy_back", buyerId, amountPaise: 200_000, invoiceNo: "BB-1", poRef: "PO-77" }, at(20)));
    await one(() => assetRemovals(db, accounts.actor, "2026-11", at(21)));

    for (const table of ["stores_asset_units", "stores_asset_unit_events", "stores_tag_decisions", "stores_condemnations", "stores_condemnation_signatures", "stores_scrap_sales"]) {
      await expect(db.execute(sql.raw(`update ${table} set ${table === "stores_tag_decisions" ? "result" : "id"} = ${table === "stores_tag_decisions" ? "result" : "id"}`)))
        .rejects.toThrow(/append_only|written once/);
      await expect(db.execute(sql.raw(`delete from ${table}`))).rejects.toThrow(/append_only|written once/);
    }

    const pack = await storesAuditPack(db, head.actor, { unitId: m!, from: at(-1000), to: at(1000) }, at(30));
    const what = pack.rows.map((r) => r.what);
    for (const a of ["tag_units", "issue_ticket", "propose_condemnation", "sign_condemnation", "dispose_unit"]) expect(what).toContain(a);
    expect(what.filter((x) => x === "sign_condemnation")).toHaveLength(4);
    expect(pack.rows.map((r) => r.seq)).toEqual([...pack.rows.map((r) => r.seq)].sort((a, b) => a - b));
    for (const r of pack.rows) expect(r.actor.roles.length).toBeGreaterThan(0);
    expect(pack.rows.find((r) => r.what === "dispose_unit")!.actor.roles).toContain("materials_head");
    expect(what).not.toContain("object_condemnation");
  });
});
