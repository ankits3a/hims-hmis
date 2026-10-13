import { z } from "zod";

/**
 * E1.3 (#720, decision 0072) — ATTENDANT AND VISITOR PASSES (SPEC-ipd-companions §8).
 *
 * Every pass belongs to one admission. Its QR carries an OPAQUE TOKEN and nothing else: no name, no UHID, no bed —
 * a photographed pass leaks nothing, and a revoked or expired token answers so at the gate. Every act is one intent
 * here (zod input, refusal codes with a rule and a fix); the module function re-checks permission and state.
 *
 * DECIDED (standard Indian corporate-hospital practice, owner asleep 2026-10-12):
 * - bedside passes by bed class: general, semi-private, overflow, day care, emergency, LDR 1; private, deluxe,
 *   suite 2; HDU, ICU, NICU, PICU 0 at the bedside and 1 lounge pass;
 * - a child (under 14 on the day, or on a NICU/PICU bed) gets `parent_stay` instead of `attendant`;
 * - a mother whose baby is in NICU gets one `nicu_mother` pass, linked by the baby's admission id typed in by hand,
 *   for the baby's ward;
 * - visitor passes only inside visiting hours (16:00–19:00 IST), at most 2 live per admission, valid that IST day;
 * - police custody: only `police_guard` passes (at most 2); setting custody revokes every other live pass;
 * - a doctor's visitor ban pauses the live visitor passes and refuses new ones until resumed.
 */

export const PASS_KINDS = ["attendant", "visitor", "parent_stay", "nicu_mother", "police_guard", "lounge"] as const;
export type PassKind = (typeof PASS_KINDS)[number];
export const PassKindSchema = z.enum(PASS_KINDS);
/** The kinds `issuePasses` hands out (a visitor pass has its own intent, bound to visiting hours). */
export const PASS_ISSUE_KINDS = ["attendant", "parent_stay", "nicu_mother", "police_guard", "lounge"] as const;
export type PassIssueKind = (typeof PASS_ISSUE_KINDS)[number];

export const PASS_STATES = ["active", "revoked", "expired", "paused"] as const;
export type PassState = (typeof PASS_STATES)[number];

/** One answer per scan, one beep word. `unknown` = the token is no pass at all. */
export const PASS_SCAN_RESULTS = ["valid", "wrong_ward", "outside_hours", "expired", "revoked", "paused", "unknown"] as const;
export type PassScanResult = (typeof PASS_SCAN_RESULTS)[number];

/** Why a pass ended. The four terminal admission events, the ward-less refer-out, and the desk's acts. */
export const PASS_END_REASONS = [
  "discharged", "lama", "absconded", "deceased", "transferred_out", "lost", "damaged", "holder_changed", "police_custody",
  "baby_discharged",
] as const;
export type PassEndReason = (typeof PASS_END_REASONS)[number];

/** Visiting hours, IST, as minutes after midnight. DECIDED default 16:00–19:00 (configuration lives here). */
export const PASS_VISITING_HOURS = { startMinute: 16 * 60, endMinute: 19 * 60, label: "16:00–19:00" } as const;
export const PASS_MAX_LIVE_VISITORS = 2;
export const PASS_MAX_POLICE_GUARDS = 2;

const id = z.ulid();
const idempotencyKey = z.uuid();
const reason = z.string().trim().min(1).max(500);

/** An attendant is not staff: a name and a phone are what the desk writes down, and the relation. */
export const PassHolderSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "a 10-digit Indian mobile number").optional(),
  relation: z.string().trim().min(1).max(40),
});
export type PassHolder = z.infer<typeof PassHolderSchema>;

export const PASS_INTENTS = {
  issue_passes: z.strictObject({
    idempotencyKey, admissionId: id,
    /** Omitted: the admission's entitled bedside kind (police guard in custody, lounge in ICU, parent stay for a child). */
    kind: z.enum(PASS_ISSUE_KINDS).optional(),
    holders: z.array(PassHolderSchema).min(1).max(4),
    /** `nicu_mother` only: the baby's admission, typed in by hand. */
    babyAdmissionId: id.optional(),
  }),
  issue_visitor_pass: z.strictObject({ idempotencyKey, admissionId: id, holder: PassHolderSchema }),
  reissue_pass: z.strictObject({
    idempotencyKey, passId: id, reason: z.enum(["lost", "damaged", "holder_changed"]),
    /** A new holder (holder_changed); omitted keeps the old one. */
    holder: PassHolderSchema.optional(),
  }),
  scan_pass: z.strictObject({
    token: z.string().trim().min(1).max(64),
    /** The ward door the guard stands at; omitted at the main gate (no ward check there). */
    wardId: id.optional(),
    gate: z.string().trim().min(1).max(40).optional(),
  }),
  pause_passes: z.strictObject({
    idempotencyKey, admissionId: id, reason,
    /** `visitors`: the doctor's visitor ban. `all`: every live pass (passes.manage only). */
    scope: z.enum(["visitors", "all"]).default("visitors"),
  }),
  resume_passes: z.strictObject({ idempotencyKey, admissionId: id, note: reason.optional() }),
  set_police_custody: z.strictObject({ idempotencyKey, admissionId: id, custody: z.boolean(), note: reason }),
} as const;
export type PassIntentName = keyof typeof PASS_INTENTS;
export type PassIntentInput<N extends PassIntentName> = z.input<(typeof PASS_INTENTS)[N]>;

