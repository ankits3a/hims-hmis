import type { StudyType } from "./definitions";

/**
 * PLAN 18-S RS3 — **WHAT THE PATIENT MUST DO BEFORE THE SLOT**, derived in ONE place.
 *
 * The desk's Checks step, the slip and the appointment message all read this list, so the three can
 * never tell the patient different things. It is a KEY list, not prose: the screen and the message
 * template each render a key in English and Hindi, and nothing clinical (no study name, no finding)
 * rides the key.
 *
 * ═══ DECIDED — DERIVED FROM THE STUDY TYPE'S FLAGS AND ITS CODE FAMILY, UNTIL RS4 ═══
 *
 * The study book carries no prep field. RS4's `imaging_protocols` definition is where prep becomes
 * data; until then the rules below are the board's (`checksFor` in the 28 Sep spec) expressed over
 * the flags the book DOES carry, and — for the two ultrasound rules that no flag distinguishes
 * (fasting for the gall bladder, a full bladder for the pelvis) — the seeded code family. A type
 * outside those families asks for nothing rather than for a guess.
 *
 * `contrast_option: 'optional'` asks for nothing, for check-in's reason (checkin.ts): whether
 * contrast is given is decided at the console, and a fasting instruction for a scan that turns out
 * to be plain is one patients learn to ignore.
 */
export const PREP_KEYS = [
  "nil_by_mouth_4h",
  "creatinine_report",
  "fasting_6h",
  "full_bladder",
  "metal_and_implants",
  "id_and_referral",
] as const;
export type PrepKey = (typeof PREP_KEYS)[number];

const FULL_BLADDER = /(^|-)(KUB|PELVIS|OBS-EARLY)(-|$)/;

export function prepFor(studyType: StudyType): PrepKey[] {
  const out: PrepKey[] = [];
  if (studyType.contrast_option === "required") out.push("nil_by_mouth_4h", "creatinine_report");
  if (studyType.modality === "usg") {
    if (FULL_BLADDER.test(studyType.code)) out.push("full_bladder");
    else if (studyType.body_part === "abdomen") out.push("fasting_6h");
  }
  if (studyType.modality === "mri") out.push("metal_and_implants");
  if (studyType.pcpndt_applicable) out.push("id_and_referral");
  return out;
}
