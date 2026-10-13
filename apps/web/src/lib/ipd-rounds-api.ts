import { api, newIdempotencyKey } from "./api";
import type { IpdConsultantChoice, IpdRoundPatient, IpdRoundSoap, IpdRoundsList } from "@hmis/contracts";

/**
 * E4.2 (#734) — the rounds surface's wire (spec §4.5A, §4.9 E). Shapes are the contract's (`packages/contracts/src/ipd/
 * rounds.ts`, `intents-ward.ts`, `intents-meds.ts`, `intents-rounds.ts`); the paths are copied here because the web bundle
 * imports the contract package for TYPES only. Every act carries a fresh idempotency key in its body (§4.10 edge 9).
 */
const R = {
  list: "/ipd/rounds",
  consultants: "/ipd/rounds/consultants",
  sign: "/ipd/rounds/sign",
  cosign: "/ipd/rounds/cosign",
  placeOrder: "/ipd/orders",
  stopOrder: "/ipd/orders/stop",
  cancelOrder: "/ipd/orders/cancel",
  requestConsult: "/ipd/consults",
  closeConsult: "/ipd/consults/close",
} as const;

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export type DrugRoute = "oral" | "iv" | "im" | "sc" | "inhaled" | "topical" | "rectal" | "sublingual" | "ng" | "other";
export const DRUG_ROUTES: readonly DrugRoute[] = ["oral", "iv", "im", "sc", "inhaled", "topical", "rectal", "sublingual", "ng", "other"];
export const FREQUENCIES = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT"] as const;

export type WireMedicineHit = { id: string; name: string; form: string; strength: string | null; salts: string[] };

export const getRoundsList = (): Promise<IpdRoundsList> => api("GET", R.list);
export const getRoundPatient = (admissionId: string): Promise<IpdRoundPatient> => api("GET", `${R.list}/${encodeURIComponent(admissionId)}`);
export const getConsultants = async (): Promise<IpdConsultantChoice[]> => (await api<{ items: IpdConsultantChoice[] }>("GET", R.consultants)).items;
export const searchMedicines = async (q: string): Promise<WireMedicineHit[]> =>
  (await api<{ items: WireMedicineHit[] }>("GET", `/formulary/medicines/search?for=rx&limit=8&q=${encodeURIComponent(q)}`)).items;

export const signRound = (b: {
  admissionId: string; seenAt: string; mode: "bedside" | "remote_review"; soap: IpdRoundSoap;
  source?: "typed" | "voice" | "copilot_draft"; fit?: { when: "today" | "tomorrow"; disposition: "home" | "transfer_out" };
}): Promise<{ roundId: string; status: "signed" | "awaiting_cosign"; fitDeclaredAt: string | null }> => post(R.sign, b);
export const cosignRound = (roundId: string): Promise<unknown> => post(R.cosign, { roundId });

export type DrugOrderInput = {
  itemId: string; dose: { value: number; unit: string }; route: DrugRoute; frequency: string; startAt: string;
  stopAt?: string; durationDays?: number; antibiotic: boolean;
};
export const placeDrugOrder = (admissionId: string, drug: DrugOrderInput): Promise<{ orderId: string }> =>
  post(R.placeOrder, { admissionId, kind: "drug", drug });
export const placeTestOrder = (admissionId: string, kind: "lab" | "imaging", serviceIds: string[], indication: string): Promise<{ orderId: string }> =>
  post(R.placeOrder, { admissionId, kind, tests: { serviceIds, indication } });
export const stopOrder = (orderId: string, reason: string): Promise<unknown> => post(R.stopOrder, { orderId, reason });
export const cancelOrder = (orderId: string, reason: string): Promise<unknown> => post(R.cancelOrder, { orderId, reason });
export const requestConsult = (b: { admissionId: string; consultantId: string; question: string; urgency: "routine" | "urgent" }): Promise<unknown> =>
  post(R.requestConsult, b);
export const closeConsult = (consultId: string): Promise<unknown> => post(R.closeConsult, { consultId });

/** The refusal's code, when the server answered one (`IpdRefusalBody`); the screen words it by code. */
export function refusalCode(e: unknown): string | null {
  const body = (e as { body?: { code?: unknown } } | null)?.body;
  return typeof body?.code === "string" ? body.code : null;
}
