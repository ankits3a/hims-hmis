import { z } from "zod";
import type { TaskBoardView, TaskState } from "./tasks";

/**
 * E1.4 HOUSEKEEPING (issue #721, decision 0072, spec SPEC-ipd-companions §3) — bed turnover on the shared task
 * engine. A bed released into cleaning raises exactly one cleaning task; the bed becomes available only when that
 * task is verified (the verification runs the ipd beds seam in the same transaction). A terminal clean (isolation
 * bed, infection-control or deep-clean block, death or absconded discharge) is checked by the housekeeping
 * supervisor alone.
 */

export const HOUSEKEEPING_KINDS = {
  routine: "bed_clean_routine",
  terminal: "bed_clean_terminal",
  spill: "spill",
  inspection: "room_inspection",
  // HK-1 (#973) — an area's scheduled round (classes A and B are checked by the unit side; C and D are not),
  // and a request raised at an area (by staff or from the door QR).
  round: "area_round",
  roundChecked: "area_round_checked",
  request: "area_request",
} as const;
export type HousekeepingKind = (typeof HOUSEKEEPING_KINDS)[keyof typeof HOUSEKEEPING_KINDS];
/** Every kind housekeeping owns, in board order. */
export const HOUSEKEEPING_KIND_LIST: readonly HousekeepingKind[] = [
  HOUSEKEEPING_KINDS.terminal, HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.spill, HOUSEKEEPING_KINDS.request,
  HOUSEKEEPING_KINDS.roundChecked, HOUSEKEEPING_KINDS.round, HOUSEKEEPING_KINDS.inspection,
];
/** The two kinds that turn a bed over: their verification makes the bed available. */
export const BED_CLEAN_KINDS: readonly HousekeepingKind[] = [HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.terminal];

/** Targets (spec §3): routine turnover 45 min from release, terminal 90 min, spill 15 min. */
export const HOUSEKEEPING_TARGET_MIN = { routine: 45, terminal: 90, spill: 15 } as const;

const id = z.string().min(1).max(64);
export const cleanRefInput = z.object({ taskId: id, version: z.number().int().positive().optional() }).strict();
export type CleanRefInput = z.infer<typeof cleanRefInput>;

/** One bed's cleaning, as the Beds board and the supervisor see it. No patient, no money. */
export type BedCleanView = {
  bedId: string;
  taskId: string;
  kind: HousekeepingKind;
  terminal: boolean;
  /** created / assigned / accepted / in_progress = being cleaned; done = cleaned, waiting for the check. */
  state: TaskState;
  raisedAt: string;
  dueAt: string;
  /** Whole minutes since the task was raised (the bed's release), at `serverNow`. */
  minutes: number;
  late: boolean;
  /** "A. K." — the assignee's initials (never a full name on a wall), or null while in the pool. */
  assigneeInitials: string | null;
  escalatedRung: number;
  version: number;
};
export type BedCleansView = { serverNow: string; cleans: BedCleanView[] };

/** The housekeeping supervisor's board: the task board over housekeeping's kinds only. */
export type HousekeepingBoardView = TaskBoardView;

export const HOUSEKEEPING_ROUTES = {
  bedCleans: "/housekeeping/bed-cleans",
  board: "/housekeeping/board",
  verify: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/verify`,
  nudge: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/nudge`,
  // HK-1 (#973)
  supervisor: "/housekeeping/supervisor",
  confirm: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/confirm`,
  work: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/work`,
  photo: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/photo`,
  workForm: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/work-form`,
  setup: "/housekeeping/setup",
  areas: "/housekeeping/areas",
  areaQr: (areaId: string) => `/housekeeping/areas/${encodeURIComponent(areaId)}/qr`,
  areaRevoke: (areaId: string) => `/housekeeping/areas/${encodeURIComponent(areaId)}/revoke-qr`,
  checklists: "/housekeeping/checklists",
  contractors: "/housekeeping/contractors",
  staff: "/housekeeping/staff",
  rotas: "/housekeeping/rotas",
  rotaPublish: (rotaId: string) => `/housekeeping/rotas/${encodeURIComponent(rotaId)}/publish`,
  door: "/housekeeping/door",
} as const;

