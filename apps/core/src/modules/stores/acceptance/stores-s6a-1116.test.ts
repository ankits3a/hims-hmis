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
  MaterialsError, acceptBillDifference, acceptSupplierBill, activateVendor, addVendorDocument, applyBankChange, billDraftFromGrn, captureGrn,
  createPaymentRun, createPurchaseOrder, createStore, createSupplierBill, decidePaymentRun, decidePurchaseOrder, draftPaymentRun, getPaymentRun,
  matchSupplierBill, payables, planPaymentRun, postGrn, recordVendorPayment, registerItem, registerMaterialsApprovalTypes, registerVendor,
  requestBankChange, runGateQc, submitPaymentRun, submitPurchaseOrder,
} from "../../materials";
import { storesManifest } from "../manifest";
import {
  StoresError, approveSupplierCategory, billDraftFromSes, confirmServiceEntry, createShelf, holdsDryRun, holdsForBill, keepHold, listCategories,
  payablesByGroup, payingSettings, recheckBillHolds, registerStoresItem, releaseHold, seedStoresMasters, setPayingSettings, storesAuditPack,
} from "../index";
import type { BillLineInput } from "../../materials";
import type { Actor, WirePayHold } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1116, spec docs/specs/1116-stores-paying-desk.md (owner APPROVED 2026-11-19, decision 0101):
 * Stores S6a, the paying desk's core. D1 (service entry sheets and the bill from one), D2 (a line names a GRN or an SES,
 * never both or neither; pharmacy as before with every switch off), D3 (each hold rule), D4 (pharmacy bills stay out of
 * the holds until the owner's switch, after a dry run), D5 (holds keep lines out of runs; who may release), D6 (UTR shape
 * and reuse), D7 (payables by item group and department, to the paisa) and D8 (audit). D9 and D10 are the web's
 * (apps/web/src/screens/acceptance/stores-paying-1116.test.tsx).
 *
 * Every intent is handed the clock it runs on.
 */
