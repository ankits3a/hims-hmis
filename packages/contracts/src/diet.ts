import { z } from "zod";

/**
 * E4.4 DIET (#736, decision 0072) — the doctor's diet order to the kitchen's meal list (SPEC-ipd-companions §7).
 *
 * DECIDED (standard Indian corporate-hospital dietetics, owner ruling: anything not money/procurement/law):
 * - the catalogue below is the hospital's diet list; NPO is in it but is its own record (start, optional end) and
 *   ALWAYS wins over any diet;
 * - doctors and dieticians order a diet; a nurse may set or lift NPO (a safety act) and nothing else;
 * - a therapeutic diet (diabetic, renal, cardiac, high protein, Ryle's tube feed) ordered by a doctor opens a
 *   dietician consult (NABH: nutritional assessment for therapeutic diets);
 * - four meal rounds, cut-off and serve time per round in IST minutes (settings rows, seeded below);
 * - an OT booking sets NPO from 00:00 IST on the surgery day to the end of that IST day; a cancelled booking lifts it;
 * - no money: diet is part of the room-rent package (IPD charges have no diet component; nothing is charged here).
 */

export const DIET_CODES = [
  "normal", "soft", "liquid_clear", "liquid_full", "diabetic", "renal", "cardiac", "high_protein", "ryles_feed",
  "paediatric", "npo",
] as const;
export type DietCode = (typeof DIET_CODES)[number];
export const DietCodeSchema = z.enum(DIET_CODES);

export type DietCatalogueEntry = {
  code: DietCode;
  label: string;
  /** Opens a dietician consult when a doctor orders it. */
  therapeutic: boolean;
  /** Needs a volume (ml) and a frequency (hours) — the feed the kitchen prepares. */
  tubeFeed: boolean;
  /** Not a diet: an NPO record (ordering it starts NPO). */
  npo: boolean;
};

export const DIET_CATALOGUE: readonly DietCatalogueEntry[] = [
  { code: "normal", label: "Normal", therapeutic: false, tubeFeed: false, npo: false },
  { code: "soft", label: "Soft", therapeutic: false, tubeFeed: false, npo: false },
  { code: "liquid_clear", label: "Clear liquid", therapeutic: false, tubeFeed: false, npo: false },
  { code: "liquid_full", label: "Full liquid", therapeutic: false, tubeFeed: false, npo: false },
  { code: "diabetic", label: "Diabetic", therapeutic: true, tubeFeed: false, npo: false },
  { code: "renal", label: "Renal", therapeutic: true, tubeFeed: false, npo: false },
  { code: "cardiac", label: "Cardiac / low salt", therapeutic: true, tubeFeed: false, npo: false },
  { code: "high_protein", label: "High protein", therapeutic: true, tubeFeed: false, npo: false },
  { code: "ryles_feed", label: "Ryle's tube feed", therapeutic: true, tubeFeed: true, npo: false },
  { code: "paediatric", label: "Paediatric", therapeutic: false, tubeFeed: false, npo: false },
  { code: "npo", label: "NPO (nil by mouth)", therapeutic: false, tubeFeed: false, npo: true },
];

export function dietEntry(code: DietCode): DietCatalogueEntry {
  return DIET_CATALOGUE.find((d) => d.code === code)!;
}

export const DIET_PREFERENCES = ["veg", "non_veg", "jain"] as const;
export type DietPreference = (typeof DIET_PREFERENCES)[number];

export const DIET_MEALS = ["breakfast", "lunch", "evening", "dinner"] as const;
export type DietMeal = (typeof DIET_MEALS)[number];

/** Seeded IST defaults, minutes after IST midnight (the settings rows start here; `diet.manage` edits them). */
export const DIET_MEAL_ROUND_DEFAULTS: Record<DietMeal, { cutoffMinute: number; serveMinute: number }> = {
  breakfast: { cutoffMinute: 6 * 60, serveMinute: 7 * 60 + 30 },
  lunch: { cutoffMinute: 10 * 60 + 30, serveMinute: 12 * 60 + 30 },
  evening: { cutoffMinute: 15 * 60, serveMinute: 16 * 60 + 30 },
  dinner: { cutoffMinute: 17 * 60 + 30, serveMinute: 19 * 60 + 30 },
};

