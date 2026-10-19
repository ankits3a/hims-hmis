import { z } from "zod";
import { ER_AGE_BAND_INFO, ErIdSchema, ErInstantSchema } from "./common";
import { ER_ESI_INFO, ErEsiDecisionSchema, ErEsiLevelSchema, esiAlgorithm } from "./triage";
import type { ErAgeBand } from "./common";
import type { ErEsiDecision, ErEsiLevel, ErVitals } from "./triage";

/**
 * ER lane 9 (#816) — THE ER COPILOT (spec SPEC-emergency §4.9, T2: it proposes, a person confirms).
 *
 *  - Now cards: one desk provider per card type, each gated by the permission of the act that answers it.
 *  - The ESI proposal: the four decision points proposed from the complaint, the age and the last vital set, with the
 *    reasons in words. RULES ONLY — never a model (autonomy ladder: ESI stays T2, never auto-set). Nothing is written
 *    until the nurse taps Triage; the level they pick is theirs, and a pick other than the proposal is logged as an
 *    override (`copilotLevel` on the triage entry), never questioned for an up-triage (spec §6 edge 2).
 *  - "Since arrival": four to six lines, each with its source and the records it was read from.
 *  - Drafts (ER summary, MLC narrative, referral letter): each stamped "Draft" until a doctor signs it through the act
 *    that owns it. An MLC, sealed or confidential patient gets NO model call; the MLC narrative is never sent to one.
 *  - The waiting-area display: a token and a stage word, never a name or clinical text; MLC and sealed patients absent.
 * No money anywhere (decision 0058).
 */

/** The Now card keys (spec §4.9), each `emergency.<card>`. */
export const ER_NOW_CARD_KEYS = [
  "emergency.casualty_now", "emergency.retriage_due", "emergency.doctor_overdue", "emergency.call_unanswered",
  "emergency.result_ready", "emergency.critical_result", "emergency.boarding_long", "emergency.mlc_intimation_due",
  "emergency.mlc_countersign_due", "emergency.pre_alert", "emergency.lwbs_risk",
] as const;
export type ErNowCardKey = (typeof ER_NOW_CARD_KEYS)[number];

/* ═══════════════════════════════ the ESI proposal ═══════════════════════════════ */

/**
 * ESI v4 danger-zone heart and breathing rates by age (the ESI Implementation Handbook's table), and SpO2 < 92 % at
 * every age. DECIDED (lane 9): the handbook's numbers as printed.
 */
export function esiDangerZone(ageYears: number | null): { pulse: number; respRate: number } {
  if (ageYears === null || ageYears >= 8) return { pulse: 100, respRate: 20 };
  if (ageYears >= 3) return { pulse: 140, respRate: 30 };
  if (ageYears >= 0.25) return { pulse: 160, respRate: 40 };
  return { pulse: 180, respRate: 50 };
}

/** Complaint words (English and the Hindi / Hinglish heard at an Indian ER desk) and what each makes the proposal say. */
const LIFE_SAVING_WORDS = ["cardiac arrest", "not breathing", "no pulse", "unresponsive", "unconscious", "behosh", "बेहोश", "saans nahi", "fitting now", "seizing"];
const HIGH_RISK_WORDS = [
  "chest pain", "seene mein dard", "सीने में दर्द", "stroke", "paralysis", "lakwa", "लकवा", "slurred", "one side weak", "poison", "zeher", "ज़हर",
  "जहर", "snake", "saanp", "सांप", "burn", "jal gaya", "head injury", "sir pe chot", "accident", "rta", "hanging", "drowning", "bleeding heavily",
  "vomiting blood", "khoon ki ulti", "suicid", "overdose", "pregnant bleeding", "severe pain", "tez dard", "assault", "stab", "gunshot",
  "breathless", "saans phool", "सांस फूल", "seizure", "fits", "mirgi",
];
const MANY_RESOURCE_WORDS = [
  "abdominal pain", "pet dard", "पेट दर्द", "fever", "bukhar", "बुखार", "vomiting", "ulti", "fall", "fracture", "haddi", "injury", "chot", "चोट",
  "breathless", "chest pain", "headache", "weakness", "kamzori", "bleeding", "jaundice", "pregnan", "diarrhoea", "dast",
];
const NO_RESOURCE_WORDS = ["refill", "prescription", "certificate", "dressing change", "suture removal", "injection only", "repeat medicine"];

