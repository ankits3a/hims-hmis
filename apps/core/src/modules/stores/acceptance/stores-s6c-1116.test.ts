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
  acceptSupplierBill, activateVendor, addVendorDocument, applyBankChange, captureGrn, createPaymentRun, createPurchaseOrder, createSupplierBill,
  decidePaymentRun, decidePurchaseOrder, issueStock, matchSupplierBill, postGrn, recordVendorPayment, registerMaterialsApprovalTypes, registerVendor,
  requestBankChange, runGateQc, submitPaymentRun, submitPurchaseOrder,
} from "../../materials";
import { storesManifest } from "../manifest";
import {
  approveSupplierCategory, auditFlags, createShelf, listCategories, ownerMonthlyList, receiveAtShelf, recordShelfCheck, registerStoresItem, reviewFlag,
  runAuditorNight, seedStoresMasters,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1116, spec docs/specs/1116-stores-paying-desk.md (owner APPROVED 2026-11-19, decision 0101):
 * Stores S6c, the auditor agent (T1). D17 (it flags split POs and one person at both ends of a chain, cites rows, names
 * no person, places no hold) and D18 (a person reviews each flag: Upheld with a note, Dismissed with a reason, never the
 * flagged department's HOD; upheld flags reach the owner's monthly list; flags and reviews are append-only; each review
 * is a `copilot_acts` row naming the reviewer). Every intent is handed the clock it runs on.
 */
describe("Stores S6c: the auditor agent and its review (spec #1116)", () => {
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
        "stores.masters.manage", "stores.holds.release", "stores.audit.read", "materials.items.read", "materials.stock.read", "materials.vendors.manage",
        "materials.po.raise", "materials.grn.capture", "materials.grn.qc", "materials.bills.manage", "materials.bills.accept_difference",
        "materials.payments.prepare", "approvals.requests.decide", "approvals.requests.read",
      ],
      accounts_officer: ["materials.bills.manage", "materials.payments.prepare", "materials.payments.record", "stores.audit.read", "stores.tax.manage"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "materials.grn.capture", "materials.grn.qc"],
      owner: ["stores.holds.release", "stores.audit.read", "approvals.requests.decide", "approvals.requests.read", "materials.payments.record"],
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
    mops = await item("HK-MOP-0001", "Wet mop refill", "HSK", 1800);
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "clinical", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  /** A supplier with its papers, active, bank past cooling-off, approved for the Stores categories. */
  async function aVendor(code: string): Promise<string> {
    const pan = `${code.replace(/[^A-Z]/g, "").padEnd(3, "X").slice(0, 3)}CA1234A`;
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, {
      code, legalName: `${code} Services`, pan, gstin: `10${pan}1Z5`, paymentTermsDays: 7, msmeClass: null,
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

  /* ─────────────────────────────── D17 ─────────────────────────────── */

  it("spec #1116 D17: the auditor flags two ₹30,000 POs to one supplier and category 3 days apart, and one person booking a bill and recording its payment; every flag cites rows, names no person, and places no hold", async () => {
    const v = await aVendor("HOUSEKEEP");
    const p1 = await ordered(v, gloves, 30, 100_000, -15);
    const p2 = await ordered(v, mops, 30, 100_000, -12);

    // One person (the accounts officer) enters and books the bill for the first PO's goods, and records its payment.
    const bill = await createSupplierBill(db, acct.actor, {
      vendorId: v, vendorBillNo: "HK/0001", billDate: TODAY, lines: [{ grnId: p1.grnId, itemId: gloves, uom: "piece", qtyPacks: 30, ratePaise: 100_000, gstRateBps: 1200 }],
    }, { now: at(0) });
    await matchSupplierBill(db, acct.actor, bill.id, at(1));
    await acceptSupplierBill(db, acct.actor, bill.id, at(2));
    const run = await createPaymentRun(db, head.actor, { lines: [{ billId: bill.id, payPaise: 30 * 100_000 + Math.round((30 * 100_000 * 1200) / 10_000) }] }, { now: at(10) });
    await submitPaymentRun(db, head.actor, run.id, at(11));
    await decidePaymentRun(db, owner.actor, run.id, "approve", "pay", at(12));
    await recordVendorPayment(db, acct.actor, run.id, v, { mode: "neft", reference: "HDFC526314000077", paidOn: TODAY }, at(13));

    const holdsBefore = await count(sql`select count(*)::int as n from stores_bill_holds`);
    const night = await runAuditorNight(db, NIGHT);
    expect(night.halted).toBe(false);
    const flags = await auditFlags(db, head.actor, {}, NIGHT);

    const split = flags.filter((f) => f.kind === "split_po");
    expect(split).toHaveLength(1);
    expect(split[0]!.cites.filter((c) => c.type === "po").map((c) => c.id).sort()).toEqual([p1.poId, p2.poId].sort());
    const both = flags.filter((f) => f.kind === "both_ends");
    expect(both).toHaveLength(1);
    expect(both[0]!.cites.map((c) => c.type).sort()).toEqual(expect.arrayContaining(["bill", "payment"]));
    expect(both[0]!.cites.find((c) => c.type === "bill")!.id).toBe(bill.id);

    // Every flag cites rows, and no flag's text names any person on the users table.
    const people = await userNames();
    expect(people.length).toBeGreaterThan(5);
    for (const f of flags) {
      expect(f.cites.length).toBeGreaterThan(0);
      for (const n of people) expect(f.text.toLowerCase()).not.toContain(n.toLowerCase());
      for (const n of people) expect(JSON.stringify(f.cites).toLowerCase()).not.toContain(n.toLowerCase());
    }
    // The auditor places no hold, releases none, pays nothing; a second night raises nothing twice.
    expect(await count(sql`select count(*)::int as n from stores_bill_holds`)).toBe(holdsBefore);
    expect(await count(sql`select count(*)::int as n from stores_bill_hold_steps where step = 'released'`)).toBe(0);
    await runAuditorNight(db, new Date(NIGHT.getTime() + 24 * 60 * MIN));
    expect((await auditFlags(db, head.actor, {}, NIGHT)).length).toBe(flags.length);
  });

  /* ─────────────────────────────── D18 ─────────────────────────────── */

  it("spec #1116 D18: Upheld needs a note and Dismissed a reason; the flagged department's HOD may not review; an upheld flag is on the owner's monthly list; flags and reviews are append-only; each review is a copilot_acts row naming the reviewer", async () => {
    await overBookThrice();
    await runAuditorNight(db, NIGHT);
    const flags = await auditFlags(db, auditor.actor, {}, NIGHT);
    const flag = flags.find((f) => f.kind === "more_than_book")!;
    expect(flag).toBeDefined();
    expect(flag.departments.map((d) => d.id)).toEqual([deptA.id]);
    expect(flag.status).toBe("open");

    await expect(reviewFlag(db, head.actor, flag.id, { verdict: "upheld", note: "" }, at(11 * 60))).rejects.toMatchObject({ code: "reason_required" });
    await expect(reviewFlag(db, head.actor, flag.id, { verdict: "dismissed", note: "  " }, at(11 * 60))).rejects.toMatchObject({ code: "reason_required" });
    await expect(reviewFlag(db, hodA.actor, flag.id, { verdict: "dismissed", note: "it is fine" }, at(11 * 60))).rejects.toMatchObject({ code: "hod_reviews_own" });
    // Nobody but the materials head or the stores auditor reviews a flag.
    await expect(reviewFlag(db, acct.actor, flag.id, { verdict: "upheld", note: "recounted" }, at(11 * 60))).rejects.toMatchObject({ code: "not_permitted" });
    expect(await count(sql`select count(*)::int as n from stores_audit_flag_reviews`)).toBe(0);

    const reviewed = await reviewFlag(db, head.actor, flag.id, { verdict: "upheld", note: "Shelf recounted; receipts were short-entered, keeper retrained" }, at(11 * 60));
    expect(reviewed.status).toBe("upheld");
    await expect(reviewFlag(db, auditor.actor, flag.id, { verdict: "dismissed", note: "no" }, at(11 * 60 + 1))).rejects.toMatchObject({ code: "flag_reviewed" });

    const list = await ownerMonthlyList(db, owner.actor, "2026-11");
    expect(list.map((f) => f.id)).toContain(flag.id);
    await expect(ownerMonthlyList(db, keeper.actor, "2026-11")).rejects.toMatchObject({ code: "not_permitted" });

    // Every flag is a copilot_acts proposal naming its reviewer.
    const acts = (await db.execute(sql`select actor_id, tool from copilot_acts where proposal_id = ${flag.id}`)).rows as { actor_id: string; tool: string }[];
    expect(acts).toEqual([{ actor_id: head.id, tool: "stores.auditor_flag" }]);

    // Flags and reviews refuse UPDATE and DELETE.
    await expect(db.execute(sql`update stores_audit_flags set text = 'x' where id = ${flag.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from stores_audit_flags where id = ${flag.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update stores_audit_flag_reviews set note = 'x'`)).rejects.toThrow();
    await expect(db.execute(sql`delete from stores_audit_flag_reviews`)).rejects.toThrow();
  });
});