/** Who set an order, an NPO or a lift: the person, the role they acted in, or the system (OT booking). */
export const DIET_SOURCES = ["doctor", "dietician", "nurse", "ot_booking", "system"] as const;
export type DietSource = (typeof DIET_SOURCES)[number];
export type DietProvenance = { source: DietSource; by: string; at: string; ref?: string | null };

export const DIET_LINE_STATES = ["active", "withdrawn"] as const;
export const DIET_WITHDRAW_REASONS = ["npo", "transferred", "discharged", "deceased", "lama", "absconded", "transferred_out"] as const;
export type DietWithdrawReason = (typeof DIET_WITHDRAW_REASONS)[number];
export const DIET_SERVE_OUTCOMES = ["delivered", "refused"] as const;

const id = z.ulid();
const minute = z.number().int().min(0).max(24 * 60 - 1);
const note = z.string().trim().min(1).max(280);

export const DIET_INTENTS = {
  order_diet: z.strictObject({
    admissionId: id,
    code: DietCodeSchema,
    preference: z.enum(DIET_PREFERENCES).default("veg"),
    tubeVolumeMl: z.number().int().min(10).max(1000).optional(),
    tubeEveryHours: z.number().int().min(1).max(12).optional(),
    note: note.optional(),
  }),
  start_npo: z.strictObject({
    admissionId: id,
    /** ISO instant; absent = now. */
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    reason: note,
  }),
  lift_npo: z.strictObject({ npoId: id, reason: note }),
  request_consult: z.strictObject({ admissionId: id, reason: note }),
  complete_consult: z.strictObject({ consultId: id, note }),
  set_meal_round: z.strictObject({ meal: z.enum(DIET_MEALS), cutoffMinute: minute, serveMinute: minute }),
  build_lists: z.strictObject({ meal: z.enum(DIET_MEALS), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  serve_line: z.strictObject({ lineId: id, outcome: z.enum(DIET_SERVE_OUTCOMES) }),
} as const;
export type DietIntentName = keyof typeof DIET_INTENTS;
export type DietIntentInput<N extends DietIntentName> = z.input<(typeof DIET_INTENTS)[N]>;

export const DIET_REFUSALS = {
  bad_input: { rule: "The request is not complete.", fix: "Check the fields and send again." },
  forbidden: { rule: "You may not do this.", fix: "Ask a doctor or the dietician." },
  admission_not_found: { rule: "No admission has this id.", fix: "Search admissions" },
  admission_not_placed: { rule: "Diet is ordered only while the patient is on a bed.", fix: "Open the admission" },
  nurse_npo_only: { rule: "A nurse may set or lift NPO only; a diet is the doctor's or the dietician's.", fix: "Ask the doctor" },
  tube_feed_needs_volume: { rule: "A tube feed needs the volume and how often.", fix: "Enter ml and hours" },
  npo_end_before_start: { rule: "NPO must end after it starts.", fix: "Fix the end time" },
  npo_not_found: { rule: "No NPO has this id.", fix: "Open the diet sheet" },
  npo_not_live: { rule: "This NPO has already ended.", fix: "Open the diet sheet" },
  consult_not_found: { rule: "No open consult has this id.", fix: "Open the consult queue" },
  consult_open: { rule: "A dietician consult is already open for this patient.", fix: "Open the consult queue" },
  list_not_found: { rule: "No meal list has this id.", fix: "Open the kitchen board" },
  list_not_printed: { rule: "Print the list before dispatch.", fix: "Print the list" },
  list_already_dispatched: { rule: "This list has already left the kitchen.", fix: "Open the kitchen board" },
  line_not_found: { rule: "No tray line has this id.", fix: "Open the diet sheet" },
  line_withdrawn: { rule: "This tray was withdrawn (NPO, transfer or discharge).", fix: "Do not serve" },
  list_not_dispatched: { rule: "The kitchen has not sent this list yet.", fix: "Wait for the trolley" },
  cutoff_after_serve: { rule: "The cut-off must come before the serve time.", fix: "Fix the times" },
} as const;
export type DietRefusalCode = keyof typeof DIET_REFUSALS;

/** The patient on a list line or sheet row. `sealed`: alias only (no UHID). Bed stays — the tray must reach it. */
export type DietPatient = { name: string; uhid: string; sealed: boolean };

export type DietOrderView = {
  id: string; code: DietCode; label: string; preference: DietPreference; tubeVolumeMl: number | null;
  tubeEveryHours: number | null; note: string | null; startedAt: string; provenance: DietProvenance;
};
export type DietNpoView = {
  id: string; startsAt: string; endsAt: string | null; reason: string; provenance: DietProvenance; live: boolean;
};

export type DietLineView = {
  id: string; admissionId: string; bedCode: string | null; patient: DietPatient; code: DietCode; label: string;
  preference: DietPreference; tube: string | null; allergies: string[]; defaulted: boolean; late: boolean;
  state: (typeof DIET_LINE_STATES)[number]; withdrawnReason: DietWithdrawReason | null;
  served: (typeof DIET_SERVE_OUTCOMES)[number] | null;
};

export type DietListState = "preview" | "built" | "printed" | "dispatched" | "delivered";

export type DietListView = {
  id: string | null; wardId: string; wardName: string; meal: DietMeal; date: string; serveAt: string; state: DietListState;
  builtAt: string | null; printedAt: string | null; dispatchedAt: string | null; deliveredAt: string | null;
  counts: { trays: number; npo: number; withdrawn: number; late: number; byDiet: Partial<Record<DietCode, number>> };
  lines: DietLineView[];
};

export type DietKitchenBoardView = {
  serverNow: string; meal: DietMeal; date: string; cutoffAt: string; serveAt: string; lists: DietListView[];
  rounds: DietMealRoundView[];
};
export type DietMealRoundView = { meal: DietMeal; cutoffMinute: number; serveMinute: number };

export type DietWardSheetRow = {
  admissionId: string; bedCode: string | null; patient: DietPatient; order: DietOrderView | null; npo: DietNpoView | null;
  allergies: string[]; consultOpen: boolean; nextLine: DietLineView | null;
};
export type DietWardSheetView = {
  serverNow: string; wardId: string; wardName: string; next: { meal: DietMeal; date: string; listId: string | null; state: DietListState };
  rows: DietWardSheetRow[];
};
export type DietWard = { id: string; code: string; name: string };

export type DietConsultView = {
  id: string; admissionId: string; patient: DietPatient; bedCode: string | null; wardName: string | null; reason: string;
  requestedAt: string; waitMinutes: number; order: DietOrderView | null;
};

/** The task kinds diet raises on the engine. */
export const DIET_TASK_KINDS = { delivery: "diet_delivery", wardNotice: "diet_ward_notice" } as const;

/** Routes under the API prefix. The web bundle copies these (it imports this package for TYPES only). */
export const DIET_ROUTES = {
  catalogue: "/diet/catalogue",
  wards: "/diet/wards",
  sheet: "/diet/wards/:wardId/sheet",
  order: "/diet/orders",
  npo: "/diet/npo",
  liftNpo: "/diet/npo/:id/lift",
  consults: "/diet/consults",
  completeConsult: "/diet/consults/:id/complete",
  kitchen: "/diet/kitchen",
  build: "/diet/lists/build",
  list: "/diet/lists/:id",
  printed: "/diet/lists/:id/printed",
  dispatch: "/diet/lists/:id/dispatch",
  serve: "/diet/lines/:id/serve",
  rounds: "/diet/rounds",
} as const;
