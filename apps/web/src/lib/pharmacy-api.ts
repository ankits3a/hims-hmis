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
  orderItemId: string | null; invoiceLineId: string | null; unitPaise: number | null; priceWinner: string | null;
  fefoOverride: boolean; pickNote: string | null;
  /** Pharmacy P3: a component of this line's medicine is not yet reviewed. Absent from an older server. */
  partlyChecked?: boolean;
};
export type WirePatientSummary = { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
export type WireDispense = {
  id: string; status: string; dispenseNo: string | null; orderId: string | null; prescriptionId: string; prescriptionVersion: number;
  encounterId: string; storeResourceId: string | null; scheduled: boolean; invoiceId: string | null; identityConfirmedVia: string | null;
  claimedAt: string | null; verifiedAt: string | null; pickedAt: string | null; billedAt: string | null; handedOverAt: string | null;
  cancelReason: string | null; patient: WirePatientSummary; allergies: { substance: string; severity: string | null }[]; lines: WireDispenseLine[];
};
export type WireQueueRow = {
  dispenseId: string; status: string; dispenseNo: string | null; scheduled: boolean; lineCount: number;
  createdAt: string; claimedAt: string | null; patient: WirePatientSummary;
};
export type WireFindResult =
  | { kind: "dispense"; door: string; dispense: WireDispense }
  | { kind: "patients"; door: "uhid"; patients: WirePatientSummary[] }
  | { kind: "none"; door: string; reason: "not_found" | "qr_invalid" | "no_prescription_today" };
export type WireAlternative = { medicineId: string; brandName: string; strengthLabel: string | null; form: string; itemId: string; itemCode: string; available: number };

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
export async function fetchAlternatives(id: string, lineIdx: number): Promise<WireAlternative[]> {
  const { items } = await api<{ items: WireAlternative[] }>("GET", `/pharmacy/dispenses/${id}/lines/${String(lineIdx)}/alternatives`);
  return items;
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
export type WirePricedLine = { lineId: string; serviceId: string; serviceName: string; qty: number; unitPaise: number; grossPaise: number; discountPaise: number; netPaise: number; gst: { rateBps: number; exempt: boolean } };
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
  restricted: boolean; prescriberName: string; prescriberRegNo: string | null; drugName: string;
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
    dispenseId: string; dispenseNo: string | null; itemCode: string; batchNo: string;
    issued: number; returned: number; billed: number; credited: number; unbilledUnits: number; unbilledPaise: number;
  }[];
  otherConsumption: { itemCode: string; batchNo: string; units: number; refType: string | null; refId: string | null; actorId: string; occurredAt: string }[];
  counted: { counts: number; varianceUnits: number; variancePaise: number; lines: { countId: string; itemCode: string; batchNo: string; varianceQty: number; variancePaise: number }[] };
  summary: { unbilledUnits: number; unbilledPaise: number; otherUnits: number; countVarianceUnits: number; countVariancePaise: number };
};
export async function fetchLeakage(day: string): Promise<WireLeakageReport> {
  return api<WireLeakageReport>("GET", `/pharmacy/leakage${qs({ day })}`);
}