/** Every refusal a pass act can return: a rule a desk clerk reads and the label of the button that fixes it. */
export const PASS_REFUSALS = {
  admission_not_found: { rule: "No admission has this id.", fix: "Search admissions" },
  admission_not_placed: { rule: "Passes are issued only while the patient is admitted on a bed.", fix: "Open admission" },
  pass_not_found: { rule: "No pass has this id.", fix: "Open passes" },
  pass_not_live: { rule: "Only a live pass can be reissued.", fix: "Issue a new pass" },
  entitlement_used: { rule: "This bed class's passes are all issued.", fix: "Reissue a lost pass" },
  kind_not_entitled: { rule: "This kind of pass is not given for this bed or patient.", fix: "Issue the entitled pass" },
  icu_no_bedside_pass: { rule: "ICU beds have no bedside attendant; the family gets one lounge pass.", fix: "Issue lounge pass" },
  police_custody_guard_only: { rule: "A patient in police custody gets passes for the police guard only.", fix: "Issue police guard pass" },
  not_in_police_custody: { rule: "Police guard passes are only for a patient in police custody.", fix: "Record police custody" },
  baby_admission_required: { rule: "A NICU mother pass needs the baby's admission.", fix: "Enter baby's admission" },
  baby_not_in_nicu: { rule: "The baby's admission is not on a NICU bed.", fix: "Check baby's admission" },
  outside_visiting_hours: { rule: "Visitor passes are issued only in visiting hours.", fix: "Come back at visiting time" },
  visitor_limit: { rule: "Only two visitor passes may be live at a time.", fix: "Wait for a visitor to leave" },
  visitors_banned: { rule: "The doctor has stopped visitors for this patient.", fix: "Ask the doctor" },
  pause_needs_manage: { rule: "Pausing attendant passes needs the passes manager; a doctor stops visitors only.", fix: "Stop visitors only" },
  nothing_paused: { rule: "No pass of this admission is paused.", fix: "Open passes" },
} as const;
export type PassRefusalCode = keyof typeof PASS_REFUSALS;
export type PassRefusalBody = { statusCode: number; code: PassRefusalCode; message: string; rule: string; fix: string; detail?: Record<string, unknown> };

/** What a pass card prints. The patient line is the ALIAS for a sealed or VIP patient — never the name. */
export type PassCard = {
  passId: string;
  token: string;
  kind: PassKind;
  state: PassState;
  holderName: string;
  holderRelation: string;
  patientLabel: string;
  uhid: string | null;
  admissionNo: string | null;
  wardName: string | null;
  bedCode: string | null;
  validFrom: string;
  validTo: string | null;
  visitingHours: string | null;
};

export type PassEntitlement = {
  /** The bedside kind this admission is entitled to now, with its limit and how many are live. */
  kind: PassIssueKind;
  max: number;
  live: number;
  /** Why (words for the desk): "Private room: 2 attendants", "ICU: lounge only", "Police custody". */
  basis: string;
};

export type PassAdmissionView = {
  admissionId: string;
  admissionNo: string | null;
  state: string;
  patientLabel: string;
  uhid: string | null;
  bedClass: string | null;
  bedCode: string | null;
  wardId: string | null;
  wardName: string | null;
  policeCustody: boolean;
  visitorBan: { reason: string; at: string } | null;
  entitlement: PassEntitlement;
  visitors: { live: number; max: number; hours: string; open: boolean };
  passes: PassCard[];
};

export type PassScanAnswer = {
  result: PassScanResult;
  /** The one beep word, in English; the screen translates by `result`. */
  word: string;
  kind: PassKind | null;
  holderName: string | null;
  wardName: string | null;
  bedCode: string | null;
  at: string;
};

export type PassWard = { id: string; code: string; name: string };

/** Routes under the API prefix. The web bundle copies these (it imports this package for TYPES only). */
export const PASS_ROUTES = {
  admission: "/passes/admissions/:admissionId",
  issue: "/passes/issue",
  visitor: "/passes/visitor",
  reissue: "/passes/reissue",
  pause: "/passes/pause",
  resume: "/passes/resume",
  custody: "/passes/custody",
  scan: "/passes/scan",
  wards: "/passes/wards",
} as const;
