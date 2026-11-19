import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
// The Stores module is loaded as it is in the running app, so whatever it registers with materials is in force here.
import "../stores";
import {
  acceptSupplierBill, activateVendor, addVendorDocument, billDraftFromGrn, captureGrn, createPurchaseOrder, createStore, createSupplierBill,
  decidePaymentRun, decidePurchaseOrder, draftPaymentRun, getPaymentRun, getSupplierBill, matchSupplierBill, payables, planPaymentRun, postGrn,
  recordVendorPayment, registerItem, registerMaterialsApprovalTypes, registerVendor, runGateQc, submitPaymentRun, submitPurchaseOrder, supplierLedger, updateVendor,
} from "../materials";
import { saveTallyLedgers, tallyExport, tallyExportFile } from "./tally";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S6b (#1116, build notes) — CHARACTERISATION of pharmacy's money and accounting paths before S6b touches
 * `materials/supplier-bills.ts` (`dueDateFor`, `payables`) and `pharmacy/tally.ts`. Written FIRST and captured on the
 * lane below (S6a), so the golden file is what pharmacy did before S6b. With every S6b switch at its default (MSME rule
 * `as_today`, TDS on goods off, no signed tax table), pharmacy bills from a plain, a micro, a medium and a no-terms
 * supplier — their view, due date and payable, `payables`, `planPaymentRun`, the run, a NEFT payment, the supplier
 * ledger — and the TallyPrime files for a drug-only month (purchases) and the next (payments) must come out the same,
 * paisa for paisa and byte for byte.
 *
 * Ids are replaced by first-seen tokens; instants written by a real clock are replaced by "<ts>". The XML files carry
 * ids inside REMOTEID: those are tokenised the same way. `UPDATE_GOLDEN=1` rewrites the golden (only on the lane below).
 */
const T0 = new Date("2026-11-10T04:30:00.000Z"); // 10:00 IST
const at = (m: number): Date => new Date(T0.getTime() + m * 60_000);
const DAY = 24 * 60;
const GOLDEN = join(__dirname, "__golden__", "stores-s6b-no-change.json");

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;
const ULID_WHOLE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function normalise(value: unknown): unknown {
  const ids = new Map<string, string>();
  const tok = (s: string): string => {
    if (!ids.has(s)) ids.set(s, `<id${String(ids.size + 1)}>`);
    return ids.get(s)!;
  };
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return "<ts>";
    if (typeof v === "string") return ULID_WHOLE.test(v) ? tok(v) : INSTANT.test(v) ? "<ts>" : v.replace(ULID, (m) => tok(m));
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[ULID_WHOLE.test(k) ? tok(k) : k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return walk(value);
}

describe("pharmacy bills, due dates, payables, runs and the Tally file S6b must not move (spec #1116, characterisation)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let head2: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let accountant: { id: string; actor: Actor };
  let store: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const grants: Record<string, string[]> = {
      materials_head: [
        "materials.po.raise", "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage",
        "approvals.requests.decide", "approvals.requests.read", "materials.bills.manage", "materials.bills.accept_difference",
        "materials.payments.prepare", "materials.payments.record",
      ],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc", "materials.bills.manage"],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
      owner: ["approvals.requests.decide", "approvals.requests.read"],
      billing_manager: ["pharmacy.tally.export"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "mat.head", ["materials_head"]);
    head2 = await mkUser(db, "mat.head2", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    accountant = await mkUser(db, "the.accountant", ["billing_manager"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
  });

  async function aVendor(code: string, over: { msmeClass?: string | null; msmeActivity?: string | null; paymentTermsDays?: number | null; agreement?: boolean }): Promise<string> {
    const { agreement, msmeActivity, ...fields } = over;
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName: `${code} Pharma Pvt Ltd`, ...fields }));
    if (msmeActivity !== undefined) await withTx(db, (tx) => updateVendor(tx, head.actor, vendorId, { msmeActivity }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    if (agreement === true) await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "payment_terms_agreement", number: "a-1" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, at(-30 * DAY)));
    return vendorId;
  }

  async function received(v: string, itemId: string, strips: number, ratePerStrip: number, challanNo: string): Promise<string> {
    const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: v, storeResourceId: store, lines: [{ itemId, qtyPacks: strips, ratePaise: ratePerStrip }] }, { now: T0 });
    await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok", at(2));
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: v, source: "challan", storeResourceId: store, challanNo, challanDate: "2026-11-10", invoiceNo: `INV-${challanNo}`, purchaseOrderId: po.id,
      lines: [{ itemId, uom: "strip", qtyInUom: strips, batchNo: `B-${challanNo}`, expiryDate: "2028-06-30", unitCostPaise: ratePerStrip / 10, priceReason: { code: "other", text: "test case rate" } }],
      now: at(10),
    }));
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, at(20)));
    return grnId;
  }

  it("book → accept → payables → plan → run → NEFT payment → the Tally files of a drug-only month: the same as before S6b", async () => {
    const plain = await aVendor("ACME", { paymentTermsDays: 5 });
    const micro = await aVendor("SMALL", { msmeClass: "micro", msmeActivity: "trader", paymentTermsDays: 60 });
    const medium = await aVendor("MIDCO", { msmeClass: "medium", paymentTermsDays: 90, agreement: true });
    const noTerms = await aVendor("NOTRM", { msmeClass: "small", paymentTermsDays: null });
    const { itemId: crocin } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "CROC", name: "Crocin 500", class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    const { itemId: amox } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "ORS", name: "ORS sachet", class: "consumable", baseUom: "sachet", batchTracked: true, gstRateBps: 500,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    const grnsBooked = [
      [await received(plain, crocin, 10, 25_000, "CH-0001"), "INV/26-27/0042"],
      [await received(micro, crocin, 4, 12_000, "CH-0002"), "S-77"],
      [await received(medium, amox, 20, 9_000, "CH-0003"), "MID/118"],
      [await received(noTerms, amox, 3, 9_000, "CH-0004"), "NT-9"],
    ] as const;

    const booked: string[] = [];
    for (const [g, no] of grnsBooked) {
      const d = await billDraftFromGrn(db, pharmacist.actor, g);
      const b = await createSupplierBill(db, pharmacist.actor, {
        vendorId: d.vendorId, vendorBillNo: no, billDate: "2026-11-10", interState: d.interState,
        lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
      }, { source: "agent", now: at(60) });
      await matchSupplierBill(db, pharmacist.actor, b.id, at(61));
      booked.push((await acceptSupplierBill(db, pharmacist.actor, b.id, at(62))).id);
    }
    const views = [];
    for (const id of booked) views.push(await getSupplierBill(db, head.actor, id));
    const payablesBefore = await payables(db, head.actor, at(40 * DAY));
    const plan = await planPaymentRun(db, at(40 * DAY));

    const run = await draftPaymentRun(db, head.actor, at(40 * DAY + 1));
    await submitPaymentRun(db, head.actor, run.id, at(40 * DAY + 2));
    await decidePaymentRun(db, owner.actor, run.id, "approve", "pay them", at(40 * DAY + 3));
    await recordVendorPayment(db, head2.actor, run.id, plain, { mode: "neft", reference: "SBIN526314000001", paidOn: "2026-12-20" }, at(40 * DAY + 4));
    const runAfter = await getPaymentRun(db, head.actor, run.id, at(40 * DAY + 6));
    const payablesAfter = await payables(db, head.actor, at(40 * DAY + 6));
    const ledger = await supplierLedger(db, head.actor, plain);
    const viewsAfter = [];
    for (const id of booked) viewsAfter.push(await getSupplierBill(db, head.actor, id));

    await saveTallyLedgers(db, accountant.actor, { companyName: "Test Hospital" }, at(41 * DAY));
    const tally = [];
    for (const [from, to] of [["2026-11-01", "2026-11-30"], ["2026-12-01", "2026-12-31"]] as const) {
      const ex = await tallyExport(db, accountant.actor, { preset: "custom", from, to }, at(41 * DAY + 1));
      const vouchers = (await tallyExportFile(db, accountant.actor, ex.id, "vouchers")).xml;
      // The checksum covers REMOTEIDs (ids differ per run): kept as "is the SHA-256 of the vouchers file", the file itself compared.
      tally.push({
        summary: { ...ex, checksum: ex.checksum === createHash("sha256").update(vouchers, "utf8").digest("hex") ? "<sha256 of vouchers>" : ex.checksum },
        vouchers,
        masters: (await tallyExportFile(db, accountant.actor, ex.id, "masters")).xml,
      });
    }

    const rows = async (q: ReturnType<typeof sql>): Promise<unknown[]> => (await db.execute(q)).rows;
    const result = normalise({
      views, payablesBefore, plan, run: runAfter, payablesAfter, ledger, viewsAfter, tally,
      tables: {
        bills: await rows(sql`select bill_no, vendor_bill_no, status, msme, terms_days, acceptance_date, due_date, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, expected_total_paise, paid_paise, held_reason from supplier_bills order by bill_no`),
        billLines: await rows(sql`select b.bill_no, l.uom, l.multiplier, l.qty_packs, l.rate_paise, l.taxable_paise, l.gst_rate_bps, l.cgst_paise, l.sgst_paise, l.igst_paise, l.expected_base, l.expected_rate_paise, l.expected_taxable_paise, l.mismatch from supplier_bill_lines l join supplier_bills b on b.id = l.bill_id order by b.bill_no`),
        payments: await rows(sql`select payment_no, mode, reference, paid_on, amount_paise from supplier_payments order by payment_no`),
        events: await rows(sql`select name, count(*)::int as n from events where name like 'supplier_%' or name like 'payment_run%' or name like 'material%bill%' group by name order by name`),
      },
    });
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`);
      if (process.env.UPDATE_GOLDEN !== "1") throw new Error(`golden file was missing and has been written: ${GOLDEN}; re-run`);
    }
    expect(result).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  });
});
