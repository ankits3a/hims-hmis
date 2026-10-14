import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  events, invoiceLines, invoices, ipdAdmissions, ipdChargeExceptions, ipdChargeLines, ipdDepositAlerts, ipdEmarIssues, ipdEmarLabels, ipdFinalBills,
  pharmacySaleItems, services, stockBalances, stockBatches,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkEmarWorld } from "../../../../test/helpers/ipd";
import { mkTpaDesk } from "../../../../test/helpers/ipd-payer";
import { BillingError, issueInvoice, previewInvoice } from "../../billing";
import { postMovement } from "../../materials";
import { gstCategoryMap, invoiceInputsOf, priceBatchLine } from "../../pharmacy";
import { upsertGstCategory } from "../../tariff";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ipdManifest } from "../manifest";
import {
  IpdError, IpdRefusal, addPayerNonPayable, administerDose, composeFinalBill, confirmCharges, declareFit, issueGatePass, issueMed, keepOrderCharge,
  markDoseInError, placeIpOrder, prepareFinalBill, prepareSupplementaryBill, readBillDesk, readEmarPatient, readInterimBill, readLabelSheet,
  readPharmacyQueue, recordNarcoticWastage, recordPayerAuth, registerIpdOrderChargeSink, retryFromBillDesk, returnMed, reverseChargeLine,
  saveSummaryDraft, scanGatePass, secondCheck, settleFinalBill, signSummary, verifyOrder,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { EmarWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * #787 — MEDICINES ISSUED TO THE WARD ON THE IPD RUNNING BILL. Each `it` is one "done means" of the issue or one rule of
 * its spec, against the REAL eMAR, pharmacy price function, billing and discharge. Explicit IST instants; nothing reads
 * the clock for a date. 2026-03-11 is a Wednesday.
 *
 * The shelf: every medicine is a strip of 10 at an MRP of ₹10.00 (100 paise a tablet, GST 12 % INSIDE the MRP), unless a
 * test adds its own batch.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const UNIT = 100;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof IpdRefusal || e instanceof IpdError || e instanceof BillingError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("#787 — ward-issued medicines and returns post to the IPD running bill", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;
  let tpa: Actor;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkEmarWorld(db);
    tpa = await mkTpaDesk(db);
    await withTx(db, (tx) => upsertGstCategory(tx, w.tariffDrafter, { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null }));
    const registry = new ModuleRegistry();
    registry.install(ipdManifest);
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "t_bill_desk", "ipd.billdesk.view");
    off.push(registerIpdOrderChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  const T0 = ist("2026-03-11T07:00:00");
  const ISSUE_AT = ist("2026-03-11T07:40:00");
  const drugLines = async (admissionId: string) => (await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId))
    .orderBy(asc(ipdChargeLines.postedAt), asc(ipdChargeLines.drugSeq), asc(ipdChargeLines.id))).filter((l) => l.component === "pharmacy");
  /** The pharmacy lines still standing (not a reversal, not reversed). */
  const liveDrug = async (admissionId: string) => {
    const all = await drugLines(admissionId);
    const gone = new Set(all.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
    return all.filter((l) => l.reversalOf === null && !gone.has(l.id));
  };
  const openExceptions = async (admissionId: string) => (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId)))
    .filter((x) => x.resolvedAt === null && x.component === "pharmacy");
  const onHand = async (batchId: string) => (await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, w.storeId), eq(stockBalances.batchId, batchId))))[0]?.qtyOnHand ?? 0;
  const addBatch = async (itemId: string, opts: { mrpPaise: number | null; qty: number; expiry: string }) => {
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId, batchNo: `DB-${batchId.slice(-6)}`, expiryDate: opts.expiry, mrpPaise: opts.mrpPaise, mrpUom: opts.mrpPaise === null ? null : "strip",
      landedCostPaise: 500, ownership: "owned", createdBy: HEAD.id,
    } as never);
    await withTx(db, (tx) => postMovement(tx, HEAD, { resourceId: w.storeId, batchId, qtyDelta: opts.qty, reason: "grn", refType: "test", refId: batchId, occurredAt: new Date("2026-01-01T00:00:00Z") }));
    return batchId;
  };
  const order = async (admissionId: string, medicineId: string, drug: Record<string, unknown> = {}) => {
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: T0.toISOString(), antibiotic: false, durationDays: 5, ...drug },
    }, { now: T0 });
    await verifyOrder(db, w.pharmacist, {
      idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: { allergy: true, interaction: true, dose: true, duplicate: true }, note: "checked",
    }, { now: ist("2026-03-11T07:30:00") });
    return placed.orderId;
  };
  const issue = (orderId: string, units: number, extra: Record<string, unknown> = {}, at: Date = ISSUE_AT) =>
    issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId, units, ownMedicine: false, ...extra }, { now: at });
  const giveBack = (issueId: string, units: number, at: Date) =>
    returnMed(db, w.pharmacist, { idempotencyKey: key(), issueId, units, reason: "Course stopped early" }, { now: at });
  /** Admit on 10 March, one stocked medicine ordered, verified and `units` of it issued at 07:40 on the 11th. */
  async function ready(units = 6, opts: { name?: string; stock?: Parameters<EmarWorld["stocked"]>[1]; drug?: Record<string, unknown> } = {}) {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked(opts.name ?? `Zemox ${String(Math.random()).slice(2, 7)}`, opts.stock);
    const orderId = await order(admissionId, med.medicineId, opts.drug);
    const issued = await issue(orderId, units);
    return { admissionId, patientId, med, orderId, issueId: issued.issueId };
  }
  const fitAndReady = async (admissionId: string, day: string) => {
    await declareFit(db, w.doctor, { idempotencyKey: key(), admissionId, when: "today", disposition: "home" }, { now: ist(`${day}T09:00:00`) });
    await confirmCharges(db, w.duty, { idempotencyKey: key(), admissionId, department: "ward" }, { now: ist(`${day}T09:05:00`) });
    await confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "billing" }, { now: ist(`${day}T09:06:00`) });
    const d = await saveSummaryDraft(db, w.doctor, { idempotencyKey: key(), admissionId, expectedVersion: 0, content: { diagnosis: { text: "Fever" } } }, { now: ist(`${day}T09:07:00`) });
    await signSummary(db, w.doctor, { idempotencyKey: key(), admissionId, draftId: d.summaryId, draftVersion: d.version }, { now: ist(`${day}T09:08:00`) });
  };
  const settle = async (admissionId: string, at: Date) => {
    const b = await prepareFinalBill(db, w.cashier, admissionId, { now: at });
    return settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise, settlement: "paid",
      payments: b.balancePaise > 0 ? [{ tender: "cash", amountPaise: b.balancePaise }] : [],
    }, { now: at });
  };
  const voidLiveBills = (admissionId: string, at: Date) => db.update(ipdFinalBills)
    .set({ voidedAt: at, voidedBy: w.billDesk.id, voidReason: "Fixture void", voidApprovalId: "fixture" } as never)
    .where(and(eq(ipdFinalBills.admissionId, admissionId), isNull(ipdFinalBills.voidedAt)));
  /** A settled final bill over the given lines, written directly (the orderbill suite's fixture). */
  const settleBillOver = async (admissionId: string, lineIds: string[], at: Date) => {
    await db.insert(ipdFinalBills).values({
      id: newId(), admissionId, billVersion: lineIds.length, totalPaise: 0, payerPaise: 0, patientPaise: 0, depositAppliedPaise: 0, paidPaise: 0,
      refundPaise: 0, duesPaise: 0, settlement: "paid", split: {}, settledBy: w.billDesk.id, settledAt: at, kind: "final", seq: 0, lineIds,
    } as never);
  };

  it("done 1 — a ward issue posts one line per issued batch at the pharmacy counter's own price, marked with order, issue, batch and units", async () => {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Twobatch 500", { qty: 4 });
    // A second batch that expires later: FEFO takes 4 from the first and 6 from this one.
    const later = await addBatch(med.itemId, { mrpPaise: 1200, qty: 50, expiry: "2031-06-30" });
    const orderId = await order(admissionId, med.medicineId);
    const issued = await issue(orderId, 10);

    const lines = await drugLines(admissionId);
    expect(lines.map((l) => [l.source, l.component, l.orderId, l.issueId, l.batchId, l.qty, l.drugSeq, l.serviceDate]).sort()).toEqual([
      ["ipd.pharmacy", "pharmacy", orderId, issued.issueId, med.batchId, 4, 0, "2026-03-11"],
      ["ipd.pharmacy", "pharmacy", orderId, issued.issueId, later, 6, 0, "2026-03-11"],
    ].sort());
    // The price IS the counter's: pharmacy `priceBatchLine` priced by billing's `previewInvoice`, per batch.
    const gst = await gstCategoryMap(db);
    for (const l of lines) {
      const priced = await priceBatchLine(db, gst, { itemId: med.itemId, batchId: l.batchId!, qtyBase: l.qty }, ISSUE_AT);
      const counter = await previewInvoice(db, { lines: invoiceInputsOf(priced), roundingRule: "exact" }, ISSUE_AT);
      expect([l.unitPaise, l.grossPaise, l.netPaise, l.cgstPaise + l.sgstPaise])
        .toEqual([counter.lines[0]!.unitPaise, counter.totals.grossPaise, counter.totals.rawTotalPaise, counter.totals.cgstPaise + counter.totals.sgstPaise]);
    }
    const byBatch = new Map(lines.map((l) => [l.batchId, l] as const));
    // MRP ₹10 a strip of 10 → ₹1.00 a tablet; MRP ₹12 → ₹1.20. The GST is INSIDE the MRP, never on top of it.
    expect([byBatch.get(med.batchId)!.netPaise, byBatch.get(later)!.netPaise]).toEqual([4 * UNIT, 6 * 120]);
    expect(lines.every((l) => l.gstRateBps === 1200 && l.cgstPaise > 0 && l.taxablePaise + l.cgstPaise + l.sgstPaise === l.netPaise)).toBe(true);
    // One transaction with the stock movement: the shelf and the bill moved together.
    expect([await onHand(med.batchId), await onHand(later)]).toEqual([0, 44]);
    // The store is the one the eMAR issues from.
    expect((await db.select().from(ipdEmarIssues).where(eq(ipdEmarIssues.id, issued.issueId)))[0]!.storeId).toBe(w.storeId);
    // No invoice was raised by the pharmacy for this patient.
    expect(await db.select().from(invoices).where(eq(invoices.patientId, patientId))).toEqual([]);
  });

  it("done 1 — a strip whose MRP does not divide is still ONE line for its batch, at the loose-MRP ruling's amount", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Oddstrip 500", { qty: 1 });
    const odd = await addBatch(med.itemId, { mrpPaise: 1055, qty: 40, expiry: "2031-06-30" });
    const orderId = await order(admissionId, med.medicineId);
    await issue(orderId, 12, { batchId: odd });
    const [line] = await drugLines(admissionId);
    // One full strip at exactly ₹10.55 and two loose tablets at ₹1.05 (rounded down): ₹12.65, not 12 × ₹1.05.
    expect([line!.qty, line!.unitPaise, line!.grossPaise, line!.netPaise]).toEqual([12, 105, 1265, 1265]);
    expect(await drugLines(admissionId)).toHaveLength(1);
  });

  it("done 2 — a return posts a reversal and the kept units at the ORIGINAL price; never an edit, a delete, or today's price", async () => {
    const r = await ready(10);
    const [first] = await drugLines(r.admissionId);
    expect([first!.qty, first!.netPaise]).toEqual([10, 10 * UNIT]);
    // The shelf price moves after the issue: a return must not read it.
    await db.update(stockBatches).set({ mrpPaise: 9000 }).where(eq(stockBatches.id, r.med.batchId));
    const back = await giveBack(r.issueId, 3, ist("2026-03-11T15:00:00"));
    expect(back).toEqual({ returnId: back.returnId, units: 3, creditedUnits: 3 });

    let all = await drugLines(r.admissionId);
    expect(all.map((l) => [l.source, l.qty, l.netPaise, l.drugSeq, l.reversalOf])).toEqual([
      ["ipd.pharmacy", 10, 1000, 0, null],
      ["ipd.reversal", 10, -1000, 0, first!.id],
      ["ipd.pharmacy", 7, 700, 1, null],
    ]);
    expect(all[1]!.reason).toMatch(/^returned to pharmacy \(3 of 10\)/);
    expect((await liveDrug(r.admissionId)).map((l) => [l.qty, l.unitPaise, l.netPaise, l.issueId, l.batchId])).toEqual([[7, UNIT, 700, r.issueId, r.med.batchId]]);
    expect(await onHand(r.med.batchId)).toBe(93);

    // A second return, then the rest: the chain ends at nothing — every paisa of the first line is credited, once.
    await giveBack(r.issueId, 4, ist("2026-03-11T16:00:00"));
    expect((await liveDrug(r.admissionId)).map((l) => [l.qty, l.netPaise, l.drugSeq])).toEqual([[3, 300, 2]]);
    await giveBack(r.issueId, 3, ist("2026-03-11T17:00:00"));
    all = await drugLines(r.admissionId);
    expect(await liveDrug(r.admissionId)).toEqual([]);
    for (const f of ["grossPaise", "discountPaise", "taxablePaise", "cgstPaise", "sgstPaise", "netPaise"] as const) expect(all.reduce((t, l) => t + l[f], 0)).toBe(0);
    expect(await codeOf(giveBack(r.issueId, 1, ist("2026-03-11T18:00:00")))).toBe("return_exceeds_issue");
    // Append-only: the table refuses an edit and a delete.
    await expect(db.execute(sql`update ipd_charge_lines set net_paise = 0 where id = ${first!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from ipd_charge_lines where id = ${first!.id}`)).rejects.toThrow();
  });

  it("done 2 — repeated returns of an odd strip never leak a paisa: kept units always carry the first line's cumulative share", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Oddreturn 500", { qty: 1 });
    const odd = await addBatch(med.itemId, { mrpPaise: 1055, qty: 40, expiry: "2031-06-30" });
    const orderId = await order(admissionId, med.medicineId);
    const issued = await issue(orderId, 12, { batchId: odd });
    await giveBack(issued.issueId, 5, ist("2026-03-11T15:00:00"));
    // 1265 × 5 / 12 = 527.08 → 527 goes back; 738 stays on 7 tablets.
    expect((await liveDrug(admissionId)).map((l) => [l.qty, l.grossPaise, l.netPaise])).toEqual([[7, 738, 738]]);
    await giveBack(issued.issueId, 7, ist("2026-03-11T16:00:00"));
    expect((await drugLines(admissionId)).reduce((t, l) => t + l.netPaise, 0)).toBe(0);
  });

  it("done 3 — the patient's own medicines are never charged: not at issue, not at return", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Ownmed 500");
    const orderId = await order(admissionId, med.medicineId);
    const own = await issueMed(db, w.pharmacist, {
      idempotencyKey: key(), orderId, units: 8, ownMedicine: true, ownBatch: { batchNo: "PT-1", expiry: "2027-01-31" },
    }, { now: ISSUE_AT });
    expect(await drugLines(admissionId)).toEqual([]);
    expect(await openExceptions(admissionId)).toEqual([]);
    expect(await onHand(med.batchId)).toBe(100);
    const back = await giveBack(own.issueId, 2, ist("2026-03-11T15:00:00"));
    expect(back.creditedUnits).toBe(0);
    expect(await drugLines(admissionId)).toEqual([]);
    expect((await readInterimBill(db, w.billDesk, admissionId)).byComponent.filter((c) => c.component === "pharmacy")).toEqual([]);
  });

  it("done 4 — the lines are on the interim and the final bill; the final invoice carries them tax-inclusive at the frozen price", async () => {
    const r = await ready(10);
    await giveBack(r.issueId, 4, ist("2026-03-11T15:00:00"));
    const interim = await readInterimBill(db, w.billDesk, r.admissionId);
    expect(interim.byComponent.find((c) => c.component === "pharmacy")).toEqual({ component: "pharmacy", netPaise: 600 });
    expect(interim.days.flatMap((d) => d.lines).filter((l) => l.component === "pharmacy" && !l.reversed && l.reversalOf === null).map((l) => [l.source, l.qty, l.netPaise]))
      .toEqual([["ipd.pharmacy", 6, 600]]);

    // The shelf price and the sale item change before the bill: the invoice still carries what the stay was charged.
    await db.update(stockBatches).set({ mrpPaise: 9000 }).where(eq(stockBatches.id, r.med.batchId));
    await fitAndReady(r.admissionId, "2026-03-12");
    const view = await prepareFinalBill(db, w.cashier, r.admissionId, { now: ist("2026-03-12T09:30:00") });
    expect(view.lines.filter((l) => l.component === "pharmacy").map((l) => [l.qty, l.netPaise, l.patientPaise])).toEqual([[6, 600, 600]]);
    const done = await settle(r.admissionId, ist("2026-03-12T09:30:00"));
    const bill = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.id, done.billId)))[0]!;
    const [kept] = await liveDrug(r.admissionId);
    expect(bill.lineIds).toContain(kept!.id);
    const onInvoice = (await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, bill.invoiceId!))).filter((l) => l.serviceId === kept!.serviceId);
    // ₹6.00 for 6 tablets, the GST carved OUT of it — the patient never pays tax on top of an MRP.
    expect(onInvoice.map((l) => [l.qty, l.unitPaise, l.taxableBasePaise + l.cgstPaise + l.sgstPaise, l.taxableBasePaise, l.cgstPaise]))
      .toEqual([[6, UNIT, 600, kept!.taxablePaise, kept!.cgstPaise]]);
    // The stay's total is the invoice's: nothing was re-priced, so no phantom payer claim appears.
    expect([bill.totalPaise, bill.payerPaise]).toEqual([bill.patientPaise, 0]);
  });

  it("done 4 — an issue after the final bill settled goes to the supplementary bill", async () => {
    const r = await ready(6);
    await fitAndReady(r.admissionId, "2026-03-12");
    const done = await settle(r.admissionId, ist("2026-03-12T09:30:00"));
    // Still in the bed: the ward asks for more of the same medicine after the bill.
    const more = await issue(r.orderId, 4, { reissue: { reason: "extra_supply", note: "Two more days" } }, ist("2026-03-12T11:00:00"));
    const extra = (await drugLines(r.admissionId)).find((l) => l.issueId === more.issueId)!;
    const bill = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.id, done.billId)))[0]!;
    expect(bill.lineIds).not.toContain(extra.id);
    const supp = await prepareSupplementaryBill(db, w.cashier, r.admissionId, { now: ist("2026-03-12T11:30:00") });
    expect(supp.lines.filter((l) => l.component === "pharmacy").map((l) => [l.lineId, l.qty, l.netPaise])).toEqual([[extra.id, 4, 400]]);
  });

  it("done 4 — the payer split takes the lines: an insurer pays a medicine unless the non-payables list names it", async () => {
    const r = await ready(10);
    await recordPayerAuth(db, tpa, {
      idempotencyKey: key(), admissionId: r.admissionId, payerKind: "insurance_cashless", entry: "initial", status: "approved",
      provisionalCashlessSigned: true, approvedAmountPaise: 50_000_000,
    }, { now: ist("2026-03-11T08:00:00") });
    const [line] = await liveDrug(r.admissionId);
    const shareOf = async () => {
      const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, r.admissionId)))[0]!;
      const s = (await composeFinalBill(db, a)).live.find((x) => x.line.id === line!.id)!;
      return [s.payerPaise, s.patientPaise];
    };
    expect(await shareOf()).toEqual([1000, 0]);
    // The existing payer seam for a non-covered line: the list names the medicine's tariff category.
    await addPayerNonPayable(db, tpa, { matchKind: "category", matchValue: "pharmacy", reason: "Policy excludes medicines" });
    expect(await shareOf()).toEqual([0, 1000]);
  });

  it("done 5 — no double charge: a pharmacy invoice on the admission number is refused by code, and the ward issue raised none", async () => {
    const r = await ready(6);
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, r.admissionId)))[0]!;
    const priced = await priceBatchLine(db, await gstCategoryMap(db), { itemId: r.med.itemId, batchId: r.med.batchId, qtyBase: 6 }, ISSUE_AT);
    // The counter's own bill shape (batch-priced, tax-inclusive lines + a tender), aimed at the IP number.
    const attempt = issueInvoice(db, w.cashier, {
      draftId: newId(), patientId: r.patientId, encounterId: a.admissionNo!, lines: invoiceInputsOf(priced), roundingRule: "nearest_rupee_any_cash",
      receipt: { tenders: [{ mode: "cash", amountPaise: 600 }] },
    } as never, ISSUE_AT);
    expect(await codeOf(attempt)).toBe("ipd_running_bill");
    expect(await db.select().from(invoices).where(eq(invoices.patientId, r.patientId))).toEqual([]);
    // Charged once: one live line for the issue, and a retried issue (the same key) posts nothing more.
    expect((await liveDrug(r.admissionId)).map((l) => l.netPaise)).toEqual([600]);
    const k = key();
    const orderId2 = await order(r.admissionId, (await w.stocked("Retry 500")).medicineId);
    const one = await issueMed(db, w.pharmacist, { idempotencyKey: k, orderId: orderId2, units: 2, ownMedicine: false }, { now: ISSUE_AT });
    const two = await issueMed(db, w.pharmacist, { idempotencyKey: k, orderId: orderId2, units: 2, ownMedicine: false }, { now: ISSUE_AT });
    expect(two.issueId).toBe(one.issueId);
    expect((await drugLines(r.admissionId)).filter((l) => l.issueId === one.issueId)).toHaveLength(1);
  });

  it("missing price — a batch with no MRP raises rate_missing and posts nothing (never ₹0); Retry prices the units still with the patient", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Noprice 500", { qty: 1 });
    const bare = await addBatch(med.itemId, { mrpPaise: null, qty: 40, expiry: "2031-06-30" });
    const orderId = await order(admissionId, med.medicineId);
    const issued = await issue(orderId, 10, { batchId: bare });
    expect(await drugLines(admissionId)).toEqual([]);
    const open = await openExceptions(admissionId);
    expect(open.map((x) => [x.reason, x.component, x.key.split(":")[3], x.errorCode])).toEqual([["rate_missing", "pharmacy", `${issued.issueId}.${bare}`, "price_unknown"]]);
    // The stock still left the shelf — the ward got its medicine; only the money waits.
    expect(await onHand(bare)).toBe(30);
    const desk = (await readBillDesk(db, w.billDesk, ISSUE_AT)).rows.find((x) => x.admissionId === admissionId)!;
    expect(desk.reasons).toContain("rate_missing");
    // A retry with the price still missing posts nothing and keeps the record.
    await retryFromBillDesk(db, w.billDesk, admissionId, ist("2026-03-11T12:00:00"));
    expect([await drugLines(admissionId), (await openExceptions(admissionId)).length]).toEqual([[], 1]);
    // Three tablets come back before the price is fixed: nothing to credit yet.
    await giveBack(issued.issueId, 3, ist("2026-03-11T13:00:00"));
    expect(await drugLines(admissionId)).toEqual([]);
    // The pharmacy records the MRP; Retry posts the SEVEN tablets the patient still has, once.
    await db.update(stockBatches).set({ mrpPaise: 1000, mrpUom: "strip" }).where(eq(stockBatches.id, bare));
    await retryFromBillDesk(db, w.billDesk, admissionId, ist("2026-03-11T14:00:00"));
    await retryFromBillDesk(db, w.billDesk, admissionId, ist("2026-03-11T14:05:00"));
    expect((await drugLines(admissionId)).map((l) => [l.qty, l.netPaise, l.issueId, l.batchId, l.serviceDate])).toEqual([[7, 700, issued.issueId, bare, "2026-03-11"]]);
    expect(await openExceptions(admissionId)).toEqual([]);
  });

  it("missing price — a medicine whose GST slab is not configured, or priced at ₹0, is an exception too", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const noSlab = await w.stocked("Noslab 500");
    const sale = (await db.select().from(pharmacySaleItems).where(eq(pharmacySaleItems.itemId, noSlab.itemId)))[0]!;
    await db.update(services).set({ category: "pharmacy_18" }).where(eq(services.id, sale.serviceId));
    await issue(await order(admissionId, noSlab.medicineId), 2);
    const zero = await w.stocked("Zeroprice 500", { qty: 1 });
    const free = await addBatch(zero.itemId, { mrpPaise: 0, qty: 40, expiry: "2031-06-30" });
    await issue(await order(admissionId, zero.medicineId), 2, { batchId: free });
    expect(await drugLines(admissionId)).toEqual([]);
    expect((await openExceptions(admissionId)).map((x) => [x.reason, x.errorCode]).sort()).toEqual([["rate_missing", "gst_slab_unknown"], ["rate_missing", "price_zero"]]);
  });

  it("re-issue — lost or damaged is charged and flagged for the bill desk, which waives or keeps it; extra supply is charged with no flag", async () => {
    const r = await ready(6);
    const lost = await issue(r.orderId, 6, { reissue: { reason: "lost", note: "Strip fell behind the bed" } }, ist("2026-03-11T09:00:00"));
    const extra = await issue(r.orderId, 4, { reissue: { reason: "extra_supply", note: "Two more days" } }, ist("2026-03-11T09:30:00"));
    const live = await liveDrug(r.admissionId);
    expect(live.map((l) => [l.issueId, l.netPaise])).toEqual([[r.issueId, 600], [lost.issueId, 600], [extra.issueId, 400]]);
    const lostLine = live.find((l) => l.issueId === lost.issueId)!;
    expect((await openExceptions(r.admissionId)).map((x) => [x.reason, x.key.split(":")[3]])).toEqual([["reissue_lost_damaged", lostLine.id]]);
    const row = (await readBillDesk(db, w.billDesk, ist("2026-03-11T10:00:00"))).rows.find((x) => x.admissionId === r.admissionId)!;
    expect(row.reasons).toContain("reissue_lost_damaged");
    expect(row.orderCancels?.map((c) => [c.chargeLineId, c.reason])).toEqual([[lostLine.id, "reissue_lost_damaged"]]);
    // Billing waives it with a reason: a reversal line, and the flag closes.
    expect(await codeOf(reverseChargeLine(db, w.billDesk, { chargeLineId: lostLine.id, reason: " " }))).toBe("reversal_reason_required");
    await reverseChargeLine(db, w.billDesk, { chargeLineId: lostLine.id, reason: "Ward's fault, not the patient's" }, { now: ist("2026-03-11T10:05:00") });
    expect(await openExceptions(r.admissionId)).toEqual([]);
    expect((await liveDrug(r.admissionId)).map((l) => l.issueId)).toEqual([r.issueId, extra.issueId]);

    // A damaged replacement that billing KEEPS: the charge stands and the flag closes with the reason.
    const damaged = await issue(r.orderId, 2, { reissue: { reason: "damaged", note: "Vial cracked" } }, ist("2026-03-11T11:00:00"));
    const damagedLine = (await liveDrug(r.admissionId)).find((l) => l.issueId === damaged.issueId)!;
    expect(await keepOrderCharge(db, w.billDesk, { chargeLineId: damagedLine.id, reason: "Patient dropped it" }, { now: ist("2026-03-11T11:05:00") })).toEqual({ resolved: 1 });
    expect(await openExceptions(r.admissionId)).toEqual([]);
    expect((await liveDrug(r.admissionId)).map((l) => l.issueId)).toContain(damaged.issueId);
  });

  it("return after the bill — never a silent reversal: a bill-desk decision; after the void billing credits exactly the returned units", async () => {
    const r = await ready(10);
    const [line] = await liveDrug(r.admissionId);
    await settleBillOver(r.admissionId, [line!.id], ist("2026-03-11T10:00:00"));
    await giveBack(r.issueId, 3, ist("2026-03-11T11:00:00"));
    await giveBack(r.issueId, 2, ist("2026-03-11T11:30:00"));
    // The stock is back on the shelf; the settled bill's line is untouched.
    expect(await onHand(r.med.batchId)).toBe(95);
    expect((await drugLines(r.admissionId)).map((l) => [l.source, l.qty])).toEqual([["ipd.pharmacy", 10]]);
    const open = await openExceptions(r.admissionId);
    expect(open.map((x) => [x.reason, x.key.split(":")[3]])).toEqual([["return_after_bill", line!.id], ["return_after_bill", line!.id]]);
    const row = (await readBillDesk(db, w.billDesk, ist("2026-03-11T12:00:00"))).rows.find((x) => x.admissionId === r.admissionId)!;
    expect(row.reasons).toContain("return_after_bill");
    expect(row.orderCancels?.map((c) => [c.chargeLineId, c.reason])).toEqual([[line!.id, "return_after_bill"]]);
    // Behind a live bill the reversal is refused.
    expect(await codeOf(reverseChargeLine(db, w.billDesk, { chargeLineId: line!.id, reason: "Returned" }))).toBe("charge_line_billed");
    // Billing voids the bill (#763) and reverses: the five returned tablets come off, the five kept stay — at ₹1.00.
    await voidLiveBills(r.admissionId, ist("2026-03-11T12:30:00"));
    await reverseChargeLine(db, w.billDesk, { chargeLineId: line!.id, reason: "Returned after the bill" }, { now: ist("2026-03-11T12:35:00") });
    expect((await liveDrug(r.admissionId)).map((l) => [l.qty, l.netPaise, l.drugSeq])).toEqual([[5, 500, 1]]);
    expect(await openExceptions(r.admissionId)).toEqual([]);
  });

  it("return after the bill — a return that waited on a voided bill is credited with the next return, never lost", async () => {
    const r = await ready(10);
    const [line] = await liveDrug(r.admissionId);
    await settleBillOver(r.admissionId, [line!.id], ist("2026-03-11T10:00:00"));
    await giveBack(r.issueId, 3, ist("2026-03-11T11:00:00"));
    await voidLiveBills(r.admissionId, ist("2026-03-11T12:00:00"));
    // The bill is gone and a second return arrives before billing has answered the first: both come off, once.
    await giveBack(r.issueId, 2, ist("2026-03-11T12:30:00"));
    expect((await liveDrug(r.admissionId)).map((l) => [l.qty, l.netPaise])).toEqual([[5, 500]]);
    expect(await openExceptions(r.admissionId)).toEqual([]);
  });

  it("return after the bill — billing may keep the charge with a reason; the decision closes and the line stands", async () => {
    const r = await ready(10);
    const [line] = await liveDrug(r.admissionId);
    await settleBillOver(r.admissionId, [line!.id], ist("2026-03-11T10:00:00"));
    await giveBack(r.issueId, 3, ist("2026-03-11T11:00:00"));
    expect(await keepOrderCharge(db, w.billDesk, { chargeLineId: line!.id, reason: "Refunded by credit note at the counter" }, { now: ist("2026-03-11T12:00:00") })).toEqual({ resolved: 1 });
    expect(await openExceptions(r.admissionId)).toEqual([]);
    expect((await liveDrug(r.admissionId)).map((l) => [l.qty, l.netPaise])).toEqual([[10, 1000]]);
  });

  it("a give marked entered in error has no money effect, and a narcotic wastage reverses nothing", async () => {
    const r = await ready(6, { name: "Morphine 10 mg inj", stock: { narcotic: true, form: "injection", strength: "10 mg/ml" }, drug: { dose: { value: 5, unit: "mg" }, route: "iv" } });
    const before = (await drugLines(r.admissionId)).map((l) => [l.id, l.netPaise]);
    expect(before).toHaveLength(1);
    const band = await w.band(r.admissionId);
    const labelCode = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, r.issueId)))[0]!.code;
    const due = ist("2026-03-11T08:00:00");
    const proofFor = (purpose: "high_alert_dose" | "narcotic_wastage", at: Date, doseDueAt?: Date) => secondCheck(db, w.nurse, {
      idempotencyKey: key(), purpose, orderId: r.orderId, username: w.pins.nurse2.username, pin: w.pins.nurse2.pin, ...(doseDueAt ? { doseDueAt: doseDueAt.toISOString() } : {}),
    }, { now: at });
    const p = await proofFor("high_alert_dose", due, due);
    const given = await administerDose(db, w.nurse, {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: due.toISOString(),
      patientCheck: { kind: "scan", wristbandCode: band }, labelCode, secondNurse: { userId: w.nurse2.id, pinProof: p.pinProof },
    }, { now: due });
    await markDoseInError(db, w.nurse, { idempotencyKey: key(), actId: given.administrationId, kind: "entered_in_error", reason: "Charted on the wrong patient" }, { now: ist("2026-03-11T08:10:00") });
    const wp = await proofFor("narcotic_wastage", ist("2026-03-11T08:20:00"));
    await recordNarcoticWastage(db, w.nurse, { idempotencyKey: key(), orderId: r.orderId, qty: 0.5, reason: "Half ampoule unused", witness: { userId: w.nurse2.id, pinProof: wp.pinProof } }, { now: ist("2026-03-11T08:20:00") });
    expect((await drugLines(r.admissionId)).map((l) => [l.id, l.netPaise])).toEqual(before);
    expect(await openExceptions(r.admissionId)).toEqual([]);
  });

  it("the deposit ladder re-checks the moment a ward issue posts", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await db.update(ipdAdmissions).set({ depositRequiredPaise: 500, depositExemption: null, payerKind: "cash" } as never).where(eq(ipdAdmissions.id, admissionId));
    const med = await w.stocked("Ladder 500");
    const orderId = await order(admissionId, med.medicineId);
    expect(await db.select().from(ipdDepositAlerts).where(eq(ipdDepositAlerts.admissionId, admissionId))).toEqual([]);
    await issue(orderId, 10);
    expect((await db.select().from(ipdDepositAlerts).where(eq(ipdDepositAlerts.admissionId, admissionId))).length).toBeGreaterThan(0);
  });

  it("decision 0058 — no money on the pharmacist's or the nurse's screen: the issue, the return, the queue, the label sheet and the eMAR carry none", async () => {
    const MONEY = /paise|price|amount|mrp|deposit|balance|tariff|bill|charge|payer|receipt|gross|net(?!work)/i;
    const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
      return out;
    };
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Quiet 500");
    const orderId = await order(admissionId, med.medicineId);
    const queue = await readPharmacyQueue(db, w.pharmacist, { now: ISSUE_AT });
    const issued = await issue(orderId, 6);
    const back = await giveBack(issued.issueId, 1, ist("2026-03-11T09:00:00"));
    const answers = [
      issued, back, queue, await readPharmacyQueue(db, w.pharmacist, { now: ist("2026-03-11T09:05:00") }),
      await readLabelSheet(db, w.pharmacist, issued.issueId), await readEmarPatient(db, w.nurse, admissionId, { now: ist("2026-03-11T09:05:00") }),
    ];
    for (const a of answers) expect([...keysOf(a)].filter((k) => MONEY.test(k))).toEqual([]);
    // The posting really happened — the money is on the running bill, and only there.
    expect((await liveDrug(admissionId)).map((l) => l.netPaise)).toEqual([500]);
    const emar = (await db.select().from(events).where(eq(events.correlationId, admissionId))).filter((e) => e.name.startsWith("ipd.emar.") || e.name.startsWith("ipd.order."));
    expect(emar.length).toBeGreaterThan(0);
    for (const e of emar) expect([...keysOf(e.payload)].filter((k) => MONEY.test(k))).toEqual([]);
  });

  it("concurrency — an issue racing the discharge: stock and charge move together or not at all", async () => {
    const r = await ready(6);
    const med2 = await w.stocked("Racer 500");
    const orderId2 = await order(r.admissionId, med2.medicineId);
    await fitAndReady(r.admissionId, "2026-03-12");
    await settle(r.admissionId, ist("2026-03-12T09:30:00"));
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId: r.admissionId }, { now: ist("2026-03-12T10:00:00") });
    const at = ist("2026-03-12T10:20:00");
    const [issued, scanned] = await Promise.allSettled([
      issue(orderId2, 4, {}, at),
      scanGatePass(db, w.duty, { idempotencyKey: key(), gatePassCode: pass.code, gateId: newId(), scannedAt: at.toISOString() }, { now: at }),
    ]);
    expect(scanned.status).toBe("fulfilled");
    const lines = (await drugLines(r.admissionId)).filter((l) => l.orderId === orderId2);
    const moved = 100 - (await onHand(med2.batchId));
    if (issued.status === "fulfilled") {
      // The issue won the admission lock: the line is on the running bill (the supplementary bill's) and the stock left.
      expect([lines.map((l) => [l.qty, l.netPaise]), moved]).toEqual([[[4, 400]], 4]);
    } else {
      // The discharge won: the issue is refused whole — no stock moved, nothing charged.
      expect(issued.reason).toBeInstanceOf(IpdRefusal);
      expect([lines, moved]).toEqual([[], 0]);
    }
    // After the exit a new issue is always refused, and still charges nothing.
    expect(await codeOf(issue(orderId2, 1, issued.status === "fulfilled" ? { reissue: { reason: "extra_supply", note: "late" } } : {}, ist("2026-03-12T11:00:00")))).toBe("order_not_active");
    expect((await drugLines(r.admissionId)).filter((l) => l.orderId === orderId2)).toHaveLength(issued.status === "fulfilled" ? 1 : 0);
  });

  it("concurrency — a return racing the settle: credited before the bill, or a bill-desk decision after it; never both, never neither", async () => {
    for (let round = 0; round < 3; round += 1) {
      const r = await ready(10, { name: `Settlerace ${String(round)}` });
      await fitAndReady(r.admissionId, "2026-03-12");
      const at = ist("2026-03-12T09:30:00");
      const b = await prepareFinalBill(db, w.cashier, r.admissionId, { now: at });
      const [first] = await liveDrug(r.admissionId);
      const [back, settled] = await Promise.allSettled([
        giveBack(r.issueId, 4, at),
        settleFinalBill(db, w.cashier, {
          idempotencyKey: key(), admissionId: r.admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise, settlement: "paid",
          payments: b.balancePaise > 0 ? [{ tender: "cash", amountPaise: b.balancePaise }] : [],
        }, { now: at }),
      ]);
      // The return itself always lands: the stock is back whatever the bill says.
      expect(back.status).toBe("fulfilled");
      expect(await onHand(r.med.batchId)).toBe(94);
      const live = await liveDrug(r.admissionId);
      const decisions = (await openExceptions(r.admissionId)).filter((x) => x.reason === "return_after_bill");
      const bills = await db.select().from(ipdFinalBills).where(and(eq(ipdFinalBills.admissionId, r.admissionId), isNull(ipdFinalBills.voidedAt)));
      if (settled.status === "fulfilled") {
        if (decisions.length === 1) {
          // The settle won the lock: the bill took the ten-tablet line and the return waits on the bill desk.
          expect([live.map((l) => [l.id, l.qty]), bills[0]!.lineIds.includes(first!.id)]).toEqual([[[first!.id, 10]], true]);
        } else {
          // The return won the lock and the cashier's read was already of the credited bill (never a stale total).
          expect([decisions, live.map((l) => l.qty)]).toEqual([[], [6]]);
          expect(bills[0]!.lineIds).toContain(live[0]!.id);
        }
      } else {
        // The return won the lock: the bill changed under the cashier, who is told so and settles the credited bill.
        expect((settled.reason as IpdRefusal).code).toBe("bill_changed");
        expect([decisions, live.map((l) => [l.qty, l.netPaise]), bills]).toEqual([[], [[6, 600]], []]);
      }
    }
  });
});
