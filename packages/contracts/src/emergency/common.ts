import { z } from "zod";
import type { ErRefusalCode } from "./refusals";

/**
 * ER lane 1 (#808) — THE EMERGENCY INTENT LAYER'S SHARED VOCABULARY (spec SPEC-emergency-2026-10-15 §0–§2; decision 0076).
 *
 * Same lens as IPD (SPEC-ipd-core §0B): every ER act is one intent — a module function with a zod contract here, called
 * alike by the ER desk, the board, voice, the copilot (proposal → confirm → act, decision 0069) and later devices. The
 * intent re-checks permission and state every time and refuses with a code from `ER_REFUSALS` (a rule and a fix).
 *
 * Conventions (IPD's, unchanged): ids are ULIDs; people are user ids; times are ISO instants stamped by the server's
 * clock; every act that creates or moves something carries `idempotencyKey` (a uuid — a retried request on a bad
 * network records ONE arrival, §6 edge 8); inputs are strict. Money never appears in an ER clinical contract (0058).
 */

export const ErIdSchema = z.ulid();
export const ErUserRefSchema = z.string().min(1).max(64);
export const ErInstantSchema = z.iso.datetime({ offset: true });
export const ErIdempotencyKeySchema = z.uuid();
export const ErNoteSchema = z.string().trim().min(1).max(500);
/** Words for a person or place (a bringer's name, a police station). */
export const ErWordsSchema = z.string().trim().min(1).max(120);
/** A 10-digit Indian mobile, digits only (the desk strips spaces and +91 before sending). */
export const ErPhoneSchema = z.string().regex(/^[6-9]\d{9}$/);

/**
 * The ER episode's states (spec §1). DECIDED (lane 1): the spec's `expected` state is a PRE-ALERT row, not an episode —
 * one ambulance call can bring three patients and a call that never arrives must not mint an ER number — so an episode
 * starts at `arrived` and a pre-alert lapses to `cancelled` on its own row (`ER_PRE_ALERT_STATES`).
 */
export const ER_EPISODE_STATES = [
  "arrived", "triaged", "in_treatment", "disposition_decided", "departed", "brought_dead",
] as const;
export type ErEpisodeState = (typeof ER_EPISODE_STATES)[number];
export const ErEpisodeStateSchema = z.enum(ER_EPISODE_STATES);
/** The states in which the patient is IN the department (one open episode per patient). */
export const ER_OPEN_STATES = ["arrived", "triaged", "in_treatment", "disposition_decided"] as const;

export const ER_OUTCOMES = ["discharged", "admitted", "referred_out", "lama", "absconded", "lwbs", "died"] as const;
export type ErOutcome = (typeof ER_OUTCOMES)[number];

export const ER_PRE_ALERT_STATES = ["expected", "arrived", "cancelled"] as const;
export type ErPreAlertState = (typeof ER_PRE_ALERT_STATES)[number];
/** A pre-alert lapses two hours after its expected time (spec §1). */
export const ER_PRE_ALERT_LAPSE_MINUTES = 120;

/** Stamped once at arrival (spec §1). `ambulance_108` is the state's 108/102 service; `own_ambulance` the hospital's. */
export const ER_ARRIVAL_MODES = [
  "walk_in", "private_vehicle", "own_ambulance", "ambulance_108", "police", "referred_in", "inter_facility",
] as const;
export type ErArrivalMode = (typeof ER_ARRIVAL_MODES)[number];
export const ErArrivalModeSchema = z.enum(ER_ARRIVAL_MODES);
/** The modes that can call ahead. */
/** Lane 2 (#809, seam E9): `opd_red_flag` — the OPD desk's red-flag brake sends a known patient to Casualty. */
export const ER_PRE_ALERT_MODES = ["own_ambulance", "ambulance_108", "police", "referred_in", "inter_facility", "opd_red_flag"] as const;
export const ErPreAlertModeSchema = z.enum(ER_PRE_ALERT_MODES);

export const ER_SEXES = ["male", "female", "other", "unknown"] as const;
export type ErSex = (typeof ER_SEXES)[number];
export const ErSexSchema = z.enum(ER_SEXES);

/**
 * The approximate age band the desk taps (spec §4.1: "an approximate age band"). DECIDED (lane 1): the band is kept on
 * the episode, never written into the patient master as a date of birth — it is a guess, and a guessed child's DOB
 * would trip the minor-needs-guardian rule at the very desk that must not ask anything. `approxYears` is what the band
 * and the board print ("~30 y").
 */
export const ER_AGE_BANDS = ["infant", "child", "teen", "young_adult", "adult", "elderly"] as const;
export type ErAgeBand = (typeof ER_AGE_BANDS)[number];
export const ErAgeBandSchema = z.enum(ER_AGE_BANDS);
export const ER_AGE_BAND_INFO: Record<ErAgeBand, { approxYears: number; paediatric: boolean }> = {
  infant: { approxYears: 0, paediatric: true },
  child: { approxYears: 6, paediatric: true },
  teen: { approxYears: 15, paediatric: true },
  young_adult: { approxYears: 30, paediatric: false },
  adult: { approxYears: 50, paediatric: false },
  elderly: { approxYears: 70, paediatric: false },
};

/**
 * Who brought the patient. Every field but `kind` is optional: a Good Samaritan is never asked for identity, money or to
 * stay (MV Act s.134A; spec §3.5) — the desk may record what they volunteer, nothing more.
 */
