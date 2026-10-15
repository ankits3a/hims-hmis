import type { TriageDepartment } from "./triage";

/**
 * THE TRIAGE EVALUATION'S OWN CASES, in a module that is not a test file.
 *
 * `triage-eval.test.ts` explains the rules these were written under (two to four words, no answer
 * inside the question, four languages, the labels its author's and NOT a clinician's). They live
 * here so that something other than jest can read them: the chooser evaluation
 * (`scripts/eval-choosers.ts`, 2026-10-07) runs the same 46 complaints through each model, and a
 * later example-miner must be able to REFUSE these sentences as examples — "examples must never be
 * test sentences" is then a hash check instead of a memory.
 */
export const TRIAGE_EVAL_DEPTS: TriageDepartment[] = [
  { id: "MED", name: "General Medicine" }, { id: "SUR", name: "General Surgery" },
  { id: "PED", name: "Paediatrics" }, { id: "OBG", name: "Obstetrics & Gynaecology" },
  { id: "ORT", name: "Orthopaedics" }, { id: "ENT", name: "ENT" },
  { id: "OPH", name: "Ophthalmology" }, { id: "DER", name: "Dermatology" },
  { id: "PSY", name: "Psychiatry" }, { id: "CAR", name: "Cardiology" },
  { id: "DEN", name: "Dental" }, { id: "PHY", name: "Physiotherapy" },
];

/** `[complaint, acceptable department ids]`. More than one id means the complaint is genuinely open. */
export const TRIAGE_EVAL_CASES: [string, string[]][] = [
  // ── the owner's own report ───────────────────────────────────────────────────────────────────
  ["aankh me dard", ["OPH"]], ["आँख में दर्द", ["OPH"]], ["eye pain", ["OPH"]],
  ["motiyabind", ["OPH"]], ["aankh lal hai", ["OPH"]], ["chashma banwana hai", ["OPH"]],

  // ── ENT ─────────────────────────────────────────────────────────────────────────────────────
  ["kaan me dard", ["ENT"]], ["कान में दर्द", ["ENT"]], ["gala kharab hai", ["ENT"]],
  ["naak band hai", ["ENT"]], ["kaan bahta hai", ["ENT"]], ["sunai nahi deta", ["ENT"]],

  // ── dental ──────────────────────────────────────────────────────────────────────────────────
  ["daant me dard", ["DEN"]], ["दाँत में दर्द", ["DEN"]], ["masuda soojh gaya", ["DEN"]],
  ["daant nikalwana hai", ["DEN"]],

  // ── skin ────────────────────────────────────────────────────────────────────────────────────
  ["khujli ho rahi hai", ["DER"]], ["खुजली", ["DER"]], ["skin par daane", ["DER"]],
  ["baal jhad rahe hain", ["DER"]],

  // ── bones and joints ────────────────────────────────────────────────────────────────────────
  ["ghutne mein dard", ["ORT"]], ["kamar dard", ["ORT"]], ["thehuna me dard ba", ["ORT"]],
  ["kandha jam gaya", ["ORT", "PHY"]], ["haddi tut gayi", ["ORT"]],

  // ── heart and medicine ──────────────────────────────────────────────────────────────────────
  ["dhadkan tez", ["CAR"]], ["sugar check karana hai", ["MED", "CAR"]],
  ["bukhar", ["MED", "PED"]], ["बुखार", ["MED", "PED"]], ["khansi", ["MED"]],
  ["peeliya ho gaya", ["MED"]], ["thyroid ki jaanch", ["MED"]],
  ["jaad lag ke bukhar aawat ba", ["MED", "PED"]],

  // ── surgery ─────────────────────────────────────────────────────────────────────────────────
  ["bawaseer", ["SUR"]], ["gaanth hai pet me", ["SUR", "MED"]], ["hernia", ["SUR"]],
  ["pathri ka dard", ["SUR", "MED"]],

  // ── women and children ──────────────────────────────────────────────────────────────────────
  ["garbh theharana", ["OBG"]], ["periods nahi aa rahe", ["OBG"]],
  ["bacche ko teeka lagwana", ["PED"]], ["bachcha dudh nahi pi raha", ["PED"]],

  // ── mind ────────────────────────────────────────────────────────────────────────────────────
  ["neend nahi aati", ["PSY"]], ["ghabrahat hoti hai", ["PSY"]], ["sharab chhudwani hai", ["PSY"]],

  // ── physiotherapy ───────────────────────────────────────────────────────────────────────────
  ["physiotherapy chahiye", ["PHY"]], ["stroke ke baad rehab", ["PHY"]],
];

/** Complaints the desk must REFUSE rather than guess at. */
export const TRIAGE_EVAL_MUST_REFUSE: string[] = [
  "gadi ka tyre punchar hai", "mera mobile kho gaya", "bijli ka bill jama karna hai",
  "xyzzy", "", "   ", "dard", "problem hai", "aaj ka din kaisa hai",
];