/** Housekeeping's own refusals (the engine's `TASK_REFUSALS` cover the rest): the rule and the fix. */
export const HOUSEKEEPING_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the fields and send again." },
  not_a_clean: { sentence: "This is not a housekeeping task.", fix: "Open it from the task board." },
  terminal_needs_supervisor: {
    sentence: "A terminal clean is checked by the housekeeping supervisor (infection control).",
    fix: "Ask the housekeeping supervisor to check this bed.",
  },
  // HK-1 (#973)
  reason_required: { sentence: "A fail needs a reason.", fix: "Pick or type what was not done." },
  bad_qr: { sentence: "This QR code is not a housekeeping area code, or it was replaced.", fix: "Scan the code on this door. If it fails again, tell the supervisor." },
  wrong_place: { sentence: "This QR code belongs to another place.", fix: "Scan the code at the place of this task." },
  checklist_incomplete: { sentence: "Every checklist item needs an answer.", fix: "Answer each item, then finish." },
  photo_missing: { sentence: "A bed or a toilet needs one photo before it is done.", fix: "Take one photo of the cleaned place (never a patient)." },
  work_missing: { sentence: "This task is finished from the housekeeping checklist.", fix: "Open it in My tasks, scan the QR and answer the checklist." },
  too_many_requests: { sentence: "This place has asked for help several times this hour.", fix: "Staff are on the way. Please ask at the nursing station if it is urgent." },
  unknown_area: { sentence: "This area is not set up.", fix: "Set the area up first." },
  not_a_place: { sentence: "Only a floor, ward, room, hall or bed can be a housekeeping area.", fix: "Pick a place from the register." },
  unknown_checklist: { sentence: "This checklist does not exist.", fix: "Pick a checklist from the list." },
  unknown_contractor: { sentence: "This contractor is not on the list.", fix: "Add the contractor first." },
  contractor_exists: { sentence: "A contractor with this name is already on the list.", fix: "Use the existing one." },
  not_a_shift_start: { sentence: "A rota starts at a shift start (07:00, 14:00 or 21:00).", fix: "Pick the shift from the list." },
  unknown_rota: { sentence: "This rota does not exist.", fix: "Refresh the rota page." },
  rota_published: { sentence: "This rota is already published.", fix: "Make a new draft for changes." },
  unknown_person: { sentence: "This person cannot be placed on the rota.", fix: "Pick an active member of staff." },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type HousekeepingRefusalCode = keyof typeof HOUSEKEEPING_REFUSALS;

/* ═══ HK-1 (#973, decision 0086): areas, staff, rota, rounds, work proof, confirm, door requests ═══ */

/** Area classes: A critical (ICU, OT, isolation), B clinical (wards, rooms), C toilets, C public, D support. */
export const HK_AREA_CLASSES = ["A", "B", "C_toilet", "C_public", "D"] as const;
export type HkAreaClass = (typeof HK_AREA_CLASSES)[number];
/** Trained skills: a class A area needs `critical`, a terminal clean `terminal`, a spill `spill`. */
export const HK_SKILLS = ["critical", "spill", "terminal"] as const;
export type HkSkill = (typeof HK_SKILLS)[number];
/** What a door QR (or any staff member) may ask for. */
export const HK_DOOR_NEEDS = ["clean", "toilet", "spill", "bin"] as const;
export type HkDoorNeed = (typeof HK_DOOR_NEEDS)[number];
export const HK_ROTA_MODES = ["floor", "route", "beds"] as const;
export type HkRotaMode = (typeof HK_ROTA_MODES)[number];
export const HK_ROUND_STATUSES = ["due", "done", "missed"] as const;
export type HkRoundStatus = (typeof HK_ROUND_STATUSES)[number];
/** The company recorded for hospital-employed staff. */
export const HK_IN_HOUSE = "In-house";
/** DECIDED: a round not scanned by its due time is missed this many minutes later. */
export const HK_ROUND_GRACE_MIN = 15;
/** DECIDED: a door QR raises at most this many requests an hour per area. */
export const HK_DOOR_PER_AREA_HOUR = 4;
/** A class's photo default: a toilet always needs one (a bed clean always does, whatever its area). */
export const HK_PHOTO_BY_CLASS: Readonly<Record<HkAreaClass, boolean>> = { A: false, B: false, C_toilet: true, C_public: false, D: false };

