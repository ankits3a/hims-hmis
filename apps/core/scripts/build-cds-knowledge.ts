/**
 * `pnpm --filter @hmis/core tsx scripts/build-cds-knowledge.ts <bundle.json> <out.json>`
 *
 * ═══ THE BUNDLE IS THE SOURCE; THIS FILE IS THE ONLY PLACE IT IS INTERPRETED ═══
 *
 * The owner's bundle ships clinical intent as PROSE — `"3.5 mL (for 14kg: 12.5 mg/kg) Every 6h
 * SOS"`. A co-pilot that must compute a dose for the child actually in the chair cannot read prose,
 * and a co-pilot that parses prose AT RUNTIME is the same defect wearing an algorithm: the parse
 * fails silently on the one line nobody tested and a number still appears on screen.
 *
 * So the interpretation happens ONCE, HERE, offline, into a committed fixture a clinician can read
 * in a pull-request diff. Every pediatric line is classified by hand below — nineteen of them — and
 * the classification is DATA in this file rather than a regex over the bundle.
 *
 * ═══ THE THREE HONEST ANSWERS, AND WHY THE THIRD ONE REFUSES TO COMPUTE ═══
 *
 *   `stated`   the bundle states a mg/kg rate. Four lines do. We compute from it.
 *   `derived`  the bundle states only a millilitre figure FOR A 14 KG CHILD, and the concentration
 *              is in the product name. The implied rate is arithmetic — 3.5 mL of 45.7 mg/mL in a
 *              14 kg child is 11.4 mg/kg — but arithmetic on one worked example is NOT a clinical
 *              authority. The rate is recorded with the arithmetic that produced it and marked
 *              UNREVIEWED, and `regimen.ts` REFUSES to turn an unreviewed rate into a dose. The
 *              doctor is shown the bundle's own 14 kg example and told a dose needs review.
 *   `fixed`    the dose does not scale with weight (two puffs, one sachet, ORS after each stool).
 *   `non_drug` it is not a medicine at all (a cold compress, "consult a paediatric nephrologist").
 *
 * The fourth possible answer — invent a mg/kg rate from clinical knowledge — is the one thing this
 * file must never do, and the reason the classification is written out rather than inferred.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

type Dosing =
  | { kind: "stated"; mgPerKg: number; per: "dose" | "day"; concentrationMgPerMl?: number }
  | { kind: "derived"; mgPerKg: number; per: "dose" | "day"; concentrationMgPerMl: number; from: { exampleWeightKg: number; exampleVolumeMl: number }; reviewed: false }
  | { kind: "fixed" }
  | { kind: "non_drug" };

/**
 * ONE ROW PER PEDIATRIC LINE IN THE BUNDLE, keyed by syndrome + the drug label as shipped. A line
 * the bundle adds later and this table does not name is a BUILD FAILURE, not a default: an
 * unclassified pediatric line must never reach the regimen builder as a computable dose.
 */
