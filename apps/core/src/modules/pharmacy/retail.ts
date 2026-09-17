import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import {
  pharmacyRegH1, pharmacyRetailLicences, pharmacyRetailSaleLines, pharmacyRetailSales, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { getInvoice, issueInvoice, previewInvoice, withIdempotency } from "../billing";
import { medicinesByIds } from "../formulary";
import {
  MaterialsError, availableQty, availableQtyByItem, balances, fefoPick, findStoreByCode, getBatch, itemsByIds, postMovements,
  resolveBarcode,
} from "../materials";
import { runRxChecks } from "../opd";
import { captureDocument, getPatient, nearMatches, registerPatient, resolvePatientId } from "../patients";
import { gstCategoryMap, priceBatchLine, winnerOf } from "./bill";
import {
  REFUSED_FLAGS, REGISTER_FLAGS, RETAIL_PHARMACY_STORE_CODE, RETAIL_REF_TYPE, SCHEDULED_FLAGS, isIsoDate, istDateOf,
} from "./config";
import { PharmacyError } from "./errors";
import { retailLicenceRecorded, retailSold } from "./events";
import { PHARMACY_IDEMPOTENT_ROUTES } from "./pharmacy-http";
import { parseGs1 } from "./gs1";
import { requireRegisteredPharmacist } from "./pharmacists";
import { resolveScan } from "./scan";
import { shelfByMedicine } from "./shelf";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { MedicineWithSalts } from "../formulary";
import type { StoreRow } from "../materials";
import type { RxCheckOutcome, RxLine } from "../opd";
import type { RegisterPatientInput } from "../patients";

/**
 * ═══ PHARMACY P19 — WALK-IN RETAIL SALES ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p19-retail-sales.md`.
 *
 *   previewRetailSale (prices the cart, reports the gates, writes nothing)
 *   sellRetail        (one transaction: customer, prescription photo, stock, invoice, register)
 *
 * - **Not a dispense (R-1).** No visit and no prescriber in this hospital, so no order. The ledger,
 *   the price rule, billing and the H1 register are the counter's own.
 * - **The licence (R-2).** No sale without a current Form 20/21 licence for `PHARM-RETAIL`.
 * - **Every sale names a registered person (R-4).** Found by the counter or registered by it, under
 *   `patients.register` asserted here (the OPD walk-in precedent).
 * - **Schedule H and H1 (R-5).** Only on an outside prescription: prescriber's name, registration
 *   number and address, the date, and a photo. Sold by a registered pharmacist. Schedule X refused.
 * - **Clinical checks (R-7).** An allergy match or a severe interaction refuses the sale. No
 *   override here: no prescriber in this hospital decided anything.
 */
const SELL = "pharmacy.retail.sell";
const MANAGE = "pharmacy.retail.manage";

async function requirePermission(db: Db, actor: Actor, permission: string, what: string): Promise<string> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, permission, "hospital"))) {
    throw new PharmacyError("permission_denied", `${what} needs ${permission}`);
  }
  return actor.id;
}

export async function retailStore(db: Db): Promise<StoreRow> {
  const store = await findStoreByCode(db, RETAIL_PHARMACY_STORE_CODE);
  if (store === undefined) {
    throw new PharmacyError("retail_store_missing", `the ${RETAIL_PHARMACY_STORE_CODE} store does not exist — seed:pharmacy creates it on deploy`);
  }
  return store;
}

// ═══════════════════════════════════ THE LICENCE (R-2) ═══════════════════════════════════

export type RetailLicenceView = {
  id: string;
  form20No: string;
  form21No: string;
  validFrom: string;
  validTo: string;
  pharmacistInCharge: string;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
};

export type RetailLicenceState = {
  storeCode: string;
  storePresent: boolean;
  /** `current` is the only state in which the counter sells. */
  state: "no_store" | "missing" | "not_yet_valid" | "lapsed" | "current";
  licence: RetailLicenceView | null;
  /** Days from today to the last valid day; null without a licence. */
  daysLeft: number | null;
};

type LicenceRow = typeof pharmacyRetailLicences.$inferSelect;

function licenceView(r: LicenceRow): RetailLicenceView {
  return {
    id: r.id, form20No: r.form20No, form21No: r.form21No, validFrom: r.validFrom, validTo: r.validTo,
    pharmacistInCharge: r.pharmacistInCharge, note: r.note, recordedBy: r.recordedBy, recordedAt: r.recordedAt.toISOString(),
  };
}