/** The first word found where a word STARTS ("rta" is not inside "portal"; "suicid" finds "suicidal"). */
const has = (text: string, words: readonly string[]): string | null => {
  const t = text.toLowerCase();
  return words.find((w) => {
    let i = t.indexOf(w);
    while (i >= 0) {
      if (i === 0 || !/[a-zऀ-ॿ]/.test(t[i - 1]!)) return true;
      i = t.indexOf(w, i + 1);
    }
    return false;
  }) ?? null;
};

export type EsiProposalInput = {
  complaint: string | null;
  ageYears: number | null;
  ageBand: ErAgeBand | null;
  vitals: ErVitals | null;
};

export type EsiProposal = { level: ErEsiLevel; decision: ErEsiDecision; reasons: string[]; resourcesGuessed: boolean };

/**
 * The proposal (pure): each decision point answered from what the record holds, with the reason in words, and the
 * level the ESI algorithm gives for those answers. A point the record cannot answer is answered the cautious-but-honest
 * way: resources default to "one" and say so (`resourcesGuessed`). The nurse sees the questions with these answers
 * ticked and may change any of them; the proposal is never the level.
 */
export function proposeEsi(input: EsiProposalInput): EsiProposal {
  const reasons: string[] = [];
  const v = input.vitals ?? {};
  const age = input.ageYears ?? (input.ageBand === null ? null : ER_AGE_BAND_INFO[input.ageBand].approxYears);
  const complaint = (input.complaint ?? "").trim();

  // A — needs a life-saving intervention now.
  let lifeSaving = false;
  if (v.consciousness === "unresponsive") { lifeSaving = true; reasons.push("Unresponsive"); }
  if (v.pulse !== undefined && v.pulse === 0) { lifeSaving = true; reasons.push("No pulse recorded"); }
  if (v.respRate !== undefined && v.respRate < 8) { lifeSaving = true; reasons.push(`Breathing ${String(v.respRate)}/min`); }
  if (v.spo2 !== undefined && v.spo2 < 90) { lifeSaving = true; reasons.push(`SpO2 ${String(v.spo2)}% (below 90)`); }
  if (v.systolic !== undefined && v.systolic < 70) { lifeSaving = true; reasons.push(`Systolic ${String(v.systolic)} (below 70)`); }
  const ls = has(complaint, LIFE_SAVING_WORDS);
  if (ls !== null) { lifeSaving = true; reasons.push(`Complaint: "${ls}"`); }

  // B — high risk, new confusion or lethargy, severe pain or distress.
  let highRisk = false;
  if (v.consciousness === "confused" || v.consciousness === "voice" || v.consciousness === "pain") {
    highRisk = true; reasons.push(`Consciousness: ${v.consciousness}`);
  }
  const hr = has(complaint, HIGH_RISK_WORDS);
  if (hr !== null) { highRisk = true; reasons.push(`Complaint: "${hr}" (high risk)`); }
  if (age !== null && age < 0.25 && v.temperatureC !== undefined && v.temperatureC >= 38) {
    highRisk = true; reasons.push(`Infant under 3 months with temperature ${String(v.temperatureC)}`);
  }

  // D — danger-zone vitals for the age.
  const zone = esiDangerZone(age);
  const danger: string[] = [];
  if (v.pulse !== undefined && v.pulse > zone.pulse) danger.push(`pulse ${String(v.pulse)} (above ${String(zone.pulse)})`);
  if (v.respRate !== undefined && v.respRate > zone.respRate) danger.push(`breathing ${String(v.respRate)}/min (above ${String(zone.respRate)})`);
  if (v.spo2 !== undefined && v.spo2 < 92) danger.push(`SpO2 ${String(v.spo2)}% (below 92)`);
  if (danger.length > 0) reasons.push(`Danger-zone vitals: ${danger.join(", ")}`);

  // C — resources, from the complaint's words; unknown is "one", said as a guess.
  let resources: ErEsiDecision["resources"] = "one";
  let resourcesGuessed = false;
  const many = has(complaint, MANY_RESOURCE_WORDS);
  const none = has(complaint, NO_RESOURCE_WORDS);
  if (many !== null) { resources = "many"; reasons.push(`Complaint: "${many}" usually needs tests and treatment`); }
  else if (none !== null) { resources = "none"; reasons.push(`Complaint: "${none}" needs no resources`); }
  else { resourcesGuessed = true; reasons.push("Resources not known from the complaint: one assumed — please check"); }

  const decision: ErEsiDecision = { lifeSaving, highRisk, resources, dangerVitals: danger.length > 0 };
  return { level: esiAlgorithm(decision).level, decision, reasons, resourcesGuessed };
}

