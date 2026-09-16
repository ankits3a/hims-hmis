import { readFileSync } from "node:fs";
import { newId } from "@hmis/contracts";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import {
  formularyGenericSubstances, formularyGenerics, formularySalts, formularySubstances,
} from "../src/kernel/db/schema";
import type { Tx } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core import:nrces -- --dir ./nrces --release nrces-2026-09 --actor "<name>" [--apply]`
 *
 * === READ THE LOADER DESIGN NOTE FIRST ===
 *
 * `docs/superpowers/specs/2026-09-07-spreadsheet-loader-design.md`. This file follows its seven
 * rules, FIXES its still-open defect #4 (provenance - `formulary_generics.source` records which
 * release produced each row), and adds a fifth defect to its list: **`import-item-master` parses
 * CSV with `split(",")`, and that is not the shape to copy.** 2,116 rows of `generics.csv` and 433
 * of `substances.csv` carry quoted fields containing commas; a naive split misaligns every column
 * after the first comma inside a quoted name and REPORTS SUCCESS. The parser below is RFC4180.
 *
 * === WHAT THIS LOADS ===
 *
 * The NRCeS (National Resource Centre for EHR Standards, MoHFW / C-DAC) SNOMED CT national release
 * for Indian medicines. Three of its files, which are the STRUCTURAL SPINE:
 *
 *   substances.csv            3,283 released substances -> formulary_substances
 *   generics.csv             10,303 clinical drugs       -> formulary_generics
 *   generic_compositions.csv 13,125 composition rows     -> formulary_generic_substances
 *
 * NOT `formulary_salts`, and this table said so until 2026-09-13. The body was re-cut onto the
 * release tier and these three lines were not, so the header named the curated moiety table while
 * the code inserted into the release one. Two independent reviewers read it as authority. A
 * comment that disagrees with the code beneath it is the version a reader trusts - defect #3 of
 * `docs/superpowers/specs/2026-09-07-spreadsheet-loader-design.md`, third instance, this one mine.
 *
 * `medicines.csv` (93,905 branded products) is DELIBERATELY NOT HERE. Loading it needs a decision
 * this loader must not take quietly: `formulary_medicines_brand_lower_ux` is UNIQUE on
 * lower(brand_name), and the release has 63,333 distinct brand names across 93,905 products -
 * `thyronorm` appears 18 times, one per strength - while all 768 `medicine_name` collisions differ
 * by MANUFACTURER (two companies both sell "Dtaz 4 g/vial"). Real market data does not satisfy that
 * index, and widening a uniqueness guard to make an import pass is the one thing a loader may never
 * do. Brands are their own task, with that invariant decided in the open.
 *
 * === IT LOADS THE SPINE AND NONE OF THE CLINICAL PROSE, AND THE FILL RATES ARE WHY ===
 *
 * Measured over the release's own rows on 2026-09-13, not assumed:
 *
 *   100%  sctids, names, synonyms, dose_form, route_of_administration, substance links, timestamps
 *    23%  indications, contraindications      22%  drug_type       18%  source
 *    13%  toxicity, chemical_representation    3%  interaction_with_drugs
 *     1%  classification_of_drug               0%  excipient, license_number, license_status
 *
 * The spine is complete and is what unblocks the pharmacy. The clinical half is not there, and a
 * 3%-full `interaction_with_drugs` column sitting beside `formulary_interactions` would read as the
 * interaction dataset having arrived. It has not: that is the ONE PURCHASE of the 2026-08-23 RFQ
 * (`docs/procurement/2026-08-23-rfq-drug-knowledge-dataset.md`), and this release makes that
 * purchase CHEAPER - its M2 wants salt/INN join keys and we now bring 3,283 SNOMED-coded ones -
 * not unnecessary.
 *
 * === WHY IT DOES NOT EMIT PER-ROW EVENTS ===
 *
 * `seed-lab-catalogue` is the precedent: a catalogue is configuration, not a business fact stream,
 * and it inserts directly with no events. 3,283 + 10,303 rows through `addSalt`'s event path would
 * put ~13,600 rows in the outbox for the dispatcher to walk on the next boot. Provenance is served
 * by `formulary_generics.source` and by the audit columns, which is what provenance is for.
 *
 * === WHAT IT DOES WITH THE 29 CURATOR-NAMED MOIETIES ===
 *
 * The release is imported AS RELEASED into `formulary_substances`. The only automatic link to a
 * curated moiety is an EXACT match of the substance name or one of its synonyms against an
 * existing `formulary_salts` name - "Ibuprofen" to `ibuprofen`, which invents nothing because it
 * is the same word. Everything else lands `pending` for a pharmacist, however obvious it looks:
 * "Warfarin sodium" is NOT linked to `warfarin` by this script, because deriving a moiety from a
 * salt form is a clinical act and rule 3 forbids a loader performing one.
 *
 * A previous cut of this file created moieties directly and REFUSED the import when two release
 * rows matched one curated moiety. Both were wrong. Many substances to one moiety is the design -
 * four doxycycline salt forms, one `doxycycline` - so it links both and refuses nothing.
 *
 * === THE SENTENCE THAT USED TO BE HERE AND WAS FALSE ===
 *
 * An earlier version of this header said the loader derives `formulary_medicine_salts` so that
 * "every existing check keeps working untouched". It does not derive it, and the claim was unsafe
 * as well as untrue: every guard in the prescribing and dispensing path tests for an EMPTY salt
 * list and none tests for an INCOMPLETE one, so a derivation that emitted the components it
 * happened to have would produce a short list that reads as a complete one - 1,108 generics
 * carrying 12,783 branded products are in exactly that state. When the derivation is written it
 * must refuse to emit a partial composition at all.
 */

// ---------------------------------------------------------------------------------------------
// RFC4180 CSV. Quoted fields, embedded commas and newlines, "" as an escaped quote.
// ---------------------------------------------------------------------------------------------
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  // A leading UTF-8 BOM would otherwise become part of the first header name. `rowsToObjects`
  // trims header cells and `String.trim()` happens to treat U+FEFF as whitespace, so that path is
  // already covered - this strip is what makes `parseCsv` correct for a caller that does NOT trim,
  // which is every caller that treats it as a general parser. Belt and braces, said as such rather
  // than claimed as the only guard.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const pushField = (): void => { row.push(field); field = ""; };
  const pushRow = (): void => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === "\"") { quoted = true; i += 1; continue; }
    if (c === ",") { pushField(); i += 1; continue; }
    if (c === "\r") { i += 1; continue; }
    if (c === "\n") { pushRow(); i += 1; continue; }
    field += c; i += 1;
  }
  // A file not ending in a newline still has a last row; one that does must not gain an empty one.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Rule 4 - an unknown or missing column is REFUSED and NAMED, never ignored. */
function requireHeader(file: string, got: string[], want: string[]): void {
  const g = got.map((h) => h.trim().toLowerCase());
  const missing = want.filter((w) => !g.includes(w));
  const unknown = g.filter((h) => !want.includes(h));
  if (missing.length > 0 || unknown.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing column(s): ${missing.join(", ")}`);
    if (unknown.length > 0) parts.push(`unknown column(s): ${unknown.join(", ")}`);
    throw new Error(
      `${file}: header does not match the NRCeS release this loader knows - ${parts.join("; ")}. ` +
      "Nothing was written. If the national release has changed shape, this loader is updated " +
      "deliberately rather than importing a file it does not understand.",
    );
  }
}

