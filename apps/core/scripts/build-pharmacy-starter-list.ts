import { readFileSync, writeFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { formularyMedicineSalts, formularyMedicines, items, opdPrescriptions } from "../src/kernel/db/schema";
import { medicineIdsByBrandNames } from "../src/modules/formulary";
import { GST_NOTIFICATION, suggestGstSlab } from "../src/modules/pharmacy";
import { NLEM_2022, NLEM_2022_SECTIONS, NLEM_2022_SOURCE } from "./data/nlem-2022";
import { argValue, toCsvLine } from "./pharmacy-shelf-common";
import { classifySalts, medicineFlag, moietyKey, nrcesScheduledSubstances } from "./set-schedule-flags";
import type { Db } from "../src/kernel/db/client";
import type { NlemEntry } from "./data/nlem-2022";
import type { NrcesVerdict, SaltVerdict } from "./set-schedule-flags";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/build-pharmacy-starter-list.ts [--bundle <cds-bundle.sql>] [--nrces <generics.csv>] [--out <csv>] [--target 300]`
 *
 * ═══ THE OWNER'S RULING (2026-09-22) ═══
 *
 * The pharmacy opens on a ~300-drug starter shelf chosen by us: EVERY drug already prescribed in this
 * hospital's OPD, plus the National List of Essential Medicines 2022, each matched to ONE common Indian
 * brand the catalogue already holds. This writes that list as a CSV a person can read line by line
 * before `load-pharmacy-shelf.ts` makes it real. It writes NOTHING to the database.
 *
 * ═══ THE TWO HALVES, AND WHERE EACH IS READ ═══
 *
 *   prescribed_in_opd   read at RUN time from the target database's `opd_prescriptions` (every
 *                       version, every line naming a formulary medicine), ordered by how often. Run
 *                       against production it names production's prescribing; the committed copy was
 *                       built against the prod-like catalogue, which has no prescriptions.
 *   nlem                `data/nlem-2022.ts`, the NLEM 2022 transcription — only the dosage forms an OPD
 *                       counter hands over (no injections, IUDs, vaccines or combi-packs), primary-care
 *                       level ("P") first, then section order, until the target is reached.
 *
 * ═══ ONE BRAND PER GENERIC, AND THE RULE THAT PICKS IT ═══
 *
 * An NLEM line (medicine + form + strength) is matched to the CDS bundle's generics by COMPOSITION:
 * the same moieties (salt words stripped) at the same amount per unit, in a dose form the line's form
 * allows. Then, among the bundle's brands of those generics that the formulary holds (by exact brand
 * name), `chooseBrand` picks: a maker the owner named (Cipla, Sun, Alkem, Mankind, Lupin, Dr Reddy's,
 * Zydus, Torrent, Abbott, GSK, Micro Labs, Intas — one tier) before the other `PREFERRED_MANUFACTURERS`
 * before anyone; then the brand family with the most products in the bundle; then the shortest name.
 * A generic no preferred maker sells takes any brand by the same tie-break, and says so in `manufacturer`. A doctor's prescribed BRAND is stocked as that brand;
 * a prescribed GENERIC gets a brand by the rule above (the counter's substitution offers it, because a
 * bundle brand of a generic has that generic's composition — `equivalentMedicines`).
 *
 * ═══ THE COLUMNS A PERSON SHOULD CHECK ═══
 *
 *   schedule       derived exactly as `set-schedule-flags.ts` derives it (the formulary's own flag wins
 *                  when one is set). Schedule X rows are LEFT OUT: the OPD counter refuses X (16c R-3).
 *   gst_rate_bps   500 for every medicine; 0 for the 36 notified life-saving drugs
 *                  (`suggestGstSlab`) and for contraceptives (NLEM 18.2, HSN 3006). CA to confirm.
 *   pack           strip of 10 for every tablet/capsule — the bundle carries no pack size. The pharmacist
 *                  corrects it at opening stock (`import-opening-stock.ts` takes the real pack size).
 *   rack           a suggestion by NLEM section: one letter per section, twelve items a shelf; H1 in
 *                  its own cabinet. The pharmacist relabels at /pharmacy/items.
 */

/** The makers a hospital pharmacy in India is likeliest to hold, in the order the brand is preferred. */
export const PREFERRED_MANUFACTURERS = [
  "Cipla Limited", "Sun Pharmaceutical Industries Limited", "Sun Pharma Laboratories Limited", "Alkem Laboratories Limited",
  "Mankind Pharma Limited", "Lupin Limited", "Lupin Laboratories Limited", "Dr.Reddy's Laboratories Limited",
  "Zydus Healthcare Limited", "Cadila Healthcare Limited", "Torrent Pharmaceuticals Limited", "Abbott Healthcare Private Limited",
  "Abbott India Limited", "GlaxoSmithKline Pharmaceuticals Limited", "Micro Labs Limited", "Intas Pharmaceuticals Limited",
  "Glenmark Pharmaceuticals Limited", "Pfizer Limited", "Ipca Laboratories Limited", "Macleods Pharmaceuticals Limited",
  "Emcure Pharmaceuticals Limited", "Alembic Pharmaceuticals Limited", "Aristo Pharmaceuticals Private Limited",
  "Cadila Pharmaceuticals Limited", "FDC Limited", "Wockhardt Limited", "Novartis India Limited",
] as const;

export const GST_SOURCES = [
  "https://busy.in/gst-rates/medicines",
  "https://gimbooks.com/medicine-hsn-code-3004",
  "https://credlix.com/hsn-code/98041000",
  "(superseded, pre-2025 12% regime, not used) https://razorpay.com/learn/gst-on-medicines",
] as const;
export const GST_EFFECTIVE = "2025-09-22";
const CONTRACEPTIVE_BASIS = "nil: contraceptives, HSN 3006 — Notification 10/2025-Central Tax (Rate) entry 115 (supersedes 2/2017)";

/** NLEM forms an OPD counter hands over. Injections, devices and combi-packs are for wards and theatres. */
const OPD_FORMS = new Set(["tablet", "capsule", "oral_liquid", "cream", "ointment", "gel", "lotion", "eye_drops", "eye_ointment", "ear_drops", "nasal", "inhalation", "suppository", "powder", "topical_other"]);

// ═══════════════════════════════════ THE BUNDLE ═══════════════════════════════════

export type BundleGeneric = { sctid: string; name: string; doseForm: string; composition: Component[] | null };
export type BundleBrand = { medicineSctid: string; medicineName: string; brand: string; genericSctid: string; manufacturer: string };
export type DpcoRow = { genericName: string; strengthAndForm: string; brandedMrpInr: number; ceilingInr: number };
export type Bundle = { generics: Map<string, BundleGeneric>; brandsByGeneric: Map<string, BundleBrand[]>; brandBySctid: Map<string, BundleBrand>; dpco: DpcoRow[] };

function splitSqlValues(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (inStr) {
      if (ch === "'") { if (row[i + 1] === "'") { cur += "'"; i += 1; } else inStr = false; } else cur += ch;
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((v) => (v === "NULL" ? "" : v));
}

/** Reads the three tables this list needs from the SQLite dump, as text (the `import-cds-catalogue` precedent). */
export function parseBundle(sqlText: string): Bundle {
  const generics = new Map<string, BundleGeneric>();
  const brandsByGeneric = new Map<string, BundleBrand[]>();
  const brandBySctid = new Map<string, BundleBrand>();
  const dpco: DpcoRow[] = [];
  const head = /^INSERT (?:OR REPLACE )?INTO (generics|medicines_brands) \(([^)]*)\) VALUES \((.*)\);\s*$/;
  let inDpco = false;
  for (const line of sqlText.split("\n")) {
    if (line.startsWith("INSERT INTO dpco_jan_aushadhi_index")) { inDpco = true; continue; }
    if (inDpco) {
      const m = /^\((.*)\)[,;]\s*$/.exec(line);
      if (m === null) { inDpco = false; continue; }
      const v = splitSqlValues(m[1]!);
      dpco.push({ genericName: v[0] ?? "", strengthAndForm: v[1] ?? "", ceilingInr: Number(v[2]), brandedMrpInr: Number(v[5]) });
      if (line.trimEnd().endsWith(";")) inDpco = false;
      continue;
    }
    const m = head.exec(line);
    if (m === null) continue;
    const cols = m[2]!.split(",").map((c) => c.trim());
    const vals = splitSqlValues(m[3]!);
    const r: Record<string, string> = {};
    cols.forEach((c, i) => { r[c] = vals[i] ?? ""; });
    if (m[1] === "generics") {
      generics.set(r.generic_sctid!, { sctid: r.generic_sctid!, name: r.generic_name!, doseForm: r.dose_form ?? "", composition: parseComposition(r.composition_summary ?? "") });
    } else {
      const b: BundleBrand = { medicineSctid: r.medicine_sctid!, medicineName: r.medicine_name!, brand: r.brand_name!, genericSctid: r.generic_sctid ?? "", manufacturer: r.manufacturer_name ?? "" };
      brandBySctid.set(b.medicineSctid, b);
      const list = brandsByGeneric.get(b.genericSctid);
      if (list === undefined) brandsByGeneric.set(b.genericSctid, [b]); else list.push(b);
    }
  }
  return { generics, brandsByGeneric, brandBySctid, dpco };
}

// ═══════════════════════════════════ COMPOSITION ═══════════════════════════════════

/** One ingredient at one amount: `perUnit` is mg (or IU/units) per tablet/dose, per mL, or per g. */
export type Component = { key: string; amount: number; unit: "mg" | "iu"; per: "unit" | "ml" | "g" };

/** Moiety aliases where NLEM and the bundle spell one substance two ways. */
const ALIASES: Record<string, string> = {
  "acetylsalicylic acid": "aspirin", "clavulanic acid": "clavulanate", "glyceryl trinitrate": "nitroglycerin",
  "salbutamol": "salbutamol", "albuterol": "salbutamol", "frusemide": "furosemide", "lignocaine": "lidocaine",
  "adrenaline": "epinephrine", "noradrenaline": "norepinephrine", "beclomethasone": "beclometasone",
  "ethinyl estradiol": "ethinylestradiol", "ethinyloestradiol": "ethinylestradiol", "levothyroxine": "levothyroxine",
  "thyroxine": "levothyroxine", "cholecalciferol": "colecalciferol", "vitamin d3": "colecalciferol",
  "hyoscine butylbromide": "hyoscine butylbromide", "butylscopolamine": "hyoscine butylbromide",
  "amoxycillin": "amoxicillin", "cephalexin": "cefalexin", "cefalexin": "cefalexin", "phenobarbitone": "phenobarbital",
  "sodium valproate": "valproate", "valproic acid": "valproate", "divalproex": "valproate", "chlorpheniramine": "chlorphenamine",
  "dicyclomine": "dicycloverine", "dicycloverine": "dicycloverine", "ferrous sulfate": "ferrous", "ferrous fumarate": "ferrous",
  "ferrous gluconate": "ferrous", "ferrous salts": "ferrous", "ferrous salt": "ferrous", "folic acid": "folic acid",
  "hydroxychloroquine": "hydroxychloroquine", "sulphasalazine": "sulfasalazine", "cotrimoxazole": "sulfamethoxazole+trimethoprim",
  "co trimoxazole": "sulfamethoxazole+trimethoprim", "benzathine benzylpenicillin": "benzathine benzylpenicillin",
  "glibenclamide": "glibenclamide", "glyburide": "glibenclamide", "oral rehydration salts": "ors", "metformin": "metformin",
  "rifampin": "rifampicin", "retinol": "vitamin a", "vitamin a": "vitamin a", "pyridoxine": "pyridoxine", "ascorbic acid": "ascorbic acid",
  "clotrimazole": "clotrimazole", "isoniazid": "isoniazid", "ipratropium": "ipratropium", "budesonide": "budesonide",
  "timolol": "timolol", "calcium carbonate": "calcium carbonate", "calcium": "calcium carbonate", "zinc": "zinc",
  "zinc sulfate": "zinc", "potassium chloride": "potassium chloride", "silver sulfadiazine": "sulfadiazine silver",
  "sulfadiazine silver": "sulfadiazine silver", "povidone iodine": "povidone iodine", "tropicamide": "tropicamide",
  "acyclovir": "aciclovir", "cyclosporine": "ciclosporin", "cyclosporin": "ciclosporin", "clomiphene": "clomifene",
  "5 aminosalicylic acid": "mesalazine", "mesalamine": "mesalazine", "co trimoxazole sulphamethoxazole trimethoprim": "sulfamethoxazole+trimethoprim",
  "sulphamethoxazole": "sulfamethoxazole", "tenofovir disproxil": "tenofovir disoproxil", "tenofovir disproxil fumarate": "tenofovir disoproxil",
  "tenofovir disoproxil fumarate": "tenofovir disoproxil", "tdf": "tenofovir disoproxil", "dabigatran etexilate": "dabigatran",
  "lithium carbonate": "lithium", "hyoscine butyl bromide": "hyoscine butylbromide", "6 mercaptopurine": "mercaptopurine",
  "all trans retinoic acid": "tretinoin", "hydroxyurea": "hydroxycarbamide", "d penicillamine": "penicillamine",
  "n acetylcysteine": "acetylcysteine", "proparacaine": "proxymetacaine", "carboxymethyl cellulose": "carmellose",
};

/** A substance name to its matching key: the schedule script's moiety reduction, then the aliases. */
export function substanceKey(name: string): string {
  const raw = name.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9\s+-]/g, " ").replace(/\s+/g, " ").trim();
  if (ALIASES[raw] !== undefined) return ALIASES[raw]!;
  const k = moietyKey(name);
  return ALIASES[k] ?? k;
}

const MASS: Record<string, number> = { gram: 1000, g: 1000, milligram: 1, mg: 1, microgram: 0.001, mcg: 0.001, "µg": 0.001, nanogram: 0.000001 };
function perOf(den: string): "unit" | "ml" | "g" | null {
  const d = den.toLowerCase();
  if (/^(milliliter|millilitre|ml)$/.test(d)) return "ml";
  if (/^(gram|g)$/.test(d)) return "g";
  if (/^(tablet|capsule|each|sachet|actuation|dose|suppository|lozenge|patch|vial|ampoule|unit|drop|pessary|puff|spray)$/.test(d)) return "unit";
  return null;
}

/** `Amoxicillin (500/1 milligram/Tablet) + Clavulanate potassium (125/1 milligram/Tablet)`, or null. */
export function parseComposition(summary: string): Component[] | null {
  if (summary.trim() === "") return null;
  const out: Component[] = [];
  for (const part of summary.split(" + ")) {
    const m = /^(.*)\(([\d.]+)\/([\d.]+) ([A-Za-z µ]+)\/([A-Za-z ]+)\)\s*$/.exec(part.trim());
    if (m === null) return null;
    const num = Number(m[2]); const den = Number(m[3]);
    const unitWord = m[4]!.trim().toLowerCase();
    const per = perOf(m[5]!.trim());
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || per === null) return null;
    let amount: number; let unit: Component["unit"];
    if (MASS[unitWord] !== undefined) { amount = (num / den) * MASS[unitWord]!; unit = "mg"; }
    else if (/unit/.test(unitWord)) { amount = (num / den) * (unitWord.startsWith("million") ? 1_000_000 : 1); unit = "iu"; }
    else return null;
    out.push({ key: substanceKey(m[1]!), amount, unit, per });
  }
  return out;
}

type Want = { key: string; lo: number; hi: number; unit: Component["unit"]; per: Component["per"] | "pct" };

/** An NLEM line's strength as one `Want` per ingredient, or null when it cannot be read. */
export function nlemWants(e: Pick<NlemEntry, "medicine" | "strength">): Want[] | null {
  const names = e.medicine.replace(/^co-trimoxazole\s*\[(.*)\]$/i, "$1").split(/\s\+\s/).map((n) => n.replace(/\(.*?\)/g, "").trim());
  const keys = names.length === 1 && ALIASES[substanceKey(names[0]!)] === undefined && substanceKey(names[0]!).includes("+")
    ? substanceKey(names[0]!).split("+") : names.flatMap((n) => substanceKey(n).split("+"));
  // "0.03 mg + Tablet 0.15 mg" (a two-tablet pack printed as one line) reads as its two strengths.
  const parts = e.strength.split(/\s\+\s/).map((p) => p.replace(/^[A-Za-z\s-]+(?=\d)/, "").trim()).filter((p) => p !== "");
  if (parts.length !== keys.length) return null;
  const wants: Want[] = [];
  for (const [i, p] of parts.entries()) {
    const s = p.replace(/\s+/g, " ").replace(/\/ /g, "/").toLowerCase();
    let m = /^([\d.]+)\s*%/.exec(s);
    if (m !== null) { const v = Number(m[1]) * 10; wants.push({ key: keys[i]!, lo: v, hi: v, unit: "mg", per: "pct" }); continue; }
    m = /^([\d.]+)\s*(mg|mcg|g|µg|iu|units?)\s+to\s+([\d.]+)\s*(mg|mcg|g|µg|iu|units?)$/.exec(s);
    if (m !== null) {
      const f1 = MASS[m[2]!] ?? 1; const f2 = MASS[m[4]!] ?? 1;
      wants.push({ key: keys[i]!, lo: Number(m[1]) * f1, hi: Number(m[3]) * f2, unit: MASS[m[2]!] === undefined ? "iu" : "mg", per: "unit" });
      continue;
    }
    m = /^([\d.]+)\s*(mg|mcg|g|µg|iu|units?)(?:\s*\/\s*([\d.]*)\s*(ml|g|dose|puff|actuation|tablet|sachet|drop))?/.exec(s);
    if (m === null) return null;
    const mass = MASS[m[2]!];
    const perWord = m[4];
    const denom = m[3] === undefined || m[3] === "" ? 1 : Number(m[3]);
    const per: Want["per"] = perWord === undefined ? "unit" : perWord === "ml" ? "ml" : perWord === "g" ? "g" : "unit";
    const v = (Number(m[1]) * (mass ?? 1)) / denom;
    wants.push({ key: keys[i]!, lo: v, hi: v, unit: mass === undefined ? "iu" : "mg", per });
  }
  return wants;
}

function close(a: number, lo: number, hi: number): boolean {
  return a >= lo * 0.99 && a <= hi * 1.01;
}

export function compositionMatches(wants: readonly Want[], comp: readonly Component[]): boolean {
  if (wants.length !== comp.length) return false;
  const byKey = new Map(comp.map((c) => [c.key, c]));
  if (byKey.size !== comp.length) return false;
  return wants.every((w) => {
    const c = byKey.get(w.key);
    if (c === undefined || c.unit !== w.unit) return false;
    if (w.per === "pct") return (c.per === "g" || c.per === "ml") && close(c.amount, w.lo, w.hi);
    return c.per === w.per && close(c.amount, w.lo, w.hi);
  });
}

/** The bundle dose forms an NLEM line's form text allows. */
export function doseFormAllowed(e: Pick<NlemEntry, "form" | "formText">, doseForm: string): boolean {
  const t = e.formText.toLowerCase(); const d = doseForm.toLowerCase();
  const release = /modified|sustained|extended|prolonged|\bsr\b|\ber\b|\bcr\b/.test(t);
  switch (e.form) {
    case "tablet":
      if (/dispersible/.test(t)) return /dispersible|tablet for oral suspension|orodispersible/.test(d);
      if (/enteric|gastro/.test(t)) return /gastro-resistant oral tablet/.test(d);
      if (/chewable/.test(t)) return d === "chewable tablet";
      if (/sublingual/.test(t)) return d === "sublingual tablet";
      if (/effervescent/.test(t)) return d === "effervescent oral tablet";
      if (release) return /prolonged-release oral tablet|modified-release oral tablet/.test(d);
      return d === "oral tablet" || d === "film-coated oral tablet";
    case "capsule":
      if (release) return /prolonged-release oral capsule|modified-release oral capsule/.test(d);
      if (/enteric|gastro/.test(t)) return /gastro-resistant oral capsule/.test(d);
      return d === "oral capsule";
    case "oral_liquid": return /^oral (solution|suspension|syrup|drops|emulsion)|powder for oral (suspension|solution)|granules for oral suspension/.test(d);
    case "eye_drops": return /^eye (drops|solution|suspension)/.test(d);
    case "eye_ointment": return /^eye (ointment|gel)/.test(d);
    case "ear_drops": return /^ear (drops|solution|suspension)/.test(d);
    case "cream": return /cream/.test(d);
    case "ointment": return /ointment/.test(d) && !/eye/.test(d);
    case "gel": return /gel/.test(d) && !/eye/.test(d);
    case "lotion": return /lotion|cutaneous (solution|emulsion|suspension)/.test(d);
    case "nasal": return /nasal/.test(d);
    case "inhalation": return /inhalation/.test(d);
    case "suppository": return /suppository/.test(d);
    case "powder": return /powder for oral solution|oral powder|effervescent powder/.test(d);
    case "topical_other": return /cutaneous|shampoo|paint|dusting powder|spray/.test(d);
    default: return false;
  }
}

// ═══════════════════════════════════ THE BRAND ═══════════════════════════════════

/** The makers the owner named (2026-09-22) — one tier, no order among them. */
export const MAJOR_MANUFACTURERS = new Set([
  "cipla limited", "sun pharmaceutical industries limited", "sun pharma laboratories limited", "alkem laboratories limited",
  "mankind pharma limited", "lupin limited", "lupin laboratories limited", "dr.reddy's laboratories limited",
  "zydus healthcare limited", "cadila healthcare limited", "torrent pharmaceuticals limited", "abbott healthcare private limited",
  "abbott india limited", "glaxosmithkline pharmaceuticals limited", "micro labs limited", "intas pharmaceuticals limited",
]);
const PREFERRED = new Set<string>(PREFERRED_MANUFACTURERS.map((m) => m.toLowerCase()));

/** A brand family's name: "Crocin Advance" and "Crocin 650" are both "crocin". */
export function familyOf(brand: string): string {
  return (brand.toLowerCase().match(/[a-z0-9]+/)?.[0]) ?? brand.toLowerCase();
}

/**
 * The brand the rule picks, among those the formulary actually holds:
 *   1. a MAJOR maker (the owner's list, one tier) before another preferred maker before anyone else;
 *   2. then the brand FAMILY with the most products in the bundle — the proxy this data has for "the
 *      brand people know" (Dolo, Crocin, Pan … each sell a dozen variants; a name made up for one
 *      tender sells one);
 *   3. then the shortest name, then A–Z, so the choice is stable run to run.
 */
export function chooseBrand(
  candidates: readonly BundleBrand[], inFormulary: (b: BundleBrand) => boolean, familySize: ReadonlyMap<string, number> = new Map(),
): BundleBrand | undefined {
  const held = candidates.filter(inFormulary);
  const tier = (b: BundleBrand): number => {
    const m = b.manufacturer.replace(/''/g, "'").toLowerCase();
    return MAJOR_MANUFACTURERS.has(m) ? 0 : PREFERRED.has(m) ? 1 : 2;
  };
  const fam = (b: BundleBrand): number => familySize.get(familyOf(b.brand)) ?? 0;
  return [...held].sort((a, b) => tier(a) - tier(b) || fam(b) - fam(a) || a.brand.length - b.brand.length
    || a.brand.localeCompare(b.brand) || a.medicineName.localeCompare(b.medicineName))[0];
}

// ═══════════════════════════════════ THE LIST ═══════════════════════════════════

export type StarterRow = {
  code: string; brandName: string; medicineId: string; manufacturer: string; generic: string; strength: string; form: string;
  why: string; nlemCode: string; category: string; schedule: string; gstRateBps: number; gstBasis: string;
  baseUom: string; packUom: string; packMultiplier: number | null; hsnCode: string; rack: string; prescribedCount: number;
};

export type StarterReport = {
  prescribedMedicines: number; prescribedLines: number; freeTextLines: number; prescribedUnresolved: number;
  nlemLinesConsidered: number; nlemMatched: number; nlemNoGeneric: string[]; nlemNoBrand: string[];
  scheduleXLeftOut: string[]; rows: number; target: number;
};

/** Units by the NLEM form, or by the bundle's dose form for a prescribed row. */
export function packFor(doseForm: string): { baseUom: string; packUom: string; packMultiplier: number | null } {
  const d = doseForm.toLowerCase();
  if (/capsule/.test(d)) return { baseUom: "capsule", packUom: "strip", packMultiplier: 10 };
  if (/tablet|lozenge/.test(d)) return { baseUom: "tablet", packUom: "strip", packMultiplier: 10 };
  if (/inhal/.test(d)) return { baseUom: "inhaler", packUom: "", packMultiplier: null };
  if (/cream|ointment|gel/.test(d)) return { baseUom: "tube", packUom: "", packMultiplier: null };
  if (/suppository/.test(d)) return { baseUom: "suppository", packUom: "", packMultiplier: null };
  if (/sachet|powder for oral|oral powder/.test(d)) return { baseUom: "sachet", packUom: "", packMultiplier: null };
  if (/injection|infusion/.test(d)) return { baseUom: "vial", packUom: "", packMultiplier: null };
  return { baseUom: "bottle", packUom: "", packMultiplier: null };
}

function strengthOf(comp: readonly Component[] | null): string {
  if (comp === null) return "";
  const fmt = (c: Component): string => {
    const v = c.unit === "mg" && c.amount < 1 ? `${String(+(c.amount * 1000).toFixed(3))} mcg` : `${String(+c.amount.toFixed(3))} ${c.unit === "mg" ? "mg" : "IU"}`;
    return c.per === "unit" ? v : `${v}/${c.per === "ml" ? "mL" : "g"}`;
  };
  return comp.map(fmt).join(" + ");
}

/** A short, stable item code from the brand: `CROCIN500`. */
export function codeFor(brand: string, strength: string, doseForm: string, taken: Set<string>): string {
  const stem = brand.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "ITEM";
  const num = (/[\d.]+/.exec(strength)?.[0] ?? "").replace(".", "").slice(0, 5);
  const d = doseForm.toLowerCase();
  const suffix = /tablet|capsule|lozenge/.test(d) ? "" : /eye/.test(d) ? "E" : /ear/.test(d) ? "O" : /nasal/.test(d) ? "N" : /inhal/.test(d) ? "I"
    : /cream|ointment|gel|cutaneous|lotion/.test(d) ? "T" : /suppository/.test(d) ? "R" : "L";
  const base = `${stem}${stem.endsWith(num) ? "" : num}${suffix}`.slice(0, 16);
  let code = base;
  for (let n = 2; taken.has(code.toLowerCase()); n += 1) code = `${base}-${String(n)}`;
  taken.add(code.toLowerCase());
  return code;
}

export async function buildStarterList(
  db: Db, bundle: Bundle, nrces: Map<string, NrcesVerdict>, opts: { target?: number } = {},
): Promise<{ rows: StarterRow[]; report: StarterReport }> {
  const target = opts.target ?? 300;
  const report: StarterReport = {
    prescribedMedicines: 0, prescribedLines: 0, freeTextLines: 0, prescribedUnresolved: 0,
    nlemLinesConsidered: 0, nlemMatched: 0, nlemNoGeneric: [], nlemNoBrand: [], scheduleXLeftOut: [], rows: 0, target,
  };

  // ── which bundle brands the formulary holds, by exact (case-insensitive) brand name ──
  const allBrandNames = [...bundle.brandBySctid.values()].map((b) => b.medicineName);
  const held = await medicineIdsByBrandNames(db, allBrandNames);
  const heldId = (b: BundleBrand): string | undefined => held.get(b.medicineName.toLowerCase());

  const familySize = new Map<string, number>();
  for (const b of bundle.brandBySctid.values()) familySize.set(familyOf(b.brand), (familySize.get(familyOf(b.brand)) ?? 0) + 1);

  // ── the generic index: moiety set → generics ──
  const byKeys = new Map<string, BundleGeneric[]>();
  for (const g of bundle.generics.values()) {
    if (g.composition === null) continue;
    const k = [...new Set(g.composition.map((c) => c.key))].sort().join("|");
    const list = byKeys.get(k);
    if (list === undefined) byKeys.set(k, [g]); else list.push(g);
  }

  type Pick = { brand: BundleBrand | null; medicineId: string; brandName: string; generic: BundleGeneric | null; why: Set<string>; nlem?: NlemEntry; prescribedCount: number };
  const picks = new Map<string, Pick>();

  // ── half 1: prescribed ──
  const rx = await db.select({ lines: opdPrescriptions.lines }).from(opdPrescriptions);
  const counts = new Map<string, number>();
  for (const p of rx) {
    for (const l of (p.lines as { medicineId?: string | null }[] | null) ?? []) {
      report.prescribedLines += 1;
      if (l.medicineId === undefined || l.medicineId === null || l.medicineId === "") { report.freeTextLines += 1; continue; }
      counts.set(l.medicineId, (counts.get(l.medicineId) ?? 0) + 1);
    }
  }
  report.prescribedMedicines = counts.size;
  const rxIds = [...counts.keys()];
  const rxMeds = rxIds.length === 0 ? [] : await db.select({ id: formularyMedicines.id, brandName: formularyMedicines.brandName, sourceRef: formularyMedicines.sourceRef, active: formularyMedicines.active })
    .from(formularyMedicines).where(inArray(formularyMedicines.id, rxIds));
  for (const m of [...rxMeds].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.brandName.localeCompare(b.brandName))) {
    const n = counts.get(m.id) ?? 0;
    const asBrand = m.sourceRef === null ? undefined : bundle.brandBySctid.get(m.sourceRef);
    const asGeneric = m.sourceRef === null ? undefined : bundle.generics.get(m.sourceRef);
    let pick: Pick | undefined;
    if (asBrand !== undefined || asGeneric === undefined) {
      // A brand the doctor named — or a medicine curated here with no bundle source — is stocked as itself.
      pick = { brand: asBrand ?? null, medicineId: m.id, brandName: m.brandName, generic: asBrand === undefined ? null : bundle.generics.get(asBrand.genericSctid) ?? null, why: new Set(["prescribed_in_opd"]), prescribedCount: n };
    } else {
      const b = chooseBrand(bundle.brandsByGeneric.get(asGeneric.sctid) ?? [], (x) => heldId(x) !== undefined, familySize);
      if (b === undefined) { report.prescribedUnresolved += 1; continue; }
      pick = { brand: b, medicineId: heldId(b)!, brandName: b.medicineName, generic: asGeneric, why: new Set(["prescribed_in_opd"]), prescribedCount: n };
    }
    const prev = picks.get(pick.medicineId);
    if (prev === undefined) picks.set(pick.medicineId, pick); else prev.prescribedCount += n;
  }

  // ── half 2: NLEM, primary level first, then section order ──
  const nlemLines = NLEM_2022.filter((e) => OPD_FORMS.has(e.form));
  report.nlemLinesConsidered = nlemLines.length;
  const ordered = [...nlemLines.entries()].sort((a, b) => Number(!a[1].level.includes("P")) - Number(!b[1].level.includes("P")) || a[0] - b[0]).map(([, e]) => e);
  const seenLine = new Set<string>();
  const nlemPicks: Pick[] = [];
  for (const e of ordered) {
    const lineKey = `${e.medicine}|${e.formText}|${e.strength}`.toLowerCase();
    if (seenLine.has(lineKey)) continue; // cross-listed in another section
    seenLine.add(lineKey);
    const wants = nlemWants(e);
    const key = wants === null ? "" : [...new Set(wants.map((w) => w.key))].sort().join("|");
    const generics = wants === null ? [] : (byKeys.get(key) ?? []).filter((g) => doseFormAllowed(e, g.doseForm) && compositionMatches(wants, g.composition ?? []));
    if (generics.length === 0) { report.nlemNoGeneric.push(`${e.code} ${e.medicine} ${e.formText} ${e.strength}`); continue; }
    const brand = chooseBrand(generics.flatMap((g) => bundle.brandsByGeneric.get(g.sctid) ?? []), (x) => heldId(x) !== undefined, familySize);
    if (brand === undefined) { report.nlemNoBrand.push(`${e.code} ${e.medicine} ${e.formText} ${e.strength}`); continue; }
    report.nlemMatched += 1;
    nlemPicks.push({ brand, medicineId: heldId(brand)!, brandName: brand.medicineName, generic: bundle.generics.get(brand.genericSctid) ?? generics[0]!, why: new Set(["nlem"]), nlem: e, prescribedCount: 0 });
  }

  // ── schedule and GST need each chosen medicine's salts ──
  const saltVerdicts = await classifySalts(db, nrces);
  const describe = async (ids: string[]): Promise<Map<string, { flag: string | null; routeClass: string; form: string; salts: SaltVerdict[] }>> => {
    const out = new Map<string, { flag: string | null; routeClass: string; form: string; salts: SaltVerdict[] }>();
    if (ids.length === 0) return out;
    const meds = await db.select({ id: formularyMedicines.id, flag: formularyMedicines.scheduleFlag, routeClass: formularyMedicines.routeClass, form: formularyMedicines.form })
      .from(formularyMedicines).where(inArray(formularyMedicines.id, ids));
    const links = await db.select({ medicineId: formularyMedicineSalts.medicineId, saltId: formularyMedicineSalts.saltId })
      .from(formularyMedicineSalts).where(inArray(formularyMedicineSalts.medicineId, ids));
    for (const m of meds) out.set(m.id, { flag: m.flag, routeClass: m.routeClass, form: m.form, salts: [] });
    for (const l of links) { const v = saltVerdicts.get(l.saltId); if (v !== undefined) out.get(l.medicineId)?.salts.push(v); }
    return out;
  };

  // Prescribed first (all of them), then NLEM until the target.
  for (const p of nlemPicks) {
    const prev = picks.get(p.medicineId);
    if (prev !== undefined) { prev.why.add("nlem"); prev.nlem ??= p.nlem; continue; }
    if (picks.size >= target) continue;
    picks.set(p.medicineId, p);
  }
  const info = await describe([...picks.keys()]);

  // ── rows ──
  const existingItems = await db.select({ code: items.code, medicineId: items.formularyMedicineId }).from(items).where(eq(items.class, "drug"));
  const codeOfMedicine = new Map(existingItems.filter((i) => i.medicineId !== null).map((i) => [i.medicineId!, i.code]));
  const taken = new Set(existingItems.map((i) => i.code.toLowerCase()));
  const rows: StarterRow[] = [];
  for (const p of picks.values()) {
    const d = info.get(p.medicineId);
    const derived = d === undefined ? null : d.flag ?? medicineFlag(d.salts, d.routeClass, d.form);
    if (derived === "X") { report.scheduleXLeftOut.push(p.brandName); continue; }
    const doseForm = p.generic?.doseForm ?? d?.form ?? "";
    const section = p.nlem === undefined ? "" : p.nlem.code.split(".")[0]!;
    const contraceptive = p.nlem?.code.startsWith("18.2.") === true;
    const gst = contraceptive ? { rateBps: 0, basis: CONTRACEPTIVE_BASIS }
      : suggestGstSlab((d?.salts ?? []).map((s) => ({ name: s.name }))) ?? { rateBps: 500, basis: "5%: medicaments, HSN 3004 (no composition on file)" };
    const pack = packFor(doseForm);
    const shortBrand = p.brand?.brand ?? p.brandName.replace(/\s*\(.*$/, "");
    // NLEM's own words when they are plain units ("5 mg/5 mL"); the bundle's composition otherwise.
    const plain = /^[\d.]+\s*(mg|mcg|g|iu|%)(\s*\/\s*[\d.]*\s*(ml|g|dose))?(\s\+\s[\d.]+\s*(mg|mcg|g|iu|%)(\s*\/\s*[\d.]*\s*(ml|g|dose))?)*$/i;
    const strength = p.nlem !== undefined && plain.test(p.nlem.strength.trim()) ? p.nlem.strength.trim() : strengthOf(p.generic?.composition ?? null) || (p.nlem?.strength ?? "");
    rows.push({
      code: codeOfMedicine.get(p.medicineId) ?? codeFor(shortBrand, strength, doseForm, taken),
      brandName: p.brandName, medicineId: p.medicineId, manufacturer: p.brand?.manufacturer.replace(/''/g, "'") ?? "",
      generic: p.nlem?.medicine ?? p.generic?.name ?? "", strength, form: doseForm,
      why: [...p.why].sort((a, b) => (a === "prescribed_in_opd" ? -1 : b === "prescribed_in_opd" ? 1 : 0)).join("+"),
      nlemCode: p.nlem?.code ?? "", category: section === "" ? "Prescribed in OPD (not NLEM)" : NLEM_2022_SECTIONS[section] ?? section,
      schedule: derived ?? "", gstRateBps: gst.rateBps, gstBasis: gst.basis,
      ...pack, hsnCode: contraceptive ? "3006" : "3004", rack: "", prescribedCount: p.prescribedCount,
    });
  }
  assignRacks(rows);
  report.rows = rows.length;
  return { rows, report };
}

/**
 * One letter per NLEM section in section order (prescribed-only rows last), twelve items a shelf,
 * H1 in its own cabinet — the way a counter keeps them (the demo seed's `H1 cabinet`).
 */
export function assignRacks(rows: StarterRow[]): void {
  const sectionNo = (r: StarterRow): number => (r.nlemCode === "" ? 99 : Number(r.nlemCode.split(".")[0]));
  const order = [...rows].sort((a, b) => sectionNo(a) - sectionNo(b) || a.nlemCode.localeCompare(b.nlemCode, undefined, { numeric: true }) || a.brandName.localeCompare(b.brandName));
  const letters = new Map<number, string>();
  const perLetter = new Map<string, number>();
  let h1 = 0;
  for (const r of order) {
    if (r.schedule === "H1") { h1 += 1; r.rack = `H1-${String(Math.ceil(h1 / 12))}`; continue; }
    const s = sectionNo(r);
    if (!letters.has(s)) {
      const i = letters.size;
      letters.set(s, i < 26 ? String.fromCharCode(65 + i) : `Z${String(i - 25)}`);
    }
    const letter = letters.get(s)!;
    const n = (perLetter.get(letter) ?? 0) + 1;
    perLetter.set(letter, n);
    r.rack = `${letter}${String(Math.ceil(n / 12))}`;
  }
  rows.splice(0, rows.length, ...order);
}

export const STARTER_COLUMNS = [
  "code", "brand_name", "manufacturer", "generic", "strength", "form", "why", "nlem_code", "category", "schedule",
  "gst_rate_bps", "base_uom", "pack_uom", "pack_multiplier", "hsn_code", "rack", "prescribed_count",
] as const;

export function renderStarterCsv(rows: readonly StarterRow[], report: StarterReport, builtFrom: string): string {
  const out: string[] = [
    "# PHARMACY STARTER LIST — generated by apps/core/scripts/build-pharmacy-starter-list.ts; review it, then load it with load-pharmacy-shelf.ts.",
    `# Built from: ${builtFrom}. Owner ruling 2026-09-22: every drug prescribed in OPD + NLEM 2022, one common Indian brand each.`,
    `# NLEM: ${NLEM_2022_SOURCE.title}, ${NLEM_2022_SOURCE.publisher} — ${NLEM_2022_SOURCE.url} (sha256 ${NLEM_2022_SOURCE.sha256}).`,
    "# BRAND RULE (chooseBrand): among formulary brands of the composition-matched generic — a maker the owner named (Cipla, Sun, Alkem, Mankind, Lupin, Dr Reddy's, Zydus, Torrent, Abbott, GSK, Micro Labs, Intas) first, then other large Indian makers, then any; within that, the brand family with the most products in the CDS bundle; then shortest name.",
    `# GST — CA TO CONFIRM: 500 bps (5%) for every medicine, HSN 3004, effective ${GST_EFFECTIVE} (GST rationalisation, 56th Council); 0 for the 36 life-saving drugs of ${GST_NOTIFICATION}, and 0 for contraceptives (HSN 3006, Notification 10/2025-CT(Rate) entry 115). No 12% anywhere.`,
    `# GST sources: ${GST_SOURCES.join(" ; ")}`,
    "# SCHEDULE: derived as set-schedule-flags.ts derives it (Drugs Rules 1945 Schedules X/H1/H + NRCeS); blank = not scheduled by any list. Schedule X rows are left out (the OPD counter refuses X).",
    "# PACK: strip of 10 for tablets/capsules is a DEFAULT — the bundle has no pack size; the real pack is taken at opening stock. RACK: a suggestion by NLEM section; H1 in its own cabinet.",
    `# COUNTS: ${String(report.rows)} rows (target ${String(report.target)}) · prescribed medicines ${String(report.prescribedMedicines)} from ${String(report.prescribedLines)} lines (${String(report.freeTextLines)} free-text, ${String(report.prescribedUnresolved)} with no held brand) · NLEM OPD lines ${String(report.nlemLinesConsidered)}, matched ${String(report.nlemMatched)}, no generic ${String(report.nlemNoGeneric.length)}, no brand ${String(report.nlemNoBrand.length)} · Schedule X left out ${String(report.scheduleXLeftOut.length)}`,
    toCsvLine(STARTER_COLUMNS),
  ];
  for (const r of rows) {
    out.push(toCsvLine([
      r.code, r.brandName, r.manufacturer, r.generic, r.strength, r.form, r.why, r.nlemCode, r.category, r.schedule,
      r.gstRateBps, r.baseUom, r.packUom, r.packMultiplier, r.hsnCode, r.rack, r.prescribedCount,
    ]));
  }
  return `${out.join("\n")}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bundlePath = argValue(argv, "--bundle") ?? "/opt/hmis-context/cds-bundle/cds-bundle.sql";
  const nrcesPath = argValue(argv, "--nrces") ?? "/opt/hmis-context/nrces-2026-09/generics.csv";
  const outPath = argValue(argv, "--out") ?? "scripts/data/pharmacy-starter-list.csv";
  const target = Number(argValue(argv, "--target") ?? "300");
  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url);
  try {
    const bundle = parseBundle(readFileSync(bundlePath, "utf8"));
    const nrces = nrcesScheduledSubstances(readFileSync(nrcesPath, "utf8"));
    const { rows, report } = await buildStarterList(db, bundle, nrces, { target });
    const dbName = new URL(url).pathname.replace(/^\//, "");
    writeFileSync(outPath, renderStarterCsv(rows, report, `database "${dbName}", bundle ${bundlePath}`));
    const by = (k: keyof StarterRow): string => Object.entries(rows.reduce<Record<string, number>>((a, r) => { const v = String(r[k]); a[v] = (a[v] ?? 0) + 1; return a; }, {})).map(([v, n]) => `${v || "-"} ${String(n)}`).join(" · ");
    process.stdout.write(
      `starter list → ${outPath}: ${String(rows.length)} rows\n` +
      `  why: ${by("why")}\n  schedule: ${by("schedule")}\n  gst_rate_bps: ${by("gstRateBps")}\n` +
      `  prescribed: ${String(report.prescribedMedicines)} medicines from ${String(report.prescribedLines)} lines (${String(report.freeTextLines)} free-text, ${String(report.prescribedUnresolved)} unresolved)\n` +
      `  NLEM OPD lines ${String(report.nlemLinesConsidered)} · matched ${String(report.nlemMatched)} · no generic ${String(report.nlemNoGeneric.length)} · no held brand ${String(report.nlemNoBrand.length)} · Schedule X left out ${String(report.scheduleXLeftOut.length)}\n`,
    );
    if (argv.includes("--verbose")) {
      for (const l of report.nlemNoGeneric) process.stdout.write(`    no generic: ${l}\n`);
      for (const l of report.nlemNoBrand) process.stdout.write(`    no brand:   ${l}\n`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
}
