import type { WireBillRow, WireBillRowPack } from "./pharmacy-bill";
import { api, ApiError } from "./api";
import en from "../locales/en.json";

/**
 * PLAN 16c — the pharmacy module's wire types and calls. Every shape here is what the server
 * returns, field for field; a field that stops crossing the wire fails a screen test instead of
 * silently vanishing (the `lab-api.ts` posture).
 */
export type WireSaleItem = {
  itemId: string; code: string; name: string; baseUom: string; gstRateBps: number | null;
  serviceId: string; serviceCode: string; category: string; active: boolean; itemActive: boolean;
};

export type WireSaleCandidate = { id: string; code: string; name: string; baseUom: string; gstRateBps: number | null };

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, v);
  const s = p.toString();
  return s === "" ? "" : `?${s}`;
}

export async function fetchSaleItems(q: { search?: string } = {}): Promise<WireSaleItem[]> {
  const { items } = await api<{ items: WireSaleItem[] }>("GET", `/pharmacy/sale-items${qs({ search: q.search })}`);
  return items;
}

export async function fetchSaleCandidates(q: { search?: string } = {}): Promise<WireSaleCandidate[]> {
  const { items } = await api<{ items: WireSaleCandidate[] }>("GET", `/pharmacy/sale-items/candidates${qs({ search: q.search })}`);
  return items;
}

export async function registerSaleItem(itemId: string): Promise<{ itemId: string; serviceId: string; serviceCode: string; category: string }> {
  return api("POST", "/pharmacy/sale-items", { itemId });
}

export async function patchSaleItem(itemId: string, patch: { active: boolean }): Promise<void> {
  await api<{ ok: true }>("PATCH", `/pharmacy/sale-items/${itemId}`, patch);
}

export function pharmacyErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | undefined;
    if (body !== undefined && typeof body.code === "string") return body.code;
  }
  return null;
}

/** A code the locale knows becomes a sentence; anything else is the server's own message. */
export function pharmacyErrorText(e: unknown, t: (key: string) => string): string {
  const code = pharmacyErrorCode(e);
  if (code !== null && Object.prototype.hasOwnProperty.call(en.pharmacyErrors, code)) {
    return t(`pharmacyErrors.${code}`);
  }
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown } | undefined;
    return body !== undefined && typeof body.message === "string" ? body.message : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