function rowsToObjects(file: string, csv: string, want: string[]): Record<string, string>[] {
  const rows = parseCsv(csv).filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
  const header = rows.shift();
  if (header === undefined) throw new Error(`${file}: file is empty`);
  requireHeader(file, header, want);
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((r, n) => {
    if (r.length !== keys.length) {
      throw new Error(
        `${file}: row ${String(n + 2)} has ${String(r.length)} fields, header has ${String(keys.length)}. ` +
        "Nothing was written.",
      );
    }
    const o: Record<string, string> = {};
    keys.forEach((k, idx) => { o[k] = (r[idx] ?? "").trim(); });
    return o;
  });
}

export const SUBSTANCE_COLUMNS = [
  "substance_sctid", "substance_name", "synonyms", "molecular_weight",
  "chemical_representation", "substance_info", "toxicity", "active", "last_updated_on",
];
export const GENERIC_COLUMNS = [
  "generic_sctid", "generic_name", "dose_form", "route_of_administration", "substance_sctids",
  "substance_names", "composition_summary", "drug_type", "classification_of_drug",
  "contraindications", "indications", "interaction_with_drugs", "source", "active",
  "last_updated_on",
];
export const COMPOSITION_COLUMNS = [
  "generic_sctid", "substance_sctid", "substance_name", "unit", "strength",
];

