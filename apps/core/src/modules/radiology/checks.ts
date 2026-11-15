import { CODED_SYSTEM_NAMES, aspectsScore, isCodedValue, tiradsScore } from "@hmis/contracts";
import type { CodedSystem, TiradsInputs } from "@hmis/contracts";
import type { GovernedReportTemplate } from "./definitions";

/**
 * PLAN 18-S RS8a — **THE PRE-SIGN CHECKS: rules, not a model, and one pipeline.**
 *
 * The board's "Checks before you sign" card: before a signature, the report is read by
 * deterministic rules for the mistakes a tired reader makes and a courtroom finds — a report on the
 * wrong side, an organ the patient does not have, a mammogram with no BI-RADS, a pneumothorax typed
 * and never flagged, an empty impression. **No inference runs here** (the brief: nothing with
 * inference before DPIA v0.2), and none is needed: every check is a word list and a comparison.
 *
 * ═══ ONE PIPELINE, SO A NEW GUARD JOINS RATHER THAN FORKS ═══
 *
 * `PRE_SIGN_CHECKS` is a list. Each check is a pure function of `PreSignContext` — the facts
 * `reports.ts` gathers once — returning findings with a `level`:
 *   · `refuse` — the signature is not made; the refusal carries the check's own code;
 *   · `warn` — the signature is made only when the signer acknowledges it, and the acknowledgement
 *     is stored on the signed version (`sign_checks`).
 * The same list runs at sign, at amend, and as the screen's dry run
 * (`POST /radiology/studies/:id/reports/checks`), so what the screen shows is what the signature
 * will meet. A phase that adds a guard (RS7's obstetric `foetal_sex_disclosure`) appends an entry
 * and, if it needs a fact, adds it to the context — it keeps its own refusal code.
 *
 * ═══ WHAT IS NOT HERE ═══
 *
 * The PCPNDT lexical lockout and the order-side comparison stay in `assertSignable`: they predate
 * this file, they carry an override lane and a statute, and moving them would change their codes.
 * These checks run AFTER them.
 */

export type PreSignLevel = "refuse" | "warn";

export type PreSignFinding = {
  /** The check's code — a refusal's error code, or a warning's acknowledgement key. */
  code: string;
  level: PreSignLevel;
  /** Plain words a radiologist can act on. Never an id. */
  words: string;
  detail?: Record<string, unknown>;
};

export type PreSignContext = {
  studyTypeCode: string;
  studyTypeName: string;
  /** The side the study carries (the `laterality_confirm` gate's record): left, right, bilateral, na. */
  studyLaterality: string;
  patientSex: string;
  /** Every body section's text by key (`technique`, `findings`, `recommendation`, …). */
  sections: Record<string, string>;
  impression: string;
  /** `body.coded`, as written. */
  coded: Record<string, unknown>;
  /** The governed template the report names, or null when it names a built-in skeleton. */
  template: GovernedReportTemplate | null;
  criticalCategory: string | null;
};

export type PreSignCheck = { code: string; run: (ctx: PreSignContext) => PreSignFinding[] };

/* ─────────────────────────── (5) the impression ─────────────────────────── */

const impressionRequired: PreSignCheck = {
  code: "impression_required",
  run: (ctx) => ctx.impression.trim() === ""
    ? [{
      code: "impression_required", level: "refuse",
      words: "The impression is empty. A report is not signed without one — it is the line the referring doctor acts on.",
    }]
    : [],
};

/* ─────────────────────────── (1) the side ─────────────────────────── */

const SIDE_WORDS = { left: /\bleft\b/i, right: /\bright\b/i } as const;

/**
 * The study's side against the words. A study on the LEFT whose findings and impression name only
 * the RIGHT is a report about the other limb — refused. A study that names both sides is common
 * (the other side for comparison) and is a warning to re-read each "right". Bilateral and
 * non-lateralised studies are not checked: both words belong in them.
 */
