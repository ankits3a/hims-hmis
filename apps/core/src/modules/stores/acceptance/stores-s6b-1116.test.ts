import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { allNamed, childText, parseXml, voucherSums } from "../../../../test/helpers/xml";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { grnLines, orgDepartments } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import {
  acceptBillDifference, acceptSupplierBill, activateVendor, addVendorDocument, applyBankChange, captureGrn, createPurchaseOrder, createStore,
  createSupplierBill, decidePurchaseOrder, getSupplierBill, issueStock, matchSupplierBill, payables, postGrn, registerItem, registerMaterialsApprovalTypes,
  registerVendor, requestBankChange, runGateQc, submitPurchaseOrder, updateVendor,
} from "../../materials";
import { saveTallyLedgers, tallyExport, tallyExportFile } from "../../pharmacy/tally";
import { storesManifest } from "../manifest";
import {
  addTdsCertificate, approveSupplierCategory, billTaxProposal, closeMsmeObjection, createShelf, departmentChargeOn, gstNotCreditedOn, holdsForBill,
  listCategories, msmeDryRun, payingDesk, payingSettings, receiveAtShelf, recordMsmeObjection, registerStoresItem, saveTaxTable, seedStoresMasters,
  setBillTds, setPayingSettings, setStoresTallyLedgers, signTaxTable, tagUnits, tdsDryRun,
} from "../index";
import type { BillLineInput } from "../../materials";
import type { Actor, WirePayHold, WireTdsRule } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1116, spec docs/specs/1116-stores-paying-desk.md (owner APPROVED 2026-11-19, decision 0101):
 * Stores S6b, tax on the bill. D11 (GST credit marks and reverse charge), D12 (TDS from a signed table), D13 (the
 * goods row's dry run; pharmacy untouched while it is off), D14 (the e-invoice number), D15 (the MSME clock of the
 * Act behind its switch), D16 (the one Tally export, split by item group, with cost centres, asset and TDS ledgers).
 *
 * The tax tables here are TEST tables (spec build notes: "D12 signs a test table"); the real ones are the CA's.
 * Every intent is handed the clock it runs on.
 */