/** `true`/`false` as released. Rule 3: an unrecognised value is refused, never coerced to a default. */
function parseActive(file: string, raw: string, rowLabel: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`${file}: ${rowLabel} has active="${raw}", which is neither true nor false. Nothing was written.`);
}

/**
 * Strip the SNOMED FULLY SPECIFIED NAME wrapper, and NOTHING else.
 *
 * 4,921 of 10,303 clinical-drug names arrive as "Product containing precisely <drug> (clinical
 * drug)". That wrapper is a SNOMED naming convention, not part of the drug's name, and left on it
 * makes every one of those rows share the prefix `produ` - so a five-character search still returns
 * 2,357 rows and the doctor reads a sentence about products.
 *
 * This is a display normalisation of a KNOWN, FIXED wrapper, not a rewrite: the release's own
 * string is kept verbatim in `name`, so the result is always checkable against the source. Rule 3
 * forbids inventing a value; it does not forbid removing a prefix the publisher documents.
 */
export function normalizeGenericName(raw: string): string {
  return raw
    .replace(/^Product containing precisely\s+/i, "")
    .replace(/^Product containing\s+/i, "")
    .replace(/\s*\(clinical drug\)\s*$/i, "")
    .trim();
}

function splitPipes(raw: string): string[] {
  return raw.split("|").map((s) => s.trim()).filter((s) => s !== "");
}

export interface SubstancePlan {
  sctid: string;
  name: string;
  synonyms: string[];
  active: boolean;
  /** Set only by an EXACT name/synonym match against a curated moiety. Never by a rule. */
  saltId: string | null;
}
export interface GenericPlan {
  kind: "create" | "skip";
  sctid: string;
  name: string;
  nameNormalized: string;
  doseForm: string;
  routeOfAdministration: string;
  compositionSummary: string | null;
  active: boolean;
}
export interface CompositionPlan {
  genericSctid: string;
  substanceSctid: string;
  strength: string | null;
  unit: string | null;
}
export interface Plan {
  substances: SubstancePlan[];
  generics: GenericPlan[];
  compositions: CompositionPlan[];
  release: string;
  /**
   * How many existing moieties were skipped as auto-link targets because they are themselves images
   * of a published release. Carried on the plan and PRINTED, so an operator can see that a worklist
   * stayed full for a reason rather than discover it as an empty screen.
   */
  withheldReleaseImage: number;
}

interface ExistingSalt { id: string; name: string; sourceRef: string | null }