const sideConflict: PreSignCheck = {
  code: "side_conflict",
  run: (ctx) => {
    const side = ctx.studyLaterality;
    if (side !== "left" && side !== "right") return [];
    const other = side === "left" ? "right" : "left";
    const text = [...Object.values(ctx.sections), ctx.impression].join("\n");
    const namesOwn = SIDE_WORDS[side].test(text);
    const namesOther = SIDE_WORDS[other].test(text);
    if (namesOther && !namesOwn) {
      return [{
        code: "side_conflict", level: "refuse",
        words: `This study is of the ${side} side and the report names only the ${other}. Correct the side in the text — `
          + `a report on the wrong side is a wrong-site finding with a signature on it.`,
        detail: { studySide: side, reportSide: other },
      }];
    }
    if (namesOther && namesOwn) {
      return [{
        code: "side_mentions_both", level: "warn",
        words: `This study is of the ${side} side and the report also names the ${other}. Read each "${other}" once more before signing.`,
        detail: { studySide: side },
      }];
    }
    return [];
  },
};

/* ─────────────────────────── (2) sex-specific organs ─────────────────────────── */

/**
 * Whole words only, so "cervical spine" is not a cervix and "testing" is not a testis. The lists
 * are organs no body of the other registered sex has; `adnexa` is left out (the word is used for
 * the testicular adnexa too). A patient registered `other` or `unknown` is not checked.
 */
export const FEMALE_ONLY_ORGANS = ["uterus", "uterine", "endometrium", "endometrial", "ovary", "ovaries", "ovarian", "fallopian"] as const;
export const MALE_ONLY_ORGANS = ["prostate", "prostatic", "testis", "testes", "testicle", "testicles", "testicular", "scrotum", "scrotal", "seminal vesicle", "seminal vesicles", "epididymis"] as const;

function wordsFound(text: string, words: readonly string[]): string[] {
  return words.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(text));
}

const sexOrgan: PreSignCheck = {
  code: "sex_organ_mismatch",
  run: (ctx) => {
    if (ctx.patientSex !== "male" && ctx.patientSex !== "female") return [];
    const text = [...Object.values(ctx.sections), ctx.impression].join("\n");
    const wrong = wordsFound(text, ctx.patientSex === "male" ? FEMALE_ONLY_ORGANS : MALE_ONLY_ORGANS);
    if (wrong.length === 0) return [];
    return [{
      code: "sex_organ_mismatch", level: "refuse",
      words: `The report mentions ${wrong.map((w) => `"${w}"`).join(", ")} for a patient registered ${ctx.patientSex}. `
        + "Correct the text — or, if the registration is wrong, have the front desk correct the patient's record first.",
      detail: { terms: wrong, patientSex: ctx.patientSex },
    }];
  },
};

/* ─────────────────────────── (3) the coded category ─────────────────────────── */

function codedValueOf(entry: unknown): unknown {
  return typeof entry === "object" && entry !== null && "value" in entry ? (entry as { value: unknown }).value : entry;
}

const codedRequired: PreSignCheck = {
  code: "coded_category_required",
  run: (ctx) => {
    const out: PreSignFinding[] = [];
    for (const c of ctx.template?.coded ?? []) {
      const value = codedValueOf(ctx.coded[c.system]);
      const name = CODED_SYSTEM_NAMES[c.system];
      if (value === undefined || value === null || value === "") {
        if (c.required) {
          out.push({
            code: "coded_category_required", level: "refuse",
            words: `The ${ctx.template!.name} template requires a ${name} category. Choose one before signing.`,
            detail: { system: c.system, template: ctx.template!.key },
          });
        }
        continue;
      }
      if (!isCodedValue(c.system, value)) {
        out.push({
          code: "coded_category_required", level: "refuse",
          words: `"${String(value)}" is not a ${name} category. Choose one from the list.`,
          detail: { system: c.system, value },
        });
      }
    }
    /** Where the calculator's inputs were recorded, the chosen category is compared with them. */
    for (const [system, entry] of Object.entries(ctx.coded)) {
      const mismatch = calculatorMismatch(system as CodedSystem, entry);
      if (mismatch !== null) out.push(mismatch);
    }
    return out;
  },
};

