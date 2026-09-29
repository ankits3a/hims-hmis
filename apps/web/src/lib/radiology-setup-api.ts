import { api } from "./api";

/**
 * PLAN 18-S RS4 — the Setup station's wire contract, transcribed from
 * `radiology-setup.controller.ts` (and the two existing definitions routes the Books view calls).
 * Like `radiology-api.ts`, nothing here decides anything: AE-title rules, the locked statuses and the
 * approval are the server's, and a refusal is shown with its own code and sentence.
 */

export type WireSetupDevice = {
  id: string; code: string; name: string; modality: string;
  room: string | null; roomId: string | null; aeTitle: string | null;
  portable: boolean; status: string; ionising: boolean;
  /** Ionising machines only; null when AERB licenses none (ultrasound, MRI). */
  licensedNow: boolean | null;
};

export type WireSetupRoom = { id: string; code: string; name: string };

export type WireBookedStudy = {
  studyId: string; accessionNo: string; studyTypeCode: string; status: string; scheduledAt: string | null;
};

export type WireBookVersion = {
  definitionId: string; version: number; status: "active" | "draft";
  draftedBy: string | null; createdAt: string; publishedBy: string | null; publishedAt: string | null;
  approvalId: string | null; approvalStatus: string | null; approvedBy: string | null; seeded: boolean;
};

export type WireBook = { kind: string; active: WireBookVersion | null; drafts: WireBookVersion[] };

export type WireSetupPrice = {
  serviceId: string; code: string; name: string; category: string; active: boolean;
  gst: { sacCode: string; exempt: boolean; rateBps: number } | null;
  pricePaise: number | null; ruledPricePaise: number | null;
};

export const SETUP_MODALITIES = ["xray", "usg", "ct", "mri", "mammography"] as const;
export const SETUP_STATUSES = ["available", "down", "maintenance", "qa_blocked", "retired"] as const;

export const fetchSetupDevices = () =>
  api<{ devices: WireSetupDevice[]; rooms: WireSetupRoom[] }>("GET", "/radiology/setup/devices");

export type DeviceInput = {
  code: string; name: string; modality: string; roomId: string | null; aeTitle: string | null; portable: boolean;
};

export const createSetupDevice = (input: DeviceInput) =>
  api<{ deviceResourceId: string }>("POST", "/radiology/setup/devices", input);

export const editSetupDevice = (id: string, patch: Omit<DeviceInput, "modality">) =>
  api<{ deviceResourceId: string }>("PATCH", `/radiology/setup/devices/${encodeURIComponent(id)}`, patch);

export const setSetupDeviceStatus = (id: string, status: string, reason: string) =>
  api<{ from: string; to: string; studiesToMove: WireBookedStudy[] }>(
    "POST", `/radiology/setup/devices/${encodeURIComponent(id)}/status`, { status, reason },
  );

export const fetchSetupBooks = () => api<{ books: WireBook[] }>("GET", "/radiology/setup/books");

export const fetchSetupPrices = () => api<{ services: WireSetupPrice[] }>("GET", "/radiology/setup/prices");

/** The EXISTING governed routes (18a T4) — this station adds no approval system of its own. */
export const fetchActiveBook = (kind: string) =>
  api<{ definitionId: string | null; kind: string; version: number | null; body: unknown }>(
    "GET", `/radiology/definitions/${encodeURIComponent(kind)}/active`,
  );

export const draftBook = (kind: string, body: unknown) =>
  api<{ definitionId: string; version: number; approvalId: string }>("POST", "/radiology/definitions/draft", { kind, body });

export const publishBook = (definitionId: string, approvalId: string) =>
  api<{ kind: string; version: number; supersededVersion: number | null }>(
    "POST", "/radiology/definitions/publish", { definitionId, approvalId },
  );

export function rupees(paise: number | null): string {
  if (paise === null) return "—";
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
