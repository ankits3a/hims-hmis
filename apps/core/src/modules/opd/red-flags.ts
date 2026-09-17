/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BRAKE ON THE ROUTER — the emergencies a front desk must not book an appointment for
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-17: *"my front desk staff are non medico background and so they would rely on the
 * operating system to suggest them doctor/department… just by typing 1-2 chief complaint."*
 *
 * That is the reason this module exists, and it is worth stating plainly: a doctor overrides a bad
 * suggestion, and a clerk with no clinical training follows it — because following it is the whole
 * point of giving them the tool. **The layer that routes for them is the layer that can hurt them.**
 *
 * Before this, there was no brake anywhere. A search of the triage path and the entire CDS library
 * found no handling of emergencies, and `DEFAULT_DEPARTMENTS` has no Casualty. So a clerk typing
 * *"seene mein dard"* got the best answer an OPD router can give — *"Cardiology, next slot 11:40"* —
 * for a patient who may be having a myocardial infarction.
 *
 * ═══ IT REFUSES; IT DOES NOT RANK ═══
 *
 * A red flag does not put Casualty at the top of a list. Ranking invites a choice, and this is not a
 * choice a non-medico clerk should be offered. It suppresses the suggestion entirely and says one
 * thing: do not book, escalate now.
 *
 * ═══ THE DESTINATION IS CONFIGURATION; THE REFUSAL IS NOT ═══
 *
 * DECIDED 2026-09-17 under the standing rule (anything outside money, procurement and law takes the
 * standard Indian-corporate-hospital answer): a hospital of this shape runs a 24×7 Casualty and a
 * red-flag walk-in goes there directly, without an appointment.
 *
 * But the owner has not yet said where THIS hospital sends them, and the brake must not wait on
 * that. So the refusal is unconditional and the destination is a setting: with an emergency area
 * configured the seat names it, and without one it still refuses to book and tells the clerk to
 * escalate. A brake that only works once somebody finishes configuring it is not a brake.
 *
 * ═══ NO MODEL, NO NETWORK, NO CONFIGURATION ═══
 *
 * `triage.ts`'s model is an advisor whose timeout is an ordinary outcome. That is the right shape
 * for choosing between Ophthalmology and ENT and the wrong shape entirely for this: a brake that can
 * fail to arrive because a provider is slow is not a brake. Pure function, synchronous, no inputs
 * but the complaint and the age.
 */

/** What fired, and why — never a score, and never a department. */
export type RedFlag = {
  /** Stable key for the i18n sentence the clerk reads out. */
  reasonKey: string;
  /** The phrase that matched, for the audit line and for a clerk asking "why did it say that?". */
  matched: string;
};

type Rule = {
  key: string;
  phrases: string[];
  /**
   * Age window in which this is an emergency. Absent means every age.
   *
   * An UNKNOWN age (null) always fails safe and flags: over-triage costs a walk down the corridor,
   * and under-triage costs something that cannot be undone.
   */
  minAge?: number;
};

/**
 * ═══ SHORT ON PURPOSE, AND THE TEST ENFORCES IT ═══
 *
 * Every entry here suppresses an appointment. Growth is not free the way growth in the routing table
 * is free: a list that flagged everything would be ignored within a week, which is the alert-fatigue
 * failure arriving through the one door where it is fatal. `red-flags.test.ts` caps the count so
 * that adding one has to be argued for.
 *
 * The phrases are the ones an Indian front desk actually hears, in the three scripts they are typed
 * in. They are matched as substrings, so a phrase inside a longer sentence still fires.
 */
const RULES: Rule[] = [
  {
    key: "chestPain",
    /*
      Adults only, and that is the single clinical judgement in this file. Chest pain in an adult is
      cardiac until proven otherwise; in a small child it is almost never, and flagging it would send
      every chesty six-year-old to Casualty — which is how a brake gets ignored. Twelve is the line
      `bandFor` already uses to separate paediatric from adult.
    */
    minAge: 12,
    phrases: [
      "seene mein dard", "seene me dard", "seene mai dard", "chhati me dard", "chest pain",
      "छाती में दर्द", "सीने में दर्द", "chest me dard", "dil me dard",
    ],
  },
  {
    key: "breathless",
    /*
      Every age, and deliberately the counter-example to the rule above: a breathless child is MORE
      urgent than a breathless adult, not less.
    */
    phrases: [
      "saans nahi", "sans nahi", "saans phool", "sans phool", "saans ukhad", "breathless",
      "cannot breathe", "can't breathe", "difficulty breathing", "सांस नहीं", "साँस नहीं", "दम घुट",
      "dum ghut",
    ],
  },
  {
    key: "unconscious",
    phrases: ["behosh", "बेहोश", "unconscious", "not responding", "hosh nahi", "faint ho gaya", "collapse"],
  },
  {
    key: "bleeding",
    phrases: ["khoon beh", "khoon bah", "bahut khoon", "heavy bleeding", "bleeding heavily", "खून बह", "blood loss"],
  },
  {
    key: "convulsion",
    phrases: ["daura", "दौरा", "convulsion", "seizure", "fits aa", "mirgi", "मिर्गी", "jhatke aa"],
  },
  {
    key: "poisoning",
    phrases: ["zeher", "zahar", "ज़हर", "जहर", "poison", "overdose", "kuch kha liya", "nigal liya"],
  },
  {
    key: "trauma",
    phrases: ["accident", "दुर्घटना", "major trauma", "road accident", "gir gaya sar", "head injury", "sar me chot"],
  },
  {
    key: "stroke",
    phrases: [
      "muh tedha", "मुँह टेढ़ा", "stroke", "weakness on one side", "ek taraf kamzori",
      "bol nahi pa raha", "lakwa maar", "paralysis sudden",
    ],
  },
  {
    key: "babyBlue",
    phrases: ["neela pad", "नीला पड़", "baby is blue", "bachcha neela", "not feeding at all", "doodh nahi pi raha"],
  },
  {
    key: "pregnancyBleeding",
    phrases: ["pregnancy me khoon", "garbh me khoon", "bleeding in pregnancy", "pet me tez dard pregnancy"],
  },
];

/** Pinned by the test, so that lengthening this list has to be argued for in a pull request. */
export const RED_FLAG_COUNT = RULES.length;

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does this complaint stop the booking?
 *
 * `ageYears` is the patient's age when the desk knows it — the appointment screen does, it renders
 * it on the row — and `null` when it does not. Null always fails SAFE.
 */
export function redFlagFor(complaint: string, ageYears: number | null): RedFlag | null {
  const q = normalise(complaint);
  if (q === "") return null;

  for (const rule of RULES) {
    /*
      AGE NARROWS, IT NEVER WIDENS, and an unknown age never narrows. Written as an explicit
      `ageYears !== null` rather than a defaulted number, because `?? 0` here would silently make
      every unknown-age chest pain a paediatric one — a default that reads as caution and behaves as
      the opposite.
    */
    if (rule.minAge !== undefined && ageYears !== null && ageYears < rule.minAge) continue;
    const matched = rule.phrases.find((p) => q.includes(normalise(p)));
    if (matched !== undefined) return { reasonKey: `opdTriage.redFlag.${rule.key}`, matched };
  }
  return null;
}
