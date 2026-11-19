import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { openSessionFor, submitCountFor } from "../../../../test/helpers/billing";
import { seedPharmacyBase, stockIn } from "../../../../test/helpers/pharmacy";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { usersHoldingRoleAtScope } from "../../../kernel/workflow/roles";
import { alerts, authDevices, authSessions, creditNotes, events, pharmacyRetailSaleLines, stockBatches } from "../../../kernel/db/schema";
import { phonePushConsumer } from "../../../kernel/push/consumer";
import { fixedPhonePushSource } from "../../../kernel/push/sender";
import { issueCreditNote, listSessions, liveExpectedCashPaise } from "../../billing";
import {
  activateVendor, addVendorDocument, balances, captureGrn, countSheet, createStore, getCount, postAdjustments, postGrn,
  registerMaterialsApprovalTypes, registerVendor, requestCountAdjustment, runGateQc, scheduleCount, submitCount,
} from "../../materials";
import { registerPharmacyApprovalTypes } from "../approval-types";
import { RETAIL_PHARMACY_STORE_CODE } from "../config";
import { officeExceptions, sendPharmacyExceptionDigest } from "../index";
import { pharmacyLeakage } from "../leakage";
import { captureSupplierInvoice } from "../opening-stock";
import { askRetailDiscount, previewRetailSale, recordRetailLicence, sellRetail } from "../retail";
import { acceptRetailReturn } from "../retail-returns";
import type { OpeningGridRow } from "../opening-stock";
import type { RetailSaleView } from "../retail";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { DocumentStore } from "../../../kernel/documents/store";
import type { PhoneMessage, PhonePushSender } from "../../../kernel/push/fcm";

/**
 * ACCEPTANCE — issue #1065, spec docs/specs/1065-pharmacy-exception-digest.md (owner APPROVED 2026-11-14, ruling
 * 0097): the day's pharmacy exceptions, each with rupees, who, when and a link, on an Exceptions page only the owner
 * reads, and a phone notification to the owner at 08:00 IST for the day before. The page's own half (the screen
 * sorts and totals; the bell opens the day) is the web's: apps/web/src/screens/acceptance/exception-digest-1065.test.tsx.
 *
 * Dates come from the real clock (today's IST day), never pinned; acts are stamped a few seconds apart from the
 * test's start, and a test that would straddle IST midnight waits it out first (#1056).
 */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const MIDNIGHT_GUARD_MS = 180_000;
const RIGHT = "pharmacy.exceptions.view";
const docs: DocumentStore = { put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} };
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

const istDay = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
/** 08:00 IST, `plusDays` after the IST day `day`. */
const at0800 = (day: string, plusDays: number): Date => new Date(Date.parse(`${day}T08:00:00+05:30`) + plusDays * DAY_MS);
const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
async function clearOfIstMidnight(): Promise<void> {
  const left = DAY_MS - ((Date.now() + IST_OFFSET_MS) % DAY_MS);
  if (left < MIDNIGHT_GUARD_MS) await new Promise((r) => setTimeout(r, left + 2_000));
}

