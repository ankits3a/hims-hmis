import { z } from "zod";
import {
  ErAgeBandSchema, ErArrivalModeSchema, ErIdSchema, ErInstantSchema, ErNoteSchema, ErWordsSchema, erInput, erIntent,
} from "./common";
import { ErBandPayloadSchema } from "./intents";

/**
 * ER lane 8 (#815) — MASS CASUALTY: CODE YELLOW (spec SPEC-emergency §3.9, §4.8, §5 G; decision 0076 §4).
 *
 * - `declare_mci` (the MS or the duty manager) switches the ER to mass-casualty mode and opens the event's account (lane 6:
 *   every patient tagged to the event pays nothing at the point of care; the charges post to the account at full tariff).
 *   One Code Yellow at a time. `stand_down_mci` (the same two) ends it: every tagged patient returns to the normal ESI
 *   flow (the door-to-triage clock runs again for those not yet triaged).
 * - Pre-made unidentified packs (`mint_mci_packs`, made ahead and kept at the desk): a real UHID per pack, the alias
 *   `Unknown-MCI26-001` and the band with the pack number, printed ahead. `register_mci_arrival` takes the pack number and
 *   nothing else — one act per patient, ≤ 10 s at the desk.
 * - START (adult) / JumpSTART (child) tags, in words and colour: Red Immediate, Yellow Delayed, Green Minor, Black
 *   Expectant. The proposal comes from the findings; the person picks. A re-tag is a new row (audited); a Black re-tag
 *   needs a reason (found alive).
 * - Surge bays: overflow-class beds of the IPD registry, approved by the duty manager or the MS for this event only.
 * - The MCI board and the head count by tag for the district authority: counts, never names.
 */
export const ER_MCI_TAGS = ["red", "yellow", "green", "black"] as const;
export type ErMciTag = (typeof ER_MCI_TAGS)[number];
export const ErMciTagSchema = z.enum(ER_MCI_TAGS);
/** The tag in words (colour alone is not a label). */
export const ER_MCI_TAG_WORDS: Record<ErMciTag, string> = { red: "Immediate", yellow: "Delayed", green: "Minor", black: "Expectant" };
export const ER_MCI_METHODS = ["start", "jumpstart"] as const;
export type ErMciMethod = (typeof ER_MCI_METHODS)[number];
/** DECIDED (lane 8): the roles that declare and stand down a Code Yellow, approve surge bays and make the packs. */
export const ER_MCI_COMMAND_ROLES = ["medical_superintendent", "duty_manager"] as const;
/** The most packs one act makes (a box of fifty at the desk is the planning number; two boxes at most). */
export const ER_MCI_PACKS_MAX = 100;

export const ErMciFindingsSchema = z.strictObject({
  walking: z.boolean(),
  breathing: z.boolean(),
  /** Not breathing: breathing after the airway is opened. */
  breathingAfterAirway: z.boolean().optional(),
  /** JumpSTART, a child not breathing after the airway with a pulse: breathing after five rescue breaths. */
  breathingAfterRescue: z.boolean().optional(),
  respRate: z.number().int().min(0).max(120).optional(),
  radialPulse: z.boolean().optional(),
  capRefillOver2s: z.boolean().optional(),
  followsCommands: z.boolean().optional(),
  /** JumpSTART: AVPU — P (inappropriate) or U is Red. */
  avpu: z.enum(["A", "V", "P", "U"]).optional(),
});
export type ErMciFindings = z.infer<typeof ErMciFindingsSchema>;

/**
 * The START / JumpSTART proposal from the findings. START (adult): walking → Green; not breathing → Black, unless the
 * airway opened brings breath (Red); RR > 30, no radial pulse or capillary refill > 2 s, or not following commands → Red;
 * else Yellow. JumpSTART (child): walking → Green; not breathing → airway → breathing Red; no pulse Black; with a pulse
 * five rescue breaths → breathing Red, else Black; RR < 15 or > 45, no palpable pulse, AVPU P or U → Red; else Yellow.
 */
export function mciTagProposal(method: ErMciMethod, f: ErMciFindings): ErMciTag {
  if (f.walking) return "green";
  if (!f.breathing) {
    if (f.breathingAfterAirway === true) return "red";
    if (method === "start") return "black";
    if (f.radialPulse !== true) return "black";
    return f.breathingAfterRescue === true ? "red" : "black";
  }
  if (method === "start") {
    if (f.respRate !== undefined && f.respRate > 30) return "red";
    if (f.radialPulse === false || f.capRefillOver2s === true) return "red";
    if (f.followsCommands === false) return "red";
    return "yellow";
  }
  if (f.respRate !== undefined && (f.respRate < 15 || f.respRate > 45)) return "red";
  if (f.radialPulse === false) return "red";
  if (f.avpu === "P" || f.avpu === "U") return "red";
  return "yellow";
}

export const declareMci = erIntent({
  input: erInput({ name: ErWordsSchema, place: ErWordsSchema.optional(), note: ErNoteSchema.optional() }),
  /** `paged`: #877 — how many phones the declaration rang (the Casualty roster, the on-call cover, the command). */
  output: z.strictObject({ mciId: ErIdSchema, eventAccountId: ErIdSchema, declaredAt: ErInstantSchema, paged: z.number().int().nonnegative() }),
  refusals: ["mci_role_needed", "mci_active"],
  actors: ["duty_manager", "supervisor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mci_declared", "er.event_account_opened"],
  idempotent: true,
});