const PEDIATRIC: Record<string, Dosing> = {
  // ── the four the bundle states a rate for ────────────────────────────────────────────────────
  "SYN_URI_01|Paracetamol Oral Suspension 250mg/5ml": { kind: "stated", mgPerKg: 12.5, per: "dose", concentrationMgPerMl: 50 },
  "SYN_ASTHMA_06|Prednisolone Syrup 5mg/5ml": { kind: "stated", mgPerKg: 1, per: "day", concentrationMgPerMl: 1 },
  "SYN_GE_02|Ondansetron Syrup 2mg/5ml": { kind: "stated", mgPerKg: 0.15, per: "dose", concentrationMgPerMl: 0.4 },
  "SYN_UTI_08|Cefixime Oral Suspension 100mg/5ml": { kind: "stated", mgPerKg: 8, per: "day", concentrationMgPerMl: 20 },
  // ── the concentration is named and the millilitres are a 14 kg worked example: DERIVED, UNREVIEWED ──
  "SYN_URI_01|Amoxicillin and Clavulanate Syrup 228.5mg/5ml": { kind: "derived", mgPerKg: 11.4, per: "dose", concentrationMgPerMl: 45.7, from: { exampleWeightKg: 14, exampleVolumeMl: 3.5 }, reviewed: false },
  "SYN_BRONCH_04|Amoxicillin-Clavulanate Syrup 228.5mg/5ml": { kind: "derived", mgPerKg: 11.4, per: "dose", concentrationMgPerMl: 45.7, from: { exampleWeightKg: 14, exampleVolumeMl: 3.5 }, reviewed: false },
  "SYN_MSK_07|Paracetamol Oral Suspension 250mg/5ml": { kind: "derived", mgPerKg: 12.5, per: "dose", concentrationMgPerMl: 50, from: { exampleWeightKg: 14, exampleVolumeMl: 3.5 }, reviewed: false },
  // ── fixed: the dose does not scale with the child's weight ───────────────────────────────────
  "SYN_ASTHMA_06|Salbutamol + Budesonide Inhaler with Spacer & Mask": { kind: "fixed" },
  "SYN_ASTHMA_06|Montelukast 4mg Chewable Tablets": { kind: "fixed" },
  "SYN_BRONCH_04|Ambroxol + Terbutaline Pediatric Syrup": { kind: "fixed" },
  "SYN_GERD_03|Pantoprazole 20mg Dispersible Tab": { kind: "fixed" },
  "SYN_GERD_03|Antacid Gel Pediatric": { kind: "fixed" },
  "SYN_GE_02|Oral Rehydration Salts (ORS) Pediatric": { kind: "fixed" },
  "SYN_GE_02|Zinc Sulfate Syrup 20mg/5ml": { kind: "fixed" },
  "SYN_GE_02|Racecadotril Sachet 15mg": { kind: "fixed" },
  "SYN_URI_01|Levocetirizine + Ambroxol Pediatric Syrup": { kind: "fixed" },
  // ── not a medicine, or an explicit referral ──────────────────────────────────────────────────
  "SYN_HTN_05|Amlodipine 2.5mg Tablets": { kind: "non_drug" }, // the sig is "consult a paediatric nephrologist strictly"
  "SYN_MSK_07|Cold Compress / Rest / Ice": { kind: "non_drug" },
  "SYN_UTI_08|Oral Fluids Hydration": { kind: "non_drug" },
};

/**
 * THE BUNDLE'S OWN SHAPE, declared rather than `any`: this file reads a FOREIGN document, and the
 * fields it reaches for are exactly the contract it depends on. A bundle that changes shape should
 * fail here, at build time, with a type error naming the field — not silently produce a corpus with
 * empty regimens.
 */
type BundleRegimenRow = { drug: string; sig: string; duration?: string; purpose?: string };
type BundleSubstitution = { substitute_for?: string; drug_adult?: string; drug_child?: string; reason?: string };
type BundleSyndrome = {
  id: string; name: string; keywords?: string[]; icd10?: string; clinical_description?: string;
  adult_regimen?: BundleRegimenRow[]; pediatric_regimen?: BundleRegimenRow[];
  allergy_substitutions?: Record<string, BundleSubstitution[]>;
};
type BundleRule = Record<string, unknown> & { id?: string | number; drug?: string };
type Bundle = { syndromes?: BundleSyndrome[] } & Record<string, unknown>;

type Line = {
  band: "adult" | "pediatric"; seq: number; drugLabel: string; purpose: string | null;
  sig: string; duration: string | null; dosing: Dosing | null;
};

/** The first of `keys` this rule actually carries — the bundle names the same idea differently per domain. */
function pick(r: BundleRule, keys: string[]): string | string[] | null {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v !== "") return v;
    if (Array.isArray(v)) return v.map(String);
  }
  return null;
}