async function latestLicence(db: Db, storeId: string): Promise<LicenceRow | undefined> {
  const [row] = await db.select().from(pharmacyRetailLicences)
    .where(eq(pharmacyRetailLicences.storeResourceId, storeId))
    .orderBy(desc(pharmacyRetailLicences.recordedAt), desc(pharmacyRetailLicences.id))
    .limit(1);
  return row;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The licence as the counter and the census read it. Never refuses. */
export async function retailLicenceState(db: Db, now: Date): Promise<RetailLicenceState> {
  const store = await findStoreByCode(db, RETAIL_PHARMACY_STORE_CODE);
  if (store === undefined) return { storeCode: RETAIL_PHARMACY_STORE_CODE, storePresent: false, state: "no_store", licence: null, daysLeft: null };
  const row = await latestLicence(db, store.id);
  if (row === undefined) return { storeCode: RETAIL_PHARMACY_STORE_CODE, storePresent: true, state: "missing", licence: null, daysLeft: null };
  const today = istDateOf(now);
  const state = today < row.validFrom ? "not_yet_valid" : today > row.validTo ? "lapsed" : "current";
  return { storeCode: RETAIL_PHARMACY_STORE_CODE, storePresent: true, state, licence: licenceView(row), daysLeft: daysBetween(today, row.validTo) };
}

export async function listRetailLicences(db: Db, actor: Actor): Promise<RetailLicenceView[]> {
  await requirePermission(db, actor, MANAGE, "reading the retail licence");
  const store = await retailStore(db);
  const rows = await db.select().from(pharmacyRetailLicences)
    .where(eq(pharmacyRetailLicences.storeResourceId, store.id))
    .orderBy(desc(pharmacyRetailLicences.recordedAt), desc(pharmacyRetailLicences.id))
    .limit(100);
  return rows.map(licenceView);
}

export type RecordLicenceInput = {
  form20No: string; form21No: string; validFrom: string; validTo: string; pharmacistInCharge: string; note?: string;
};

/** A new licence row. A renewal or a correction is another row; the latest one is the licence. */
export async function recordRetailLicence(db: Db, actor: Actor, input: RecordLicenceInput, now: Date): Promise<RetailLicenceView> {
  const userId = await requirePermission(db, actor, MANAGE, "recording the retail licence");
  const store = await retailStore(db);
  const form20No = input.form20No.trim();
  const form21No = input.form21No.trim();
  const pharmacistInCharge = input.pharmacistInCharge.trim();
  if (form20No === "" || form21No === "" || pharmacistInCharge === "") {
    throw new PharmacyError("invalid_retail_licence", "the Form 20 and Form 21 numbers and the pharmacist in charge are all required");
  }
  if (!isIsoDate(input.validFrom) || !isIsoDate(input.validTo) || input.validTo < input.validFrom) {
    throw new PharmacyError("invalid_retail_licence", "the licence needs a valid-from and a valid-to date, the second not before the first");
  }
  const note = input.note?.trim() ?? "";
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(pharmacyRetailLicences).values({
      id, storeResourceId: store.id, form20No, form21No, validFrom: input.validFrom, validTo: input.validTo,
      pharmacistInCharge, note: note === "" ? null : note, recordedBy: userId, recordedAt: now,
    });
    await appendEvent(tx, retailLicenceRecorded.make({
      occurredAt: now, actor,
      payload: { licenceId: id, storeResourceId: store.id, form20No, form21No, validFrom: input.validFrom, validTo: input.validTo },
    }));
  });
  const row = await latestLicence(db, store.id);
  return licenceView(row!);
}

async function requireCurrentLicence(db: Db, store: StoreRow, now: Date): Promise<LicenceRow> {
  const row = await latestLicence(db, store.id);
  if (row === undefined) {
    throw new PharmacyError("retail_licence_missing", "no Form 20/21 retail licence is recorded — walk-in sales stay closed until it is (Drugs and Cosmetics Act §18(c))");
  }
  const today = istDateOf(now);
  if (today < row.validFrom || today > row.validTo) {
    throw new PharmacyError(
      "retail_licence_lapsed",
      `the retail licence is valid ${row.validFrom} to ${row.validTo}, and today is ${today} — record the renewed licence first`,
      { validFrom: row.validFrom, validTo: row.validTo, today },
    );
  }
  return row;
}

// ═══════════════════════════════════ THE SHELF ═══════════════════════════════════

export type RetailShelfEntry = {
  medicineId: string;
  brandName: string;
  strengthLabel: string | null;
  form: string;
  scheduleFlag: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUom: string;
  available: number;
  /** The batch a scanned GS1 code named, when it did. */
  scannedBatchId: string | null;
};

const SHELF_LIMIT = 20;

function refused(flag: string | null): boolean {
  return flag !== null && (REFUSED_FLAGS as readonly string[]).includes(flag);
}

/**
 * What the retail counter can sell, matched on a typed name or code, or on a scanned pack. Schedule
 * X is never offered (R-5). Bounded by the shelf, never by the national catalogue.
 */