describe("Stores S6b: GST marks, TDS, IRN, the MSME clock and the Tally split (spec #1116)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let head2: Who;
  let acct: Who; // accounts officer: books bills, keeps the tax tables
  let keeper: Who;
  let pharmacist: Who;
  let owner: Who;
  let accountant: Who; // the Tally export
  let inA: Who;
  let deptA: { id: string; code: string };
  let genMain: string;
  let shelfA: string;
  let pharmStore: string;
  let gloves: string;
  let mops: string;
  let electrodes: string;
  let monitor: string;
  let crocin: string;
  let cats: Map<string, string>;

  /** 12:00 IST on 2026-11-10. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const DAY = 24 * 60;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
  const TODAY = "2026-11-10";
  const dayAt = (offsetDays: number): string => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);

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
      accounts_officer: ["materials.bills.manage", "materials.payments.prepare", "materials.payments.record", "stores.audit.read", "stores.tax.manage"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "materials.grn.capture", "materials.grn.qc"],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc", "materials.bills.manage"],
      owner: ["stores.holds.release", "stores.audit.read", "approvals.requests.decide", "approvals.requests.read", "materials.payments.record"],
      billing_manager: ["pharmacy.tally.export"],
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
    accountant = await mkUser(db, "the.accountant", ["billing_manager"]);
    inA = await mkUser(db, "incharge.a", []);
    deptA = await anOrgDept("ICU", "ICU");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });

    const floor1 = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "First floor" }))).resourceId;
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cats = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
    const item = async (code: string, name: string, cat: string, klass: string, trackMode: "shelf" | "expensed" | "tagged", gst: number): Promise<string> =>
      (await registerStoresItem(db, head.actor, { code, name, class: klass, baseUom: "piece", categoryId: cats.get(cat)!, trackMode, gstRateBps: gst })).itemId;
    gloves = await item("HK-GLV-0001", "Household gloves", "HSK", "consumable", "shelf", 1200);
    mops = await item("HK-MOP-0001", "Wet mop refill", "HSK", "consumable", "shelf", 1800);
    electrodes = await item("BM-ECG-0001", "ECG electrodes", "BME", "consumable", "shelf", 1200);
    monitor = await item("ME-MON-0001", "Patient monitor", "MEQ", "asset", "tagged", 1200);
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
  type VendorOpts = { msmeClass?: string | null; terms?: number | null; pan?: string | null; agreement?: boolean; einvoice?: boolean; complete?: boolean };
  /** A supplier with its papers, active. `pan: null` = no PAN on file. `complete` (default) adds the bank past cooling-off and the categories. */
  async function aVendor(code: string, o: VendorOpts = {}): Promise<string> {
    const pan = o.pan === undefined ? `${code.replace(/[^A-Z]/g, "").padEnd(3, "X").slice(0, 3)}CA1234A` : o.pan;
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, {
      code, legalName: `${code} Services`, pan, gstin: pan === null ? null : `10${pan}1Z5`, paymentTermsDays: o.terms === undefined ? 7 : o.terms,
      msmeClass: o.msmeClass ?? null,
    }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "gst_certificate", number: "g" }));
    // The PAN paper is an activation precondition; "PAN missing" is a supplier with no PAN number on file.
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "pan", number: "p" }));
    if (o.agreement === true) await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "payment_terms_agreement", number: "agreed terms" }));
    if (o.einvoice !== undefined) await withTx(db, (tx) => updateVendor(tx, head.actor, v, { einvoiceApplicable: o.einvoice }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, v, at(-400 * DAY)));
    if (o.complete === false) return v;
    const { changeId, approvalId } = await withTx(db, (tx) => requestBankChange(tx, head.actor, v, { accountNo: "123456789012", ifsc: "SBIN0000001" }));
    await approveRequest(db, owner.actor, { approvalId, note: "Verified by call-back" });
    await withTx(db, (tx) => applyBankChange(tx, head.actor, changeId, new Date()));
    await db.execute(sql`update vendors set first_payment_allowed_at = ${at(-300 * DAY)} where id = ${v}`);
    for (const c of ["HSK", "MEQ", "BME"]) await approveSupplierCategory(db, head.actor, v, cats.get(c)!, at(-300 * DAY));
    return v;
  }
  /** A posted GRN of `qty` at `rate` (pieces; strips for crocin) to GEN-MAIN (or the pharmacy), on an approved PO, posted `postDay` days from today. */
  async function received(vendorId: string, itemId: string, qty: number, rate: number, postDay = -20): Promise<{ grnId: string; grnLineId: string }> {
    const pharm = itemId === crocin;
    const raiser = pharm ? pharmacist : head2;
    const po = await createPurchaseOrder(db, raiser.actor, {
      vendorId, storeResourceId: pharm ? pharmStore : genMain, lines: [{ itemId, ...(pharm ? { uom: "strip" } : {}), qtyPacks: qty, ratePaise: rate }],
    }, { now: at((postDay - 5) * DAY) });
    await submitPurchaseOrder(db, raiser.actor, po.id, at((postDay - 5) * DAY + 1));
    // Above ₹50,000 the PO is the owner's to approve (the S5 tiers).
    await decidePurchaseOrder(db, qty * rate >= 4_000_000 ? owner.actor : head.actor, po.id, "approve", "ok", at((postDay - 5) * DAY + 2));
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId, source: "challan", storeResourceId: pharm ? pharmStore : genMain, purchaseOrderId: po.id, challanNo: `CH-${newId().slice(-6)}`,
      challanDate: dayAt(postDay), invoiceNo: `INV-${newId().slice(-6)}`,
      lines: [{
        itemId, uom: pharm ? "strip" : "piece", qtyInUom: qty, unitCostPaise: pharm ? rate / 10 : rate,
        ...(pharm ? { batchNo: `B-${newId().slice(-4)}`, expiryDate: "2028-06-30" } : {}), priceReason: { code: "other", text: "test rate" },
      }],
      now: at(postDay * DAY),
    }));
    await withTx(db, (tx) => runGateQc(tx, keeper.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, keeper.actor, grnId, at(postDay * DAY + 1)));
    const [line] = await db.select({ id: grnLines.id }).from(grnLines).where(sql`${grnLines.grnId} = ${grnId}`);
    return { grnId, grnLineId: line!.id };
  }
  type LineOver = Partial<Pick<BillLineInput, "gstCredit" | "reverseCharge" | "qtyPacks" | "ratePaise">>;
  /** Enter the bill for these GRN lines (qty and rate as received unless overridden), match it; not yet booked. */
  async function enter(
    vendorId: string, no: string, lines: { grnId: string; itemId: string; qty: number; rate: number; gst: number; over?: LineOver }[],
    opts: { billDate?: string; irn?: string | null; by?: Who } = {},
  ): Promise<string> {
    const by = opts.by ?? acct;
    const b = await createSupplierBill(db, by.actor, {
      vendorId, vendorBillNo: no, billDate: opts.billDate ?? TODAY, ...(opts.irn === undefined ? {} : { irn: opts.irn }),
      lines: lines.map((l) => ({
        grnId: l.grnId, itemId: l.itemId, uom: l.itemId === crocin ? "strip" : "piece", qtyPacks: l.qty, ratePaise: l.rate, gstRateBps: l.gst, ...(l.over ?? {}),
      })),
    }, { now: at(0) });
    await matchSupplierBill(db, by.actor, b.id, at(1));
    return b.id;
  }
  /** Book (accept) an entered bill; a held match is accepted by `head2`. */
  async function book(billId: string, by: Who = acct, now: Date = at(2)): Promise<string> {
    const v = await getSupplierBill(db, by.actor, billId);
    if (v.status === "held_for_match") return (await acceptBillDifference(db, head2.actor, billId, "agreed with the supplier", now)).id;
    return (await acceptSupplierBill(db, by.actor, billId, now)).id;
  }
  async function signedTable(kind: "tds" | "gst_credit", rules: unknown[], now: Date = at(-1)): Promise<string> {
    const t = await saveTaxTable(db, acct.actor, { kind, rules, documentRef: `ca-${kind}-${String(now.getTime())}.pdf` } as Parameters<typeof saveTaxTable>[2], now);
    await signTaxTable(db, acct.actor, t.id, { documentRef: `ca-${kind}-signed.pdf` }, now);
    return t.id;
  }
  const contractRow: WireTdsRule = {
    nature: "contract", section: "contract work (test row)", rateBps: { individual: 100, other: 200 }, panMissingRateBps: 2_000,
    threshold: { kind: "bill", paise: 30_000 }, on: true, categoryCodes: ["HSK"],
  };
  const professionalRow: WireTdsRule = {
    nature: "professional", section: "technical fee (test row)", rateBps: { individual: 1_000, other: 1_000 }, panMissingRateBps: 2_000,
    threshold: { kind: "year", paise: 50_000 }, on: true, categoryCodes: ["BME"],
  };
  const goodsRow: WireTdsRule = {
    nature: "goods", section: "purchase of goods (test row)", rateBps: { individual: 10, other: 10 }, panMissingRateBps: 500,
    threshold: { kind: "year", paise: 10_000_000 }, on: true, categoryCodes: [],
  };
  const gst = (taxable: number, bps: number): number => Math.round((taxable * bps) / 10_000);
  const openKinds = (hs: WirePayHold[]): string[] => hs.filter((h) => h.status === "open" || h.status === "kept").map((h) => h.kind).sort();
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  async function shelfIssue(itemId: string, qty: number): Promise<void> {
    const { transferId } = await withTx(db, (tx) => issueStock(tx, keeper.actor, { fromResourceId: genMain, toResourceId: shelfA, lines: [{ itemId, qtyBase: qty }], occurredAt: NOW }));
    await receiveAtShelf(db, inA.actor, transferId, NOW);
  }
  async function exportMonth(from: string, to: string): Promise<{ vouchers: string; masters: string }> {
    const ex = await tallyExport(db, accountant.actor, { preset: "custom", from, to }, at(60 * DAY));
    return { vouchers: (await tallyExportFile(db, accountant.actor, ex.id, "vouchers")).xml, masters: (await tallyExportFile(db, accountant.actor, ex.id, "masters")).xml };
  }

  /* ─────────────────────────────── D11 ─────────────────────────────── */

  it("spec #1116 D11: not_available GST counts in the department's 'GST not credited' and leaves the charge; eligible adds nothing; a drug line has no mark; reverse charge pays without GST and shows in the export's liability", async () => {
    const v = await aVendor("HOUSEKEEP");
    const g1 = await received(v, gloves, 100, 1_000);
    const g2 = await received(v, mops, 50, 2_000);
    await shelfIssue(gloves, 40);
    await shelfIssue(mops, 10);
    const charge = (await departmentChargeOn(db, deptA.code, TODAY)).chargePaise;
    expect(charge).toBe(40 * 1_000 + 10 * 2_000);
    // Before a bill is booked each line takes its category's default: not available (ruling 0101 Q2).
    expect((await gstNotCreditedOn(db, deptA.code, TODAY)).paise).toBe(gst(40 * 1_000, 1200) + gst(10 * 2_000, 1800));

    const billId = await enter(v, "HK/0001", [
      { ...g1, itemId: gloves, qty: 100, rate: 1_000, gst: 1200, over: { gstCredit: "not_available" } },
      { ...g2, itemId: mops, qty: 50, rate: 2_000, gst: 1800, over: { gstCredit: "eligible" } },
    ]);
    await book(billId);
    expect((await gstNotCreditedOn(db, deptA.code, TODAY)).paise).toBe(gst(40 * 1_000, 1200));
    expect((await departmentChargeOn(db, deptA.code, TODAY)).chargePaise).toBe(charge);
    const view = await getSupplierBill(db, acct.actor, billId);
    expect(view.lines.map((l) => [l.itemId, l.gstCredit, l.reverseCharge ?? false]).sort()).toEqual([[gloves, "not_available", false], [mops, "eligible", false]].sort());

    // A drug (pharmacy) line carries no mark, none is proposed, and one sent is refused.
    const vp = await aVendor("PHARMA", { complete: false });
    const pg = await received(vp, crocin, 10, 25_000);
    const pharmBill = await enter(vp, "PH/1", [{ ...pg, itemId: crocin, qty: 10, rate: 25_000, gst: 1200 }], { by: pharmacist });
    const proposal = await billTaxProposal(db, acct.actor, pharmBill, at(3));
    expect(proposal.lines.map((l) => [l.storesLine, l.gstCredit])).toEqual([[false, null]]);
    expect((await getSupplierBill(db, acct.actor, pharmBill)).lines[0]).not.toHaveProperty("gstCredit");
    const pg2 = await received(vp, crocin, 10, 25_000);
    await expect(createSupplierBill(db, pharmacist.actor, {
      vendorId: vp, vendorBillNo: "PH/2", billDate: TODAY, lines: [{ grnId: pg2.grnId, itemId: crocin, uom: "strip", qtyPacks: 10, ratePaise: 25_000, gstRateBps: 1200, gstCredit: "eligible" }],
    }, { now: at(4) })).rejects.toMatchObject({ code: "bill_invalid" });

    // Reverse charge: the supplier's bill carries no GST and is paid without it; the export carries the liability.
    const vr = await aVendor("SECURITY");
    const g3 = await received(vr, gloves, 10, 5_000, -15);
    const rcBill = await enter(vr, "SEC/11", [{ ...g3, itemId: gloves, qty: 10, rate: 5_000, gst: 1200, over: { reverseCharge: true, gstCredit: "not_available" } }]);
    await book(rcBill);
    const rc = await getSupplierBill(db, acct.actor, rcBill);
    expect([rc.status, rc.totalPaise, rc.cgstPaise + rc.sgstPaise + rc.igstPaise]).toEqual(["accepted", 50_000, 0]);
    expect((await payables(db, acct.actor, at(5))).bills.find((b) => b.id === rcBill)!.outstandingPaise).toBe(50_000);

    await saveTallyLedgers(db, accountant.actor, { companyName: "Test Hospital" }, at(10));
    await setStoresTallyLedgers(db, accountant.actor, {
      "purchase:HSK": "Purchase — Housekeeping", rcm_liability: "GST payable on reverse charge",
    }, at(11));
    const file = await exportMonth("2026-11-01", "2026-11-30");
    const rcVoucher = voucherSums(parseXml(file.vouchers)).find((x) => x.entries.some(([l]) => l === "SECURITY Services"))!;
    expect(rcVoucher.sum).toBe(0);
    expect(rcVoucher.entries).toEqual(expect.arrayContaining([["GST payable on reverse charge", gst(50_000, 1200)], ["SECURITY Services", 50_000]]));
  });

  /* ─────────────────────────────── D12 ─────────────────────────────── */

  it("spec #1116 D12: no signed table = 'TDS not checked' and no TDS; a signed table proposes by threshold, payee, PAN and certificate; the payable is total less TDS; a change needs a reason; a later version leaves a booked bill", async () => {
    const v = await aVendor("MANPOWER");
    const g0 = await received(v, gloves, 10, 1_000);
    const unchecked = await enter(v, "MP/0", [{ ...g0, itemId: gloves, qty: 10, rate: 1_000, gst: 1200 }]);
    expect((await billTaxProposal(db, acct.actor, unchecked, at(2))).tdsChecked).toBe(false);
    await book(unchecked);
    const u = await getSupplierBill(db, acct.actor, unchecked);
    expect(u).not.toHaveProperty("tdsPaise");
    expect(u.outstandingPaise).toBe(u.totalPaise);

    // An unsigned table changes nothing.
    await saveTaxTable(db, acct.actor, { kind: "tds", rules: [contractRow], documentRef: "draft.pdf" }, at(3));
    const g00 = await received(v, gloves, 10, 1_000);
    const stillUnchecked = await enter(v, "MP/00", [{ ...g00, itemId: gloves, qty: 10, rate: 1_000, gst: 1200 }]);
    expect((await billTaxProposal(db, acct.actor, stillUnchecked, at(4))).tdsChecked).toBe(false);

    const v1 = await signedTable("tds", [contractRow, professionalRow], at(5));
    // Under the one-bill threshold (₹200 < ₹300): none. Over it (₹400): 2 % (a company PAN) on the value before GST.
    const gUnder = await received(v, gloves, 20, 1_000);
    const under = await enter(v, "MP/1", [{ ...gUnder, itemId: gloves, qty: 20, rate: 1_000, gst: 1200 }]);
    expect((await billTaxProposal(db, acct.actor, under, at(6))).tdsPaise).toBe(0);
    await book(under);
    expect((await getSupplierBill(db, acct.actor, under)).tdsPaise).toBe(0);
    const gOver = await received(v, gloves, 40, 1_000);
    const over = await enter(v, "MP/2", [{ ...gOver, itemId: gloves, qty: 40, rate: 1_000, gst: 1200 }]);
    const p = await billTaxProposal(db, acct.actor, over, at(7));
    expect([p.tdsChecked, p.tdsPaise, p.lines[0]!.tds?.rateBps, p.lines[0]!.tds?.basePaise]).toEqual([true, 800, 200, 40_000]);
    await book(over);
    const ov = await getSupplierBill(db, acct.actor, over);
    expect(ov.tdsPaise).toBe(800);
    expect(ov.totalPaise).toBe(40_000 + gst(40_000, 1200));
    expect((await payables(db, acct.actor, at(8))).bills.find((b) => b.id === over)!.outstandingPaise).toBe(ov.totalPaise - 800);

    // A supplier past the yearly threshold is proposed on the next bill.
    const vt = await aVendor("BIOTECH");
    const gy1 = await received(vt, electrodes, 40, 1_000);
    const y1 = await enter(vt, "BT/1", [{ ...gy1, itemId: electrodes, qty: 40, rate: 1_000, gst: 1200 }]);
    await book(y1);
    expect((await getSupplierBill(db, acct.actor, y1)).tdsPaise).toBe(0);
    const gy2 = await received(vt, electrodes, 30, 1_000);
    const y2 = await enter(vt, "BT/2", [{ ...gy2, itemId: electrodes, qty: 30, rate: 1_000, gst: 1200 }]);
    await book(y2);
    expect((await getSupplierBill(db, acct.actor, y2)).tdsPaise).toBe(3_000);

    // A missing PAN takes the PAN-missing rate.
    const vn = await aVendor("NOPAN", { pan: null, complete: false });
    const gn = await received(vn, gloves, 40, 1_000);
    const np = await enter(vn, "NP/1", [{ ...gn, itemId: gloves, qty: 40, rate: 1_000, gst: 1200 }]);
    await book(np);
    expect((await getSupplierBill(db, acct.actor, np)).tdsPaise).toBe(8_000);

    // A valid lower-deduction certificate takes its rate.
    const vc = await aVendor("CERTCO");
    await addTdsCertificate(db, acct.actor, { vendorId: vc, number: "LDC-1", rateBps: 50, validFrom: "2026-04-01", validTo: "2027-03-31", documentRef: "ldc.pdf" }, at(9));
    const gc = await received(vc, gloves, 40, 1_000);
    const cb = await enter(vc, "CC/1", [{ ...gc, itemId: gloves, qty: 40, rate: 1_000, gst: 1200 }]);
    await book(cb);
    expect((await getSupplierBill(db, acct.actor, cb)).tdsPaise).toBe(200);

    // Changing the proposal needs a reason; the change is what books.
    const gx = await received(v, gloves, 50, 1_000);
    const changed = await enter(v, "MP/3", [{ ...gx, itemId: gloves, qty: 50, rate: 1_000, gst: 1200 }]);
    const line = (await billTaxProposal(db, acct.actor, changed, at(10))).lines[0]!;
    await expect(setBillTds(db, acct.actor, changed, { lines: [{ lineId: line.lineId, tdsPaise: 500 }], reason: " " }, at(11))).rejects.toMatchObject({ code: "reason_required" });
    await setBillTds(db, acct.actor, changed, { lines: [{ lineId: line.lineId, tdsPaise: 500 }], reason: "the CA's working for this contract" }, at(12));
    await book(changed);
    expect((await getSupplierBill(db, acct.actor, changed)).tdsPaise).toBe(500);

    // A later signed version (5 %) leaves every booked bill as it was booked.
    await signedTable("tds", [{ ...contractRow, rateBps: { individual: 500, other: 500 } }, professionalRow], at(13));
    expect(v1).not.toBe("");
    expect((await getSupplierBill(db, acct.actor, over)).tdsPaise).toBe(800);
    expect((await payables(db, acct.actor, at(14))).bills.find((b) => b.id === over)!.outstandingPaise).toBe(ov.totalPaise - 800);
  });

  /* ─────────────────────────────── D13 ─────────────────────────────── */

  it("spec #1116 D13: tdsDryRun for the goods row lists the pharmacy bills it would touch and writes nothing; with the row off a pharmacy bill past the threshold books with no TDS", async () => {
    await signedTable("tds", [goodsRow], at(-2));
    const vp = await aVendor("PHARMA", { complete: false });
    // ₹1,00,800 booked this year already (above the ₹1,00,000 goods threshold).
    const g1 = await received(vp, crocin, 40, 252_000, -30);
    const first = await enter(vp, "PH/1", [{ ...g1, itemId: crocin, qty: 40, rate: 252_000, gst: 1200 }], { by: pharmacist });
    await book(first, pharmacist);
    const g2 = await received(vp, crocin, 10, 25_000);
    const next = await enter(vp, "PH/2", [{ ...g2, itemId: crocin, qty: 10, rate: 25_000, gst: 1200 }], { by: pharmacist });

    const before = await Promise.all([
      count(sql`select count(*)::int as n from supplier_bills`), count(sql`select count(*)::int as n from supplier_bill_lines where tds_paise is not null`),
      count(sql`select count(*)::int as n from events`), count(sql`select count(*)::int as n from stores_paying_settings`),
    ]);
    const dry = await tdsDryRun(db, acct.actor, at(3));
    expect(dry.bills.map((b) => [b.billId, b.tdsPaise])).toContainEqual([next, gst(250_000, 10)]);
    expect(await Promise.all([
      count(sql`select count(*)::int as n from supplier_bills`), count(sql`select count(*)::int as n from supplier_bill_lines where tds_paise is not null`),
      count(sql`select count(*)::int as n from events`), count(sql`select count(*)::int as n from stores_paying_settings`),
    ])).toEqual(before);

    expect((await payingSettings(db)).tdsGoods).toBe(false);
    await book(next, pharmacist);
    const b = await getSupplierBill(db, acct.actor, next);
    expect(b).not.toHaveProperty("tdsPaise");
    expect(b.outstandingPaise).toBe(b.totalPaise);
  });

  /* ─────────────────────────────── D14 ─────────────────────────────── */

  it("spec #1116 D14: for a supplier declared for e-invoicing an eligible bill with no IRN is held (irn_missing); with an IRN, or with only not_available lines, it is not", async () => {
    const v = await aVendor("EINV", { einvoice: true });
    const ga = await received(v, gloves, 10, 1_000, -20);
    const noIrn = await enter(v, "E/1", [{ ...ga, itemId: gloves, qty: 10, rate: 1_000, gst: 1200, over: { gstCredit: "eligible" } }]);
    await book(noIrn);
    expect(openKinds(await holdsForBill(db, acct.actor, noIrn, at(3)))).toContain("irn_missing");

    const gb = await received(v, gloves, 11, 1_000, -19);
    const withIrn = await enter(v, "E/2", [{ ...gb, itemId: gloves, qty: 11, rate: 1_000, gst: 1200, over: { gstCredit: "eligible" } }], { irn: "a".repeat(64) });
    await book(withIrn);
    expect(openKinds(await holdsForBill(db, acct.actor, withIrn, at(3)))).not.toContain("irn_missing");
    expect((await getSupplierBill(db, acct.actor, withIrn)).irn).toBe("a".repeat(64));

    const gc = await received(v, gloves, 12, 1_000, -18);
    const notAvail = await enter(v, "E/3", [{ ...gc, itemId: gloves, qty: 12, rate: 1_000, gst: 1200, over: { gstCredit: "not_available" } }]);
    await book(notAvail);
    expect(openKinds(await holdsForBill(db, acct.actor, notAvail, at(3)))).not.toContain("irn_missing");
  });

  /* ─────────────────────────────── D15 ─────────────────────────────── */

  it("spec #1116 D15: with msme_rule act micro/small fall due at 15 days or the agreed days up to 45, medium on its terms, an objection moves the start; as_today as on main; switching leaves booked bills and the dry run lists them; Due soon and Overdue", async () => {
    const D0 = -20; // the GRN's posting day = the day of acceptance
    const vMicro = await aVendor("MICRO", { msmeClass: "micro", terms: 7 });
    const vAgreed60 = await aVendor("AGREEDSIXTY", { msmeClass: "small", terms: 60, agreement: true });
    const vAgreed30 = await aVendor("AGREEDTHIRTY", { msmeClass: "micro", terms: 30, agreement: true });
    const vMedium = await aVendor("MEDIUM", { msmeClass: "medium", terms: 7 });
    const vQc = await aVendor("QCCO", { msmeClass: "micro", terms: 60 });
    const billFor = async (vendorId: string, no: string, qty: number): Promise<{ billId: string; grnId: string }> => {
      const g = await received(vendorId, gloves, qty, 1_000, D0);
      return { billId: await enter(vendorId, no, [{ ...g, itemId: gloves, qty, rate: 1_000, gst: 1200 }]), grnId: g.grnId };
    };

    // As today (the switch's default): any MSME class = acceptance + min(terms, 45); the bill date is today.
    expect((await payingSettings(db)).msmeRule).toBe("as_today");
    const t1 = await billFor(vMicro, "T/1", 10);
    const t2 = await billFor(vMedium, "T/2", 11);
    await book(t1.billId);
    await book(t2.billId);
    expect((await getSupplierBill(db, acct.actor, t1.billId)).dueDate).toBe(dayAt(D0 + 7));
    expect((await getSupplierBill(db, acct.actor, t2.billId)).dueDate).toBe(dayAt(D0 + 7));

    // The dry run lists the open bill whose date would move; switching on needs it, and leaves booked bills alone.
    const dry = await msmeDryRun(db, acct.actor, at(3));
    expect(dry.bills.map((b) => [b.billId, b.dueDate, b.actDueDate])).toContainEqual([t1.billId, dayAt(D0 + 7), dayAt(D0 + 15)]);
    await setPayingSettings(db, owner.actor, { msmeRule: "act", dryRunAt: dry.at }, at(4));
    expect((await payingSettings(db)).msmeRule).toBe("act");
    expect((await getSupplierBill(db, acct.actor, t1.billId)).dueDate).toBe(dayAt(D0 + 7));

    const a1 = await billFor(vMicro, "A/1", 12);
    const a2 = await billFor(vAgreed60, "A/2", 13);
    const a3 = await billFor(vAgreed30, "A/3", 14);
    const a4 = await billFor(vMedium, "A/4", 15);
    const a5 = await billFor(vQc, "A/5", 16);
    const obj = await recordMsmeObjection(db, head.actor, { grnId: a5.grnId, kind: "qc_rejection", raisedOn: dayAt(D0 + 5), reason: "10 pieces torn" }, at(5));
    await closeMsmeObjection(db, head.actor, obj.id, { closedOn: dayAt(D0 + 9), note: "replaced by the supplier" }, at(6));
    for (const b of [a1, a2, a3, a4, a5]) await book(b.billId, acct, at(7));
    const due = async (id: string): Promise<string | null> => (await getSupplierBill(db, acct.actor, id)).dueDate;
    expect(await due(a1.billId)).toBe(dayAt(D0 + 15));
    expect(await due(a2.billId)).toBe(dayAt(D0 + 45));
    expect(await due(a3.billId)).toBe(dayAt(D0 + 30));
    expect(await due(a4.billId)).toBe(dayAt(0 + 7)); // a medium supplier: the bill date + its terms
    expect(await due(a5.billId)).toBe(dayAt(D0 + 24));

    // The desk's words: 5 days left = "Due soon"; past the date = "Overdue".
    const word = async (id: string, now: Date): Promise<string | null | undefined> => (await payingDesk(db, acct.actor, now)).due.find((d) => d.billId === id)?.dueWord;
    expect(await word(a1.billId, new Date(Date.parse(`${dayAt(D0 + 10)}T06:30:00Z`)))).toBe("due_soon");
    expect(await word(a1.billId, new Date(Date.parse(`${dayAt(D0 + 16)}T06:30:00Z`)))).toBe("overdue");
  });

  /* ─────────────────────────────── D16 ─────────────────────────────── */

  it("spec #1116 D16: a month with one Stores bill exports its lines to the category ledger with the cost centre, the tagged unit to the asset ledger, not_available GST inside the purchase, TDS on its ledger; a missing ledger refuses with the list; a drug-only month is as before", async () => {
    await signedTable("tds", [{ ...contractRow, threshold: { kind: "bill", paise: 0 } }], at(-2));
    const v = await aVendor("STORESCO");
    const gg = await received(v, gloves, 100, 1_000, -10);
    const gm = await received(v, monitor, 1, 5_000_000, -10);
    await tagUnits(db, keeper.actor, { grnLineId: gm.grnLineId, units: [{ serial: "SN-1" }] }, at(-9 * DAY));
    const billId = await enter(v, "ST/77", [
      { ...gg, itemId: gloves, qty: 100, rate: 1_000, gst: 1200, over: { gstCredit: "not_available" } },
      { ...gm, itemId: monitor, qty: 1, rate: 5_000_000, gst: 1200, over: { gstCredit: "eligible" } },
    ], { irn: "b".repeat(64) });
    await book(billId);
    const bill = await getSupplierBill(db, acct.actor, billId);
    expect(bill.tdsPaise).toBe(gst(100_000, 200));

    await saveTallyLedgers(db, accountant.actor, { companyName: "Test Hospital" }, at(10));
    await expect(tallyExport(db, accountant.actor, { preset: "custom", from: "2026-11-01", to: "2026-11-30" }, at(11)))
      .rejects.toMatchObject({ code: "invalid_tally_ledgers", detail: { missing: expect.arrayContaining(["purchase:HSK", "asset:MEQ", "tds:contract"]) } });
    expect(await count(sql`select count(*)::int as n from pharmacy_tally_exports`)).toBe(0);

    await setStoresTallyLedgers(db, accountant.actor, {
      "purchase:HSK": "Purchase — Housekeeping", "asset:MEQ": "Fixed assets — Medical equipment", "tds:contract": "TDS payable — contract",
    }, at(12));
    const file = await exportMonth("2026-11-01", "2026-11-30");
    const doc = parseXml(file.vouchers);
    const voucher = voucherSums(doc).find((x) => x.type === "Purchase")!;
    expect(voucher.sum).toBe(0);
    expect(voucher.entries).toEqual(expect.arrayContaining([
      ["Purchase — Housekeeping", -(100_000 + gst(100_000, 1200))],
      ["Fixed assets — Medical equipment", -5_000_000],
      ["Input CGST", -Math.floor(gst(5_000_000, 1200) / 2)],
      ["Input SGST", -(gst(5_000_000, 1200) - Math.floor(gst(5_000_000, 1200) / 2))],
      ["TDS payable — contract", gst(100_000, 200)],
      ["STORESCO Services", bill.totalPaise - gst(100_000, 200)],
    ]));
    expect(voucher.entries.map(([l]) => l)).not.toContain("Purchase — Medicines");
    const purchaseEntry = allNamed(doc, "ALLLEDGERENTRIES.LIST").find((e) => childText(e, "LEDGERNAME") === "Purchase — Housekeeping")!;
    expect(allNamed(purchaseEntry, "COSTCENTREALLOCATIONS.LIST").map((c) => childText(c, "NAME"))).toEqual(["GEN-MAIN"]);
    expect(file.masters).toContain("Purchase — Housekeeping");
    expect(file.masters).toContain("TDS payable — contract");

    // A drug-only month: the classic voucher, one purchase ledger, no cost centre (byte-for-byte: pharmacy/stores-s6b-no-change.test.ts).
    const vp = await aVendor("PHARMA", { complete: false });
    const pg = await received(vp, crocin, 10, 25_000, -10);
    const pb = await enter(vp, "PH/9", [{ ...pg, itemId: crocin, qty: 10, rate: 25_000, gst: 1200 }], { by: pharmacist, billDate: "2026-10-15" });
    await book(pb, pharmacist);
    const october = await exportMonth("2026-10-01", "2026-10-31");
    const pv = voucherSums(parseXml(october.vouchers)).filter((x) => x.type === "Purchase");
    expect(pv.map((x) => x.entries.map(([l]) => l).sort())).toEqual([["Input CGST", "Input SGST", "PHARMA Services", "Purchase — Medicines"]]);
    expect(october.vouchers).not.toContain("COSTCENTREALLOCATIONS.LIST");
  });
});