export const ER_BRINGER_KINDS = ["relative", "bystander", "good_samaritan", "police", "ambulance_crew", "self"] as const;
export const ErBroughtBySchema = z.strictObject({
  kind: z.enum(ER_BRINGER_KINDS),
  name: ErWordsSchema.optional(),
  phone: ErPhoneSchema.optional(),
  relation: z.string().trim().min(1).max(40).optional(),
  /** Police: the station and the officer's badge or belt number (the MLC lane records the intimation proper). */
  policeStation: ErWordsSchema.optional(),
  badgeNo: z.string().trim().min(1).max(40).optional(),
  /** Ambulance: the vehicle number. */
  vehicleNo: z.string().trim().min(1).max(20).optional(),
});
export type ErBroughtBy = z.infer<typeof ErBroughtBySchema>;

/** §0 provenance, as IPD: who or what produced a datum. */
export const ER_PROVENANCE_SOURCES = ["person", "device", "copilot_draft", "agent", "import", "system"] as const;
export const ErProvenanceSchema = z.enum(ER_PROVENANCE_SOURCES);

/** A stamped time may run ahead of the server's clock by at most 2 minutes (IPD's skew allowance). */
export const ER_CLOCK_SKEW_MS = 2 * 60_000;
/** DECIDED (lane 1): a gate time more than 24 hours back is a downtime back-fill and needs its paper serial. */
export const ER_ARRIVAL_BACKFILL_MS = 24 * 3_600_000;
/** Door-to-triage target (spec §3.2): the board's first clock. */
export const ER_DOOR_TO_TRIAGE_MINUTES = 5;
/** A second arrival within this window carries the "returned within 24 h" flag (spec §4.1). */
export const ER_RETURN_WINDOW_MS = 24 * 3_600_000;

export function erIsInFuture(at: string, now: Date): boolean {
  return new Date(at).getTime() > now.getTime() + ER_CLOCK_SKEW_MS;
}

/**
 * Role KINDS an ER intent admits; the workflow maps each to the hospital's role keys. `er_nurse` is the casualty nurse
 * (a role lane 1 introduces); `doctor` is any doctor role holder, the casualty medical officer among them.
 */
export const ER_ACTOR_KINDS = ["desk", "er_nurse", "doctor", "supervisor", "duty_manager", "device", "agent"] as const;
export type ErActorKind = (typeof ER_ACTOR_KINDS)[number];
export const ER_AGENT_TIERS = ["none", "T1", "T2", "T3", "T4"] as const;
export const ER_UNDO_KINDS = ["undo_window", "reversal_line", "entered_in_error", "irreversible"] as const;

export type ErIntentMeta = {
  actors: readonly ErActorKind[];
  /** A person's copilot may put this act on a proposal card for that person to confirm (decision 0069). */
  copilotProposable: boolean;
  agentTier: (typeof ER_AGENT_TIERS)[number];
  undo: (typeof ER_UNDO_KINDS)[number];
  events: readonly string[];
  idempotent: boolean;
};

export type ErIntentDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, R extends readonly ErRefusalCode[] = readonly ErRefusalCode[]> =
  ErIntentMeta & { input: I; output: O; refusals: R };

/** Declares one ER intent (its refusal list is checked against `ER_REFUSALS` by the contract test). */
export function erIntent<I extends z.ZodType, O extends z.ZodType, const R extends readonly ErRefusalCode[]>(
  spec: ErIntentMeta & { input: I; output: O; refusals: R },
): ErIntentDef<I, O, R> {
  return spec;
}

/** A strict input object that always carries the idempotency key. */
export function erInput<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject({ idempotencyKey: ErIdempotencyKeySchema, ...shape });
}

/**
 * Every act of spec §2, lanes 1–9. Lane 1 contracts the arrival and identity acts (`ER_INTENTS`); the rest are named
 * here so the episode workflow can name the act behind each edge now, and the later lanes contract them.
 */
export const ER_INTENT_CATALOGUE = [
  // arrival (lane 1)
  "pre_alert", "cancel_pre_alert", "register_arrival", "register_unidentified", "record_brought_dead",
  "print_er_band", "reprint_er_band", "link_identity",
  // triage (lane 2)
  "triage", "re_triage", "record_er_vitals", "place_in_bay", "move_bay", "assign_er_doctor",
  // care (lane 3)
  "call_specialty", "answer_call", "record_er_note", "cosign_er_note", "place_er_order", "issue_er_med", "give_er_dose",
  "sign_er_verbal_order", "record_procedure", "declare_stabilised", "record_consent", "return_er_med",
  // law (lane 4)
  "open_mlc", "record_police_intimation", "countersign_mlc", "record_belongings", "hand_over_evidence",
  // disposition (lane 5)
  "decide_disposition", "discharge_from_er", "hand_to_unit", "refer_out", "record_lama", "record_lwbs", "record_abscond",
  "record_er_death",
  // money (lane 6)
  "settle_er_bill", "record_er_dues",
  // codes and MCI (lanes 7, 8)
  "call_code", "record_code_event", "end_code", "declare_mci", "mci_tag", "stand_down_mci",
] as const;
export type ErCatalogueIntent = (typeof ER_INTENT_CATALOGUE)[number];