export async function searchRetailShelf(db: Db, actor: Actor, q: string, now: Date): Promise<RetailShelfEntry[]> {
  await requirePermission(db, actor, SELL, "searching the retail shelf");
  const store = await retailStore(db);
  const text = q.trim();
  if (text === "") return [];
  const shelf = await shelfByMedicine(db);
  let scanned: { itemId: string; batchId: string | null } | null = null;
  const gs1 = parseGs1(text);
  for (const code of gs1 === null ? [text] : [gs1.gtin, gs1.gtin.replace(/^0/, ""), text]) {
    const hit = await resolveBarcode(db, code);
    if (hit !== undefined) { scanned = { itemId: hit.itemId, batchId: null }; break; }
  }
  const needle = text.toLowerCase();
  const entries = [...shelf.values()].filter((e) => scanned === null
    ? e.item.code.toLowerCase().includes(needle) || e.item.name.toLowerCase().includes(needle)
    : e.item.id === scanned.itemId);
  const medicines = await medicinesByIds(db, entries.slice(0, 200).map((e) => e.medicineId));
  const offered = entries
    .map((e) => ({ e, m: medicines.get(e.medicineId) }))
    .filter((x): x is { e: typeof x.e; m: MedicineWithSalts } => x.m !== undefined && !refused(x.m.scheduleFlag))
    .filter((x) => scanned !== null || x.m.brandName.toLowerCase().includes(needle) || x.e.item.code.toLowerCase().includes(needle) || x.e.item.name.toLowerCase().includes(needle))
    .slice(0, SHELF_LIMIT);
  if (scanned !== null && gs1 !== null && gs1.batch !== null && offered.length > 0) {
    const scan = await resolveScan(db, store.id, 0, scanned.itemId, text);
    scanned.batchId = scan.batchId;
  }
  const available = await availableQtyByItem(db, store.id, offered.map((x) => x.e.item.id), now);
  return offered.map(({ e, m }) => ({
    medicineId: m.id, brandName: m.brandName, strengthLabel: m.strengthLabel, form: m.form, scheduleFlag: m.scheduleFlag,
    itemId: e.item.id, itemCode: e.item.code, itemName: e.item.name, baseUom: e.item.baseUom,
    available: available.get(e.item.id) ?? 0, scannedBatchId: scanned?.batchId ?? null,
  }));
}

// ═══════════════════════════════════ THE CART ═══════════════════════════════════

export type RetailLineInput = {
  medicineId: string;
  /** In the item's base unit (tablets, ml). */
  qtyBase: number;
  /** A later batch than FEFO offers, named. */
  batchId?: string;
  /** The code read off the pack in hand (P13): it must be this line's item. */
  scan?: string;
};

type PlannedLine = {
  lineIdx: number;
  medicine: MedicineWithSalts;
  itemId: string;
  batchId: string;
  qtyBase: number;
  fefoOverride: boolean;
  scheduleFlag: string | null;
};

function isScheduled(flag: string | null): boolean {
  return flag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(flag);
}

