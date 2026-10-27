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
  // HK-2 (#974) — the rework a failed random inspection raises on the floor team (checked by the supervisor).
  rework: "area_rework",
} as const;
export type HousekeepingKind = (typeof HOUSEKEEPING_KINDS)[keyof typeof HOUSEKEEPING_KINDS];
/** Every kind housekeeping owns, in board order. */
export const HOUSEKEEPING_KIND_LIST: readonly HousekeepingKind[] = [
  HOUSEKEEPING_KINDS.terminal, HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.spill, HOUSEKEEPING_KINDS.request,
  HOUSEKEEPING_KINDS.roundChecked, HOUSEKEEPING_KINDS.round, HOUSEKEEPING_KINDS.rework, HOUSEKEEPING_KINDS.inspection,
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
  proof: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/proof`,
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
  // HK-2 (#974)
  floorStores: "/housekeeping/floor-stores",
  toCheck: "/housekeeping/to-check",
  inspections: "/housekeeping/inspections",
  inspection: (id: string) => `/housekeeping/inspections/${encodeURIComponent(id)}`,
  inspectionPhoto: (id: string) => `/housekeeping/inspections/${encodeURIComponent(id)}/photo`,
  consumables: "/housekeeping/reports/consumables",
  sla: "/housekeeping/reports/sla",
  daily: "/housekeeping/reports/daily",
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
  not_a_shift_start: { sentence: "A rota starts at a shift start (07:00, 15:00 or 23:00).", fix: "Pick the shift from the list." },
  unknown_rota: { sentence: "This rota does not exist.", fix: "Refresh the rota page." },
  rota_published: { sentence: "This rota is already published.", fix: "Make a new draft for changes." },
  unknown_person: { sentence: "This person cannot be placed on the rota.", fix: "Pick an active member of staff." },
  // HK-2 (#974)
  not_a_floor: { sentence: "Only a floor has a housekeeping store.", fix: "Pick a floor from the list." },
  not_a_store: { sentence: "This is not a store.", fix: "Pick a store from the materials list." },
  store_taken: { sentence: "This store already serves another floor.", fix: "Pick the floor's own store, or create one." },
  unknown_inspection: { sentence: "This inspection does not exist.", fix: "Refresh the inspection list." },
  inspection_done: { sentence: "This inspection is already scored.", fix: "Open the next one on the list." },
  bad_month: { sentence: "A month is written as YYYY-MM.", fix: "Pick the month from the list." },
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

/** DECIDED (the design board, the standard three eight-hour shifts): morning 07–15, evening 15–23, night 23–07 IST. */
export function hkShiftAt(now: Date): HkShift {
  const day = hospitalDayStart(now);
  const h = (now.getTime() - day) / HOUR;
  if (h < 8) return { key: "morning", startsAt: new Date(day), endsAt: new Date(day + 8 * HOUR) };
  if (h < 16) return { key: "evening", startsAt: new Date(day + 8 * HOUR), endsAt: new Date(day + 16 * HOUR) };
  return { key: "night", startsAt: new Date(day + 16 * HOUR), endsAt: new Date(day + 24 * HOUR) };
}

/**
 * Round slots per class, as hours after 07:00 IST (DECIDED by standard NABH housekeeping practice): A every 4 h,
 * B once a shift, toilets hourly 07:00–22:00 and two-hourly at night, public areas two-hourly, D once a day.
 */
const SLOTS: Readonly<Record<HkAreaClass, readonly number[]>> = {
  A: [0, 4, 8, 12, 16, 20],
  B: [0, 8, 16],
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
export const HK_FAIL_REASONS = ["Floor wet", "Bin full", "Linen missing", "Stain", "Smell", "Toilet dirty"] as const;

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
  /** IPD beds, for a bed-wise rota section. */
  beds: { id: string; code: string; floorId: string | null; floorName: string | null }[];
  /** Everyone who may be placed on the rota: the cleaning skill's role holders, active. */
  people: { userId: string; name: string; company: string; skills: HkSkill[] }[];
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
/** What a checker sees before Pass or Fail: the newest attempt's proof (photo bytes inline), or null without one. */
export type HkProofView = {
  taskId: string; attempt: number; doneByName: string; company: string; scannedAt: string; scanAreaName: string | null;
  answers: { text: string; ok: boolean }[]; photo: { mimeType: string; imageBase64: string } | null;
  /** Failed checks so far, and the newest reason. */
  fails: number; lastReason: string | null;
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


/* ═══ HK-2 (#974, decision 0086): floor stores, random inspections, contractor SLA, daily and monthly reports ═══ */

/** DECIDED (spec #974): two random C or D areas per floor per shift. */
export const HK_INSPECT_PER_FLOOR = 2;
/** DECIDED (spec #974, NABH housekeeping audit): an inspection passes at 80 % or more. */
export const HK_INSPECT_PASS_PCT = 80;
/** The classes a random inspection draws from: toilets, public areas, support areas (no per-round check of their own). */
export const HK_INSPECT_CLASSES: readonly HkAreaClass[] = ["C_toilet", "C_public", "D"];
/**
 * DECIDED: the short NABH housekeeping audit (HIC chapter: environment cleaning, BMW segregation, washroom upkeep).
 * Ids are stable (answers store them); the words are translated on screen (`housekeeping.inspect.item.<id>`).
 */
export const HK_INSPECTION_ITEMS = [
  { id: "floor", text: "Floor clean and dry, no stains" },
  { id: "surfaces", text: "High-touch surfaces wiped (handles, switches, rails)" },
  { id: "bins", text: "Bins emptied, lined and colour-coded" },
  { id: "fixtures", text: "Basins, toilets and fixtures clean, no smell" },
  { id: "supplies", text: "Soap, tissue and hand rub stocked" },
  { id: "dust", text: "No dust, cobwebs or pests on high surfaces" },
  { id: "signage", text: "Wet-floor sign used and cleaning log signed" },
  { id: "clutter", text: "No clutter, linen or waste left lying" },
] as const;
export type HkInspectionItemId = (typeof HK_INSPECTION_ITEMS)[number]["id"];

/** The score of an inspection: the share of items answered Yes, whole per cent. */
export function hkInspectionScore(answers: readonly { ok: boolean }[]): number {
  if (answers.length === 0) return 0;
  return Math.round((answers.filter((a) => a.ok).length * 100) / answers.length);
}

/** A month is `YYYY-MM`, in IST. */
export const hkMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
/** The IST month holding `at`, as `YYYY-MM`. */
export function hkMonthOf(at: Date): string {
  const ist = new Date(at.getTime() + IST_MS);
  return `${String(ist.getUTCFullYear())}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
}
/** The instants an IST month runs between: 00:00 IST on its first day to 00:00 IST on the next month's first. */
export function hkMonthWindow(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1) - IST_MS), end: new Date(Date.UTC(y, m, 1) - IST_MS) };
}

