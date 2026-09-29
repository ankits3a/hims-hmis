import { api } from "./api";
import { setSetupDeviceStatus } from "./radiology-setup-api";
import type { WireImagingDevice, WireWorklistRow } from "./radiology-api";

/**
 * PLAN 18-S RS6 — the modality rooms' wire contract, transcribed from `radiology-room.controller.ts`
 * and the acquisition routes the console is the first full caller of. Like `radiology-api.ts`,
 * nothing here decides anything: the DRL verdict, the gates, the licence and the money are the
 * server's, and a refusal is shown with its own code and sentence.
 */

export const REPEAT_REASONS = ["positioning", "motion", "exposure", "artefact", "equipment"] as const;
export type RepeatReason = (typeof REPEAT_REASONS)[number];

export type WireRange = { min: number; max: number };
export type WireProtocol = {
  study_type_code?: string; modality?: string; name: string; technique: string; preset?: string;
  kv?: WireRange; mas?: WireRange; ct?: { slice_mm: number; pitch: number }; sequences?: string[];
  contrast?: { agent?: string; phase: string; ml_per_kg: number; max_ml: number; delay_s: number; rate_ml_s?: number };
  breath_hold?: { en: string; hi: string };
  paediatric?: { bands: { from_kg: number; to_kg: number; kv?: WireRange; mas?: WireRange; ml_per_kg?: number; note?: string }[] };
};
export type WireDrl = { study_type_code?: string; modality?: string; quantity: "ctdivol" | "dlp" | "dap" | "fluoro_seconds"; value: number; source?: string };

/** `room.ts`'s `RoomView`. */
export type WireRoomView = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; studyTypeName: string; modality: string; bodyPart: string;
  contrastOption: "none" | "optional" | "required"; lateralityApplicable: boolean; laterality: string;
  ionising: boolean; bedsideLocation: string | null; encounterNo: string; patientId: string;
  mintedStudyInstanceUid: string;
  patient: {
    name: string; uhid: string; restricted: boolean; ageYears: number | null; sex: string;
    allergies: string[]; weight: { kg: number; recordedAt: string } | null;
  };
  device: WireImagingDevice | null;
  protocol: { book: "active" | "none"; version: number | null; matchedOn: "study_type" | "modality" | null; protocol: WireProtocol | null };
  drl: WireDrl[];
  renal: { creatinineUmolL: number | null; egfr: number | null; sampledAt: string | null } | null;
  repeats: { reason: RepeatReason; at: string }[];
};

export type WireRejects = {
  from: string; to: string;
  rows: { deviceResourceId: string; deviceCode: string; technologistId: string; technologistName: string; acquired: number; repeats: number }[];
  reasons: { reason: RepeatReason; count: number }[];
  log: { at: string; studyId: string; accessionNo: string; studyTypeCode: string; deviceCode: string; technologistName: string; reason: RepeatReason }[];
  openDecisions: { id: string; kind: string; studyId: string; accessionNo: string; reason: string | null; raisedAt: string }[];
};

/** `GET /aerb/doses` — `DoseRegisterRow` (18c), with RS6's `drlReason`. */
export type WireDoseRow = {
  id: string; source: string; sourceRef: string; patientId: string; patientName: string; uhid: string; restricted: boolean;
  deviceCode: string | null; modality: string; procedureCode: string;
  doseCtdivol: string | null; doseDlp: string | null; doseDap: string | null; fluoroSeconds: number | null;
  doseManual: boolean; drlQuantity: string | null; drlValue: string | null; overDrl: boolean | null;
  drlReason: string | null; occurredAt: string;
};

export const fetchRoomView = (studyId: string) =>
  api<{ study: WireRoomView }>("GET", `/radiology/studies/${encodeURIComponent(studyId)}/room`);

/** One machine's floor list (`worklist`'s own `deviceResourceId` filter). */
export const fetchMachineWorklist = (deviceResourceId: string) =>
  api<{ rows: WireWorklistRow[] }>("GET", `/radiology/worklist?view=floor&deviceResourceId=${encodeURIComponent(deviceResourceId)}`);

export const recordRepeat = (studyId: string, reason: RepeatReason) =>
  api<{ studyId: string; billDecisionId: string | null }>("POST", `/radiology/studies/${encodeURIComponent(studyId)}/acquisition/repeat`, { reason });

/** A bedside start carries the technologist's radiation checklist as attested text (RS6 T3). */
export const startAtBedside = (studyId: string, bedsideSafety: string) =>
  api("POST", `/radiology/studies/${encodeURIComponent(studyId)}/acquisition/start`, { bedsideSafety });