async function planLines(db: Db, storeId: string, lines: readonly RetailLineInput[], now: Date): Promise<PlannedLine[]> {
  if (lines.length === 0) throw new PharmacyError("nothing_to_dispense", "the cart is empty");
  if (lines.length > 50) throw new PharmacyError("qty_required", "a walk-in sale carries at most 50 lines");
  const shelf = await shelfByMedicine(db);
  const medicines = await medicinesByIds(db, lines.map((l) => l.medicineId));
  const plan: PlannedLine[] = [];
  for (const [lineIdx, line] of lines.entries()) {
    const n = String(lineIdx + 1);
    if (!Number.isSafeInteger(line.qtyBase) || line.qtyBase <= 0) {
      throw new PharmacyError("qty_required", `line ${n}: a quantity is a whole number above zero`, { lineIdx });
    }
    const medicine = medicines.get(line.medicineId);
    if (medicine === undefined) throw new PharmacyError("unresolved_medicine", `line ${n}: unknown medicine`, { lineIdx });
    const entry = shelf.get(medicine.id);
    if (entry === undefined) {
      throw new PharmacyError("unknown_sale_item", `line ${n}: ${medicine.brandName} is not a stocked sale item`, { lineIdx });
    }
    const scheduleFlag = medicine.scheduleFlag;
    if (refused(scheduleFlag)) {
      throw new PharmacyError(
        "schedule_x_not_dispensed_here",
        `line ${n}: ${medicine.brandName} is Schedule ${String(scheduleFlag)} — not sold at the retail counter until double custody (16d)`,
        { lineIdx, scheduleFlag },
      );
    }
    const itemId = entry.item.id;
    const scan = line.scan !== undefined && line.scan.trim() !== "" ? await resolveScan(db, storeId, lineIdx, itemId, line.scan) : undefined;
    if (scan?.batchId != null && line.batchId !== undefined && line.batchId !== scan.batchId) {
      throw new PharmacyError("scan_batch_mismatch", `line ${n}: the scanned pack is batch ${scan.batchNo ?? ""}, not the batch named`, { lineIdx });
    }
    const named = scan?.batchId ?? line.batchId;
    const offered = await fefoPick(db, storeId, itemId, line.qtyBase, now);
    if (named !== undefined) {
      const batch = await getBatch(db, named);
      if (batch !== undefined && batch.expiryDate !== null && batch.expiryDate < istDateOf(now)) {
        throw new PharmacyError("batch_expired", `line ${n}: batch ${batch.batchNo} expired on ${batch.expiryDate} — it cannot be sold`, { lineIdx, batchId: named, expiryDate: batch.expiryDate });
      }
      const rows = await balances(db, { resourceId: storeId, batchId: named });
      const available = rows.reduce((s, b) => s + b.qtyOnHand - b.qtyReserved - b.qtyFrozen, 0);
      if (batch === undefined || batch.itemId !== itemId || batch.recallStatus !== "none" || available < line.qtyBase) {
        throw new PharmacyError("fefo_override_unavailable", `line ${n}: batch ${named} cannot cover ${String(line.qtyBase)} at the retail store`, { lineIdx, available });
      }
      plan.push({ lineIdx, medicine, itemId, batchId: named, qtyBase: line.qtyBase, fefoOverride: offered[0]?.batchId !== named, scheduleFlag });
      continue;
    }
    const first = offered[0];
    if (first === undefined || first.qty < line.qtyBase) {
      const available = await availableQty(db, storeId, itemId, now);
      throw new PharmacyError(
        "short_stock",
        `line ${n}: the earliest batch holds ${String(first?.qty ?? 0)} of ${String(line.qtyBase)} (${String(available)} across batches) — sell less, or split the line across batches`,
        { lineIdx, offered, available },
      );
    }
    plan.push({ lineIdx, medicine, itemId, batchId: first.batchId, qtyBase: line.qtyBase, fefoOverride: false, scheduleFlag });
  }
  return plan;
}

/** "Azee 500 500 mg tablet": what the register and the bill call a medicine. */
function drugNameOf(m: MedicineWithSalts | undefined): string | undefined {
  return m === undefined ? undefined : `${m.brandName}${m.strengthLabel === null ? "" : ` ${m.strengthLabel}`} ${m.form}`;
}

function checkLinesOf(plan: readonly PlannedLine[]): RxLine[] {
  return plan.map((p) => ({
    drug: p.medicine.brandName, medicineId: p.medicine.id, dose: "", route: p.medicine.routeClass, frequency: "",
    durationDays: null, instructions: null, noSubstitution: false,
  }));
}

/** R-7 — the blocks, with no override at this counter. */
function refuseOnChecks(outcome: RxCheckOutcome): void {
  if (outcome.allergyMatches.length > 0) {
    throw new PharmacyError(
      "allergy_block",
      `the customer is recorded allergic to ${outcome.allergyMatches.map((m) => m.substance).join(", ")} — do not sell; refer them to their prescriber`,
      { hits: outcome.allergyMatches.map((m) => ({ lineIdx: m.lineIndex, substance: m.substance })) },
    );
  }
  const severe = outcome.interactions.filter((h) => h.severity === "severe");
  if (severe.length > 0) {
    throw new PharmacyError(
      "interaction_block",
      `a severe interaction: ${severe.map((h) => h.note).join("; ")} — do not sell; refer them to their prescriber`,
      { hits: severe.map((h) => ({ lineIdx: h.lineIndex, saltPair: h.saltPair, note: h.note })) },
    );
  }
}

export type RetailPreview = {
  licence: RetailLicenceState;
  prescriptionRequired: boolean;
  lines: {
    lineIdx: number; medicineId: string; brandName: string; strengthLabel: string | null; form: string; scheduleFlag: string | null;
    itemId: string; batchId: string; batchNo: string; expiryDate: string | null; qtyBase: number; fefoOverride: boolean;
  }[];
  totals: { grossPaise: number; discountPaise: number; taxPaise: number; netPayablePaise: number };
  /** Null when no customer was named yet: nothing to check against. */
  checks: {
    allergies: { lineIdx: number; substance: string }[];
    interactions: { lineIdx: number; severity: string; note: string }[];
    duplicates: number;
    partlyCheckedLineIdxs: number[];
  } | null;
};