/** IST is UTC+05:30 all year. */
const IST_MS = 330 * 60_000;
const HOUR = 3_600_000;
export type HkShiftKey = "morning" | "evening" | "night";
export type HkShift = { key: HkShiftKey; startsAt: Date; endsAt: Date };

/** 07:00 IST of the hospital day holding `now` (a day runs 07:00 to 07:00). */
function hospitalDayStart(now: Date): number {
  const ist = now.getTime() + IST_MS - 7 * HOUR;
  return Math.floor(ist / (24 * HOUR)) * 24 * HOUR - IST_MS + 7 * HOUR;
}

/** DECIDED (standard three-shift pattern): morning 07:00–14:00, evening 14:00–21:00, night 21:00–07:00 IST. */
export function hkShiftAt(now: Date): HkShift {
  const day = hospitalDayStart(now);
  const h = (now.getTime() - day) / HOUR;
  if (h < 7) return { key: "morning", startsAt: new Date(day), endsAt: new Date(day + 7 * HOUR) };
  if (h < 14) return { key: "evening", startsAt: new Date(day + 7 * HOUR), endsAt: new Date(day + 14 * HOUR) };
  return { key: "night", startsAt: new Date(day + 14 * HOUR), endsAt: new Date(day + 24 * HOUR) };
}

/**
 * Round slots per class, as hours after 07:00 IST (DECIDED by standard NABH housekeeping practice): A every 3–4 h,
 * B once a shift, toilets hourly 07:00–22:00 and two-hourly at night, public areas two-hourly, D once a day.
 */
const SLOTS: Readonly<Record<HkAreaClass, readonly number[]>> = {
  A: [0, 4, 7, 11, 14, 18, 22],
  B: [0, 7, 14],
  C_toilet: [...Array.from({ length: 15 }, (_, i) => i), 15, 17, 19, 21, 23],
  C_public: Array.from({ length: 12 }, (_, i) => i * 2),
  D: [0],
};
/** Minutes from a slot's start to its due time (null: the slot's own end). */
const DUE_MIN: Readonly<Record<HkAreaClass, number | null>> = { A: 60, B: 120, C_toilet: null, C_public: null, D: 240 };

/** The round slot of this class that holds `now`: its start and its due time. */
export function hkSlotAt(areaClass: HkAreaClass, now: Date): { slotStart: Date; dueAt: Date } {
  const day = hospitalDayStart(now);
  const h = (now.getTime() - day) / HOUR;
  const slots = SLOTS[areaClass];
  let i = 0;
  while (i + 1 < slots.length && slots[i + 1]! <= h) i += 1;
  const start = day + slots[i]! * HOUR;
  const end = day + (slots[i + 1] ?? 24) * HOUR;
  const dueMin = DUE_MIN[areaClass];
  return { slotStart: new Date(start), dueAt: new Date(dueMin === null ? end : start + dueMin * 60_000) };
}

const text = z.string().trim().min(1).max(200);
export const saveChecklistInput = z.object({
  name: text,
  items: z.array(z.object({ text }).strict()).min(1).max(30),
  /** A new version of an existing checklist: areas on the old version move to the new one. */
  lineageId: id.optional(),
}).strict();
export type SaveChecklistInput = z.infer<typeof saveChecklistInput>;
export const defineAreaInput = z.object({
  resourceId: id,
  areaClass: z.enum(HK_AREA_CLASSES),
  checklistId: id.nullable().optional(),
  photoNeeded: z.boolean().optional(),
}).strict();
export type DefineAreaInput = z.infer<typeof defineAreaInput>;
export const areaRefInput = z.object({ areaId: id }).strict();
export const addContractorInput = z.object({ name: text }).strict();
export const setHkStaffInput = z.object({
  userId: id,
  contractorId: id.nullable(),
  skills: z.array(z.enum(HK_SKILLS)).max(HK_SKILLS.length),
}).strict();
export type SetHkStaffInput = z.infer<typeof setHkStaffInput>;
export const rotaPlaceInput = z.discriminatedUnion("mode", [
  z.object({ userId: id, mode: z.literal("floor"), floorId: id }).strict(),
  z.object({ userId: id, mode: z.literal("route"), areaIds: z.array(id).min(1).max(100) }).strict(),
  z.object({ userId: id, mode: z.literal("beds"), bedIds: z.array(id).min(1).max(100) }).strict(),
]);
export type RotaPlaceInput = z.infer<typeof rotaPlaceInput>;
export const saveRotaInput = z.object({
  shiftStartsAt: z.iso.datetime({ offset: true }),
  places: z.array(rotaPlaceInput).max(500),
}).strict();
export type SaveRotaInput = z.infer<typeof saveRotaInput>;
export const publishRotaInput = z.object({ rotaId: id }).strict();
export const finishWorkInput = z.object({
  taskId: id,
  scan: z.string().trim().min(1).max(256),
  answers: z.array(z.object({ itemId: id, ok: z.boolean() }).strict()).max(30),
  photoKey: z.string().min(1).max(256).optional(),
}).strict();
export type FinishWorkInput = z.infer<typeof finishWorkInput>;
export const confirmCleanInput = z.object({
  taskId: id,
  result: z.enum(["pass", "fail"]),
  reason: z.string().trim().max(280).optional(),
  version: z.number().int().positive().optional(),
}).strict();
export type ConfirmCleanInput = z.infer<typeof confirmCleanInput>;
export const doorRequestInput = z.object({ token: z.string().trim().min(1).max(256), need: z.enum(HK_DOOR_NEEDS) }).strict();
export type DoorRequestInput = z.infer<typeof doorRequestInput>;