export const ErEsiProposalSchema = z.strictObject({
  episodeId: ErIdSchema,
  level: ErEsiLevelSchema,
  word: z.string(),
  decision: ErEsiDecisionSchema,
  reasons: z.array(z.string()),
  resourcesGuessed: z.boolean(),
  /** What it was read from: the complaint words, the age, the last vital set's instant. */
  basedOn: z.strictObject({ complaint: z.string().nullable(), ageYears: z.number().nullable(), vitalsAt: ErInstantSchema.nullable() }),
  /** Always "rules": the ESI proposal never comes from a model. */
  source: z.literal("rules"),
  /**
   * #899 — the proposal's identity: the rows it was read from (the episode's latest triage entry, its bay) and a digest
   * of what it says. Opaque to a screen: the card sends it back to `…/check` and the server says whether it still stands.
   */
  basis: z.string().min(1).max(200),
});
export type ErEsiProposal = z.infer<typeof ErEsiProposalSchema>;

/**
 * #899 (spec §6 edge 1) — why a shown proposal withdrew itself. DECIDED (lane 9): the record's own words, one line at
 * 390 px: a person triaged or re-triaged, the patient moved bay or left the ER, new vitals, the complaint or age changed;
 * a basis the server cannot read is "out of date" (fail closed — never "still current").
 */
export const ER_PROPOSAL_WITHDRAW_REASONS = ["triaged", "re_triaged", "moved", "departed", "new_vitals", "details_changed", "out_of_date"] as const;
export type ErProposalWithdrawReason = (typeof ER_PROPOSAL_WITHDRAW_REASONS)[number];

export const ErEsiProposalCheckSchema = z.strictObject({
  episodeId: ErIdSchema,
  /** True only when the shown proposal is the one the server would show now. */
  current: z.boolean(),
  withdrawn: z.strictObject({
    reason: z.enum(ER_PROPOSAL_WITHDRAW_REASONS),
    /** The record's instant (the triage, the move, the vital set, the departure), when it has one. */
    at: ErInstantSchema.nullable(),
    level: ErEsiLevelSchema.nullable(),
    bayCode: z.string().nullable(),
    /** The reason in words (English; a screen may say it in its own language from the fields above). */
    text: z.string(),
    /** A new proposal can be shown (the patient is still waiting for triage). */
    fresh: z.boolean(),
  }).nullable(),
});
export type ErEsiProposalCheck = z.infer<typeof ErEsiProposalCheckSchema>;

/** The reason in words, one short line (DECIDED wording, #899). */
export function erWithdrawText(w: { reason: ErProposalWithdrawReason; at: string | null; level: ErEsiLevel | null; bayCode: string | null }): string {
  const time = w.at === null ? "" : ` at ${erIstHm(w.at)}`;
  const esi = w.level === null ? "" : ` ESI ${String(w.level)}`;
  switch (w.reason) {
    case "triaged": return `Triaged${esi}${time}`;
    case "re_triaged": return `Re-triaged${esi}${time}`;
    case "moved": return w.bayCode === null ? `Moved bay${time}` : `Moved to ${w.bayCode}${time}`;
    case "departed": return `Left the ER${time}`;
    case "new_vitals": return `New vitals${time}`;
    case "details_changed": return "Complaint or age changed";
    case "out_of_date": return "Suggestion out of date";
  }
}

