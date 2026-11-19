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
  setVendorRates, acceptSupplierBill, activateVendor, addVendorDocument, applyBankChange, captureGrn, createPaymentRun, createPurchaseOrder, createSupplierBill,
  decidePaymentRun, decidePurchaseOrder, issueStock, matchSupplierBill, postGrn, recordVendorPayment, registerMaterialsApprovalTypes, registerVendor,
  requestBankChange, runGateQc, submitPaymentRun, submitPurchaseOrder,
} from "../materials";
import { storesManifest } from "./manifest";
import {
  approveSupplierCategory, auditFlags, confirmServiceEntry, createShelf, listCategories, msmeDuesReport, msmeHalfOf, receiveAtShelf, recordShelfCheck,
  registerStoresItem, reverseServiceEntry, runAuditorNight, runAuditorNightIfDue, seedStoresMasters, sendMsmeDueSoon, sendServiceToConfirm, servicesDue,
  storesFlagsDesk, storesMsmeDueDesk, storesServicesDesk, towerView, unbilledServiceEntries,
} from "./index";
import { budgetsForMonth } from "./buy-reads";
import { setHalt } from "../../kernel/copilot/halt";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
  * NOT ACCEPTANCE (the locked D17/D18 checks live in acceptance/) — issue #1116, spec docs/specs/1116-stores-paying-desk.md (owner APPROVED 2026-11-19, decision 0101):
 * Stores S6c, the auditor agent (T1). D17 (it flags split POs and one person at both ends of a chain, cites rows, names
 * no person, places no hold) and D18 (a person reviews each flag: Upheld with a note, Dismissed with a reason, never the
 * flagged department's HOD; upheld flags reach the owner's monthly list; flags and reviews are append-only; each review
 * is a `copilot_acts` row naming the reviewer). Every intent is handed the clock it runs on.
 */