export const abortAcquisition = (studyId: string, reason: string) =>
  api<{ studyId: string; status: string }>("POST", `/radiology/studies/${encodeURIComponent(studyId)}/acquisition/abort`, { reason });

/** The controller's `acquiredBody`, transcribed (F57: an untyped body is an invisible 400). */
export type AcquiredBody = {
  imageSource: "pacs" | "no_pacs_images";
  studyInstanceUid?: string | null;
  doseCtdivol?: number | null; doseDlp?: number | null; doseDap?: number | null; fluoroSeconds?: number | null;
  doseManual?: boolean;
  contrastGiven?: boolean; contrastAgent?: string | null; contrastVolumeMl?: number | null;
  drlReason?: string | null; contrastNotGivenReason?: string | null;
};

export const sendAcquired = (studyId: string, body: AcquiredBody) =>
  api<{ studyId: string; accessionNo: string; studyInstanceUid: string | null; billDecisionIds: string[] }>(
    "POST", `/radiology/studies/${encodeURIComponent(studyId)}/acquisition/acquired`, body,
  );

export const fetchRejects = (from?: string, to?: string) => {
  const qs = [from === undefined ? "" : `from=${from}`, to === undefined ? "" : `to=${to}`].filter((x) => x !== "").join("&");
  return api<WireRejects>("GET", `/radiology/room/rejects${qs === "" ? "" : `?${qs}`}`);
};

/** The dose register for IST days `[from, to]` (the RSO's read; the radiographer holds `aerb.doses.read`). */
export const fetchDoseLog = (from: string, to: string) =>
  api<{ rows: WireDoseRow[] }>("GET", `/aerb/doses?from=${from}&to=${to}`);

/**
 * "Report breakdown" is Setup's status write (18-S RS4, `radiology.devices.manage`), reused as-is:
 * the reason is required and the answer names the booked studies the desk must move.
 */
export const reportBreakdown = (deviceResourceId: string, reason: string) => setSetupDeviceStatus(deviceResourceId, "down", reason);

export const resolveBillDecision = (id: string, resolution: string) =>
  api("POST", `/radiology/bill-decisions/${encodeURIComponent(id)}/resolve`, { resolution });

/* ── pure helpers the console shows; each is a suggestion, never a control ── */

/**
 * The contrast volume the protocol suggests for this weight: `ml_per_kg × kg`, rounded to the
 * millilitre and capped at the protocol's maximum. A paediatric band's own ml/kg wins when the
 * weight falls inside one. The technologist types the volume actually given.
 */
export function suggestedContrastMl(p: WireProtocol, kg: number | null): number | null {
  if (p.contrast === undefined || kg === null || !(kg > 0)) return null;
  const band = paediatricBand(p, kg);
  const perKg = band?.ml_per_kg ?? p.contrast.ml_per_kg;
  return Math.min(Math.round(perKg * kg), p.contrast.max_ml);
}

export function paediatricBand(p: WireProtocol, kg: number | null): NonNullable<WireProtocol["paediatric"]>["bands"][number] | null {
  if (p.paediatric === undefined || kg === null) return null;
  return p.paediatric.bands.find((b) => kg >= b.from_kg && kg < b.to_kg) ?? null;
}

/** The dose fields a modality is recorded in (`recordAcquired`'s four numbers). */
export const DOSE_FIELDS: Record<string, readonly ("doseCtdivol" | "doseDlp" | "doseDap" | "fluoroSeconds")[]> = {
  ct: ["doseCtdivol", "doseDlp"],
  xray: ["doseDap", "fluoroSeconds"],
  mammography: ["doseDap"],
};

const FIELD_QUANTITY = { doseCtdivol: "ctdivol", doseDlp: "dlp", doseDap: "dap", fluoroSeconds: "fluoro_seconds" } as const;

/**
 * Which typed numbers sit above a published level — shown beside the field so the technologist can
 * say why. The verdict that is STORED is the server's (`drlFor`); this only decides whether to ask.
 */
export function aboveDrl(drl: readonly WireDrl[], typed: Partial<Record<keyof typeof FIELD_QUANTITY, number | null>>): WireDrl[] {
  return drl.filter((l) => {
    const field = (Object.keys(FIELD_QUANTITY) as (keyof typeof FIELD_QUANTITY)[]).find((f) => FIELD_QUANTITY[f] === l.quantity);
    const v = field === undefined ? null : typed[field] ?? null;
    return v !== null && v > l.value;
  });
}
