import { z } from "zod";
import type { BoardWorker } from "./tasks";

/**
 * E1.6 TRANSPORT (issue #723, decision 0072, spec SPEC-ipd-companions §6) — porters and patient movement on the
 * shared task engine. A patient move says how (wheelchair, stretcher, bed, walking), with what (oxygen, monitor),
 * under which isolation precautions and whether a nurse or doctor escort goes with it. A critical patient's move
 * cannot START without an escort recorded; an oxygen move cannot start before the cylinder check; the move is DONE
 * only when the porter scans the patient's wristband at the destination and it resolves to the same admission.
 * Sample and document runs use the same engine and need no patient.
 */

export const TRANSPORT_KINDS = {
  patientMove: "patient_move",
  sampleRun: "sample_run",
  documentRun: "document_run",
} as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[keyof typeof TRANSPORT_KINDS];
export const TRANSPORT_KIND_LIST: readonly TransportKind[] = [
  TRANSPORT_KINDS.patientMove, TRANSPORT_KINDS.sampleRun, TRANSPORT_KINDS.documentRun,
];

export const TRANSPORT_MODES = ["wheelchair", "stretcher", "bed", "walking"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export const TRANSPORT_ISOLATION = ["none", "contact", "droplet", "airborne"] as const;
export type TransportIsolation = (typeof TRANSPORT_ISOLATION)[number];
export const TRANSPORT_REASONS = ["admit", "transfer", "imaging", "ot", "discharge", "other"] as const;
export type TransportReason = (typeof TRANSPORT_REASONS)[number];
/** Why an escort is required: the bed's critical-care class, or the requester's high-risk flag. */
export const ESCORT_REASONS = ["critical_care_bed", "high_risk_flag", "requested"] as const;
export type EscortReason = (typeof ESCORT_REASONS)[number];

/** Targets (spec §6, DECIDED): a patient move accepted within 5 min and done within 30; a run done within 20. */
export const TRANSPORT_TARGET_MIN = { moveAccept: 5, moveDone: 30, runAccept: 5, runDone: 20 } as const;

const id = z.string().min(1).max(64);

/**
 * A transport request. A patient move needs `admissionId`; a run (sample, document) needs no patient. `from` defaults
 * to the patient's current bed; `to` is a register place or, when the place is not in the register (the gate, an
 * outside centre), a short note.
 */
export const requestTransportInput = z.object({
  kind: z.enum([TRANSPORT_KINDS.patientMove, TRANSPORT_KINDS.sampleRun, TRANSPORT_KINDS.documentRun]),
  admissionId: id.optional(),
  fromResourceId: id.optional(),
  toResourceId: id.optional(),
  toNote: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(TRANSPORT_MODES).optional(),
  oxygen: z.boolean().optional(),
  monitor: z.boolean().optional(),
  isolation: z.enum(TRANSPORT_ISOLATION).optional(),
  escortRequired: z.boolean().optional(),
  /** The requester's high-risk flag (until nursing early-warning scores exist): forces an escort. */
  highRisk: z.boolean().optional(),
  reason: z.enum(TRANSPORT_REASONS).optional(),
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  note: z.string().trim().max(280).optional(),
  /** An IPD lane's key for the move (e.g. `admission:<id>:to-bed`): a second request with it returns the first. */
  sourceRef: z.string().trim().min(1).max(128).optional(),
}).strict();
export type RequestTransportInput = z.infer<typeof requestTransportInput>;

const ref = { taskId: id, version: z.number().int().positive().optional() };
export const addEscortInput = z.object({ ...ref, escortUserId: id }).strict();
export type AddEscortInput = z.infer<typeof addEscortInput>;
export const oxygenCheckInput = z.object({ ...ref }).strict();
export type OxygenCheckInput = z.infer<typeof oxygenCheckInput>;

/** Transport's own refusals (the engine's `TASK_REFUSALS` cover the rest): the rule and the fix. */
export const TRANSPORT_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the fields and send again." },
  admission_required: { sentence: "A patient move needs the patient's admission.", fix: "Pick the patient." },
  admission_not_open: { sentence: "This admission is not open.", fix: "Pick a patient who is admitted." },
  no_destination: { sentence: "Where to is missing.", fix: "Pick the place, or type where." },
  no_origin: { sentence: "Where from is missing.", fix: "Pick the place the patient is in." },
  unknown_place: { sentence: "This place is not in the register.", fix: "Pick the place from the list." },
  not_transport: { sentence: "This is not a transport task.", fix: "Open it from the transport board." },
  escort_required: {
    sentence: "A critical patient moves only with a nurse or doctor escort.",
    fix: "Add escort",
  },
  escort_not_clinical: { sentence: "An escort is a nurse or a doctor.", fix: "Pick a nurse or doctor on duty." },
  escort_is_porter: { sentence: "The porter cannot be the escort.", fix: "Pick a nurse or doctor." },
  oxygen_not_checked: { sentence: "Check the oxygen cylinder before the move.", fix: "Check cylinder" },
  already_started: { sentence: "The move has started.", fix: "Record this before Start." },
  scan_required: { sentence: "Scan the patient's wristband to hand over.", fix: "Scan wristband" },
  band_unknown: { sentence: "This wristband is not known.", fix: "Scan the band on the patient's wrist." },
  band_void: { sentence: "This wristband was replaced.", fix: "Scan the patient's new band." },
  wrong_patient: { sentence: "Wrong patient: this band is another patient's.", fix: "Stop. Scan the band of the patient you moved." },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type TransportRefusalCode = keyof typeof TRANSPORT_REFUSALS;

/* ═══ wire shapes ═══ */

/** Escort state in words: not needed, waiting for one, or with one. */
export type EscortState = "not_needed" | "waiting" | "with_escort";

/** A transport task's details as its porter sees them on "My tasks" (their own card: the patient's name and IP no). */
export type TransportDetail = {
  taskId: string;
  kind: TransportKind;
  fromName: string | null;
  toName: string | null;
  mode: TransportMode | null;
  oxygen: boolean;
  oxygenChecked: boolean;
  monitor: boolean;
  isolation: TransportIsolation;
  reason: TransportReason | null;
  escortRequired: boolean;
  escortReason: EscortReason | null;
  escortState: EscortState;
  escortName: string | null;
  /** Porter's own card only — never the board. */
  patientName: string | null;
  admissionNo: string | null;
  handedOverAt: string | null;
};
export type TransportDetailsView = { details: TransportDetail[] };

/** One open move on the supervisor's wall board. No patient identity, no money. */
export type TransportBoardRow = {
  taskId: string;
  kind: TransportKind;
  state: string;
  priority: string;
  fromName: string | null;
  toName: string | null;
  mode: TransportMode | null;
  oxygen: boolean;
  monitor: boolean;
  isolation: TransportIsolation;
  escortState: EscortState;
  /** "A. K." — the porter's initials, or null while waiting for a porter. */
  porterInitials: string | null;
  createdAt: string;
  dueAt: string;
  late: boolean;
  version: number;
};
export type TransportBoardView = {
  serverNow: string;
  rows: TransportBoardRow[];
  workers: BoardWorker[];
  counts: { open: number; late: number; waitingEscort: number; pool: number; notShown: number };
};

/** The request sheet's pickers. */
export type TransportPatientOption = {
  admissionId: string; admissionNo: string | null; name: string; uhid: string; bedId: string | null; bedName: string | null;
  criticalCare: boolean;
};
export type TransportPlaceOption = { id: string; kind: string; code: string; name: string };
export type TransportEscortOption = { userId: string; name: string };
export type TransportRequestAck = { taskId: string; state: string; version: number; merged: boolean; escortRequired: boolean };

export const TRANSPORT_ROUTES = {
  request: "/transport/requests",
  details: "/transport/details",
  board: "/transport/board",
  patients: "/transport/patients",
  places: "/transport/places",
  escorts: "/transport/escorts",
  escort: (taskId: string) => `/transport/tasks/${encodeURIComponent(taskId)}/escort`,
  oxygen: (taskId: string) => `/transport/tasks/${encodeURIComponent(taskId)}/oxygen-check`,
} as const;
