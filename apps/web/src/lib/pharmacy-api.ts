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
  saleable: boolean; available: number | null; batchId: string | null; reservationId: string | null; orderItemId: string | null;
  unitPaise: number | null; priceWinner: string | null;
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
export async function cancelDispense(id: string, reason: string): Promise<WireDispense> {
  return api<WireDispense>("POST", `/pharmacy/dispenses/${id}/cancel`, { reason });
}