describe("the pharmacy's daily exceptions (spec #1065)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let A: Actor;
  let owner: Actor;
  let T0 = 0;
  let today = "";
  const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await clearOfIstMidnight();
    T0 = Date.now();
    today = istDay(new Date(T0));
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    A = fx.pharmacist.actor;
    owner = fx.base.owner;
    await seedSodPairs(db);
    await registerPharmacyApprovalTypes(db, fx.base.activator);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    await openSessionFor(db, { id: fx.pharmacist.id }, 100_000);
    const year = new Date(T0).getUTCFullYear();
    const { resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    const licensee = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
    await recordRetailLicence(db, licensee.actor, {
      form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: `${String(year - 1)}-01-01`, validTo: `${String(year + 3)}-12-31`,
      pharmacistInCharge: "A. Kulkarni",
    }, at(0));
    // ₹12 a tablet (₹120 a strip of 10), so every cash total is whole rupees.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-R", qtyBase: 500, mrpPaise: 12_000, resourceId: retailId, expiryDate: `${String(year + 2)}-12-31` });
  }, MIDNIGHT_GUARD_MS + 60_000);
  afterEach(() => { fx.unregister(); });

  /** The owner's Exceptions page for an IST day. */
  async function page(day: string, who: Actor = owner): Promise<Awaited<ReturnType<typeof officeExceptions>>> {
    await grantPermissionToRole(db, fx.registry, "owner", RIGHT);
    return officeExceptions(db, who, { day }, at(120));
  }

  /** `qty` Crocin tablets sold at the walk-in counter, paid in cash. */
  async function sold(qty: number, when: Date, discount?: { value: number; approvalId?: string; draftId?: string }): Promise<RetailSaleView> {
    const lines = [{ medicineId: fx.med.crocin, qtyBase: qty }];
    const ask = discount === undefined ? undefined : { kind: "percent_bps" as const, value: discount.value, reason: "regular customer" };
    const p = await previewRetailSale(db, A, { patientId: fx.patient.id, lines, ...(ask === undefined ? {} : { discount: ask }) }, when);
    return sellRetail(db, docs, A, {
      customer: { existingId: fx.patient.id }, lines, tenders: [{ mode: "cash", amountPaise: p.byTender!.cash.netPayablePaise }],
      ...(ask === undefined ? {} : { discount: { ...ask, ...(discount!.approvalId === undefined ? {} : { approvalId: discount!.approvalId }) } }),
      ...(discount?.draftId === undefined ? {} : { draftId: discount.draftId }),
    }, undefined, when);
  }

  /** Sealed strips of the whole sale (a multiple of 10) brought back the same day: a credit note and a refund request. */
  async function refunded(qty: number, when: Date): Promise<{ creditNoteId: string; netPaise: number }> {
    const sale = await sold(qty, when);
    const r = await acceptRetailReturn(db, A, sale.id, {
      lines: [{ lineIdx: 0, qtyBase: qty }], sealedIntact: true, reason: "the doctor changed the medicine", reasonClass: "genuine",
    }, undefined, new Date(when.getTime() + 1000));
    const [note] = await db.select({ netPaise: creditNotes.netPaise }).from(creditNotes).where(eq(creditNotes.id, r.creditNoteId));
    return { creditNoteId: r.creditNoteId, netPaise: note!.netPaise };
  }

  /** A blind count of the OPD counter that finds `short` Calpol tablets fewer than the books, approved by the MS and posted. */
  async function adjusted(short: number): Promise<{ valuePaise: number }> {
    for (const role of ["materials_head", "storekeeper", "medical_superintendent"]) await ensureRole(db, role);
    await grantPermissionToRole(db, fx.registry, "materials_head", "materials.counts.manage");
    await grantPermissionToRole(db, fx.registry, "storekeeper", "materials.counts.perform");
    for (const p of ["approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, fx.registry, "medical_superintendent", p);
    const head = await mkUser(db, "mat.head", ["materials_head"]);
    const keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    const ms = await mkUser(db, "ms.approver", ["medical_superintendent"]);
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 30, expiryDate: `${String(new Date(T0).getUTCFullYear() + 2)}-12-31` });
    const count = await scheduleCount(db, head.actor, { storeResourceId: fx.storeId }, at(10));
    const sheet = await countSheet(db, keeper.actor, count.id);
    // The sheet is blind (no quantities, no batch ids): the books are read by batch number.
    const books = new Map<string, number>();
    for (const b of await balances(db, { resourceId: fx.storeId })) {
      const no = (await db.select({ no: stockBatches.batchNo }).from(stockBatches).where(eq(stockBatches.id, b.batchId)))[0]!.no;
      books.set(no, (books.get(no) ?? 0) + b.qtyOnHand);
    }
    await submitCount(db, keeper.actor, count.id, {
      countedAt: at(11).toISOString(),
      lines: sheet.lines.map((l) => ({ lineId: l.lineId, countedQty: (books.get(l.batchNo) ?? 0) - (l.batchNo === "CP-1" ? short : 0) })),
    }, at(12));
    const review = await getCount(db, head.actor, count.id);
    const lineId = review.lines.find((l) => l.batchNo === "CP-1")!.lineId;
    const req = await requestCountAdjustment(db, head.actor, count.id, { lines: [{ lineId, reasonCode: "shrinkage" }], note: "strips missing" }, at(13));
    await approveRequest(db, ms.actor, { approvalId: req.approvalId, note: "book the loss" });
    await postAdjustments(db, head.actor, req.approvalId, at(14));
    return { valuePaise: Math.abs(req.adjustments[0]!.valuePaise) };
  }

  it("spec #1065 D1: a refund, a 15% discount approved by the in-charge and an approved stock adjustment appear on that day's page with rupees, who and a link; a 5% discount does not", async () => {
    const refund = await refunded(10, at(1));

    const approver = await mkUser(db, "ph.ic.two", ["pharmacy_incharge"]);
    const draftId = newId();
    const cart = [{ medicineId: fx.med.crocin, qtyBase: 15 }];
    const asked = await askRetailDiscount(db, A, {
      draftId, patientId: fx.patient.id, lines: cart, discount: { kind: "percent_bps", value: 1500, reason: "regular customer" },
    }, at(3));
    expect(asked.tier).toBe("pharmacy_incharge");
    await approveRequest(db, approver.actor, { approvalId: asked.approvalId, note: "ok" });
    await sold(15, at(4), { value: 1500, approvalId: asked.approvalId, draftId });
    await sold(10, at(5), { value: 500 }); // the pharmacist's own 5%: no approval, no exception

    const { valuePaise } = await adjusted(3);

    const p = await page(today);
    expect(p.day).toBe(today);
    const of = (kind: string) => p.rows.filter((r) => r.kind === kind);
    expect(of("refund")).toEqual([expect.objectContaining({
      paise: refund.netPaise, who: "ph.mehta", link: expect.stringMatching(/^\//), at: expect.any(String),
    })]);
    expect(of("discount")).toEqual([expect.objectContaining({
      paise: asked.amountPaise, who: "ph.ic.two", link: expect.stringMatching(/^\//), at: expect.any(String),
    })]);
    expect(of("stock_adjustment")).toEqual([expect.objectContaining({
      paise: valuePaise, who: "ms.approver", link: expect.stringMatching(/^\//), at: expect.any(String),
    })]);
    expect(valuePaise).toBeGreaterThan(0);
    for (const r of p.rows) {
      expect(typeof r.what).toBe("string");
      expect(r.what.length).toBeGreaterThan(0);
      expect(istDay(new Date(r.at!))).toBe(today);
    }
    // Another day is not this day.
    expect((await page(istDay(new Date(T0 - DAY_MS)))).rows).toEqual([]);
  });

  it("spec #1065 D2: a leakage mismatch and a shift count ₹40 short appear on the page", async () => {
    const sale = await sold(10, at(1));
    const [line] = await db.select({ invoiceLineId: pharmacyRetailSaleLines.invoiceLineId }).from(pharmacyRetailSaleLines)
      .where(eq(pharmacyRetailSaleLines.saleId, sale.id));
    // Three tablets refunded at the billing desk; nothing came back to the shelf.
    await issueCreditNote(db, A, { kind: "refund", invoiceId: sale.invoiceId, reason: "patient complained", lines: [{ invoiceLineId: line!.invoiceLineId, qty: 3 }] }, at(2));
    const leakage = await pharmacyLeakage(db, today, RETAIL_PHARMACY_STORE_CODE);
    expect(leakage.summary.unbilledPaise).toBeGreaterThan(0);

    // The pharmacist's drawer counted ₹40 short at the blind count.
    const session = (await listSessions(db, { cashierUserId: fx.pharmacist.id })).find((s) => s.status === "open")!;
    let left = (await liveExpectedCashPaise(db, session)) - 4_000;
    const denominations: Record<string, number> = {};
    for (const d of [200_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100]) {
      const n = Math.floor(left / d);
      if (n > 0) { denominations[String(d)] = n; left -= n * d; }
    }
    expect(left).toBe(0);
    expect((await submitCountFor(db, { id: fx.pharmacist.id }, denominations)).status).toBe("closing");

    const p = await page(today);
    expect(p.rows.filter((r) => r.kind === "leakage")).toEqual([expect.objectContaining({ paise: leakage.summary.unbilledPaise, link: expect.stringMatching(/^\//) })]);
    const cash = p.rows.filter((r) => r.kind === "cash");
    expect(cash).toEqual([expect.objectContaining({ paise: 4_000, who: "ph.mehta", link: expect.stringMatching(/^\//) })]);
    expect(cash[0]!.what).toMatch(/short/i);
  });

  it("spec #1065 D3: a purchase line captured with a price reason appears with the extra rupees", async () => {
    for (const perm of ["materials.items.manage", "materials.vendors.manage", "materials.grn.capture", "materials.grn.qc", "materials.po.raise", "materials.bills.manage"]) {
      await grantPermissionToRole(db, fx.registry, "pharmacy", perm);
    }
    const supplier = async (code: string): Promise<string> => {
      const { vendorId } = await withTx(db, (tx) => registerVendor(tx, fx.incharge.actor, { code, legalName: `${code} Distributors Pvt Ltd` }));
      await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "gst_certificate", number: "g" }));
      await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "pan", number: "p" }));
      await withTx(db, (tx) => activateVendor(tx, fx.incharge.actor, vendorId, new Date()));
      return vendorId;
    };
    const year = new Date(T0).getUTCFullYear() + 1;
    const alpha = await supplier("ALPHA");
    const bravo = await supplier("BRAVO");
    // Last paid receipt: 800 paise a tablet, two days back.
    const back = new Date(T0 - 2 * DAY_MS);
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
      vendorId: alpha, source: "challan", storeResourceId: fx.storeId, challanNo: "CH-OLD", challanDate: istDay(back), now: back,
      lines: [{ itemId: fx.item.crocin, uom: "strip", qtyInUom: 5, batchNo: "OLD1", expiryDate: `${String(year)}-08-31`, mrpPaise: 12_000, mrpUom: "strip", unitCostPaise: 800 }],
    }));
    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, grnId, back));

    // Today: ₹84 a strip = 840 paise a tablet, 5% above, captured with a reason. 50 tablets × 40 paise = ₹20 extra.
    const row: OpeningGridRow = {
      itemId: fx.item.crocin, batch: "NEW1", expiry: `08/${String(year).slice(2)}`, packSize: "10", packs: "5", freePacks: "", mrpPerPack: "120.00",
      ratePerPack: "84.00", discountPct: "", priceReason: "urgent_buy",
    };
    await captureSupplierInvoice(db, fx.incharge.actor, {
      vendorId: bravo, invoiceNo: "INV-D3", invoiceDate: today, purchaseOrderId: null, storeResourceId: fx.storeId, rateIncludesGst: false,
    }, [row], at(1));

    const p = await page(today);
    expect(p.rows.filter((r) => r.kind === "purchase_price")).toEqual([expect.objectContaining({
      paise: 2_000, who: "ph.incharge", link: expect.stringMatching(/^\//), at: expect.any(String),
    })]);
  });

  it("spec #1065 D4: the page sorts by rupees and totals each kind; without pharmacy.exceptions.view it is refused", async () => {
    const small = await refunded(10, at(1));
    const big = await refunded(20, at(3));
    const { valuePaise } = await adjusted(2);

    const p = await page(today);
    expect(p.rows).toHaveLength(3);
    for (let i = 1; i < p.rows.length; i += 1) expect(p.rows[i - 1]!.paise).toBeGreaterThanOrEqual(p.rows[i]!.paise);
    expect(p.rows.map((r) => r.paise)).toEqual([big.netPaise, small.netPaise, valuePaise].sort((a, b) => b - a));
    const total = (kind: string) => p.totals.find((t) => t.kind === kind);
    expect(total("refund")).toEqual({ kind: "refund", count: 2, paise: small.netPaise + big.netPaise });
    expect(total("stock_adjustment")).toEqual({ kind: "stock_adjustment", count: 1, paise: valuePaise });
    expect(p.count).toBe(3);
    expect(p.totalPaise).toBe(small.netPaise + big.netPaise + valuePaise);

    // The counter's pharmacists hold no right to it: the owner alone does (ruling 0097).
    await expect(page(today, A)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(page(today, fx.incharge.actor)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("spec #1065 D5: at 08:00 IST the owner gets one notification with the count and total, opening that day's page; a day with no exceptions sends none", async () => {
    const refund = await refunded(10, at(1));
    const second = await mkUser(db, "owner.two", ["owner"]);
    /** A signed-in phone with an address for `userId`. */
    const phone = async (userId: string, token: string): Promise<void> => {
      const deviceRowId = newId();
      await db.insert(authDevices).values({ id: deviceRowId, userId, deviceId: `dev-${token}`, appVersion: "0.19.0", pushToken: token, pushTokenAt: new Date() });
      await db.insert(authSessions).values({ id: newId(), tokenHash: `h-${token}`, userId, expiresAt: new Date(Date.now() + 30 * DAY_MS), deviceRowId });
    };
    await phone(owner.id, "fGx1:APA91b-owner-phone-token-0123456789abcdef");
    await phone(second.id, "fGx1:APA91b-second-owner-token-0123456789abcd");
    await phone(fx.pharmacist.id, "fGx1:APA91b-pharmacist-token-0123456789abcde");

    // 08:00 IST the next day: the digest of today.
    await sendPharmacyExceptionDigest(db, at0800(today, 1));
    // Every holder of the owner role (the fixture's base carries owners of its own) and nobody else gets the bell row.
    const owners = await withTx(db, (tx) => usersHoldingRoleAtScope(tx, "owner", "hospital"));
    expect(owners).toEqual(expect.arrayContaining([owner.id, second.id]));
    const digests = await db.select().from(alerts).where(eq(alerts.kind, "pharmacy_exception_digest"));
    expect(digests.map((a) => a.userId).sort()).toEqual([...owners].sort());
    expect(digests.map((a) => a.userId)).not.toContain(fx.pharmacist.id);
    for (const a of digests) expect(a).toMatchObject({ refType: "pharmacy_exceptions_day", refId: today });

    // The phone relay sends what the bell raised: one notification per owner phone, count and rupees, no patient text.
    const sent: { token: string; message: PhoneMessage }[] = [];
    const sender: PhonePushSender = { send: (token, message) => { sent.push({ token, message }); return Promise.resolve("sent"); } };
    const relay = phonePushConsumer(db, fixedPhonePushSource(sender));
    const raised = async () => (await db.select().from(events).where(and(eq(events.name, "alert.raised"), inArray(events.module, ["alerts"]))))
      .filter((e) => (e.payload as { kind?: unknown }).kind === "pharmacy_exception_digest");
    for (const e of await raised()) {
      await relay({ seq: e.seq, eventId: e.eventId, name: e.name, payload: e.payload, patientId: e.patientId, correlationId: e.correlationId, occurredAt: e.occurredAt });
    }
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.message.body).toBe(`Pharmacy: 1 exception yesterday, ${rupees(refund.netPaise)}`);
      expect(s.message.data).toEqual({ category: "reminder", link: "pharmacyExceptions" });
      expect(s.message.body).not.toContain("Crocin");
    }
    expect(sent.map((s) => s.token)).not.toContain("fGx1:APA91b-pharmacist-token-0123456789abcde");

    // A second run, or a second worker, raises nothing twice.
    await sendPharmacyExceptionDigest(db, at0800(today, 1));
    await sendPharmacyExceptionDigest(db, new Date(at0800(today, 1).getTime() + 60_000));
    expect(await db.select().from(alerts).where(eq(alerts.kind, "pharmacy_exception_digest"))).toHaveLength(owners.length);
    expect(await raised()).toHaveLength(owners.length);

    // The next day had no exceptions: nothing is raised for it.
    await sendPharmacyExceptionDigest(db, at0800(today, 2));
    expect(await db.select().from(alerts).where(eq(alerts.kind, "pharmacy_exception_digest"))).toHaveLength(owners.length);
  });
});