export function planImport(
  substancesCsv: string,
  genericsCsv: string,
  compositionsCsv: string,
  existingSalts: ExistingSalt[],
  existingSubstanceSctids: Set<string>,
  existingGenericSctids: Set<string>,
  release: string,
): Plan {
  const substances = rowsToObjects("substances.csv", substancesCsv, SUBSTANCE_COLUMNS);
  const generics = rowsToObjects("generics.csv", genericsCsv, GENERIC_COLUMNS);
  const compositions = rowsToObjects("generic_compositions.csv", compositionsCsv, COMPOSITION_COLUMNS);

  // -- substances ------------------------------------------------------------------------------
  //
  // THE ONLY AUTO-LINK IS AN EXACT NAME MATCH, and the distinction is the whole safety argument.
  // Matching "Ibuprofen" to the curated moiety `ibuprofen` INVENTS NOTHING - it is the same word.
  // Deriving `doxycycline` from "Doxycycline hyclate" is a clinical transformation, and rule 3 of
  // the loader design note forbids a loader making one. Everything that is not an exact match is
  // left `pending` for a pharmacist, however obvious it looks.
  //
  // MANY SUBSTANCES MAY MAP TO ONE MOIETY AND THAT IS NOT A CONFLICT. An earlier cut REFUSED the
  // whole import when two release rows matched one curated moiety; under this model that is the
  // intended shape (four doxycycline salt forms, one moiety), so it links both.
  //
  // ═══ THE PREMISE ABOVE IS CONDITIONAL, AND THE CONDITION STOPPED HOLDING ═══
  //
  // "It is the same word" is a safe thing to say about a moiety a PHARMACIST curated. It is not a
  // safe thing to say about a moiety a LOADER wrote: then it is the same word because it is the
  // same row, and the link asserts a clinical equivalence that nobody made.
  //
  // That is the world as it stands. `import-cds-catalogue.ts` loads the same national release's
  // 3,283 substances straight into `formulary_salts`, and MEASURED on the loaded catalogue every
  // one of the 3,283 rows carries a `source_ref` - it is the release, verbatim, with 437 salt-form
  // names and no drug classes. Left alone, this arm would match all 3,283 substances to the rows
  // that ARE those substances, stamp them `mapped`, and empty the pharmacist's worklist before a
  // human ever opened it. A machine would have recorded three thousand clinical decisions.
  //
  // So a moiety that is itself an image of a published release is NOT a match target.
  // `formulary_salts.source_ref` is the discriminator because it has exactly ONE writer in the tree
  // - the catalogue loader - and `addSalt` does not set it, so a null means a human made this row.
  // It is withheld rather than refused: withholding costs a pharmacist a decision they were always
  // going to make, and the other direction costs them the decision itself.
  const byName = new Map<string, ExistingSalt>();
  let withheldReleaseImage = 0;
  for (const s of existingSalts) {
    if (s.sourceRef !== null) { withheldReleaseImage += 1; continue; }
    byName.set(s.name.trim().toLowerCase(), s);
  }

  const substancePlans: SubstancePlan[] = [];
  const seenSctid = new Set<string>();
  const seenName = new Set<string>();

  for (const r of substances) {
    const sctid = r["substance_sctid"] ?? "";
    const name = r["substance_name"] ?? "";
    if (sctid === "" || name === "") {
      throw new Error("substances.csv: a row has an empty substance_sctid or substance_name. Nothing was written.");
    }
    if (seenSctid.has(sctid)) throw new Error(`substances.csv: sctid ${sctid} appears twice. Nothing was written.`);
    seenSctid.add(sctid);
    const lower = name.toLowerCase();
    if (seenName.has(lower)) throw new Error(`substances.csv: substance_name "${name}" appears twice. Nothing was written.`);
    seenName.add(lower);
    if (existingSubstanceSctids.has(sctid)) continue; // already imported by an earlier release

    const synonyms = splitPipes(r["synonyms"] ?? "");
    const active = parseActive("substances.csv", r["active"] ?? "", `substance ${sctid}`);

    let hit = byName.get(lower);
    if (hit === undefined) {
      for (const syn of synonyms) {
        const h = byName.get(syn.toLowerCase());
        if (h !== undefined) { hit = h; break; }
      }
    }
    substancePlans.push({ sctid, name, synonyms, active, saltId: hit?.id ?? null });
  }

  // -- generics --------------------------------------------------------------------------------
  const genericPlans: GenericPlan[] = [];
  const seenGeneric = new Set<string>();
  for (const r of generics) {
    const sctid = r["generic_sctid"] ?? "";
    const name = r["generic_name"] ?? "";
    const doseForm = r["dose_form"] ?? "";
    const route = r["route_of_administration"] ?? "";
    if (sctid === "" || name === "" || doseForm === "" || route === "") {
      throw new Error(
        `generics.csv: generic ${sctid === "" ? "(blank sctid)" : sctid} is missing one of generic_name, ` +
        "dose_form, route_of_administration. Rule 3 - a blank is not a default. Nothing was written.",
      );
    }
    if (seenGeneric.has(sctid)) throw new Error(`generics.csv: sctid ${sctid} appears twice. Nothing was written.`);
    seenGeneric.add(sctid);
    const summary = r["composition_summary"] ?? "";
    const nameNormalized = normalizeGenericName(name);
    if (nameNormalized === "") {
      throw new Error(
        `generics.csv: generic ${sctid} has a name that is nothing but the SNOMED wrapper ` +
        `("${name}"). Nothing was written.`,
      );
    }
    genericPlans.push({
      kind: existingGenericSctids.has(sctid) ? "skip" : "create",
      sctid, name, nameNormalized, doseForm, routeOfAdministration: route,
      compositionSummary: summary === "" ? null : summary,
      active: parseActive("generics.csv", r["active"] ?? "", `generic ${sctid}`),
    });
  }

  // -- compositions ----------------------------------------------------------------------------
  const knownSubstances = new Set<string>([...seenSctid, ...existingSubstanceSctids]);
  const knownGenerics = new Set<string>([...seenGeneric, ...existingGenericSctids]);
  const compositionPlans: CompositionPlan[] = [];
  const seenPair = new Set<string>();
  for (const r of compositions) {
    const g = r["generic_sctid"] ?? "";
    const s = r["substance_sctid"] ?? "";
    if (!knownGenerics.has(g)) {
      throw new Error(`generic_compositions.csv: generic_sctid ${g} is in no generic row. Nothing was written.`);
    }
    if (!knownSubstances.has(s)) {
      throw new Error(`generic_compositions.csv: substance_sctid ${s} is in no substance row. Nothing was written.`);
    }
    const key = `${g} ${s}`;
    // Keyed on the SUBSTANCE, so two salt forms of one moiety are two rows and neither is lost.
    if (seenPair.has(key)) {
      throw new Error(`generic_compositions.csv: the pair (${g}, ${s}) appears twice. Nothing was written.`);
    }
    seenPair.add(key);
    const strength = r["strength"] ?? "";
    const unit = r["unit"] ?? "";
    compositionPlans.push({
      genericSctid: g, substanceSctid: s,
      strength: strength === "" ? null : strength,
      unit: unit === "" ? null : unit,
    });
  }

  return { substances: substancePlans, generics: genericPlans, compositions: compositionPlans, release, withheldReleaseImage };
}