/** The cart, priced and judged. Writes nothing and refuses only what the cart itself makes impossible. */
export async function previewRetailSale(
  db: Db, actor: Actor, input: { patientId?: string; lines: RetailLineInput[] }, now: Date,
): Promise<RetailPreview> {
  await requirePermission(db, actor, SELL, "pricing a walk-in sale");
  const store = await retailStore(db);
  const licence = await retailLicenceState(db, now);
  const plan = await planLines(db, store.id, input.lines, now);
  const gst = await gstCategoryMap(db);
  const priced: Awaited<ReturnType<typeof priceBatchLine>>[] = [];
  for (const p of plan) priced.push(await priceBatchLine(db, gst, p, now));
  const patientId = input.patientId === undefined ? undefined : (await resolvePatientId(db, input.patientId)) ?? undefined;
  if (input.patientId !== undefined && patientId === undefined) throw new PharmacyError("not_found", `patient ${input.patientId} not found`);
  const draft = await previewInvoice(db, { ...(patientId === undefined ? {} : { patientId }), lines: priced.map((x) => x.input) }, now);
  let checks: RetailPreview["checks"] = null;
  if (patientId !== undefined) {
    const outcome = await runRxChecks(db, patientId, checkLinesOf(plan), now);
    checks = {
      allergies: outcome.allergyMatches.map((m) => ({ lineIdx: m.lineIndex, substance: m.substance })),
      interactions: outcome.interactions.map((h) => ({ lineIdx: h.lineIndex, severity: h.severity, note: h.note })),
      duplicates: outcome.duplicates.length,
      partlyCheckedLineIdxs: outcome.unreviewedLineIndexes,
    };
  }
  const batches = new Map<string, Awaited<ReturnType<typeof getBatch>>>();
  for (const p of plan) batches.set(p.batchId, await getBatch(db, p.batchId));
  return {
    licence,
    prescriptionRequired: plan.some((p) => isScheduled(p.scheduleFlag)),
    lines: plan.map((p) => ({
      lineIdx: p.lineIdx, medicineId: p.medicine.id, brandName: p.medicine.brandName, strengthLabel: p.medicine.strengthLabel,
      form: p.medicine.form, scheduleFlag: p.scheduleFlag, itemId: p.itemId, batchId: p.batchId,
      batchNo: batches.get(p.batchId)?.batchNo ?? "", expiryDate: batches.get(p.batchId)?.expiryDate ?? null,
      qtyBase: p.qtyBase, fefoOverride: p.fefoOverride,
    })),
    totals: {
      grossPaise: draft.totals.grossPaise, discountPaise: draft.totals.discountPaise,
      taxPaise: draft.totals.cgstPaise + draft.totals.sgstPaise, netPayablePaise: draft.totals.netPayablePaise,
    },
    checks,
  };
}

// ═══════════════════════════════════ THE SALE ═══════════════════════════════════

export type RetailCustomerInput =
  | { existingId: string }
  | { register: Pick<RegisterPatientInput, "name" | "sex" | "ageYears" | "phone" | "addressLine">; acknowledgedDuplicates?: boolean };

export type RetailPrescriptionInput = {
  prescriberName: string;
  prescriberRegNo: string;
  prescriberAddress: string;
  rxDate: string;
  photo: { mimeType: string; bytes: Buffer };
};

export type RetailSaleInput = {
  customer: RetailCustomerInput;
  lines: RetailLineInput[];
  prescription?: RetailPrescriptionInput;
  tenders: { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string }[];
  panNumber?: string;
  form60?: boolean;
  changeGivenPaise?: number;
};

function cleanPrescription(rx: RetailPrescriptionInput, now: Date): Omit<RetailPrescriptionInput, "photo"> {
  const out = {
    prescriberName: rx.prescriberName.trim(), prescriberRegNo: rx.prescriberRegNo.trim(),
    prescriberAddress: rx.prescriberAddress.trim(), rxDate: rx.rxDate.trim(),
  };
  if (out.prescriberName === "" || out.prescriberRegNo === "" || out.prescriberAddress === "") {
    throw new PharmacyError("invalid_prescription", "the prescription needs the prescriber's name, registration number and address, as written on it");
  }
  if (!isIsoDate(out.rxDate) || out.rxDate > istDateOf(now)) {
    throw new PharmacyError("invalid_prescription", "the prescription's date is a real date, not after today", { rxDate: out.rxDate });
  }
  return out;
}