/** The proposal's level with its word, for a screen (never colour alone). */
export const esiWord = (level: ErEsiLevel): string => `ESI ${String(level)} ${ER_ESI_INFO[level].word}`;

/* ═══════════════════════════════ since arrival ═══════════════════════════════ */

export const ER_SINCE_SOURCES = ["arrival", "triage", "vitals", "doctor", "call", "critical", "results", "meds", "procedure", "note", "mlc", "disposition"] as const;
export type ErSinceSource = (typeof ER_SINCE_SOURCES)[number];
export const ER_SINCE_MIN_LINES = 4;
export const ER_SINCE_MAX_LINES = 6;

export const ErSinceRecordSchema = z.strictObject({ id: z.string(), at: ErInstantSchema.nullable(), label: z.string() });

/**
 * Review #894 — a line is built from TYPED FACTS, each pointing at the stored column it was read from (`ref`). The text is
 * `template` with `{0}`, `{1}`… replaced by the facts as formatted for their kind, and nothing else, so the verifier can
 * re-read every fact from its column and re-render the text: a number that differs from its source cannot stand.
 *
 *  - `time` an instant (shown as IST hh:mm) · `number` · `text` · `mode` (an arrival mode, shown in words) · `esi_word`
 *    (an ESI level, shown as its word) · `excerpt` (the start of a stored text, cut at a word boundary) ·
 *    `minutes` (DERIVED: whole minutes from `ref` to `to`, or to the read's `asOf` — recomputed by the verifier).
 */
export const ER_SINCE_FACT_KINDS = ["time", "number", "text", "mode", "esi_word", "excerpt", "minutes"] as const;
export const ErSinceRefSchema = z.strictObject({ table: z.string(), id: z.string(), column: z.string() });
export type ErSinceRef = z.infer<typeof ErSinceRefSchema>;
export const ErSinceFactSchema = z.strictObject({
  kind: z.enum(ER_SINCE_FACT_KINDS),
  field: z.string(),
  value: z.union([z.string(), z.number()]),
  ref: ErSinceRefSchema,
  /** `minutes` only: the later instant's column, or "now" (the read's `asOf`). */
  to: z.union([ErSinceRefSchema, z.literal("now")]).optional(),
});
export type ErSinceFact = z.infer<typeof ErSinceFactSchema>;

export const ErSinceLineSchema = z.strictObject({
  key: z.string(),
  text: z.string(),
  /** The text's shape: constant words and `{i}` slots, one per fact. */
  template: z.string(),
  facts: z.array(ErSinceFactSchema),
  source: z.enum(ER_SINCE_SOURCES),
  at: ErInstantSchema.nullable(),
  abnormal: z.boolean(),
  /** The rows the line was read from (the source chip's detail). */
  records: z.array(ErSinceRecordSchema).min(1),
});
export type ErSinceLine = z.infer<typeof ErSinceLineSchema>;

/** IST hh:mm of an instant (the one way a since-line shows a time). */
export function erIstHm(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
}

export const ER_MODE_WORDS: Record<string, string> = {
  walk_in: "walked in", private_vehicle: "private vehicle", own_ambulance: "hospital ambulance", ambulance_108: "108 ambulance",
  police: "brought by police", referred_in: "referred in", inter_facility: "inter-facility transfer",
};

/** One fact as the line shows it. */
export function formatSinceFact(f: Pick<ErSinceFact, "kind" | "value">): string {
  switch (f.kind) {
    case "time": return erIstHm(String(f.value));
    case "mode": return ER_MODE_WORDS[String(f.value)] ?? String(f.value);
    case "esi_word": return ER_ESI_INFO[Number(f.value) as ErEsiLevel]?.word ?? String(f.value);
    default: return String(f.value);
  }
}