/**
 * Rule 1 - ONE TRANSACTION FOR THE WHOLE IMPORT. A failure part-way through 26,711 rows that left
 * the substances committed and the compositions not would produce moieties with no products and
 * products with partial composition, and the operator could not tell which half.
 */
export async function applyPlan(tx: Tx, plan: Plan, actor: string): Promise<void> {
  const substanceIdBySctid = new Map<string, string>();
  for (const s of plan.substances) {
    const id = newId();
    const mapped = s.saltId !== null;
    await tx.insert(formularySubstances).values({
      id, sctid: s.sctid, name: s.name, synonyms: s.synonyms,
      saltId: s.saltId,
      mappingStatus: mapped ? "mapped" : "pending",
      mappedBy: mapped ? `import:${plan.release}` : null,
      mappedAt: mapped ? new Date() : null,
      source: plan.release, active: s.active, createdBy: actor, updatedBy: actor,
    });
    substanceIdBySctid.set(s.sctid, id);
  }
  const priorSubstances = await tx.select({ id: formularySubstances.id, sctid: formularySubstances.sctid })
    .from(formularySubstances);
  for (const s of priorSubstances) substanceIdBySctid.set(s.sctid, s.id);

  const genericIdBySctid = new Map<string, string>();
  for (const g of plan.generics) {
    if (g.kind === "skip") continue;
    const id = newId();
    await tx.insert(formularyGenerics).values({
      id, sctid: g.sctid, name: g.name, nameNormalized: g.nameNormalized, doseForm: g.doseForm,
      routeOfAdministration: g.routeOfAdministration, compositionSummary: g.compositionSummary,
      source: plan.release, active: g.active, createdBy: actor, updatedBy: actor,
    });
    genericIdBySctid.set(g.sctid, id);
  }
  const priorGenerics = await tx.select({ id: formularyGenerics.id, sctid: formularyGenerics.sctid })
    .from(formularyGenerics);
  for (const g of priorGenerics) genericIdBySctid.set(g.sctid, g.id);

  for (const c of plan.compositions) {
    const genericId = genericIdBySctid.get(c.genericSctid);
    const substanceId = substanceIdBySctid.get(c.substanceSctid);
    if (genericId === undefined || substanceId === undefined) {
      throw new Error(
        `internal: composition (${c.genericSctid}, ${c.substanceSctid}) did not resolve after planning`,
      );
    }
    // No onConflictDoNothing: the plan already refused a duplicate pair, so a conflict here would
    // be a defect worth hearing about rather than a row to drop quietly.
    await tx.insert(formularyGenericSubstances)
      .values({ genericId, substanceId, strength: c.strength, unit: c.unit });
  }
}