export async function sellRetail(
  db: Db, documents: DocumentStore, actor: Actor, input: RetailSaleInput, idempotencyKey: string | undefined, now: Date,
): Promise<RetailSaleView> {
  const userId = await requirePermission(db, actor, SELL, "a walk-in sale");
  const { prescription: rxInput, ...hashable } = input;
  const bodyForHash = { ...hashable, prescription: rxInput === undefined ? null : { ...rxInput, photo: rxInput.photo.bytes.toString("base64") } };
  const saleId = await withIdempotency(db, { actorId: userId, route: PHARMACY_IDEMPOTENT_ROUTES.retailSale, key: idempotencyKey }, bodyForHash, async () => {
    const store = await retailStore(db);
    const licence = await requireCurrentLicence(db, store, now);

    const who = input.customer;
    const registerInput = "register" in who ? who.register : null;
    let existingId: string | null = null;
    if ("register" in who) {
      // The registration permission, asserted HERE because a second route decorator would overwrite the first.
      if (!(await hasPermission(db, userId, "patients.register", "hospital"))) {
        throw new PharmacyError("registration_not_permitted", "this account may sell but not register a customer — find them by mobile or UHID");
      }
      if (who.acknowledgedDuplicates !== true) {
        const candidates = await nearMatches(db, actor, who.register);
        if (candidates.length > 0) {
          throw new PharmacyError("duplicate_suspected", `${String(candidates.length)} registered person(s) closely match — pick one, or confirm this is someone new`, { candidates });
        }
      }
    } else {
      existingId = await resolvePatientId(db, who.existingId);
      if (existingId === null) throw new PharmacyError("not_found", `patient ${who.existingId} not found`);
    }

    const plan = await planLines(db, store.id, input.lines, now);
    const scheduled = plan.some((p) => isScheduled(p.scheduleFlag));
    const rx = rxInput === undefined ? null : cleanPrescription(rxInput, now);
    let pharmacistRegNo: string | null = null;
    if (scheduled) {
      if (rx === null) {
        const first = plan.find((p) => isScheduled(p.scheduleFlag))!;
        throw new PharmacyError(
          "prescription_required",
          `line ${String(first.lineIdx + 1)}: ${first.medicine.brandName} is Schedule ${String(first.scheduleFlag)} — sold only on a prescription (Drugs and Cosmetics Rules r.65(9)); capture it, or remove the line`,
          { lineIdxs: plan.filter((p) => isScheduled(p.scheduleFlag)).map((p) => p.lineIdx) },
        );
      }
      if (!(await hasPermission(db, userId, "pharmacy.dispense.scheduled", "hospital"))) {
        throw new PharmacyError("scheduled_needs_pharmacist", "a Schedule H/H1 sale is made by a registered pharmacist (Pharmacy Act 1948 §42) — call one to the counter");
      }
      pharmacistRegNo = (await requireRegisteredPharmacist(db, actor, now)).registrationNo;
    }
    if (existingId !== null) refuseOnChecks(await runRxChecks(db, existingId, checkLinesOf(plan), now));

    const gst = await gstCategoryMap(db);
    const priced: Awaited<ReturnType<typeof priceBatchLine>>[] = [];
    for (const p of plan) priced.push(await priceBatchLine(db, gst, p, now));
    const medicineNames = new Map(plan.map((p) => [p.lineIdx, drugNameOf(p.medicine)!]));
    const itemRows = await itemsByIds(db, plan.map((p) => p.itemId));

    const id = newId();
    await withTx(db, async (tx) => {
      let patientId: string;
      let registeredHere = false;
      if (existingId !== null) {
        patientId = existingId;
      } else {
        patientId = (await registerPatient(tx, actor, registerInput!)).patient.id;
        registeredHere = true;
      }
      let rxDocumentId: string | null = null;
      if (rxInput !== undefined && rx !== null) {
        rxDocumentId = (await captureDocument(tx, documents, actor, patientId, {
          kind: "outside_prescription", mimeType: rxInput.photo.mimeType, bytes: rxInput.photo.bytes,
          note: `walk-in sale: ${rx.prescriberName} (${rx.prescriberRegNo}), ${rx.rxDate}`,
        }, now)).documentId;
      }
      const lineIds = plan.map(() => newId());
      let moved: { ledgerEntryId: string }[];
      try {
        moved = await postMovements(tx, actor, plan.map((p, i) => ({
          resourceId: store.id, batchId: p.batchId, qtyDelta: -p.qtyBase, reason: "consume" as const,
          refType: RETAIL_REF_TYPE, refId: lineIds[i]!, patientId, occurredAt: now,
        })));
      } catch (e) {
        // Two lines of one batch, or a sale at the next counter: the ledger's lock said no.
        if (e instanceof MaterialsError && (e.code === "insufficient_stock" || e.code === "negative_stock")) {
          throw new PharmacyError("short_stock", "the shelf no longer holds this cart — preview it again", { cause: e.message });
        }
        throw e;
      }
      const result = await issueInvoice(tx as unknown as Db, actor, {
        draftId: id, patientId, lines: priced.map((x) => x.input),
        receipt: {
          tenders: input.tenders,
          ...(input.panNumber === undefined ? {} : { panNumber: input.panNumber }),
          ...(input.form60 === undefined ? {} : { form60: input.form60 }),
          ...(input.changeGivenPaise === undefined ? {} : { changeGivenPaise: input.changeGivenPaise }),
        },
      }, now);
      const stored = await getInvoice(tx, result.invoiceId);
      if (stored === null) throw new PharmacyError("not_found", `invoice ${result.invoiceId} vanished inside its own transaction`);
      const byNo = [...stored.lines].sort((a, b) => a.lineNo - b.lineNo);

      await tx.insert(pharmacyRetailSales).values({
        id, storeResourceId: store.id, licenceId: licence.id, patientId, registeredHere, scheduled,
        rxPrescriberName: rx?.prescriberName ?? null, rxPrescriberRegNo: rx?.prescriberRegNo ?? null,
        rxPrescriberAddress: rx?.prescriberAddress ?? null, rxDate: rx?.rxDate ?? null, rxDocumentId,
        invoiceId: result.invoiceId, pharmacistRegNo, soldBy: userId, soldAt: now,
      });
      const patient = (await getPatient(tx as unknown as Db, actor, patientId))?.patient;
      let h1Rows = 0;
      const eventLines = [];
      for (const [i, p] of plan.entries()) {
        const row = byNo[i];
        if (row === undefined) throw new PharmacyError("not_found", `invoice line ${String(i + 1)} missing`);
        const ledgerEntryId = moved[i]!.ledgerEntryId;
        await tx.insert(pharmacyRetailSaleLines).values({
          id: lineIds[i]!, saleId: id, lineIdx: p.lineIdx, medicineId: p.medicine.id, itemId: p.itemId, batchId: p.batchId,
          qtyBase: p.qtyBase, ledgerEntryId, invoiceLineId: row.id, unitPaise: row.unitPaise,
          priceWinner: winnerOf(row, { winner: priced[i]!.winner, batchUnitPaise: priced[i]!.input.batchUnitPaise ?? null }),
          scheduleFlag: p.scheduleFlag, fefoOverride: p.fefoOverride,
        });
        if (p.scheduleFlag !== null && (REGISTER_FLAGS as readonly string[]).includes(p.scheduleFlag) && rx !== null) {
          const batch = await getBatch(tx, p.batchId);
          await tx.insert(pharmacyRegH1).values({
            id: newId(), retailLineId: lineIds[i]!, dispensedAt: now, patientId,
            patientName: patient?.name ?? "", patientAddress: patient?.addressLine ?? null,
            prescriberName: rx.prescriberName, prescriberRegNo: rx.prescriberRegNo, prescriberAddress: rx.prescriberAddress,
            drugName: medicineNames.get(p.lineIdx)!, medicineId: p.medicine.id, batchNo: batch?.batchNo ?? p.batchId,
            qtyBase: p.qtyBase, unit: itemRows.get(p.itemId)?.baseUom ?? "unit", recordedBy: userId, pharmacistRegNo,
          });
          h1Rows += 1;
        }
        eventLines.push({
          lineIdx: p.lineIdx, medicineId: p.medicine.id, itemId: p.itemId, batchId: p.batchId, qtyBase: p.qtyBase,
          scheduleFlag: p.scheduleFlag, ledgerEntryId, fefoOverride: p.fefoOverride,
        });
      }
      await appendEvent(tx, retailSold.make({
        occurredAt: now, actor, patientId, correlationId: id,
        payload: {
          saleId: id, patientId, invoiceId: result.invoiceId, storeResourceId: store.id, licenceId: licence.id,
          registeredHere, scheduled, h1RegisterRows: h1Rows, lines: eventLines,
          netPaise: result.totals.netPayablePaise, pharmacistRegNo,
        },
      }));
    });
    return id;
  }, now);
  return getRetailSale(db, actor, saleId);
}