describe("Stores S6a: service entries, holds and release, UTR, payables by group, audit (spec #1116)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who; // the materials head who approves the POs
  let head2: Who; // a second materials head: approved no PO, booked no bill
  let acct: Who; // accounts officer: books bills, records payments
  let keeper: Who;
  let pharmacist: Who;
  let owner: Who;
  let inA: Who; // ICU's department store in-charge: confirms services
  let inB: Who; // another department's in-charge
  let deptA: { id: string; code: string };
  let deptB: { id: string; code: string };
  let genMain: string;
  let pharmStore: string;
  let gloves: string;
  let laundry: string;
  let amc: string;
  let crocin: string;
  let cats: Map<string, string>;

  /** 12:00 IST on 2026-11-10. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const DAY = 24 * 60;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
  const TODAY = "2026-11-10";
  const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

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
      materials_head: [
        "stores.masters.manage", "stores.holds.release", "stores.audit.read", "materials.items.read", "materials.stock.read", "materials.vendors.manage",
        "materials.po.raise", "materials.grn.capture", "materials.grn.qc", "materials.bills.manage", "materials.bills.accept_difference",
        "materials.payments.prepare", "approvals.requests.decide", "approvals.requests.read",
      ],
      accounts_officer: ["materials.bills.manage", "materials.payments.prepare", "materials.payments.record", "stores.audit.read"],
      storekeeper: ["materials.stock.read", "materials.grn.capture", "materials.grn.qc"],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc", "materials.bills.manage"],
      owner: ["stores.holds.release", "stores.audit.read", "approvals.requests.decide", "approvals.requests.read", "materials.payments.record"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work", "stores.ses.confirm"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    head2 = await mkUser(db, "stores.head2", ["materials_head"]);
    acct = await mkUser(db, "accounts.a", ["accounts_officer"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    pharmacist = await mkUser(db, "pharm.a", ["pharmacy"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    inA = await mkUser(db, "incharge.a", []);
    inB = await mkUser(db, "incharge.b", []);
    deptA = await anOrgDept("ICU", "ICU");
    deptB = await anOrgDept("OT", "Operation theatre");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: inB.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptB.id });

    const floor1 = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "First floor" }))).resourceId;
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cats = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain });
    const item = async (code: string, name: string, cat: string, klass: string, trackMode: "shelf" | "expensed", gst: number): Promise<string> =>
      (await registerStoresItem(db, head.actor, { code, name, class: klass, baseUom: "piece", categoryId: cats.get(cat)!, trackMode, gstRateBps: gst })).itemId;
    gloves = await item("HK-GLV-0001", "Household gloves", "HSK", "consumable", "shelf", 1200);
    laundry = await item("HK-LDY-0001", "Laundry per piece", "HSK", "service", "expensed", 1800);
    amc = await item("BM-AMC-0001", "Monitor AMC", "BME", "service", "expensed", 1800);
    ({ resourceId: pharmStore } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ itemId: crocin } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "CROC", name: "Crocin 500", class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    })));
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "clinical", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  /** A supplier: PAN, GSTIN, its papers, active, terms 7 days. `complete` adds the owner-approved bank past cooling-off and every category. */
  async function aVendor(code: string, complete = true, over: { msmeClass?: string | null } = {}): Promise<string> {
    const pan = `${code.replace(/[^A-Z]/g, "").padEnd(5, "X").slice(0, 5)}1234A`;
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName: `${code} Services`, pan, gstin: `10${pan}1Z5`, paymentTermsDays: 7, ...over }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, v, at(-400 * DAY)));
    if (!complete) return v;
    const { changeId, approvalId } = await withTx(db, (tx) => requestBankChange(tx, head.actor, v, { accountNo: "123456789012", ifsc: "SBIN0000001" }));
    await approveRequest(db, owner.actor, { approvalId, note: "Verified by call-back" });
    await withTx(db, (tx) => applyBankChange(tx, head.actor, changeId, new Date()));
    await db.execute(sql`update vendors set first_payment_allowed_at = ${at(-300 * DAY)} where id = ${v}`);
    for (const c of ["HSK", "MEQ"]) await approveSupplierCategory(db, head.actor, v, cats.get(c)!, at(-300 * DAY));
    return v;
  }
  /** An approved PO (approved by `head`) for `poQty` of `itemId` at `rate` per piece, to GEN-MAIN (or the pharmacy for crocin). */
  async function aPo(vendorId: string, itemId: string, poQty: number, rate: number): Promise<string> {
    const pharm = itemId === crocin;
    const raiser = pharm ? pharmacist : head2;
    const po = await createPurchaseOrder(db, raiser.actor, {
      vendorId, storeResourceId: pharm ? pharmStore : genMain, lines: [{ itemId, ...(pharm ? { uom: "strip" } : {}), qtyPacks: poQty, ratePaise: rate }],
    }, { now: at(-60 * DAY) });
    await submitPurchaseOrder(db, raiser.actor, po.id, at(-60 * DAY + 1));
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok", at(-60 * DAY + 2));
    return po.id;
  }
  /** A posted GRN of `qty` (pieces, or strips for crocin) against `poId`. */
  async function received(vendorId: string, itemId: string, qty: number, rate: number, poId: string | null, dayOffset = -20): Promise<string> {
    const pharm = itemId === crocin;
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId, source: "challan", storeResourceId: pharm ? pharmStore : genMain, purchaseOrderId: poId, challanNo: `CH-${newId().slice(-6)}`,
      challanDate: daysAgo(-dayOffset), invoiceNo: `INV-${newId().slice(-6)}`,
      lines: [{
        itemId, uom: pharm ? "strip" : "piece", qtyInUom: qty, unitCostPaise: pharm ? rate / 10 : rate,
        ...(pharm ? { batchNo: `B-${newId().slice(-4)}`, expiryDate: "2028-06-30" } : {}), priceReason: { code: "other", text: "test rate" },
      }],
      now: at(dayOffset * DAY),
    }));
    await withTx(db, (tx) => runGateQc(tx, keeper.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, keeper.actor, grnId, at(dayOffset * DAY + 1)));
    return grnId;
  }
  /** The accounts officer books the bill from the prefill (lines overridden as given); a held match is accepted by `head2`. */
  async function bookFromGrn(grnId: string, vendorBillNo: string, billDate: string, over: Partial<BillLineInput> = {}, by: Who = acct): Promise<string> {
    const d = await billDraftFromGrn(db, by.actor, grnId);
    const b = await createSupplierBill(db, by.actor, {
      vendorId: d.vendorId, vendorBillNo, billDate, interState: d.interState,
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps, ...over })),
    }, { now: at(0) });
    const m = await matchSupplierBill(db, by.actor, b.id, at(1));
    if (m.status === "held_for_match") return (await acceptBillDifference(db, head2.actor, b.id, "agreed with the supplier", at(2))).id;
    return (await acceptSupplierBill(db, by.actor, b.id, at(2))).id;
  }
  async function bookFromSes(sesId: string, vendorBillNo: string, billDate: string): Promise<string> {
    const d = await billDraftFromSes(db, acct.actor, sesId);
    const b = await createSupplierBill(db, acct.actor, {
      vendorId: d.vendorId, vendorBillNo, billDate, interState: d.interState,
      lines: d.lines.map((l) => ({ sesId: l.sesId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    }, { now: at(0) });
    expect((await matchSupplierBill(db, acct.actor, b.id, at(1))).status).toBe("matched");
    return (await acceptSupplierBill(db, acct.actor, b.id, at(2))).id;
  }
  const open = (hs: WirePayHold[]): string[] => hs.filter((h) => h.status === "open" || h.status === "kept").map((h) => h.kind).sort();
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  const actsNamed = (act: string): Promise<number> =>
    count(sql`select count(*)::int as n from events where name = 'stores.act_recorded' and payload->>'act' = ${act}`);
  const laundryMonth = { kind: "month" as const, key: "2026-10", start: "2026-10-01", end: "2026-10-31" };

  /* ─────────────────────────────── D1 ─────────────────────────────── */

  it("spec #1116 D1: a laundry month confirms one SES, a second is refused (ses_exists); the bill from it makes one payable, once; a term-started AMC is payable with no pay_after_grn hold", async () => {
    const vL = await aVendor("LAUNDRY");
    const po = await aPo(vL, laundry, 3_000, 500);
    await expect(confirmServiceEntry(db, inB.actor, { purchaseOrderId: po, departmentId: deptA.id, period: laundryMonth, source: "laundry_month" }, at(0)))
      .rejects.toMatchObject({ code: "not_permitted" });
    const ses = await confirmServiceEntry(db, inA.actor, {
      purchaseOrderId: po, departmentId: deptA.id, period: laundryMonth, source: "laundry_month", sourceRef: "linen-2026-10",
      lines: [{ itemId: laundry, qtyBase: 2_800, shortReason: "200 pieces not returned" }],
    }, at(0));
    expect([ses.status, ses.lines[0]!.qtyBase, ses.lines[0]!.shortBase]).toEqual(["short", 2_800, 200]);
    await expect(confirmServiceEntry(db, inA.actor, { purchaseOrderId: po, departmentId: deptA.id, period: laundryMonth, source: "laundry_month" }, at(1)))
      .rejects.toMatchObject({ code: "ses_exists" });
    expect(await count(sql`select count(*)::int as n from stores_service_entries`)).toBe(1);

    const billId = await bookFromSes(ses.id, "LDY/10", TODAY);
    const p = await payables(db, acct.actor, at(3));
    const mine = p.bills.filter((b) => b.id === billId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.outstandingPaise).toBe(2_800 * 500 + Math.round((2_800 * 500 * 1800) / 10_000));
    // Once: the SES is on a live bill, so a second bill from it is refused and writes nothing.
    await expect(billDraftFromSes(db, acct.actor, ses.id)).rejects.toMatchObject({ code: "ses_already_billed" });
    await expect(createSupplierBill(db, acct.actor, {
      vendorId: vL, vendorBillNo: "LDY/10-B", billDate: TODAY, lines: [{ sesId: ses.id, itemId: laundry, uom: "piece", qtyPacks: 2_800, ratePaise: 500, gstRateBps: 1800 }],
    }, { now: at(4) })).rejects.toBeInstanceOf(MaterialsError);
    expect(await count(sql`select count(*)::int as n from supplier_bills`)).toBe(1);

    const vA = await aVendor("AMCCO");
    const amcPo = await aPo(vA, amc, 1, 4_000_000);
    const term = await confirmServiceEntry(db, inA.actor, {
      purchaseOrderId: amcPo, departmentId: deptA.id, period: { kind: "term_start", key: "2026-27", start: "2026-11-01", end: "2027-10-31" }, source: "term_start",
    }, at(5));
    const amcBill = await bookFromSes(term.id, "AMC-26-27", TODAY);
    expect(open(await holdsForBill(db, acct.actor, amcBill, at(6)))).not.toContain("pay_after_grn");
    expect((await payables(db, acct.actor, at(6))).bills.map((b) => b.id)).toContain(amcBill);
  });

  /* ─────────────────────────────── D2 ─────────────────────────────── */

  it("spec #1116 D2: a line with neither a GRN nor an SES, or with both, is refused; with every switch off a pharmacy bill books, falls due and is planned as before", async () => {
    const vL = await aVendor("LAUNDRY");
    const po = await aPo(vL, laundry, 100, 500);
    const ses = await confirmServiceEntry(db, inA.actor, { purchaseOrderId: po, departmentId: deptA.id, period: laundryMonth, source: "laundry_month" }, at(0));
    const grn = await received(vL, gloves, 10, 1_000, null);
    const line = { itemId: laundry, uom: "piece", qtyPacks: 100, ratePaise: 500, gstRateBps: 1800 };
    await expect(createSupplierBill(db, acct.actor, { vendorId: vL, vendorBillNo: "X-1", billDate: TODAY, lines: [line as BillLineInput] }, { now: at(1) }))
      .rejects.toMatchObject({ code: "bill_invalid" });
    await expect(createSupplierBill(db, acct.actor, { vendorId: vL, vendorBillNo: "X-2", billDate: TODAY, lines: [{ ...line, grnId: grn, sesId: ses.id }] }, { now: at(1) }))
      .rejects.toMatchObject({ code: "bill_invalid" });
    expect(await count(sql`select count(*)::int as n from supplier_bills`)).toBe(0);

    expect(await payingSettings(db)).toMatchObject({ holdsCoverPharmacy: false, msmeRule: "as_today" });
    // The pharmacy fixture, as on main: 10 strips at ₹250 + 12 % GST, terms 7 days from the bill date, no hold.
    const vP = await aVendor("PHARMA", false);
    const pg = await received(vP, crocin, 10, 25_000, await aPo(vP, crocin, 10, 25_000));
    const bill = await bookFromGrn(pg, "PH/0042", TODAY, {}, pharmacist);
    const p = await payables(db, pharmacist.actor, at(3));
    const row = p.bills.find((b) => b.id === bill)!;
    expect([row.status, row.totalPaise, row.outstandingPaise, row.dueDate, row.msme]).toEqual(["accepted", 280_000, 280_000, "2026-11-17", false]);
    expect(p.totalOutstandingPaise).toBe(280_000);
    expect(await holdsForBill(db, head.actor, bill, at(3))).toEqual([]);
    const plan = await planPaymentRun(db, at(3));
    expect(plan.groups.map((g) => [g.vendorCode, g.totalPaise, g.bills.map((b) => [b.billId, b.payablePaise, b.dueDate])])).toEqual([["PHARMA", 280_000, [[bill, 280_000, "2026-11-17"]]]]);
    expect([plan.totalPaise, plan.blocked, plan.coveredByCredit]).toEqual([280_000, [], []]);
  });

  /* ─────────────────────────────── D3 ─────────────────────────────── */

  it("spec #1116 D3: on Stores bills each rule places one hold citing its rows; booking the same bill twice places no second hold", async () => {
    // duplicate_like: same supplier, same total, 3 days apart, a different number.
    const v1 = await aVendor("ONE");
    const first = await bookFromGrn(await received(v1, gloves, 10, 1_000, null), "ONE/1", daysAgo(3));
    const dup = await bookFromGrn(await received(v1, gloves, 10, 1_000, null), "ONE/2", TODAY);
    const dupHolds = await holdsForBill(db, acct.actor, dup, at(3));
    expect(open(dupHolds)).toEqual(["duplicate_like"]);
    expect(dupHolds[0]!.evidence.map((e) => e.id)).toContain(first);

    // out_of_pattern: three earlier bills, then one at 3 × the 90th percentile.
    const v2 = await aVendor("TWO");
    for (const [n, qty] of [[1, 10], [2, 9], [3, 8]] as const) await bookFromGrn(await received(v2, gloves, qty, 1_000, null), `TWO/${String(n)}`, daysAgo(10 * n));
    const big = await bookFromGrn(await received(v2, gloves, 30, 1_000, null), "TWO/4", TODAY);
    const bigHolds = await holdsForBill(db, acct.actor, big, at(3));
    expect(open(bigHolds)).toEqual(["out_of_pattern"]);
    expect(bigHolds[0]!.evidence.length).toBeGreaterThanOrEqual(3);

    // above_po: billed at a rate above the PO's.
    const v3 = await aVendor("THREE");
    const po3 = await aPo(v3, gloves, 10, 1_000);
    const above = await bookFromGrn(await received(v3, gloves, 10, 1_000, po3), "THREE/1", TODAY, { ratePaise: 1_300 });
    const aboveHolds = await holdsForBill(db, acct.actor, above, at(3));
    expect(open(aboveHolds)).toEqual(["above_po"]);
    expect(aboveHolds[0]!.evidence.map((e) => e.id)).toContain(po3);

    // pay_after_grn: billed for 10 when the GRN received 5, on a pay-after-GRN PO.
    const v4 = await aVendor("FOUR");
    const po4 = await aPo(v4, gloves, 10, 1_000);
    const g4 = await received(v4, gloves, 5, 1_000, po4);
    const early = await bookFromGrn(g4, "FOUR/1", TODAY, { qtyPacks: 10 });
    const earlyHolds = await holdsForBill(db, acct.actor, early, at(3));
    expect(open(earlyHolds)).toEqual(["pay_after_grn"]);
    expect(earlyHolds[0]!.evidence.map((e) => e.id)).toContain(g4);

    // kyc_incomplete: a supplier that can quote but is not KYC complete.
    const v5 = await aVendor("FIVE", false);
    const kyc = await bookFromGrn(await received(v5, gloves, 10, 1_000, null), "FIVE/1", TODAY);
    const kycHolds = await holdsForBill(db, acct.actor, kyc, at(3));
    expect(open(kycHolds)).toEqual(["kyc_incomplete"]);
    expect(kycHolds[0]!.evidence.map((e) => e.id)).toContain(v5);

    // Re-checking (booking again) places nothing new.
    const before = await count(sql`select count(*)::int as n from stores_bill_holds`);
    await recheckBillHolds(db, acct.actor, dup, at(4));
    await recheckBillHolds(db, acct.actor, dup, at(5));
    expect(await count(sql`select count(*)::int as n from stores_bill_holds`)).toBe(before);
  });

  /* ─────────────────────────────── D4 ─────────────────────────────── */

  it("spec #1116 D4: a pharmacy-only bill that meets a rule is not held while the switch is off; the dry run lists it and writes nothing; after the owner's switch a newly booked one is held", async () => {
    const vP = await aVendor("PHARMA", false); // not KYC complete in the Stores sense
    const b1 = await bookFromGrn(await received(vP, crocin, 10, 25_000, await aPo(vP, crocin, 10, 25_000)), "PH/1", TODAY, {}, pharmacist);
    expect(await holdsForBill(db, head.actor, b1, at(3))).toEqual([]);
    const settingsBefore = await count(sql`select count(*)::int as n from stores_paying_settings`);
    await expect(holdsDryRun(db, head.actor, at(3))).rejects.toMatchObject({ code: "not_permitted" });
    const dry = await holdsDryRun(db, owner.actor, at(3));
    expect(dry.bills.map((b) => [b.billId, b.kinds.includes("kyc_incomplete")])).toEqual([[b1, true]]);
    expect(await count(sql`select count(*)::int as n from stores_bill_holds`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from stores_paying_settings`)).toBe(settingsBefore);

    await expect(setPayingSettings(db, head.actor, { holdsCoverPharmacy: true, dryRunAt: dry.at }, at(4))).rejects.toMatchObject({ code: "not_permitted" });
    const s = await setPayingSettings(db, owner.actor, { holdsCoverPharmacy: true, dryRunAt: dry.at }, at(4));
    expect(s.holdsCoverPharmacy).toBe(true);
    const b2 = await bookFromGrn(await received(vP, crocin, 5, 25_000, await aPo(vP, crocin, 5, 25_000)), "PH/2", TODAY, {}, pharmacist);
    expect(open(await holdsForBill(db, head.actor, b2, at(5)))).toContain("kyc_incomplete");
  });

  /* ─────────────────────────────── D5 ─────────────────────────────── */

  it("spec #1116 D5: a held line is not drafted; a hold placed after drafting refuses submit (line_on_hold); release needs a reason and the right person within the limit; a cooling-off hold is never released; keep needs a reason", async () => {
    const v1 = await aVendor("ONE");
    const vK = await aVendor("KYCLESS", false);
    const clean = await bookFromGrn(await received(v1, gloves, 10, 1_000, null), "ONE/1", daysAgo(3));
    const held = await bookFromGrn(await received(vK, gloves, 10, 1_000, null), "K/1", daysAgo(3));
    expect(open(await holdsForBill(db, acct.actor, held, at(3)))).toEqual(["kyc_incomplete"]);
    const run = await draftPaymentRun(db, head.actor, at(10));
    const drafted = (await getPaymentRun(db, head.actor, run.id, at(10))).vendors.flatMap((v) => v.lines.map((l) => l.billId));
    expect(drafted).toEqual([clean]);
    expect(drafted).not.toContain(held);
    // A same-total bill from the same supplier 3 days later: re-checked at submit, the drafted bill is now held too.
    await bookFromGrn(await received(v1, gloves, 10, 1_000, null), "ONE/2", TODAY);
    await expect(submitPaymentRun(db, head.actor, run.id, at(11))).rejects.toMatchObject({ code: "line_on_hold" });
    expect((await getPaymentRun(db, head.actor, run.id, at(11))).status).toBe("draft");

    // Release: a reason; never the booker; never the PO's approver; above ₹50,000 only the owner.
    const [kycHold] = (await holdsForBill(db, acct.actor, held, at(12))).filter((h) => h.kind === "kyc_incomplete");
    await expect(releaseHold(db, head2.actor, kycHold!.id, "  ", at(12))).rejects.toMatchObject({ code: "reason_required" });
    const vMine = await aVendor("MINE", false);
    const headBooked = await bookFromGrn(await received(vMine, gloves, 10, 1_000, null), "M/1", TODAY, {}, head);
    const [mineHold] = await holdsForBill(db, head.actor, headBooked, at(12));
    await expect(releaseHold(db, head.actor, mineHold!.id, "papers seen", at(12))).rejects.toMatchObject({ code: "own_bill" });
    const vPo = await aVendor("POV", false);
    const poBill = await bookFromGrn(await received(vPo, gloves, 10, 1_000, await aPo(vPo, gloves, 10, 1_000)), "P/1", TODAY);
    const [poHold] = await holdsForBill(db, head.actor, poBill, at(12));
    await expect(releaseHold(db, head.actor, poHold!.id, "papers seen", at(12))).rejects.toMatchObject({ code: "po_approver" });
    const vBig = await aVendor("BIGV", false);
    const bigBill = await bookFromGrn(await received(vBig, gloves, 50, 1_000_00, null), "B/1", TODAY); // ₹50,000 + GST
    const bigHold = (await holdsForBill(db, head2.actor, bigBill, at(12))).find((h) => h.kind === "kyc_incomplete")!;
    await expect(releaseHold(db, head2.actor, bigHold.id, "papers seen", at(12))).rejects.toMatchObject({ code: "above_limit" });
    expect((await releaseHold(db, owner.actor, bigHold.id, "papers seen", at(13))).status).toBe("released");
    expect((await releaseHold(db, head2.actor, kycHold!.id, "KYC papers verified by call", at(13))).status).toBe("released");
    expect(await count(sql`select count(*)::int as n from stores_bill_hold_steps where step = 'released'`)).toBe(2);

    // A bank change in cooling-off: nobody releases it.
    const vBank = await aVendor("BANKV");
    const bankBill = await bookFromGrn(await received(vBank, gloves, 10, 1_000, null), "BK/1", TODAY);
    await db.execute(sql`update vendors set first_payment_allowed_at = ${at(2 * DAY)} where id = ${vBank}`);
    await recheckBillHolds(db, acct.actor, bankBill, at(14));
    const cool = (await holdsForBill(db, acct.actor, bankBill, at(14))).find((h) => h.kind === "bank_cooling_off")!;
    expect(cool.endsAt).not.toBeNull();
    for (const who of [owner, head2, head]) await expect(releaseHold(db, who.actor, cool.id, "urgent", at(15))).rejects.toMatchObject({ code: "ends_by_itself" });

    // Keep: a reason (and a review date at most 30 days on).
    const dupHold = (await holdsForBill(db, acct.actor, clean, at(16))).find((h) => h.kind === "duplicate_like")!;
    await expect(keepHold(db, head2.actor, dupHold.id, { reason: "", reviewOn: "2026-11-20" }, at(16))).rejects.toMatchObject({ code: "reason_required" });
    expect((await keepHold(db, head2.actor, dupHold.id, { reason: "supplier to confirm", reviewOn: "2026-11-20" }, at(16))).status).toBe("kept");
  });

  /* ─────────────────────────────── D6 ─────────────────────────────── */

  it("spec #1116 D6: NEFT 12 characters is refused (reference_shape) and 16 accepted; UPI 12 digits accepted; a used reference of that mode is refused (utr_reused); a cheque records as before", async () => {
    const vs = [await aVendor("ONE"), await aVendor("TWO"), await aVendor("THREE"), await aVendor("FOUR")];
    const bills = [];
    for (const [i, v] of vs.entries()) bills.push(await bookFromGrn(await received(v, gloves, 10 + i, 1_000, null), `B/${String(i)}`, daysAgo(3 + 8 * i)));
    const run = await createPaymentRun(db, head.actor, { lines: bills.map((billId, i) => ({ billId, payPaise: (10 + i) * 1_000 + Math.round(((10 + i) * 1_000 * 1200) / 10_000) })) }, { now: at(10) });
    await submitPaymentRun(db, head.actor, run.id, at(11));
    await decidePaymentRun(db, owner.actor, run.id, "approve", "pay", at(12));
    const pay = (v: string, mode: "neft" | "upi" | "cheque", reference: string) => recordVendorPayment(db, acct.actor, run.id, v, { mode, reference, paidOn: TODAY }, at(13));
    await expect(pay(vs[0]!, "neft", "SBIN52631400")).rejects.toMatchObject({ code: "reference_shape" });
    expect(await count(sql`select count(*)::int as n from supplier_payments`)).toBe(0);
    await pay(vs[0]!, "neft", "SBIN526314000001");
    await pay(vs[1]!, "upi", "431209876543");
    await expect(pay(vs[2]!, "neft", "SBIN526314000001")).rejects.toMatchObject({ code: "utr_reused" });
    await pay(vs[3]!, "cheque", "000123");
    const rows = (await db.execute(sql`select mode, reference from supplier_payments order by payment_no`)).rows;
    expect(rows).toEqual([{ mode: "neft", reference: "SBIN526314000001" }, { mode: "upi", reference: "431209876543" }, { mode: "cheque", reference: "000123" }]);
  });

  /* ─────────────────────────────── D7 ─────────────────────────────── */

  it("spec #1116 D7: payablesByGroup splits open payables by item group and by department, and each split sums to payables' total to the paisa", async () => {
    const v1 = await aVendor("ONE");
    await bookFromGrn(await received(v1, gloves, 7, 1_333, null), "G/1", TODAY);
    const vL = await aVendor("LAUNDRY");
    const ses = await confirmServiceEntry(db, inA.actor, { purchaseOrderId: await aPo(vL, laundry, 333, 517), departmentId: deptA.id, period: laundryMonth, source: "laundry_month" }, at(0));
    await bookFromSes(ses.id, "L/1", TODAY);
    const vP = await aVendor("PHARMA", false);
    await bookFromGrn(await received(vP, crocin, 3, 25_010, await aPo(vP, crocin, 3, 25_010)), "PH/1", TODAY, {}, pharmacist);
    const total = (await payables(db, acct.actor, at(5))).totalOutstandingPaise;
    const split = await payablesByGroup(db, acct.actor, at(5));
    expect(split.totalPaise).toBe(total);
    expect(split.byGroup.reduce((s, g) => s + g.paise, 0)).toBe(total);
    expect(split.byDepartment.reduce((s, d) => s + d.paise, 0)).toBe(total);
    expect(split.byGroup.map((g) => g.group).sort()).toEqual(["HSK", "drugs"]);
    expect(split.byDepartment.map((d) => d.costCentre)).toContain("ICU");
  });

  /* ─────────────────────────────── D8 ─────────────────────────────── */

  it("spec #1116 D8: every act appends one event; SES rows, holds and their steps refuse UPDATE and DELETE; the audit pack lists PO → GRN → bill → hold → release → run → authorisation → payment with its reference", async () => {
    const vL = await aVendor("LAUNDRY");
    const ses = await confirmServiceEntry(db, inA.actor, { purchaseOrderId: await aPo(vL, laundry, 10, 500), departmentId: deptA.id, period: laundryMonth, source: "laundry_month" }, at(0));
    expect(await actsNamed("ses_confirm")).toBe(1);
    const vK = await aVendor("KYCLESS", false);
    const po = await aPo(vK, gloves, 10, 1_000);
    const grn = await received(vK, gloves, 10, 1_000, po);
    const bill = await bookFromGrn(grn, "K/1", daysAgo(3));
    expect(await actsNamed("hold_placed")).toBe(1);
    const [h] = await holdsForBill(db, acct.actor, bill, at(3));
    await releaseHold(db, head2.actor, h!.id, "KYC papers verified", at(4));
    expect(await actsNamed("hold_release")).toBe(1);
    const dry = await holdsDryRun(db, owner.actor, at(4));
    await setPayingSettings(db, owner.actor, { holdsCoverPharmacy: false, dryRunAt: dry.at }, at(4));
    expect(await actsNamed("paying_settings")).toBe(1);

    for (const q of [
      sql`update stores_service_entries set note = 'x' where id = ${ses.id}`, sql`delete from stores_service_entries where id = ${ses.id}`,
      sql`update stores_service_entry_lines set qty_base = 1`, sql`delete from stores_service_entry_lines`,
      sql`update stores_bill_holds set kind = 'above_po'`, sql`delete from stores_bill_holds`,
      sql`update stores_bill_hold_steps set reason = 'x'`, sql`delete from stores_bill_hold_steps`,
      sql`update stores_paying_settings set holds_cover_pharmacy = true`,
    ]) await expect(db.execute(q)).rejects.toThrow();

    const run = await draftPaymentRun(db, head.actor, at(10));
    await submitPaymentRun(db, head.actor, run.id, at(11));
    await decidePaymentRun(db, owner.actor, run.id, "approve", "pay", at(12));
    await recordVendorPayment(db, acct.actor, run.id, vK, { mode: "neft", reference: "HDFC526314000077", paidOn: TODAY }, at(13));
    // `grn.received` is dated by the wall clock (materials' postGrn), so the window reaches past it.
    const pack = await storesAuditPack(db, head.actor, { billId: bill, from: at(-90 * DAY), to: new Date(Math.max(Date.now(), at(20).getTime()) + 60 * MIN) });
    const whats = pack.rows.map((r) => r.what);
    const firstOf = (w: string | RegExp): number => whats.findIndex((x) => (typeof w === "string" ? x === w : w.test(x)));
    const order = [/^purchase_order\./, /^grn\./, "supplier_bill.accepted", "hold_placed", "hold_release", "payment_run.drafted", "payment_run.authorised", "supplier_payment.recorded"];
    const idx = order.map(firstOf);
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const payRow = pack.rows.find((r) => r.what === "supplier_payment.recorded")!;
    expect(JSON.stringify(payRow.after)).toContain("HDFC526314000077");
    expect(payRow.actor.roles).toEqual(["accounts_officer"]);
    expect(pack.rows.find((r) => r.what === "hold_release")!.actor.id).toBe(head2.id);
  });
});