/** DECIDED: the reasons a checker picks from (a typed reason is also accepted). */
export const HK_FAIL_REASONS = ["Floor not mopped", "Bin not emptied", "Linen not changed", "Surfaces dusty", "Washroom not cleaned", "Smell remains"] as const;

export type HkChecklistItem = { id: string; text: string };
export type HkChecklistView = { id: string; lineageId: string; version: number; name: string; items: HkChecklistItem[] };
export type HkAreaView = {
  id: string; resourceId: string; name: string; code: string; kind: string; areaClass: HkAreaClass;
  floorId: string | null; floorName: string | null; checklistId: string | null; photoNeeded: boolean; qrVersion: number;
};
export type HkContractorView = { id: string; name: string };
export type HkStaffView = { userId: string; name: string; contractorId: string | null; company: string; skills: HkSkill[] };
export type HkSetupView = {
  areas: HkAreaView[]; checklists: HkChecklistView[]; contractors: HkContractorView[]; staff: HkStaffView[];
  /** Places that may become areas: floors, wards, rooms and halls. */
  places: { id: string; name: string; code: string; kind: string; floorName: string | null }[];
};
export type HkRotaPlaceView = { userId: string; name: string; company: string; mode: HkRotaMode; floorId: string | null; areaIds: string[]; bedIds: string[]; load: number };
export type HkRotaView = {
  id: string | null; status: "none" | "draft" | "published"; shift: HkShiftKey; shiftStartsAt: string; shiftEndsAt: string;
  places: HkRotaPlaceView[];
  /** People placed without a roster duty in this shift: they get no tasks. */
  warnings: { userId: string; code: "no_roster_duty" }[];
};
export type HkRoundView = { id: string; areaId: string; taskId: string; slotStart: string; dueAt: string; status: HkRoundStatus };
export type HkWorkView = {
  taskId: string; attempt: number; doneBy: string; company: string; scannedAt: string; scanAreaId: string;
  answers: { itemId: string; ok: boolean }[]; photoKey: string | null;
};
/** What the phone shows before the attendant finishes a task: the checklist and whether a photo is needed. */
export type HkWorkForm = { taskId: string; needsWork: boolean; areaName: string | null; items: HkChecklistItem[]; photoNeeded: boolean; lastReason: string | null };
export type HkMissedRound = {
  areaId: string; areaName: string; floorName: string | null; taskId: string; slotStart: string; dueAt: string;
  /** Initials only: the board is a wall display. */
  assigneeInitials: string | null;
};
export type HkNeedsYou = { taskId: string; kind: string; placeName: string | null; fails: number; reason: string | null; assigneeInitials: string | null };
export type HkPerson = { userId: string; name: string; company: string; placement: string; load: number };
export type HkSupervisorView = { serverNow: string; missed: HkMissedRound[]; needsYou: HkNeedsYou[]; people: HkPerson[] };
export type HkDoorAck = { requestId: string; taskId: string };