export const standDownMci = erIntent({
  input: erInput({ mciId: ErIdSchema, note: ErNoteSchema.optional() }),
  output: z.strictObject({ mciId: ErIdSchema, stoodDownAt: ErInstantSchema, backToEsi: z.number().int().nonnegative() }),
  refusals: ["mci_role_needed", "mci_not_found", "mci_stood_down"],
  actors: ["duty_manager", "supervisor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mci_stood_down"],
  idempotent: true,
});

export const ErMciPackSchema = z.object({
  packId: ErIdSchema, packNo: z.string(), patientId: ErIdSchema, uhid: z.string(), alias: z.string(), aliasHi: z.string(),
  /** The band printed with the pack: barcode = the pack number, QR `ERBAND1|<pack no>|<UHID>` (the ER band's grammar). */
  band: ErBandPayloadSchema,
});
export type ErMciPack = z.infer<typeof ErMciPackSchema>;

export const mintMciPacks = erIntent({
  input: erInput({ count: z.number().int().min(1).max(ER_MCI_PACKS_MAX) }),
  output: z.strictObject({ packs: z.array(ErMciPackSchema) }),
  refusals: ["mci_role_needed", "registration_not_ready"],
  actors: ["duty_manager", "supervisor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mci_packs_minted"],
  idempotent: true,
});

export const registerMciArrival = erIntent({
  input: erInput({
    /** "MCI26-007" as printed on the pack (case and spaces ignored). */
    packNo: z.string().trim().min(3).max(20),
    arrivalMode: ErArrivalModeSchema.optional(),
    ageBand: ErAgeBandSchema.optional(),
    tag: ErMciTagSchema.optional(),
    arrivedAt: ErInstantSchema.optional(),
  }),
  output: z.strictObject({
    episodeId: ErIdSchema, episodeNo: z.string(), patientId: ErIdSchema, uhid: z.string(), alias: z.string(), mciId: ErIdSchema,
    tag: ErMciTagSchema.nullable(), mlcNo: z.string(),
  }),
  refusals: ["mci_not_active", "pack_not_found", "pack_used", "time_in_future", "arrival_too_old", "episode_already_open"],
  actors: ["desk", "er_nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.arrived", "er.mci_tagged"],
  idempotent: true,
});

export const mciTag = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    tag: ErMciTagSchema,
    method: z.enum(ER_MCI_METHODS).optional(),
    findings: ErMciFindingsSchema.optional(),
    /** A re-tag from Black (found alive) says why; every re-tag is kept. */
    reason: ErNoteSchema.optional(),
  }),
  output: z.strictObject({
    episodeId: ErIdSchema, mciId: ErIdSchema, tag: ErMciTagSchema, proposal: ErMciTagSchema.nullable(), previous: ErMciTagSchema.nullable(),
  }),
  refusals: ["episode_not_found", "episode_wrong_state", "mci_not_active", "retag_needs_reason"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mci_tagged"],
  idempotent: true,
});

export const openSurgeBays = erIntent({
  input: erInput({ mciId: ErIdSchema, bedIds: z.array(ErIdSchema).min(1).max(60) }),
  output: z.strictObject({ mciId: ErIdSchema, opened: z.array(z.object({ bedId: ErIdSchema, code: z.string() })) }),
  refusals: ["mci_role_needed", "mci_not_found", "mci_stood_down", "surge_bed_not_overflow"],
  actors: ["duty_manager", "supervisor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mci_surge_opened"],
  idempotent: true,
});

// ═══════════════════════════════════════ reads: the MCI board and the head count ═══════════════════════════════════════

const TagCountsSchema = z.object({
  red: z.number().int(), yellow: z.number().int(), green: z.number().int(), black: z.number().int(), untagged: z.number().int(),
});
/** The head count for the district authority: counts by tag and by where the patients are now. No names, ever. */
export const ErMciCountSchema = z.object({
  mciId: ErIdSchema, name: z.string(), place: z.string().nullable(), declaredAt: ErInstantSchema, stoodDownAt: ErInstantSchema.nullable(),
  asOf: ErInstantSchema, total: z.number().int(), byTag: TagCountsSchema,
  byOutcome: z.object({
    inDepartment: z.number().int(), admitted: z.number().int(), discharged: z.number().int(), referredOut: z.number().int(),
    died: z.number().int(), left: z.number().int(),
  }),
});
export type ErMciCount = z.infer<typeof ErMciCountSchema>;

export const ErMciPatientSchema = z.object({
  episodeId: ErIdSchema, episodeNo: z.string(),
  /** The pack alias, or initials for a named patient — the board may hang on a wall. */
  label: z.string(),
  tag: ErMciTagSchema.nullable(), esi: z.number().int().nullable(), bayCode: z.string().nullable(), state: z.string(), arrivedAt: ErInstantSchema,
});
export const ErMciSurgeBedSchema = z.object({ bedId: ErIdSchema, code: z.string(), ward: z.string().nullable(), status: z.enum(["free", "occupied", "cleaning", "blocked"]), approved: z.boolean() });
export type ErMciSurgeBed = z.infer<typeof ErMciSurgeBedSchema>;

export const ErMciBoardSchema = z.object({
  /** The running Code Yellow (null when none) and its head count. */
  active: ErMciCountSchema.nullable(),
  /** The last stood-down events (newest first), for the count after the event. */
  recent: z.array(ErMciCountSchema),
  patients: z.array(ErMciPatientSchema),
  packsReady: z.number().int(),
  bays: z.object({ free: z.number().int(), total: z.number().int() }),
  surge: z.object({ free: z.number().int(), total: z.number().int() }),
  /** Inpatient beds free across the hospital (IPD registry: available, no occupant; ER bays and overflow excluded). */
  hospitalBedsFree: z.number().int(),
  serverNow: ErInstantSchema,
});
export type ErMciBoard = z.infer<typeof ErMciBoardSchema>;