// ═══════════════════════════════════ READS ═══════════════════════════════════

export type RetailSaleView = {
  id: string;
  soldAt: string;
  soldBy: string;
  /** For the bill: "Dispensed by …" (Rule 65(4) wants the pharmacist on the cash memo). */
  soldByName: string;
  patient: { id: string; uhid: string; name: string; phone: string | null; registeredHere: boolean };
  invoiceId: string;
  invoiceNo: string;
  netPaise: number;
  scheduled: boolean;
  prescription: { prescriberName: string; prescriberRegNo: string; prescriberAddress: string; rxDate: string; documentId: string | null } | null;
  pharmacistRegNo: string | null;
  lines: {
    lineIdx: number; medicineId: string; drugName: string; itemId: string; itemCode: string; itemName: string; batchId: string; batchNo: string;
    expiryDate: string | null; qtyBase: number; baseUom: string; unitPaise: number; scheduleFlag: string | null; fefoOverride: boolean;
  }[];
};

/** One sale, with its customer: a PHI read, logged by the patient module. */
export async function getRetailSale(db: Db, actor: Actor, saleId: string): Promise<RetailSaleView> {
  await requirePermission(db, actor, SELL, "reading a walk-in sale");
  const [sale] = await db.select().from(pharmacyRetailSales).where(eq(pharmacyRetailSales.id, saleId));
  if (sale === undefined) throw new PharmacyError("unknown_retail_sale", `walk-in sale ${saleId} not found`);
  const lines = await db.select().from(pharmacyRetailSaleLines)
    .where(eq(pharmacyRetailSaleLines.saleId, saleId)).orderBy(asc(pharmacyRetailSaleLines.lineIdx));
  const visible = await getPatient(db, actor, sale.patientId);
  if (visible === null) throw new PharmacyError("unknown_retail_sale", `walk-in sale ${saleId} not found`);
  const invoice = await getInvoice(db, sale.invoiceId);
  const items = await itemsByIds(db, lines.map((l) => l.itemId));
  const medicines = await medicinesByIds(db, lines.map((l) => l.medicineId));
  const [seller] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, sale.soldBy));
  const out: RetailSaleView["lines"] = [];
  for (const l of lines) {
    const batch = await getBatch(db, l.batchId);
    const item = items.get(l.itemId);
    out.push({
      lineIdx: l.lineIdx, medicineId: l.medicineId, drugName: drugNameOf(medicines.get(l.medicineId)) ?? item?.name ?? "",
      itemId: l.itemId, itemCode: item?.code ?? "", itemName: item?.name ?? "",
      batchId: l.batchId, batchNo: batch?.batchNo ?? "", expiryDate: batch?.expiryDate ?? null, qtyBase: l.qtyBase,
      baseUom: item?.baseUom ?? "unit", unitPaise: l.unitPaise, scheduleFlag: l.scheduleFlag, fefoOverride: l.fefoOverride,
    });
  }
  return {
    id: sale.id, soldAt: sale.soldAt.toISOString(), soldBy: sale.soldBy, soldByName: seller?.fullName ?? sale.soldBy,
    patient: {
      id: visible.patient.id, uhid: visible.patient.uhid, name: visible.patient.name, phone: visible.patient.phone,
      registeredHere: sale.registeredHere,
    },
    invoiceId: sale.invoiceId, invoiceNo: invoice?.invoice.invoiceNo ?? "", netPaise: invoice?.invoice.netPayablePaise ?? 0,
    scheduled: sale.scheduled,
    prescription: sale.rxPrescriberName === null ? null : {
      prescriberName: sale.rxPrescriberName, prescriberRegNo: sale.rxPrescriberRegNo ?? "",
      prescriberAddress: sale.rxPrescriberAddress ?? "", rxDate: sale.rxDate ?? "", documentId: sale.rxDocumentId,
    },
    pharmacistRegNo: sale.pharmacistRegNo,
    lines: out,
  };
}