function calculatorMismatch(system: CodedSystem, entry: unknown): PreSignFinding | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { value, inputs } = entry as { value?: unknown; inputs?: unknown };
  if (inputs === undefined || inputs === null) return null;
  try {
    if (system === "tirads") {
      const r = tiradsScore(inputs as TiradsInputs);
      if (r.level !== value) {
        return {
          code: "coded_calculation_differs", level: "warn",
          words: `The TI-RADS features add up to ${String(r.points)} points (${r.level}); the report says ${String(value)}. Sign only if you mean to grade it differently.`,
          detail: { system, computed: r.level, chosen: value },
        };
      }
    }
    if (system === "aspects" && Array.isArray((inputs as { affected?: unknown }).affected)) {
      const score = aspectsScore((inputs as { affected: string[] }).affected);
      if (score !== value) {
        return {
          code: "coded_calculation_differs", level: "warn",
          words: `The regions marked give ASPECTS ${String(score)}; the report says ${String(value)}.`,
          detail: { system, computed: score, chosen: value },
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/* ─────────────────────────── (4) critical terms, with negation ─────────────────────────── */

/**
 * The findings a radiologist telephones about. The list follows the ACR practice parameter's and
 * the NABH critical-result examples; the department's own examples live in `critical_categories`.
 * Spelled both ways where British and American differ, because both are dictated.
 */
export const CRITICAL_TERMS = [
  "tension pneumothorax", "pneumothorax",
  "intracranial haemorrhage", "intracranial hemorrhage", "subarachnoid haemorrhage", "subarachnoid hemorrhage",
  "subdural haematoma", "subdural hematoma", "extradural haematoma", "extradural hematoma",
  "epidural haematoma", "epidural hematoma",
  "aortic dissection", "pulmonary embolism", "pulmonary embolus", "pulmonary thromboembolism",
  "free air", "pneumoperitoneum", "free intraperitoneal air",
  "ectopic pregnancy", "testicular torsion", "ovarian torsion", "cord compression",
  "acute infarct", "acute infarction", "hyperdense mca", "large vessel occlusion",
  "midline shift", "bowel perforation", "ruptured aneurysm", "active extravasation",
] as const;

/**
 * ═══ #1076 — THE SAME TERMS AS A HINDI SPEAKER WRITES THEM, IN DEVANAGARI ═══
 *
 * A clinician reading a finding back on the phone often types it in Devanagari. The report is in English,
 * so these are TRANSLITERATIONS of the English terms (DECIDED in the spec), not Hindi medical words: a
 * doctor who heard "pneumothorax" writes न्यूमोथोरैक्स. Each form maps to the English term it names.
 * Spelling varies (long or short vowels, ै or े, ॉ or ो, a nukta or none), so the forms here and the text
 * they are matched against both pass through `foldDevanagari` first.
 */
const DEVANAGARI_PARTS = {
  pneumothorax: ["न्यूमोथोरैक्स", "न्यूमोथोराक्स", "निमोथोरैक्स", "न्यूमोथोरेक्स"],
  tension: ["टेंशन", "टेन्शन"],
  intracranial: ["इंट्राक्रेनियल", "इन्ट्राक्रेनियल", "इंट्राक्रैनियल"],
  subarachnoid: ["सबएरेक्नॉइड", "सबअरेक्नॉइड", "सबएरैक्नॉयड", "सबअरैक्नॉइड"],
  haemorrhage: ["हेमरेज", "हेमोरेज", "हैमरेज"],
  haematoma: ["हेमाटोमा", "हीमैटोमा", "हेमेटोमा"],
  subdural: ["सबड्यूरल"],
  extradural: ["एक्स्ट्राड्यूरल", "एक्सट्राड्यूरल"],
  epidural: ["एपिड्यूरल"],
  aortic: ["एओर्टिक", "अओर्टिक", "ऑर्टिक"],
  dissection: ["डिसेक्शन", "डाइसेक्शन"],
  pulmonary: ["पल्मोनरी", "पल्मोनेरी"],
  embolism: ["एम्बोलिज्म", "एम्बोलिज़्म", "एम्बोलिस्म", "एंबोलिज्म"],
  embolus: ["एम्बोलस", "एंबोलस"],
  pneumoperitoneum: ["न्यूमोपेरिटोनियम"],
  ectopic: ["एक्टोपिक"],
  pregnancy: ["प्रेगनेंसी", "प्रेग्नेंसी", "प्रेगनेन्सी"],
  testicular: ["टेस्टिकुलर"],
  ovarian: ["ओवेरियन", "ओवरियन"],
  torsion: ["टॉर्शन"],
  cord: ["कॉर्ड"],
  compression: ["कम्प्रेशन", "कंप्रेशन"],
  acute: ["एक्यूट"],
  infarct: ["इन्फार्क्ट", "इंफार्क्ट"],
  bowel: ["बाउल", "बॉवेल"],
  perforation: ["परफोरेशन", "पर्फोरेशन"],
  ruptured: ["रप्चर्ड"],
  aneurysm: ["एन्यूरिज्म", "एन्यूरिस्म"],
  active: ["एक्टिव"],
  extravasation: ["एक्स्ट्रावेसेशन", "एक्सट्रावेसेशन"],
} as const;

type CriticalTerm = (typeof CRITICAL_TERMS)[number];
const P = DEVANAGARI_PARTS;
/** Every spelling of a two-word term: each first word with each second word. */
const pairs = (a: readonly string[], b: readonly string[]): string[] => a.flatMap((x) => b.map((y) => `${x} ${y}`));

export const CRITICAL_TERMS_DEVANAGARI: readonly (readonly [string, CriticalTerm])[] = ([
  ...pairs(P.tension, P.pneumothorax).map((f) => [f, "tension pneumothorax"]),
  ...P.pneumothorax.map((f) => [f, "pneumothorax"]),
  ...pairs(P.intracranial, P.haemorrhage).map((f) => [f, "intracranial haemorrhage"]),
  ...pairs(P.subarachnoid, P.haemorrhage).map((f) => [f, "subarachnoid haemorrhage"]),
  ...pairs(P.subdural, P.haematoma).map((f) => [f, "subdural haematoma"]),
  ...pairs(P.extradural, P.haematoma).map((f) => [f, "extradural haematoma"]),
  ...pairs(P.epidural, P.haematoma).map((f) => [f, "epidural haematoma"]),
  ...pairs(P.aortic, P.dissection).map((f) => [f, "aortic dissection"]),
  ...pairs(P.pulmonary, P.embolism).map((f) => [f, "pulmonary embolism"]),
  ...pairs(P.pulmonary, P.embolus).map((f) => [f, "pulmonary embolus"]),
  ["फ्री एयर", "free air"], ["फ्री एअर", "free air"],
  ...P.pneumoperitoneum.map((f) => [f, "pneumoperitoneum"]),
  ...pairs(P.ectopic, P.pregnancy).map((f) => [f, "ectopic pregnancy"]),
  ...pairs(P.testicular, P.torsion).map((f) => [f, "testicular torsion"]),
  ...pairs(P.ovarian, P.torsion).map((f) => [f, "ovarian torsion"]),
  ...pairs(P.cord, P.compression).map((f) => [f, "cord compression"]),
  ...pairs(P.acute, P.infarct).map((f) => [f, "acute infarct"]),
  ["मिडलाइन शिफ्ट", "midline shift"],
  ...pairs(P.bowel, P.perforation).map((f) => [f, "bowel perforation"]),
  ...pairs(P.ruptured, P.aneurysm).map((f) => [f, "ruptured aneurysm"]),
  ...pairs(P.active, P.extravasation).map((f) => [f, "active extravasation"]),
] as [string, CriticalTerm][]);

/**
 * One spelling for the variants a typed Devanagari word takes: NFC, no nukta, short for long vowel signs,
 * े for ै, ो for ॉ, ं for ँ. Applied to the lexicon and to the text alike.
 */
export function foldDevanagari(text: string): string {
  return text.normalize("NFC").normalize("NFD").replace(/\u093C/g, "").normalize("NFC")
    .replace(/\u0940/g, "\u093F").replace(/\u0942/g, "\u0941")
    .replace(/[\u0948\u0945]/g, "\u0947").replace(/\u0949/g, "\u094B")
    .replace(/\u0901/g, "\u0902").replace(/\u0911/g, "\u0913").replace(/\u0910/g, "\u090F")
    .replace(/\u0908/g, "\u0907").replace(/\u090A/g, "\u0909");
}

const FOLDED_DEVANAGARI = CRITICAL_TERMS_DEVANAGARI.map(([form, term]) => [foldDevanagari(form), term] as const)
  .sort((a, b) => b[0].length - a[0].length);
/** A Devanagari or English negator as its own word (folded, as the text is): नहीं, नही, ना, न, बिना, मत; no, not, without. */
const DEVANAGARI_NEGATOR = new RegExp(
  `(?:^|[^\\p{L}\\p{M}])(?:${["नहीं", "नही", "ना", "न", "बिना", "मत", "no", "not", "without"].map(foldDevanagari).join("|")})(?![\\p{L}\\p{M}])`,
  "iu",
);
const DEVANAGARI_CLAUSE_BREAK = /[.;!?\n\u0964\u0965]|(?:^|\s)(?:लेकिन|पर|मगर|किंतु|but|however)(?=\s|$)/iu;

/**
 * The English critical terms a Devanagari text names: `said` where its clause carries no negator, `negated`
 * where it does ("न्यूमोथोरैक्स नहीं है"). A longer form shadows a shorter one inside it. Judged per clause,
 * as `criticalTermsIn` judges English.
 */
export function devanagariCriticalTermsIn(text: string): { said: CriticalTerm[]; negated: CriticalTerm[] } {
  const said: CriticalTerm[] = [];
  const negated: CriticalTerm[] = [];
  for (const raw of foldDevanagari(text).split(DEVANAGARI_CLAUSE_BREAK)) {
    if (raw === undefined || raw.trim() === "") continue;
    let clause = raw;
    const found: CriticalTerm[] = [];
    for (const [form, term] of FOLDED_DEVANAGARI) {
      const re = new RegExp(`(?<![\\p{L}\\p{M}])${form.replace(/ /g, "\\s+")}(?![\\p{L}\\p{M}])`, "u");
      if (!re.test(clause)) continue;
      found.push(term);
      clause = clause.replace(re, " ");
    }
    if (found.length === 0) continue;
    (DEVANAGARI_NEGATOR.test(raw) ? negated : said).push(...found);
  }
  return { said, negated };
}

/**
 * A negator before the term, inside its clause, no more than eight words back — "no evidence of
 * pneumothorax, haemorrhage or free air" negates all three, which is how a normal-study sentence
 * is written and why the scope crosses commas (NegEx's rule). The clause ends at a sentence mark
 * or a termination word (`CLAUSE_BREAK`), so "no effusion; large pneumothorax" is a hit.
 */
const NEGATION_BEFORE = /\b(no|not|without|negative for|absence of|free of|rules? out|ruled out|excluded?|nor|neither)\b(?:\W+\w+){0,8}\W*$/i;
const CLAUSE_BREAK = /[.;!?\n]|\b(?:but|however|although|though|except|apart from|aside from|whereas)\b/i;
/** A negator after the term, within its sentence: "pneumothorax is not seen". */
const NEGATION_AFTER = /^\W*(?:\w+\W+){0,3}?(is|are|was|were)?\s*(not|no longer)\s+(seen|identified|demonstrated|present|visualised|visualized|evident|detected)|^\W*(?:\w+\W+){0,2}?(absent|excluded|ruled out)\b/i;

/**
 * Terms present and NOT negated. Each occurrence is judged inside its own clause: "No
 * pneumothorax. Large left pneumothorax on the repeat film." is a hit, because the second sentence
 * says it. A longer term shadows the shorter one it contains ("tension pneumothorax" is reported,
 * "pneumothorax" is not reported twice).
 */
export function criticalTermsIn(text: string): string[] {
  const hits: string[] = [];
  for (const sentence of text.split(CLAUSE_BREAK)) {
    if (sentence === undefined) continue;
    const low = sentence.toLowerCase();
    for (const term of CRITICAL_TERMS) {
      const re = new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(low)) !== null) {
        const before = low.slice(0, m.index);
        const after = low.slice(m.index + m[0].length);
        if (!NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after)) {
          if (!hits.some((h) => h.includes(term))) hits.push(term);
          break;
        }
      }
    }
  }
  /** Drop a shorter term a longer hit contains, whichever order they were found in. */
  return hits.filter((h) => !hits.some((o) => o !== h && o.includes(h)));
}

const criticalTerms: PreSignCheck = {
  code: "critical_term",
  run: (ctx) => {
    if (ctx.criticalCategory !== null) return [];
    const text = [ctx.sections.findings ?? "", ctx.impression].join("\n");
    const hits = criticalTermsIn(text);
    if (hits.length === 0) return [];
    return [{
      code: "critical_term", level: "warn",
      words: `Critical terms found: ${hits.map((h) => `"${h}"`).join(", ")}. Flag a critical result (red, orange or yellow) `
        + "— or acknowledge that this is not a critical result for this patient.",
      detail: { terms: hits },
    }];
  },
};

/** The pipeline, in the order a reader would fix things. RS7's obstetric guard joins HERE. */
export const PRE_SIGN_CHECKS: readonly PreSignCheck[] = [
  impressionRequired, sideConflict, sexOrgan, codedRequired, criticalTerms,
];

export function runPreSignChecks(
  ctx: PreSignContext, checks: readonly PreSignCheck[] = PRE_SIGN_CHECKS,
): PreSignFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