export const linkFloorStoreInput = z.object({ floorId: id, storeId: id }).strict();
export type LinkFloorStoreInput = z.infer<typeof linkFloorStoreInput>;
export const recordInspectionInput = z.object({
  inspectionId: id,
  scan: z.string().trim().min(1).max(256),
  answers: z.array(z.object({ itemId: id, ok: z.boolean() }).strict()).max(30),
  photoKey: z.string().min(1).max(256).optional(),
}).strict();
export type RecordInspectionInput = z.infer<typeof recordInspectionInput>;

export type HkFloorStoreView = { floorId: string; floorName: string; storeId: string | null; storeName: string | null };
export type HkInspectionStatus = "due" | "passed" | "failed";
export type HkInspectionView = {
  id: string; areaId: string; areaName: string; areaClass: HkAreaClass; floorId: string; floorName: string | null;
  shiftStartsAt: string; status: HkInspectionStatus; scorePct: number | null; inspectedAt: string | null;
  /** The company whose attendant last worked the area before the inspection (null: nobody had). Never a person. */
  company: string | null;
  reworkTaskId: string | null;
};
export type HkInspectionsView = { serverNow: string; shiftStartsAt: string; inspections: HkInspectionView[] };

/** One floor's month of consumables: what its store received, valued at the store's landed cost on the transfer. */
export type HkConsumableLine = { itemId: string; itemCode: string; itemName: string; baseUom: string; qty: number; valuePaise: number };
export type HkFloorConsumables = {
  floorId: string; floorName: string; storeId: string; storeName: string;
  items: HkConsumableLine[]; totalPaise: number;
  /** IPD beds on the floor (0: not a ward floor, total only). */
  beds: number;
  /** Occupied bed-days by the midnight census (null when the floor has no IPD beds). */
  occupiedBedDays: number | null;
  /** Total ÷ occupied bed-days, whole paise (null without beds or bed-days). */
  costPerBedDayPaise: number | null;
};
export type HkConsumablesView = { month: string; floors: HkFloorConsumables[]; totalPaise: number };

/**
 * One company's month (a contractor, or In-house for comparison). Report only: no money, no deduction (decision 0086),
 * and no person — company names only.
 */
export type HkSlaRow = {
  company: string; contractorId: string | null; inHouse: boolean;
  rounds: { onTime: number; late: number; missed: number };
  turnaround: { count: number; medianMin: number | null; p90Min: number | null };
  firstPass: { checked: number; passedFirstTime: number; ratePct: number | null };
  inspections: { count: number; avgScorePct: number | null };
};
export type HkSlaView = { month: string; rows: HkSlaRow[] };

/** A count and the records behind it (task ids; inspection ids for inspections), so the count can be checked. */
export type HkBucket = { count: number; ids: string[] };
export type HkDailyView = {
  floorId: string; floorName: string; shift: HkShiftKey; shiftStartsAt: string; shiftEndsAt: string;
  rounds: { due: HkBucket; done: HkBucket; missed: HkBucket };
  turnarounds: HkBucket & { medianMin: number | null };
  requests: { raised: HkBucket; closed: HkBucket };
  fails: HkBucket;
  rework: HkBucket;
  inspections: { drawn: HkBucket; passed: HkBucket; failed: HkBucket };
};
/** What a nurse or the supervisor may Pass or Fail now (the phone's check list). No patient. */
export type HkToCheck = { taskId: string; kind: string; kindLabel: string; placeName: string | null; doneAt: string | null; terminal: boolean; fails: number };