describe("Stores S6c: the auditor's other rules, its night and halt; the reversing SES; the paying notices; the MSME dues report; GST not credited (#1116)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let head2: Who;
  let acct: Who;
  let keeper: Who;
  let owner: Who;
  let auditor: Who;
  let hodA: Who;
  let inA: Who;
  let deptA: { id: string; code: string };
  let genMain: string;
  let shelfA: string;
  let gloves: string;
  let mops: string;
  let laundry: string;
  let cats: Map<string, string>;

  /** 12:00 IST on 2026-11-10. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const DAY = 24 * 60;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
  const TODAY = "2026-11-10";
  const dayAt = (offsetDays: number): string => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  /** 22:30 IST the same day: the auditor's night. */
  const NIGHT = at(10 * 60 + 30);

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
        "stores.tower.read", "stores.spend.read", "stores.masters.manage", "stores.holds.release", "stores.audit.read", "materials.items.read", "materials.stock.read", "materials.vendors.manage",
        "materials.po.raise", "materials.grn.capture", "materials.grn.qc", "materials.bills.manage", "materials.bills.accept_difference",
        "materials.payments.prepare", "approvals.requests.decide", "approvals.requests.read",
      ],
      accounts_officer: ["materials.bills.manage", "materials.payments.prepare", "materials.payments.record", "stores.audit.read", "stores.tax.manage"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "materials.grn.capture", "materials.grn.qc"],
      owner: ["stores.budget.manage", "stores.holds.release", "stores.audit.read", "approvals.requests.decide", "approvals.requests.read", "materials.payments.record"],
      stores_auditor: ["stores.audit.read", "stores.assets.read"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
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
    owner = await mkUser(db, "the.owner", ["owner"]);
    auditor = await mkUser(db, "internal.auditor", ["stores_auditor"]);
    hodA = await mkUser(db, "icu.hod", ["stores_auditor"]);
    inA = await mkUser(db, "incharge.a", []);
    // Real-looking names, so "no flag names a person" is a test of the text and not of the usernames.
    const names: [Who, string][] = [[head, "Ramesh Kumar"], [head2, "Sunita Devi"], [acct, "Anil Prasad"], [keeper, "Mohan Lal"], [owner, "Vikram Singh"],
      [auditor, "Kavita Sharma"], [hodA, "Rajesh Gupta"], [inA, "Pooja Kumari"]];
    for (const [w, n] of names) await db.execute(sql`update users set full_name = ${n} where id = ${w.id}`);
    deptA = await anOrgDept("ICU", "ICU");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });

    const floor1 = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "First floor" }))).resourceId;
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cats = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
    const item = async (code: string, name: string, cat: string, gst: number): Promise<string> =>
      (await registerStoresItem(db, head.actor, { code, name, class: "consumable", baseUom: "piece", categoryId: cats.get(cat)!, trackMode: "shelf", gstRateBps: gst })).itemId;
    gloves = await item("HK-GLV-0001", "Household gloves", "HSK", 1200);
    laundry = (await registerStoresItem(db, head.actor, { code: "HK-LDY-0001", name: "Laundry per piece", class: "service", baseUom: "piece", categoryId: cats.get("HSK")!, trackMode: "expensed", gstRateBps: 1800 })).itemId;
    mops = await item("HK-MOP-0001", "Wet mop refill", "HSK", 1800);
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "clinical", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  /** A supplier with its papers, active, bank past cooling-off, approved for the Stores categories. */
  async function aVendor(code: string, msmeClass: string | null = null): Promise<string> {
    const pan = `${code.replace(/[^A-Z]/g, "").padEnd(3, "X").slice(0, 3)}CA1234A`;
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, {
      code, legalName: `${code} Services`, pan, gstin: `10${pan}1Z5`, paymentTermsDays: 7, msmeClass,
    }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, v, at(-400 * DAY)));
    const { changeId, approvalId } = await withTx(db, (tx) => requestBankChange(tx, head.actor, v, { accountNo: "123456789012", ifsc: "SBIN0000001" }));
    await approveRequest(db, owner.actor, { approvalId, note: "Verified by call-back" });
    await withTx(db, (tx) => applyBankChange(tx, head.actor, changeId, new Date()));
    await db.execute(sql`update vendors set first_payment_allowed_at = ${at(-300 * DAY)} where id = ${v}`);
    for (const c of ["HSK", "MEQ", "BME"]) await approveSupplierCategory(db, head.actor, v, cats.get(c)!, at(-300 * DAY));
    return v;
  }
  /** An approved PO for `qty` × `rate` placed `poDay` days from today, received and posted to GEN-MAIN two days later. */
  async function ordered(vendorId: string, itemId: string, qty: number, rate: number, poDay: number): Promise<{ poId: string; poNo: string; grnId: string }> {
    const po = await createPurchaseOrder(db, head2.actor, { vendorId, storeResourceId: genMain, lines: [{ itemId, qtyPacks: qty, ratePaise: rate }] }, { now: at(poDay * DAY) });
    await submitPurchaseOrder(db, head2.actor, po.id, at(poDay * DAY + 1));
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok", at(poDay * DAY + 2));
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId, source: "challan", storeResourceId: genMain, purchaseOrderId: po.id, challanNo: `CH-${newId().slice(-6)}`, challanDate: dayAt(poDay + 2),
      invoiceNo: `INV-${newId().slice(-6)}`, lines: [{ itemId, uom: "piece", qtyInUom: qty, unitCostPaise: rate, priceReason: { code: "other", text: "test rate" } }],
      now: at((poDay + 2) * DAY),
    }));
    await withTx(db, (tx) => runGateQc(tx, keeper.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, keeper.actor, grnId, at((poDay + 2) * DAY + 1)));
    return { poId: po.id, poNo: po.poNo, grnId };
  }
  const userNames = async (): Promise<string[]> => ((await db.execute(sql`select full_name from users`)).rows as { full_name: string }[]).map((r) => r.full_name);
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);

  /** Three "More than book" counts at the ICU shelf this quarter: a department-level flag. */
  async function overBookThrice(): Promise<void> {
    await ordered(await aVendor("GLOVESCO"), gloves, 100, 1_000, -20);
    const { transferId } = await withTx(db, (tx) => issueStock(tx, keeper.actor, { fromResourceId: genMain, toResourceId: shelfA, lines: [{ itemId: gloves, qtyBase: 40 }], occurredAt: at(-10 * DAY) }));
    await receiveAtShelf(db, inA.actor, transferId, at(-10 * DAY));
    for (const d of [-9, -6, -3]) await recordShelfCheck(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: gloves, counted: 45 }] }, at(d * DAY));
  }

  async function shelfIssue(qty: number, when: Date): Promise<void> {
    const { transferId } = await withTx(db, (tx) => issueStock(tx, keeper.actor, { fromResourceId: genMain, toResourceId: shelfA, lines: [{ itemId: gloves, qtyBase: qty }], occurredAt: when }));
    await receiveAtShelf(db, inA.actor, transferId, when);
  }
  async function bookGrn(v: string, p: { grnId: string }, itemId: string, qty: number, rate: number, gstBps: number, no: string, when: Date): Promise<string> {
    const bill = await createSupplierBill(db, acct.actor, { vendorId: v, vendorBillNo: no, billDate: TODAY, lines: [{ grnId: p.grnId, itemId, uom: "piece", qtyPacks: qty, ratePaise: rate, gstRateBps: gstBps }] }, { now: when });
    await matchSupplierBill(db, acct.actor, bill.id, when);
    await acceptSupplierBill(db, acct.actor, bill.id, when);
    return bill.id;
  }
  const laundryMonth = { kind: "month" as const, key: "2026-10", start: "2026-10-01", end: "2026-10-31" };

  it("price drift and use out of pattern: a GRN 5 % over the contract and a week's use 3 × the department's median are flagged, each once; with the copilot halted the night writes nothing", async () => {
    const v = await aVendor("GLOVESCO");
    await setVendorRates(db, head.actor, v, [{ itemId: gloves, packSize: 1, ratePaise: 1_000 }], { validFrom: dayAt(-120), now: at(-120 * DAY) });
    await ordered(v, gloves, 2_000, 1_000, -100);
    await ordered(v, gloves, 10, 1_050, -10);
    for (let w = 12; w >= 1; w--) await shelfIssue(10, at(-(w * 7 + 2) * DAY));
    await shelfIssue(30, at(-2 * DAY));

    await setHalt(db, owner.actor, "draft", "test");
    expect(await runAuditorNight(db, NIGHT)).toMatchObject({ halted: true, flags: [] });
    expect(await count(sql`select count(*)::int as n from stores_audit_flags`)).toBe(0);
    await db.execute(sql`delete from copilot_halts`);

    // Not night yet at noon; at 22:30 the night runs once.
    expect(await runAuditorNightIfDue(db, at(0))).toBeNull();
    const night = await runAuditorNightIfDue(db, NIGHT);
    expect(night?.halted).toBe(false);
    expect(await runAuditorNightIfDue(db, new Date(NIGHT.getTime() + 60_000))).toBeNull();
    const flags = await auditFlags(db, head.actor, {}, NIGHT);
    expect(flags.map((f) => f.kind).sort()).toEqual(["price_drift", "use_out_of_pattern"]);
    expect(flags.find((f) => f.kind === "use_out_of_pattern")!.departments.map((d) => d.id)).toEqual([deptA.id]);
    // The Now card and the waiting line are the reviewers' only.
    expect(await storesFlagsDesk.waiting!({ db, actor: auditor.actor, now: NIGHT } as never)).toEqual([expect.objectContaining({ kind: "stores.flagsToReview", count: 2 })]);
    expect(await storesFlagsDesk.waiting!({ db, actor: acct.actor, now: NIGHT } as never)).toEqual([]);
    await expect(auditFlags(db, acct.actor, {}, NIGHT)).rejects.toMatchObject({ code: "not_permitted" });
    // Each reviewer (two materials heads, two stores auditors) is told once that night.
    expect(await count(sql`select count(*)::int as n from alerts where ref_type = 'stores_audit_flags'`)).toBe(4);
  });

  it("the reversing service entry: a reason, the department's confirmer, once, never on a billed sheet; the month is then due again and its confirmer is told once", async () => {
    const v = await aVendor("LAUNDRYCO");
    const po = await createPurchaseOrder(db, head2.actor, { vendorId: v, storeResourceId: genMain, lines: [{ itemId: laundry, qtyPacks: 3_000, ratePaise: 500 }] }, { now: at(-60 * DAY) });
    await submitPurchaseOrder(db, head2.actor, po.id, at(-60 * DAY + 1));
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok", at(-60 * DAY + 2));
    // A contract no department has confirmed yet is not announced (no department on the PO).
    expect((await servicesDue(db, at(0))).map((s) => [s.poId, s.departmentId])).toEqual([[po.id, null]]);
    expect(await sendServiceToConfirm(db, at(0))).toBe(0);
    const ses = await confirmServiceEntry(db, inA.actor, { purchaseOrderId: po.id, departmentId: deptA.id, period: laundryMonth, source: "laundry_month" }, at(1));
    expect(await servicesDue(db, at(2))).toEqual([]);
    expect((await unbilledServiceEntries(db)).map((s) => s.id)).toEqual([ses.id]);

    await expect(reverseServiceEntry(db, inA.actor, ses.id, " ", at(3))).rejects.toMatchObject({ code: "reason_required" });
    await expect(reverseServiceEntry(db, keeper.actor, ses.id, "counted twice", at(3))).rejects.toMatchObject({ code: "not_permitted" });
    const rev = await reverseServiceEntry(db, inA.actor, ses.id, "linen count was entered twice", at(3));
    expect(rev.lines).toEqual([]);
    await expect(reverseServiceEntry(db, inA.actor, ses.id, "again", at(4))).rejects.toMatchObject({ code: "already_reversed" });
    await expect(reverseServiceEntry(db, inA.actor, rev.id, "undo", at(4))).rejects.toMatchObject({ code: "not_reversible" });
    expect(await unbilledServiceEntries(db)).toEqual([]);
    expect((await servicesDue(db, at(5))).map((s) => [s.poId, s.departmentId])).toEqual([[po.id, deptA.id]]);
    expect(await storesServicesDesk.waiting!({ db, actor: inA.actor, now: at(5) } as never)).toEqual([expect.objectContaining({ kind: "stores.servicesToConfirm", count: 1 })]);
    expect(await sendServiceToConfirm(db, at(5))).toBe(1);
    expect(await sendServiceToConfirm(db, at(6))).toBe(0);
    const [n] = (await db.execute(sql`select title, body from alerts where ref_type = 'stores_ses'`)).rows as { title: string; body: string }[];
    expect(n).toEqual({ title: "Service to confirm", body: `सेवा की पुष्टि करें · ${po.poNo}` });

    // Confirmed again, billed: a billed sheet is corrected by the supplier's credit note, not reversed.
    const again = await confirmServiceEntry(db, inA.actor, { purchaseOrderId: po.id, departmentId: deptA.id, period: laundryMonth, source: "laundry_month" }, at(7));
    const bill = await createSupplierBill(db, acct.actor, { vendorId: v, vendorBillNo: "LDY/10", billDate: TODAY, lines: [{ sesId: again.id, itemId: laundry, uom: "piece", qtyPacks: 3_000, ratePaise: 500, gstRateBps: 1800 }] }, { now: at(8) });
    expect(bill.id).toBeTruthy();
    await expect(reverseServiceEntry(db, inA.actor, again.id, "wrong", at(9))).rejects.toMatchObject({ code: "ses_already_billed" });
  });

  it("MSME bill due soon: told once to the preparers and accounts officers; the half-yearly report lists a micro supplier's bill outstanding past 45 days and not a newer one", async () => {
    const v = await aVendor("MICROCO", "micro");
    const soon = await ordered(v, gloves, 10, 1_000, -6);
    const old = await ordered(v, mops, 10, 2_000, -62);
    const recent = await ordered(v, gloves, 5, 1_000, -22);
    const soonBill = await bookGrn(v, soon, gloves, 10, 1_000, 1200, "MC/1", at(0));
    const oldBill = await bookGrn(v, old, mops, 10, 2_000, 1800, "MC/2", at(0));
    await bookGrn(v, recent, gloves, 5, 1_000, 1200, "MC/3", at(0));

    expect(await sendMsmeDueSoon(db, at(1))).toBeGreaterThanOrEqual(2);
    expect(await sendMsmeDueSoon(db, at(2))).toBe(0);
    const told = ((await db.execute(sql`select user_id, ref_id, body from alerts where ref_type = 'stores_pay_due'`)).rows as { user_id: string; ref_id: string; body: string }[]);
    expect(told.every((t) => t.ref_id === soonBill)).toBe(true);
    expect(told.map((t) => t.user_id)).toEqual(expect.arrayContaining([acct.id, head.id]));
    expect(told[0]!.body).not.toContain("MICROCO");
    expect(await storesMsmeDueDesk.waiting!({ db, actor: acct.actor, now: at(1) } as never)).toEqual([expect.objectContaining({ kind: "stores.msmeDueSoon", count: 1 })]);

    const report = await msmeDuesReport(db, acct.actor, msmeHalfOf(at(0)), at(0));
    expect(report.half).toBe("2026-H2");
    expect(report.rows.map((r) => r.billId)).toEqual([oldBill]);
    expect(report.rows[0]).toMatchObject({ msmeClass: "micro", daysOutstanding: 60, outstandingPaise: 10 * 2_000 + Math.round((10 * 2_000 * 1800) / 10_000) });
    await expect(msmeDuesReport(db, keeper.actor, "2026-H2", at(0))).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("GST not credited sits beside the spend on the budgets month and the tower's spend tile, never inside it", async () => {
    const v = await aVendor("GLOVESCO");
    await ordered(v, gloves, 100, 1_000, -20);
    await shelfIssue(40, at(-1 * DAY));
    const icu = (await budgetsForMonth(db, owner.actor, "2026-11")).find((d) => d.departmentId === deptA.id)!;
    expect(icu.gstNotCreditedPaise).toBe(Math.round((40 * 1_000 * 1200) / 10_000));
    expect(icu.spentPaise).toBe(40 * 1_000);
    const tile = (await towerView(db, head.actor, at(0))).spend!.departments.find((d) => d.id === deptA.id)!;
    expect(tile).toMatchObject({ chargePaise: 40 * 1_000, gstNotCreditedPaise: Math.round((40 * 1_000 * 1200) / 10_000) });
  });
});