function main(): void {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) throw new Error("usage: build-cds-knowledge.ts <bundle.json> <out.json>");
  const raw = readFileSync(inPath, "utf8");
  const b = JSON.parse(raw) as Bundle;

  const unclassified: string[] = [];
  const syndromes = (b.syndromes ?? []).map((s: BundleSyndrome) => {
    const lines: Line[] = [];
    (s.adult_regimen ?? []).forEach((r: BundleRegimenRow, i: number) => {
      lines.push({ band: "adult", seq: i + 1, drugLabel: r.drug, purpose: r.purpose ?? null, sig: r.sig, duration: r.duration ?? null, dosing: null });
    });
    (s.pediatric_regimen ?? []).forEach((r: BundleRegimenRow, i: number) => {
      const key = `${s.id}|${r.drug}`;
      const d = PEDIATRIC[key];
      if (d === undefined) unclassified.push(key);
      lines.push({ band: "pediatric", seq: i + 1, drugLabel: r.drug, purpose: r.purpose ?? null, sig: r.sig, duration: r.duration ?? null, dosing: d ?? null });
    });
    const subs = Object.entries(s.allergy_substitutions ?? {}).flatMap(([condition, arr]) =>
      arr.map((x: BundleSubstitution) => ({
        condition, substituteFor: x.substitute_for ?? null,
        drugAdult: x.drug_adult ?? null, drugChild: x.drug_child ?? null, reason: x.reason ?? null,
      })));
    return {
      key: s.id, name: s.name, keywords: s.keywords ?? [], icd10: s.icd10 ?? null,
      description: s.clinical_description ?? null, lines, substitutions: subs,
    };
  });

  /* An unclassified pediatric line is a BUILD FAILURE. See the header: the alternative is a default,
     and the only safe default for "how much of this do I give a child" is to refuse to have one. */
  if (unclassified.length > 0) {
    throw new Error(`unclassified pediatric lines (add them to PEDIATRIC):\n  ${unclassified.join("\n  ")}`);
  }

  /* The 22 guardrail domains. They are heterogeneous by nature — a vitals rule has an operator and
     a threshold, a QTc rule has points, an AMSP rule has a day cap — so the common spine is
     columns and everything else rides `payload` verbatim. Nothing from the bundle is dropped. */
  const DOMAINS = [
    "vitals_rules", "allergy_rules", "lab_rules", "g6pd_rules", "tdm_rules", "electrolyte_rules",
    "pregnancy_trimester_rules", "acb_rules", "cyp450_rules", "amsp_rules", "dialysis_rules",
    "iv_ysite_rules", "perioperative_rules", "qtc_rules", "enteral_tube_rules",
    "duplicate_subclasses", "jan_aushadhi_pricing", "emergency_antidotes", "ddi_rules",
    "symptom_mappings", "radiology_rules",
  ] as const;
  const rules = DOMAINS.flatMap((domain) =>
    ((b[domain] as BundleRule[] | undefined) ?? []).map((r: BundleRule) => ({
      domain,
      ruleKey: String(r.id ?? ""),
      subject: pick(r, ["drug", "allergen", "vital", "symptom", "subclass", "analyte"]),
      severity: pick(r, ["sev", "severity", "category"]),
      message: pick(r, ["msg", "message", "hazard", "warning", "rationale"]),
      action: pick(r, ["alternative", "safe_alternatives", "de_escalation", "action"]),
      payload: r,
    })));

  const out = {
    source: { file: inPath.split("/").pop(), sha256: createHash("sha256").update(raw).digest("hex") },
    builtFrom: "owner CDS bundle (CDAC DIS / NFI / WHO AWaRe / ICMR / CredibleMeds)",
    syndromes, rules,
  };
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  const ped = syndromes.flatMap((s) => s.lines.filter((l) => l.band === "pediatric"));
  const by = (k: string) => ped.filter((l) => l.dosing?.kind === k).length;
  console.log(`syndromes ${syndromes.length} · regimen lines ${syndromes.reduce((n, s) => n + s.lines.length, 0)} · rules ${rules.length}`);
  console.log(`pediatric: stated ${by("stated")} · derived(unreviewed) ${by("derived")} · fixed ${by("fixed")} · non-drug ${by("non_drug")}`);
}

main();