export function renderReport(plan: Plan, applied: boolean): string {
  const mapped = plan.substances.filter((s) => s.saltId !== null).length;
  const pending = plan.substances.length - mapped;
  const newGenerics = plan.generics.filter((g) => g.kind === "create").length;
  const skipped = plan.generics.filter((g) => g.kind === "skip").length;
  return [
    "",
    `NRCeS formulary import - release ${plan.release}`,
    applied ? "APPLIED" : "DRY RUN - nothing was written. Re-run with --apply to write.",
    "",
    `  substances     ${String(plan.substances.length)} imported as released`,
    `    mapped       ${String(mapped)} auto-linked to a curated moiety by EXACT name or synonym`,
    `    pending      ${String(pending)} awaiting a pharmacist`,
    `    withheld     ${String(plan.withheldReleaseImage)} moieties skipped as match targets - they are release images, not curated rows`,
    `  generics       ${String(newGenerics)} new, ${String(skipped)} already present (skipped)`,
    `  compositions   ${String(plan.compositions.length)}`,
    "",
    "  THE PENDING COUNT IS NOT A BACKLOG TO BE RUSHED. Until a substance is mapped, products",
    "  containing it have no curated moiety, and the derivation must REFUSE to emit a partial",
    "  composition for them rather than emit the components it happens to have - a short salt list",
    "  reads as a complete one to every check in the system.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): { dir: string; release: string; actor: string; apply: boolean } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get("--dir");
  const release = get("--release");
  const actor = get("--actor");
  if (dir === undefined || release === undefined || actor === undefined) {
    throw new Error(
      "usage: import:nrces -- --dir <folder> --release <label> --actor \"<name>\" [--apply]\n" +
      "  --dir      holds substances.csv, generics.csv and generic_compositions.csv\n" +
      "  --release  provenance written to formulary_generics.source, e.g. nrces-2026-09\n" +
      "  --actor    Rule 6 - a NAME for the audit columns. This script authenticates nobody\n" +
      "             and mints no credential.",
    );
  }
  return { dir, release, actor, apply: argv.includes("--apply") };
}

async function main(): Promise<void> {
  const { dir, release, actor, apply } = parseArgs(process.argv.slice(2));
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const read = (f: string): string => readFileSync(`${dir}/${f}`, "utf8");

  const existingSalts = await db.select({
    id: formularySalts.id, name: formularySalts.name, sourceRef: formularySalts.sourceRef,
  }).from(formularySalts);
  const existingSubstances = await db.select({ sctid: formularySubstances.sctid }).from(formularySubstances);
  const existingGenerics = await db.select({ sctid: formularyGenerics.sctid }).from(formularyGenerics);

  const plan = planImport(
    read("substances.csv"), read("generics.csv"), read("generic_compositions.csv"),
    existingSalts,
    new Set(existingSubstances.map((s) => s.sctid)),
    new Set(existingGenerics.map((g) => g.sctid)),
    release,
  );

  try {
    if (!apply) {
      process.stdout.write(renderReport(plan, false));
      return;
    }
    await withTx(db, (tx) => applyPlan(tx, plan, actor));
    process.stdout.write(renderReport(plan, true));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().then(
    () => { process.exit(0); },
    (e: unknown) => {
      process.stderr.write(`import:nrces FAILED: ${String(e instanceof Error ? e.message : e)}\n`);
      process.exit(1);
    },
  );
}