export type RetailSaleRow = {
  id: string; soldAt: string; soldBy: string; invoiceId: string; invoiceNo: string; netPaise: number;
  scheduled: boolean; lineCount: number; registeredHere: boolean;
};

/**
 * One IST day's walk-in sales, newest first. No customer is named: the list is the till's, and a
 * sale is opened (and its read logged) to see who bought it.
 */
export async function listRetailSales(db: Db, actor: Actor, day: string): Promise<RetailSaleRow[]> {
  await requirePermission(db, actor, SELL, "listing walk-in sales");
  if (!isIsoDate(day)) throw new PharmacyError("invalid_day", `"${day}" is not a date`);
  const { start, end } = istDayWindow(new Date(`${day}T12:00:00+05:30`));
  const sales = await db.select().from(pharmacyRetailSales)
    .where(and(gte(pharmacyRetailSales.soldAt, start), lt(pharmacyRetailSales.soldAt, end)))
    .orderBy(desc(pharmacyRetailSales.soldAt), desc(pharmacyRetailSales.id)).limit(500);
  const out: RetailSaleRow[] = [];
  for (const s of sales) {
    const invoice = await getInvoice(db, s.invoiceId);
    out.push({
      id: s.id, soldAt: s.soldAt.toISOString(), soldBy: s.soldBy, invoiceId: s.invoiceId,
      invoiceNo: invoice?.invoice.invoiceNo ?? "", netPaise: invoice?.invoice.netPayablePaise ?? 0,
      scheduled: s.scheduled, lineCount: invoice?.lines.length ?? 0, registeredHere: s.registeredHere,
    });
  }
  return out;
}