/** The text a template and its facts make — the ONLY way a since-line's text is produced. */
export function renderSinceLine(template: string, facts: readonly Pick<ErSinceFact, "kind" | "value">[]): string {
  return template.replace(/\{(\d+)\}/g, (_m, i: string) => {
    const f = facts[Number(i)];
    return f === undefined ? "" : formatSinceFact(f);
  });
}
export const ErSinceArrivalSchema = z.strictObject({
  episodeId: ErIdSchema,
  asOf: ErInstantSchema,
  arrivedAt: ErInstantSchema,
  lines: z.array(ErSinceLineSchema),
});
export type ErSinceArrival = z.infer<typeof ErSinceArrivalSchema>;

/* ═══════════════════════════════ drafts ═══════════════════════════════ */

export const ER_DRAFT_KINDS = ["summary", "referral", "mlc_narrative"] as const;
export type ErDraftKind = (typeof ER_DRAFT_KINDS)[number];
/** Why a draft is the template's alone (no model sentence in it). */
export const ER_DRAFT_FALLBACKS = ["barred", "model_off", "halted", "capped", "identifier_leak", "model_down", "over_budget", "rejected", "no_text", "template_only"] as const;

export const ErDraftSchema = z.strictObject({
  episodeId: ErIdSchema,
  kind: z.enum(ER_DRAFT_KINDS),
  /** Always "Draft": the record exists only when a doctor signs it through its own act. */
  label: z.literal("Draft"),
  source: z.enum(["template", "model"]),
  modelId: z.string().nullable(),
  /** Null when a model's sentence is in the draft. */
  fallback: z.enum(ER_DRAFT_FALLBACKS).nullable(),
  builtAt: ErInstantSchema,
  /** The fields of the act the draft prefills (summary: diagnosis, treatmentGiven; referral: note; MLC: text). */
  fields: z.record(z.string(), z.string()),
  /** Words of a model's sentence found in no record (a misspelt medicine looks like this): shown to the signer. */
  unverified: z.array(z.string()),
});
export type ErDraft = z.infer<typeof ErDraftSchema>;

/* ═══════════════════════════════ the waiting-area display ═══════════════════════════════ */

/** The stage words a family reads (spec §5 I): never clinical text, never a name. */
export const ER_STAGE_WORDS = ["Waiting", "Being seen", "Waiting for test", "Admitting", "Going home soon", "Transfer arranged"] as const;
export type ErStageWord = (typeof ER_STAGE_WORDS)[number];
export const ER_STAGE_WORDS_HI: Record<ErStageWord, string> = {
  Waiting: "प्रतीक्षा में", "Being seen": "डॉक्टर देख रहे हैं", "Waiting for test": "जाँच की प्रतीक्षा", Admitting: "भर्ती हो रहे हैं",
  "Going home soon": "जल्द घर", "Transfer arranged": "स्थानांतरण तय",
};

export const ErWaitingDisplaySchema = z.strictObject({
  generatedAt: ErInstantSchema,
  /** The token is the last four digits of the ER number (printed on the band and the arrival slip). */
  rows: z.array(z.strictObject({ token: z.string().regex(/^\d{4}$/), stage: z.enum(ER_STAGE_WORDS), stageHi: z.string() })),
});
export type ErWaitingDisplay = z.infer<typeof ErWaitingDisplaySchema>;

export const ER_COPILOT_ROUTES = {
  /** GET /er/copilot/esi/:episodeId — the triage proposal (er.triage). GET …/:episodeId/check?basis= — does a shown one
   *  still stand (#899)? */
  esi: "/er/copilot/esi",
  /** GET /er/copilot/since/:episodeId — "since arrival" (er.care). */
  since: "/er/copilot/since",
  /** POST /er/copilot/drafts/:episodeId/:kind — build a draft (summary, referral: er.disposition; MLC: er.mlc). */
  drafts: "/er/copilot/drafts",
  /** GET /er/copilot/waiting — the waiting-area display (er.board.wall). */
  waiting: "/er/copilot/waiting",
} as const;