// ── T3 — the counter ──
export type WireRxLine = { drug: string; medicineId?: string | null; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null; noSubstitution: boolean };
export type WireMedicine = { id: string; brandName: string; strengthLabel: string | null; form: string; scheduleFlag?: string | null };
export type WireDispenseLine = {
  lineIdx: number; rxLine: WireRxLine; status: string; declinedReason: string | null; substitutionType: string;
  qtyBase: number | null; scheduleFlag: string | null;
  orderedMedicine: WireMedicine | null; dispensedMedicine: WireMedicine | null;
  item: { id: string; code: string; name: string; baseUom: string; uoms: { uom: string; toBaseMultiplier: number }[] } | null;
  saleable: boolean; available: number | null; batchId: string | null; reservationId: string | null; ledgerEntryId: string | null;
  /** PD-D18 — where the item sits in the counter's store ("R-12"). Absent from an older server. */
  location?: string | null;
  /** PD-9 — requests to the prescriber about this line. Absent from an older server. */
  authorisations?: WireLineAuthorisation[];
  orderItemId: string | null; invoiceLineId: string | null; unitPaise: number | null; priceWinner: string | null;
  fefoOverride: boolean; pickNote: string | null;
  /** Pharmacy P3: a component of this line's medicine is not yet reviewed. Absent from an older server. */
  partlyChecked?: boolean;
  /** PD-4 — the sellable batches an OPEN line's pick would draw from, earliest expiry first. Absent from an older server. */
  /** What the bill will ask for this line at today's shelf price (`quote.ts`). Absent from an older server. */
  quote?: WireQuote | null;
  batches?: WireBatch[];
  /** PD-4 — once picked, the batch it was given from. Absent from an older server. */
  pickedBatch?: { batchNo: string; expiryDate: string | null } | null;
  /** The salt(s) of the medicine the doctor wrote ("Amoxicillin + Clavulanic acid"). Absent from an older server. */
  salt?: string | null;
};
export type WireBatch = { batchId: string; batchNo: string; expiryDate: string | null; available: number };
export type WirePatientSummary = { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
export type WireDispense = {
  /** The ticket at today's shelf prices, the server's own sum. Absent from an older server. */
  quotedTotalPaise?: number;
  id: string; status: string; dispenseNo: string | null; orderId: string | null; prescriptionId: string; prescriptionVersion: number;
  encounterId: string; storeResourceId: string | null; scheduled: boolean; invoiceId: string | null; identityConfirmedVia: string | null;
  claimedAt: string | null; verifiedAt: string | null; pickedAt: string | null; billedAt: string | null; handedOverAt: string | null;
  cancelReason: string | null; patient: WirePatientSummary; allergies: { substance: string; severity: string | null }[]; lines: WireDispenseLine[];
  /** PD-1 — who holds it. Absent from an older server. */
  claimedBy?: string | null; claimedByName?: string | null;
  /** PD-8 / E28 — typed from the doctor's paper, by whom, and whether the slip is confirmed. Absent from an older server. */
  transcribedBy?: string | null; transcribedByName?: string | null; slipConfirmedBy?: string | null;
  /** PD-9 — the doctor who wrote this prescription, whom the counter asks. Absent from an older server. */
  prescriberName?: string | null;
};
/** FD-31 — the pharmacist's cross-confirmation of a transcribed prescription against the paper. */
export async function confirmDispenseSlip(id: string): Promise<{ slipConfirmedBy: string | null; slipConfirmedAt: string | null }> {
  return api("POST", `/pharmacy/dispenses/${id}/confirm-slip`, {});
}
export type WireQueueRow = {
  dispenseId: string; status: string; dispenseNo: string | null; scheduled: boolean; lineCount: number;
  createdAt: string; claimedAt: string | null; patient: WirePatientSummary;
  /** What the doctor wrote on that ticket, in order. Absent from an older server. */
  drugs?: string[];
  /** The IST day it was queued — an earlier day's open ticket stays on the line. Absent from an older server. */
  queuedOn?: string;
  /** FD-31 — who typed a paper slip, and whether a pharmacist has cross-confirmed it. */
  transcribedBy?: string | null; slipConfirmedBy?: string | null;
  /** PD-1 — who holds a claimed ticket. Absent from an older server. */
  claimedBy?: string | null; claimedByName?: string | null;
  /** PD-7 / C1 — a waiting ticket checked against the shelf; null once claimed. Absent from an older server. */
  shelf?: WireShelfCheck | null;
};
export type WireShelfCheck = { lines: number; onShelf: number; short: string[]; notStocked: string[]; unplaceable: number; scheduleX: boolean };
export type WireFindResult =
  | { kind: "dispense"; door: string; dispense: WireDispense }
  | { kind: "patients"; door: "uhid"; patients: WirePatientSummary[] }
  | { kind: "none"; door: string; reason: "not_found" | "qr_invalid" | "no_prescription_today" | "restricted" };
/** `about` is what the line says; `key` is the hit's identity, which a PD-9 authorisation names. */
export type WireAlternativeBlock = { book: "allergy" | "interaction" | "duplicate" | "drug_disease"; about: string; key: string };
/** PD-9 — one request to the prescriber about one refusal on one line. */
export type WireLineAuthorisation = {
  id: string; book: string; about: string; status: "pending" | "authorised" | "declined"; requestNote: string | null;
  decisionReason: string | null; requestedAt: string; decidedAt: string | null;
};
/** PD-7 C3 — each equivalent comes back already put to this patient's check, judged as verify judges. */
/** What the bill will ask for a medicine, from the batch the pick would take (`quote.ts`). `lastKnown`: the shelf is empty and this is the last printed MRP. */
export type WireQuote = {
  batchId: string; batchNo: string; expiryDate: string | null; unitPaise: number;
  pack: { uom: string; multiplier: number; paise: number } | null; lastKnown: boolean;
  /** Which bound set the price, and the printed MRP beside it. Absent from an older server. */
  winner?: "batch_mrp" | "ceiling"; mrpUnitPaise?: number | null;
};
export type WireAlternative = {
  medicineId: string; brandName: string; strengthLabel: string | null; form: string; itemId: string; itemCode: string; available: number;
  check: { verdict: "clear" | "not_checked" | "blocked"; blocks: WireAlternativeBlock[] };
  /** Absent from an older server. */
  quote?: WireQuote | null;
};

export async function fetchQueue(): Promise<WireQueueRow[]> {
  const { items } = await api<{ items: WireQueueRow[] }>("GET", "/pharmacy/queue");
  return items;
}
export async function findAtCounter(q: string): Promise<WireFindResult> {
  return api<WireFindResult>("GET", `/pharmacy/find${qs({ q })}`);
}
export async function fetchDispense(id: string): Promise<WireDispense> {
  return api<WireDispense>("GET", `/pharmacy/dispenses/${id}`);
}
/** The board's left rail: who is at the window (`patient-rail.ts`). Read once per ticket, never polled. */
export type WireRailVisit = {
  encounterId: string; serviceDate: string; departmentName: string | null; doctorName: string | null;
  status: string; prescriptionLineCount: number;
};
export type WireRailMedicine = { drug: string; sig: string; since: string };
export type WireRailBenefit = { planTitle: string; cardCode: string; usable: boolean; validTo: string };
export type WirePatientRail = {
  ageYears: number | null; sex: string | null; visits: WireRailVisit[]; alreadyTaking: WireRailMedicine[];
  benefits?: WireRailBenefit[]; account?: { outstandingPaise: number; advancePaise: number };
};

export async function fetchPatientRail(id: string): Promise<WirePatientRail> {
  return api<WirePatientRail>("GET", `/pharmacy/dispenses/${id}/patient`);
}

/** The board's three boxes on the done screen (`closing.ts`), read once when the ticket has closed. */
export type WireClosing = {
  ticket: { dispenseNo: string | null; claimedByName: string | null; claimedAt: string | null; handedOverAt: string | null; lines: number; substituted: number; declined: number };
  money: { invoiceNo: string; netPayablePaise: number; cgstPaise: number; sgstPaise: number; receiptNo: string | null; changeGivenPaise: number; tenders: { mode: string; amountPaise: number; refText: string | null }[] } | null;
  registers: { h1Rows: number; batches: number };
};
export async function fetchClosing(id: string): Promise<WireClosing> {
  return api<WireClosing>("GET", `/pharmacy/dispenses/${id}/closing`);
}

export async function fetchAlternatives(id: string, lineIdx: number): Promise<{ items: WireAlternative[]; written: WireQuote | null }> {
  const r = await api<{ items: WireAlternative[]; written?: WireQuote | null }>("GET", `/pharmacy/dispenses/${id}/lines/${String(lineIdx)}/alternatives`);
  return { items: r.items, written: r.written ?? null };
}
/** C3b — the ticket's own lines, put to the check at the claim: what it would refuse, before the tick. */
export type WireLinePrecheck = { lineIdx: number; verdict: "clear" | "not_checked" | "blocked" | "unplaced"; blocks: WireAlternativeBlock[] };
export async function fetchPrecheck(id: string): Promise<WireLinePrecheck[]> {
  const { lines } = await api<{ lines: WireLinePrecheck[] }>("GET", `/pharmacy/dispenses/${id}/precheck`);
  return lines;
}
/** PD-5b — what a line the catalogue could not place may be read as: this ticket's shelf, never Schedule X. */
export async function fetchPlacements(id: string, lineIdx: number, q: string): Promise<WireRetailShelfEntry[]> {
  const { items } = await api<{ items: WireRetailShelfEntry[] }>("GET", `/pharmacy/dispenses/${id}/lines/${String(lineIdx)}/shelf${qs({ q })}`);
  return items;
}
/** PD-9 — ask the prescriber to authorise one refusal on one line. */
export async function askPrescriber(dispenseId: string, lineIdx: number, input: { book: string; about: string; note?: string }): Promise<WireLineAuthorisation> {
  return api<WireLineAuthorisation>("POST", `/pharmacy/dispenses/${dispenseId}/lines/${String(lineIdx)}/authorisations`, input);
}
/** PD-9 — the request as the prescriber reads it. */
export type WireAuthorisationDetail = {
  authorisation: WireLineAuthorisation & { dispenseId: string; lineIdx: number; requestedBy: string };
  requestedByName: string | null;
  dispenseNo: string | null;
  patient: { name: string | null; alias: string | null; uhid: string; restricted: boolean } | null;
  line: { drug: string; dose: string; frequency: string; durationDays: number | null; instructions: string | null } | null;
};
export async function fetchAuthorisation(id: string): Promise<WireAuthorisationDetail> {
  return api<WireAuthorisationDetail>("GET", `/pharmacy/authorisations/${id}`);
}
export async function decideAuthorisation(id: string, authorise: boolean, reason: string): Promise<WireLineAuthorisation> {
  return api<WireLineAuthorisation>("POST", `/pharmacy/authorisations/${id}/decision`, { authorise, reason });
}
/** PD-D18 — say where an item sits in a counter's store; an empty label clears it. */
export async function setShelfLocation(itemId: string, storeResourceId: string, location: string): Promise<{ location: string | null }> {
  return api<{ location: string | null }>("PUT", `/pharmacy/sale-items/${itemId}/location`, { storeResourceId, location });
}
export async function claimDispense(dispenseId: string, door: string, idempotencyKey: string): Promise<WireDispense> {
  return api<WireDispense>("POST", "/pharmacy/dispenses", { dispenseId, door }, idempotencyKey);
}
export type VerifyLine = { lineIdx: number; qtyBase: number; dispensedMedicineId?: string; patientConsent?: boolean };
export async function verifyDispense(id: string, lines: VerifyLine[], idempotencyKey: string): Promise<WireDispense> {
  return api<WireDispense>("POST", `/pharmacy/dispenses/${id}/verify`, { lines }, idempotencyKey);
}
export async function declineLine(id: string, lineIdx: number, reason: string): Promise<WireDispense> {
  return api<WireDispense>("POST", `/pharmacy/dispenses/${id}/lines/${String(lineIdx)}/decline`, { reason });
}
/** P5 — a paid dispense that cannot be collected: cancelled, credited, the refund requested. */
export async function cancelBilledDispense(
  id: string, body: { reason: string; reasonClass: "mistake" | "genuine" }, idempotencyKey: string,
): Promise<{ dispense: WireDispense; creditNoteId: string; creditNoteNo: string; refundApprovalId: string }> {
  return api("POST", `/pharmacy/dispenses/${id}/refund`, body, idempotencyKey);
}
/** P6 — a sealed pack comes back after the hand-over. */
export async function acceptReturn(
  id: string,
  body: { lines: { lineIdx: number; qtyBase: number }[]; sealedIntact: true; reason: string; reasonClass: "mistake" | "genuine" },
  idempotencyKey: string,
): Promise<{ dispense: WireDispense; creditNoteId: string; creditNoteNo: string; refundApprovalId: string }> {
  return api("POST", `/pharmacy/dispenses/${id}/returns`, body, idempotencyKey);
}
export async function cancelDispense(id: string, reason: string): Promise<WireDispense> {
  return api<WireDispense>("POST", `/pharmacy/dispenses/${id}/cancel`, { reason });
}

// ── T4 — pick, bill, hand over, the label ──
export type PickLine = { lineIdx: number; qtyBase?: number; pickNote?: string; batchId?: string; scan?: string };
/** P13 — what the pack in hand is, checked as it is scanned. */
export async function checkPickScan(id: string, lineIdx: number, code: string): Promise<{ itemCode: string; batchNo: string | null; expiryDate: string | null }> {
  return api("GET", `/pharmacy/dispenses/${id}/lines/${String(lineIdx)}/scan${qs({ code })}`);
}
export async function pickDispense(id: string, lines: PickLine[], idempotencyKey: string): Promise<WireDispense> {
  return api<WireDispense>("POST", `/pharmacy/dispenses/${id}/pick`, { lines }, idempotencyKey);
}
/** `pack`: the server folded a pack residue into this drug's line and says how its quantity reads (loose-MRP ruling). Absent from an older server. */
export type WirePricedLine = { lineId: string; serviceId: string; serviceName: string; qty: number; unitPaise: number; grossPaise: number; discountPaise: number; netPaise: number; gst: { rateBps: number; exempt: boolean }; pack?: WireBillRowPack | null };
export type WirePricedDraft = { lines: WirePricedLine[]; totals: { grossPaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; rawTotalPaise: number; netPayablePaise: number; roundingPaise: number } };
export async function previewBill(id: string): Promise<WirePricedDraft> {
  return api<WirePricedDraft>("GET", `/pharmacy/dispenses/${id}/bill/preview`);
}
export type Tender = { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string };
export async function billDispense(id: string, input: { tenders: Tender[]; changeGivenPaise?: number }, idempotencyKey: string): Promise<WireDispense> {
  return api<WireDispense>("POST", `/pharmacy/dispenses/${id}/bill`, input, idempotencyKey);
}
export async function handOverDispense(id: string, identity: { via: "token" | "phone_last4"; value: string } | null, idempotencyKey: string): Promise<WireDispense> {
  return api<WireDispense>("POST", `/pharmacy/dispenses/${id}/handover`, identity === null ? {} : { identity }, idempotencyKey);
}
export type WireLabel = {
  dispenseNo: string | null; status: string; patient: { display: string; uhid: string }; handedOverAt: string | null;
  lines: { lineIdx: number; drug: string; strength: string | null; form: string | null; qtyBase: number; unit: string; packs: string | null; batchNo: string; expiryDate: string | null; directions: string; substitutedFor: string | null }[];
  /** P2 — who verified the dispense, and the registration current then. Absent from an older server. */
  pharmacist?: { name: string; council: string | null; registrationNo: string | null } | null;
  /** The issued bill, one row per drug (loose-MRP ruling). Null before the bill; absent from an older server. */
  billRows?: WireBillRow[] | null;
};
export async function fetchLabel(id: string): Promise<WireLabel> {
  return api<WireLabel>("GET", `/pharmacy/dispenses/${id}/label`);
}

// ── P2 — the register of pharmacists (Pharmacy Act 1948 §42) ──
export type WirePharmacistRegistration = {
  id: string; userId: string; council: string; registrationNo: string; validUntil: string | null;
  recordedBy: string; recordedAt: string; endedAt: string | null; endedBy: string | null; endReason: string | null;
};
export type WirePharmacist = {
  userId: string; username: string; fullName: string; active: boolean;
  current: WirePharmacistRegistration | null; history: WirePharmacistRegistration[];
  /** P15 — days left once inside the renewal window; absent from an older server. */
  renewalDueInDays?: number | null;
};
/** The desk header's pill: the caller's OWN current registration, or null. 404 from an older server. */
export async function fetchMyRegistration(): Promise<{ registration: { council: string; registrationNo: string; validUntil: string | null } | null }> {
  return api("GET", "/pharmacy/pharmacists/me");
}
export async function fetchPharmacists(): Promise<WirePharmacist[]> {
  const { items } = await api<{ items: WirePharmacist[] }>("GET", "/pharmacy/pharmacists");
  return items;
}
export async function filePharmacistRegistration(
  userId: string, body: { council: string; registrationNo: string; validUntil: string | null },
): Promise<{ id: string; supersededId: string | null }> {
  return api("POST", `/pharmacy/pharmacists/${userId}/registrations`, body);
}
export async function endPharmacistRegistration(registrationId: string, reason: string): Promise<void> {
  await api("POST", `/pharmacy/pharmacists/registrations/${registrationId}/end`, { reason });
}

// ── P16 — GST slabs against the notification ──
export type WireGstPlanRow = {
  itemId: string; code: string; name: string; current: number | null; suggested: number | null; basis: string | null;
  verdict: "set" | "differs" | "ok" | "unknown"; categoryStale: boolean;
};
export async function fetchGstPlan(): Promise<WireGstPlanRow[]> {
  return (await api<{ items: WireGstPlanRow[] }>("GET", "/pharmacy/sale-items/gst-plan")).items;
}
export async function applyGstPlan(overwrite: boolean): Promise<{ slabsSet: number; categoriesSynced: number }> {
  return api("POST", "/pharmacy/sale-items/gst-plan/apply", { overwrite });
}

// ── P4 — the reorder list ──
export type WireReorderLine = {
  itemId: string; code: string; name: string; baseUom: string;
  status: "stock_out" | "reorder" | "ok" | "no_movement";
  available: number; usedInWindow: number; daysOfCover: number | null;
  /** P8: what the pace will not sell before its batch expires; not counted as cover. */
  unsoldByExpiry: number;
  suggestBase: number; suggestPacks: string | null;
  source: { storeCode: string; storeName: string; available: number } | null;
};
export type WireExpiringLine = {
  itemId: string; code: string; name: string; baseUom: string;
  batchId: string; batchNo: string; expiryDate: string; daysLeft: number;
  available: number; unsoldByExpiry: number; action: "move_back" | "sell_first";
};
export type WireExpiredLine = {
  itemId: string; code: string; name: string; baseUom: string; batchId: string; batchNo: string; expiryDate: string; onHand: number;
};
export type WireReorderAdvice = {
  asOf: string;
  window: { days: number; minCoverDays: number; targetCoverDays: number; nearExpiryDays: number };
  items: WireReorderLine[];
  expiring: WireExpiringLine[];
  expiredOnShelf: WireExpiredLine[];
};
export async function fetchReorderAdvice(): Promise<WireReorderAdvice> {
  return api<WireReorderAdvice>("GET", "/pharmacy/reorder");
}

// ── P9 — the Schedule H1 register ──
export type WireH1RegisterRow = {
  entryNo: number; dispensedAt: string; patientId: string; patientName: string; patientAddress: string | null;
  restricted: boolean; prescriberName: string; prescriberRegNo: string | null;
  /** P19 — a walk-in's outside prescriber, and where the row came from. Absent from an older server. */
  prescriberAddress?: string | null; source?: "counter" | "walk_in";
  drugName: string;
  batchNo: string; qtyBase: number; unit: string; pharmacistRegNo: string | null;
};
export type WireH1Register = { period: { from: string; to: string }; rows: WireH1RegisterRow[] };
export async function fetchH1Register(from: string, to: string): Promise<WireH1Register> {
  return api<WireH1Register>("GET", `/pharmacy/registers/h1${qs({ from, to })}`);
}

// ── P7 — the counter's day ──
export type WireCounterSummary = {
  day: string; handedOver: number;
  medianMinutes: { queueToHandover: number | null; claimToHandover: number | null };
  billedPaise: number;
  open: { queued: number; claimed: number; verified: number; picked: number; billed: number };
  declinedLines: number; declinedTop: { reason: string; lines: number }[];
  substitutions: number; cancelled: number; refundedAfterBilling: number; returns: number;
  partlyCheckedLines: number; scheduledHandovers: number;
  /** P14 — absent from an older server. */
  queuedToday?: number; notCollected?: number; scan?: { pickedLines: number; scannedLines: number };
};
export async function fetchCounterSummary(day?: string): Promise<WireCounterSummary> {
  return api<WireCounterSummary>("GET", `/pharmacy/summary${qs({ day })}`);
}

// ── P12 — the leakage triangle ──
export type WireLeakageReport = {
  day: string;
  store: { code: string; name: string };
  dispensed: { lines: number; units: number };
  mismatches: {
    /** P19b — absent from an older server, which only read counter dispenses. */
    source?: "dispense" | "walk_in" | "downtime";
    dispenseId: string | null; dispenseNo: string | null; saleId?: string | null; invoiceNo?: string | null; itemCode: string; batchNo: string;
    issued: number; returned: number; billed: number; credited: number; unbilledUnits: number; unbilledPaise: number;
  }[];
  otherConsumption: { itemCode: string; batchNo: string; units: number; refType: string | null; refId: string | null; actorId: string; actorName?: string; occurredAt: string }[];
  counted: { counts: number; varianceUnits: number; variancePaise: number; lines: { countId: string; itemCode: string; batchNo: string; varianceQty: number; variancePaise: number }[] };
  summary: { unbilledUnits: number; unbilledPaise: number; otherUnits: number; countVarianceUnits: number; countVariancePaise: number };
};
export type LeakageStore = "PHARM-OPD" | "PHARM-RETAIL";
export async function fetchLeakage(day: string, store: LeakageStore = "PHARM-OPD"): Promise<WireLeakageReport> {
  return api<WireLeakageReport>("GET", `/pharmacy/leakage${qs({ day, store })}`);
}

// ── P19 — the walk-in retail counter ──
export type WireRetailLicence = {
  id: string; form20No: string; form21No: string; validFrom: string; validTo: string;
  pharmacistInCharge: string; note: string | null; recordedBy: string; recordedAt: string;
};
export type WireRetailState = {
  storeCode: string; storePresent: boolean;
  state: "no_store" | "missing" | "not_yet_valid" | "lapsed" | "current";
  licence: WireRetailLicence | null; daysLeft: number | null;
};
export type WireRetailShelfEntry = {
  medicineId: string; brandName: string; strengthLabel: string | null; form: string; scheduleFlag: string | null;
  itemId: string; itemCode: string; itemName: string; baseUom: string; available: number; scannedBatchId: string | null;
};
export type RetailLine = { medicineId: string; qtyBase: number; batchId?: string };
export type WireRetailPreview = {
  licence: WireRetailState;
  prescriptionRequired: boolean;
  lines: {
    lineIdx: number; medicineId: string; brandName: string; strengthLabel: string | null; form: string; scheduleFlag: string | null;
    itemId: string; batchId: string; batchNo: string; expiryDate: string | null; qtyBase: number; fefoOverride: boolean;
  }[];
  totals: { grossPaise: number; discountPaise: number; taxPaise: number; netPayablePaise: number };
  checks: {
    allergies: { lineIdx: number; substance: string }[];
    interactions: { lineIdx: number; severity: string; note: string }[];
    duplicates: number; partlyCheckedLineIdxs: number[];
  } | null;
};
export type RetailCustomer =
  | { existingId: string }
  | { register: { name: string; sex: "male" | "female" | "other" | "unknown"; ageYears?: number; phone?: string; addressLine?: string }; acknowledgedDuplicates?: boolean };
export type RetailPrescription = {
  prescriberName: string; prescriberRegNo: string; prescriberAddress: string; rxDate: string;
  photo: { mimeType: "image/jpeg" | "image/png" | "application/pdf"; imageBase64: string };
};
export type RetailSaleBody = {
  customer: RetailCustomer; lines: RetailLine[]; prescription?: RetailPrescription;
  tenders: { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string }[];
  changeGivenPaise?: number;
};
export type WireRetailSale = {
  id: string; soldAt: string; soldBy: string; soldByName: string;
  /** P20 — absent from an older server. */
  channel?: "walk_in" | "downtime"; enteredBy?: string; enteredAt?: string; storeCode?: string;
  sheet?: { kitId: string; serial: number; desk: string } | null;
  patient: { id: string; uhid: string; name: string; phone: string | null; registeredHere: boolean };
  invoiceId: string; invoiceNo: string; netPaise: number; scheduled: boolean;
  prescription: { prescriberName: string; prescriberRegNo: string; prescriberAddress: string; rxDate: string; documentId: string | null } | null;
  pharmacistRegNo: string | null;
  lines: {
    lineIdx: number; medicineId: string; drugName: string; itemId: string; itemCode: string; itemName: string; batchId: string;
    batchNo: string; expiryDate: string | null; qtyBase: number; baseUom: string; unitPaise: number; scheduleFlag: string | null; fefoOverride: boolean;
    /** P19b — absent from an older server. */
    returnedQtyBase?: number;
  }[];
  /** The bill, one row per drug (loose-MRP ruling). Absent from an older server. */
  billRows?: WireBillRow[] | null;
};
export type WireRetailSaleRow = {
  id: string; soldAt: string; soldBy: string; invoiceId: string; invoiceNo: string; netPaise: number;
  scheduled: boolean; lineCount: number; registeredHere: boolean;
  /** P20 — absent from an older server. */
  channel?: "walk_in" | "downtime"; enteredAt?: string; sheet?: { desk: string; serial: number } | null;
};
/** The near-match refusal carries who matched (`duplicate_suspected`). */
export type WireDuplicateCandidate = { id: string; uhid: string; name: string | null; phone: string | null };

export async function fetchRetailState(): Promise<WireRetailState> {
  return api<WireRetailState>("GET", "/pharmacy/retail/state");
}
export async function searchRetailShelf(q: string): Promise<WireRetailShelfEntry[]> {
  const { items } = await api<{ items: WireRetailShelfEntry[] }>("GET", `/pharmacy/retail/shelf${qs({ q })}`);
  return items;
}
export async function previewRetailSale(body: { patientId?: string; lines: RetailLine[] }): Promise<WireRetailPreview> {
  return api<WireRetailPreview>("POST", "/pharmacy/retail/preview", body);
}
export async function sellRetail(body: RetailSaleBody, idempotencyKey: string): Promise<WireRetailSale> {
  return api<WireRetailSale>("POST", "/pharmacy/retail/sales", body, idempotencyKey);
}
export async function fetchRetailSales(day?: string): Promise<WireRetailSaleRow[]> {
  const { items } = await api<{ items: WireRetailSaleRow[] }>("GET", `/pharmacy/retail/sales${qs({ day })}`);
  return items;
}
export async function fetchRetailSale(id: string): Promise<WireRetailSale> {
  return api<WireRetailSale>("GET", `/pharmacy/retail/sales/${id}`);
}
/** P19b — the sale a bill belongs to, when the customer brings the bill back. */
export async function fetchRetailSaleByBill(no: string): Promise<WireRetailSale> {
  return api<WireRetailSale>("GET", `/pharmacy/retail/bill${qs({ no })}`);
}
/** P19b — a sealed pack of a walk-in sale (or a paper dispense) comes back. */
export async function acceptRetailReturn(
  saleId: string,
  body: { lines: { lineIdx: number; qtyBase: number }[]; sealedIntact: true; reason: string; reasonClass: "mistake" | "genuine" },
  idempotencyKey: string,
): Promise<{ sale: WireRetailSale; creditNoteId: string; creditNoteNo: string; refundApprovalId: string }> {
  return api("POST", `/pharmacy/retail/sales/${saleId}/returns`, body, idempotencyKey);
}
export async function fetchRetailLicences(): Promise<{ items: WireRetailLicence[]; state: WireRetailState }> {
  return api("GET", "/pharmacy/retail/licences");
}
export async function recordRetailLicence(body: {
  form20No: string; form21No: string; validFrom: string; validTo: string; pharmacistInCharge: string; note?: string;
}): Promise<WireRetailLicence> {
  return api<WireRetailLicence>("POST", "/pharmacy/retail/licences", body);
}

// ── P20 — paper dispenses entered after an outage ──
export type CounterStoreCode = "PHARM-OPD" | "PHARM-RETAIL";
export type WireSheetCheck = { valid: boolean; desk: string | null; serial: number | null; kitGeneratedAt: string | null; enteredSaleId: string | null };
export type WirePharmacyStaff = { userId: string; fullName: string; username: string; registered: boolean };
export type WireCounterBatch = { batchId: string; batchNo: string; expiryDate: string | null; onHand: number; available: number; recalled: boolean };
export type PaperDispenseBody = Omit<RetailSaleBody, "lines"> & {
  sheetQr: string; storeCode: CounterStoreCode; occurredAt: string; dispensedBy: string;
  lines: { medicineId: string; qtyBase: number; batchId: string }[];
};

export async function checkDowntimeSheet(qr: string): Promise<WireSheetCheck> {
  return api<WireSheetCheck>("GET", `/pharmacy/downtime/sheet${qs({ qr })}`);
}
export async function fetchPharmacyStaff(): Promise<WirePharmacyStaff[]> {
  const { items } = await api<{ items: WirePharmacyStaff[] }>("GET", "/pharmacy/downtime/staff");
  return items;
}
export async function searchCounterShelf(store: CounterStoreCode, q: string): Promise<WireRetailShelfEntry[]> {
  const { items } = await api<{ items: WireRetailShelfEntry[] }>("GET", `/pharmacy/downtime/shelf${qs({ store, q })}`);
  return items;
}
export async function fetchCounterBatches(store: CounterStoreCode, itemId: string): Promise<WireCounterBatch[]> {
  const { items } = await api<{ items: WireCounterBatch[] }>("GET", `/pharmacy/downtime/batches${qs({ store, itemId })}`);
  return items;
}
export async function previewPaperDispense(body: { storeCode: CounterStoreCode; occurredAt: string; patientId?: string; lines: RetailLine[] }): Promise<WireRetailPreview> {
  return api<WireRetailPreview>("POST", "/pharmacy/downtime/preview", body);
}
export async function enterPaperDispense(body: PaperDispenseBody, idempotencyKey: string): Promise<WireRetailSale> {
  return api<WireRetailSale>("POST", "/pharmacy/downtime/dispenses", body, idempotencyKey);
}
export async function fetchPaperDispenses(): Promise<WireRetailSaleRow[]> {
  const { items } = await api<{ items: WireRetailSaleRow[] }>("GET", "/pharmacy/downtime/dispenses");
  return items;
}
