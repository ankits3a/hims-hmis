#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * HARVEST THE FRONT-DESK TRIAGE BOOK — owner-supplied clinical content, collapsed onto this hospital
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner had a triage bundle built elsewhere: 82 syndromes, 782 dialect variants (including
 * Bhojpuri/Bihar forms this system had nothing for), priority 1/2/3 specialities with clinical
 * rationales, red flags and vital-sign triggers. Source preserved out of git at
 * `/opt/hmis-context/frontdesk-triage-2026-09-17/`.
 *
 * ═══ WHAT IS TAKEN, AND WHAT IS DELIBERATELY LEFT ═══
 *
 * TAKEN: the CONTENT — variants, department priorities, rationales, urgency, red-flag prose.
 *
 * LEFT: the engine. Measured before deciding, and three findings settled it:
 *   - Its "112-dimensional dense embedding" is a hand-written character-trigram list of 524
 *     entries (433 unique), and because lookup is `indexOf`, 91 dimensions can never be written by
 *     any input. It is spelling overlap, not meaning.
 *   - It strips everything outside `[a-z0-9]`, so DEVANAGARI EMBEDS TO AN ALL-ZERO VECTOR:
 *     `आँख में दर्द` returns no match at all. This hospital's clerks type Hindi.
 *   - It has no confidence floor. `"mera mobile kho gaya"` ("I lost my phone") returns
 *     **EMERGENCY (RED), Pediatrics**. For non-medico staff that is worse than no system: the red
 *     badge is the one signal that must never be diluted.
 *
 * So the vocabulary becomes data for the matcher this tree already has — which reads all three
 * scripts, refuses honestly, and has a brake in front of it.
 *
 * ═══ WHY THE OUTPUT IS CODE AND NOT A TABLE ═══
 *
 * Curated CLINICAL content belongs in git, where a diff is reviewable and a doctor's sign-off
 * attaches to a commit. What this hospital LEARNS from its own usage belongs in
 * `opd_complaint_term_usage`, which already exists. The two are different things and keeping them
 * in different places is the point: nobody can quietly edit a routing rule that says
 * "chest pain → Cardiology" without it showing up in a pull request.
 *
 * Usage:  node apps/core/scripts/harvest-triage-book.mjs [--write]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = "/opt/hmis-context/frontdesk-triage-2026-09-17";
const SOURCE = join(SOURCE_DIR, "scripts/clinical_syndromes_data.mjs");
const OUT = join(HERE, "../src/modules/opd/triage-book.ts");
const SIGNOFF = join(HERE, "../../../docs/superpowers/2026-09-17-triage-emergency-signoff.md");

/**
 * ═══ THE COLLAPSE, AND IT IS THE ONE PIECE OF JUDGEMENT IN THIS SCRIPT ═══
 *
 * The bundle names 34 primary specialities. This hospital seeds TWELVE departments
 * (`DEFAULT_DEPARTMENTS`). Twenty of its primaries do not exist here, and routing a walk-in to
 * "Vascular Surgery" at a hospital that has none is the same empty-department failure that made
 * the owner write in this morning — dressed up as precision.
 *
 * So every speciality maps to a department this hospital ACTUALLY HAS, or to `null`, which means
 * "do not route on this". The medical sub-specialities fold into General Medicine and the surgical
 * ones into General Surgery, which is what a twelve-department hospital does in practice: the
 * physician sees them and refers on.
 */
const TO_OUR_DEPARTMENT = {
  // — as-is —
  "Cardiology": "Cardiology",
  "Orthopaedics": "Orthopaedics", "Orthopedics": "Orthopaedics",
  "ENT": "ENT", "ENT (Otorhinolaryngology)": "ENT", "Otorhinolaryngology": "ENT",
  "Ophthalmology": "Ophthalmology",
  "Dermatology": "Dermatology",
  "Psychiatry": "Psychiatry",
  "Dental Surgery": "Dental", "Dentistry": "Dental",
  "Physiotherapy": "Physiotherapy", "Physical Medicine and Rehabilitation": "Physiotherapy",
  "General Surgery": "General Surgery",
  "General Medicine": "General Medicine",

  // — medical sub-specialities: the physician sees them first —
  "Pulmonology": "General Medicine", "Endocrinology": "General Medicine",
  "Diabetology": "General Medicine", "Gastroenterology": "General Medicine",
  "Nephrology": "General Medicine", "Hematology": "General Medicine",
  "Neurology": "General Medicine", "Rheumatology": "General Medicine",
  "Geriatric Medicine": "General Medicine", "Medical Oncology": "General Medicine",
  "Oncology": "General Medicine", "Pain Management": "General Medicine",
  "Preventive Health": "General Medicine", "Infectious Diseases": "General Medicine",
  "Hepatology": "General Medicine", "Clinical Immunology": "General Medicine",

  // — surgical sub-specialities: the general surgeon sees them first —
  "Urology": "General Surgery", "Vascular Surgery": "General Surgery",
  "Plastic Surgery": "General Surgery", "Surgical Oncology": "General Surgery",
  "Neurosurgery": "General Surgery", "Breast Surgery": "General Surgery",
  "Pediatric Surgery": "General Surgery", "Burns and Plastic Surgery": "General Surgery",
  "Proctology": "General Surgery", "Andrology": "General Surgery",

  // — found by the generator's own unmapped report, which is why it prints one —
  "Audiology": "ENT", "Head & Neck Surgery": "ENT",
  "Maxillofacial Surgery": "Dental",
  "Clinical Psychology": "Psychiatry",
  "Community Medicine": "General Medicine", "Dietetics": "General Medicine",
  "GI Surgery": "General Surgery", "Thoracic Surgery": "General Surgery",
  "Bariatric Surgery": "General Surgery",
  "Physiotherapy & PMR": "Physiotherapy",

  // — women and children —
  "Obstetrics & Gynaecology": "Obstetrics & Gynaecology",
  "Obstetrics and Gynaecology": "Obstetrics & Gynaecology",
  "Gynaecology": "Obstetrics & Gynaecology", "Gynecology": "Obstetrics & Gynaecology",
  "Obstetrics & Gynecology": "Obstetrics & Gynaecology",
  "Reproductive Medicine": "Obstetrics & Gynaecology",
  "Pediatrics": "Paediatrics", "Paediatrics": "Paediatrics",
  "Pediatric Neurology": "Paediatrics", "Neonatology": "Paediatrics",
  "Pediatric Endocrinology": "Paediatrics",

  /*
    NOT A DEPARTMENT IN THIS HOSPITAL, AND NOT ROUTED. These are the emergency-floor specialities;
    a complaint that lands here is a complaint the red-flag brake should be stopping, not one the
    appointment book should be filling. `null` keeps them out of the router deliberately rather
    than by omission.
  */
  "Emergency Medicine": null, "Critical Care Medicine": null, "Toxicology": null,
  "Anaesthesiology": null, "Transfusion Medicine": null, "Radiology": null,
  "Nuclear Medicine": null, "Radiation Oncology": null,
};

/** Priority 1 is the department; 2 and 3 are weaker alternatives a clerk may be offered. */
const WEIGHT_BY_PRIORITY = { 1: 100, 2: 55, 3: 30 };

async function main() {
  const write = process.argv.includes("--write");
  const src = readFileSync(SOURCE, "utf8");
  const sha = createHash("sha256").update(src).digest("hex");
  const { MASTER_SYNDROMES } = await import(SOURCE);

  const unmapped = new Set();
  const concepts = [];
  const emergencies = [];

  for (const s of MASTER_SYNDROMES) {
    const urgency = s.triage_urgency.startsWith("EMERGENCY") ? "emergency"
      : s.triage_urgency.startsWith("URGENT") ? "urgent" : "routine";

    const departments = [];
    for (const p of s.priority_specialities ?? []) {
      if (!(p.speciality in TO_OUR_DEPARTMENT)) { unmapped.add(p.speciality); continue; }
      const dept = TO_OUR_DEPARTMENT[p.speciality];
      if (dept === null) continue;
      const weight = WEIGHT_BY_PRIORITY[p.priority] ?? 20;
      const existing = departments.find((d) => d.department === dept);
      /* Two sub-specialities can collapse onto one department — keep the STRONGER claim. */
      if (existing === undefined) departments.push({ department: dept, weight });
      else existing.weight = Math.max(existing.weight, weight);
    }
    departments.sort((a, b) => b.weight - a.weight);

    concepts.push({
      key: s.complaint_code,
      label: s.standard_name,
      urgency,
      departments,
      variants: [...new Set((s.variants ?? []).map((v) => v.trim().toLowerCase()).filter((v) => v !== ""))],
    });

    if (urgency === "emergency") {
      emergencies.push({
        key: s.complaint_code, label: s.standard_name,
        redFlags: s.red_flags ?? "", vitals: s.vital_sign_triggers ?? "",
        variants: (s.variants ?? []).slice(0, 3),
      });
    }
  }

  const routable = concepts.filter((c) => c.departments.length > 0);
  console.log(`syndromes: ${String(concepts.length)}`);
  console.log(`  routable (at least one of our 12): ${String(routable.length)}`);
  console.log(`  emergency, held back for sign-off: ${String(emergencies.length)}`);
  console.log(`  variants harvested: ${String(concepts.reduce((n, c) => n + c.variants.length, 0))}`);
  if (unmapped.size > 0) {
    console.log(`\nUNMAPPED specialities (add to TO_OUR_DEPARTMENT or they are silently dropped):`);
    for (const u of [...unmapped].sort()) console.log(`  - ${u}`);
  }

  if (!write) { console.log("\n(dry run — pass --write to emit)"); return; }

  writeFileSync(OUT, renderBook(concepts, sha));
  writeFileSync(SIGNOFF, renderSignoff(emergencies, sha));
  console.log(`\nwrote ${OUT}`);
  console.log(`wrote ${SIGNOFF}`);
}

function renderBook(concepts, sha) {
  const body = concepts.map((c) => [
    `  {`,
    `    key: ${JSON.stringify(c.key)},`,
    `    label: ${JSON.stringify(c.label)},`,
    `    urgency: ${JSON.stringify(c.urgency)},`,
    `    departments: [${c.departments.map((d) => `{ department: ${JSON.stringify(d.department)}, weight: ${String(d.weight)} }`).join(", ")}],`,
    `    variants: [${c.variants.map((v) => JSON.stringify(v)).join(", ")}],`,
    `  },`,
  ].join("\n")).join("\n");

  return `/* GENERATED by apps/core/scripts/harvest-triage-book.mjs — do not edit by hand.
 * Re-run the generator instead; it is the only thing that should ever write this file.
 *
 * SOURCE: owner-supplied front-desk triage bundle, 2026-09-17.
 *   /opt/hmis-context/frontdesk-triage-2026-09-17/scripts/clinical_syndromes_data.mjs
 *   sha256 ${sha}
 *
 * ═══ THIS CONTENT WAS GENERATED BY A LANGUAGE MODEL AND IS NOT CLINICALLY SIGNED OFF ═══
 *
 * It is confident, specific and plausible, which is not the same as correct. The EMERGENCY rows
 * are deliberately NOT here — they are held in
 * docs/superpowers/2026-09-17-triage-emergency-signoff.md awaiting a doctor's initials, because a
 * red badge a non-medico clerk trusts is the one thing that must not be taken on a model's word.
 *
 * What IS here routes an appointment and nothing else: no diagnosis, no advice, no urgency shown
 * to a patient. A wrong row sends somebody to the wrong OPD queue, which a human corrects in a
 * minute — that is the blast radius, and it is why this half could ship ahead of the sign-off.
 */
import type { TriageUrgency } from "./triage-book-types";

export type TriageBookEntry = {
  key: string;
  label: string;
  urgency: TriageUrgency;
  /** Collapsed onto the twelve departments this hospital seeds. Strongest claim first. */
  departments: { department: string; weight: number }[];
  /** What patients and clerks actually say, in English, Hinglish and regional forms. */
  variants: string[];
};

export const TRIAGE_BOOK: TriageBookEntry[] = [
${body}
];
`;
}

function renderSignoff(rows, sha) {
  const body = rows.map((r, i) => [
    `### ${String(i + 1)}. ${r.label}`,
    ``,
    `- **code:** \`${r.key}\``,
    `- **proposed urgency:** EMERGENCY (RED) — would STOP the booking`,
    `- **red flags (as supplied):** ${r.redFlags || "_none given_"}`,
    `- **vital triggers (as supplied):** ${r.vitals || "_none given_"}`,
    `- **example phrasings:** ${r.variants.map((v) => `\`${v}\``).join(", ") || "_none_"}`,
    ``,
    `  - [ ] Correct as an emergency — add to the brake`,
    `  - [ ] Downgrade to URGENT (route, do not stop)`,
    `  - [ ] Wrong / remove`,
    ``,
  ].join("\n")).join("\n");

  return `# Triage emergencies — clinician sign-off sheet

**Generated 2026-09-17** from the owner-supplied triage bundle
(\`clinical_syndromes_data.mjs\`, sha256 \`${sha}\`) by
\`apps/core/scripts/harvest-triage-book.mjs\`.

## Why this sheet exists

The bundle marks **${String(rows.length)} syndromes as EMERGENCY (RED)**. In this system an emergency does not
merely colour a badge — \`red-flags.ts\` **refuses to book the appointment at all** and tells the
clerk to walk the patient to the emergency room. That is the correct behaviour for a front desk
staffed by non-clinicians, and it is exactly why the list cannot be taken on a language model's
word.

Two failure directions, and they are not symmetric:

- **Too many entries** and the brake is ignored within a week. The bundle's own engine returns
  EMERGENCY (RED) for *"mera mobile kho gaya"* — that is what a diluted red badge looks like.
- **Too few** and somebody is booked an 11:40 slot for a myocardial infarction.

So none of these has been merged into the brake. \`red-flags.ts\` still carries only the ten rules
written against the owner's own brief, and its test caps the list deliberately.

## What a reviewing doctor is being asked

For each row: is this an emergency that should **stop an OPD booking** at a front desk in *this*
hospital? Tick one box. Nothing here is merged until a row is ticked and initialled.

Please also name **where these patients go** — the system currently says "the emergency room"
because it has not been told the name of the place.

**Reviewed by:** ______________________  **Reg. no:** ______________  **Date:** ____________

---

${body}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
