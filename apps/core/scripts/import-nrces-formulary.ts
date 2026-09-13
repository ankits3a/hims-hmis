import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { createDb, withTx } from "../src/kernel/db/client";
import { formularyGenericSalts, formularyGenerics, formularySalts } from "../src/kernel/db/schema";
import type { Db, Tx } from "../src/kernel/db/client";

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
 *   substances.csv            3,283 active moieties      -> formulary_salts
 *   generics.csv             10,303 clinical drugs       -> formulary_generics
 *   generic_compositions.csv 13,125 composition rows     -> formulary_generic_salts
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
 * === THE 29 CURATOR-NAMED MOIETIES, AND THE ONE THING THAT COULD GO SILENTLY WRONG ===
 *
 * `seed-formulary-interactions` writes 29 moieties by hand, with no concept id. If this loader
 * created a SECOND row for one of them under the release's spelling, the duplicate would split
 * every check that groups by moiety - which is the exact failure `formulary_salts_name_lower_ux`
 * exists to prevent, arriving by a route that index cannot see (two different spellings).
 *
 * So a release substance is matched against existing salts by its own name AND by every synonym it
 * carries, and a match LINKS (backfills `sctid`) rather than creating. Two guards on that: a
 * release row matching an existing salt that already holds a DIFFERENT sctid is a refusal, and the
 * report NAMES every existing moiety left unlinked - because an unlinked curator moiety is the one
 * place a duplicate can still hide, and a count would not tell you which.
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

function splitPipes(raw: string): string[] {
  return raw.split("|").map((s) => s.trim()).filter((s) => s !== "");
}

export interface SaltPlan {
  kind: "create" | "link";
  sctid: string;
  name: string;
  aliases: string[];
  active: boolean;
  existingId?: string;
}
export interface GenericPlan {
  kind: "create" | "skip";
  sctid: string;
  name: string;
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
  salts: SaltPlan[];
  generics: GenericPlan[];
  compositions: CompositionPlan[];
  unlinkedExistingSalts: string[];
  release: string;
}

interface ExistingSalt { id: string; name: string; sctid: string | null }

export function planImport(
  substancesCsv: string,
  genericsCsv: string,
  compositionsCsv: string,
  existingSalts: ExistingSalt[],
  existingGenericSctids: Set<string>,
  release: string,
): Plan {
  const substances = rowsToObjects("substances.csv", substancesCsv, SUBSTANCE_COLUMNS);
  const generics = rowsToObjects("generics.csv", genericsCsv, GENERIC_COLUMNS);
  const compositions = rowsToObjects("generic_compositions.csv", compositionsCsv, COMPOSITION_COLUMNS);

  // -- substances ------------------------------------------------------------------------------
  const byName = new Map<string, ExistingSalt>();
  const bySctid = new Map<string, ExistingSalt>();
  for (const s of existingSalts) {
    byName.set(s.name.trim().toLowerCase(), s);
    if (s.sctid !== null) bySctid.set(s.sctid, s);
  }
  const saltPlans: SaltPlan[] = [];
  const seenSctid = new Set<string>();
  const seenName = new Set<string>();
  const claimedExisting = new Map<string, string>(); // existing salt id -> release sctid that claimed it

  for (const r of substances) {
    const sctid = r["substance_sctid"] ?? "";
    const name = r["substance_name"] ?? "";
    if (sctid === "" || name === "") {
      throw new Error("substances.csv: a row has an empty substance_sctid or substance_name. Nothing was written.");
    }
    // Rule 4 - a file that contradicts itself is refused; which row was meant is the operator's to say.
    if (seenSctid.has(sctid)) throw new Error(`substances.csv: sctid ${sctid} appears twice. Nothing was written.`);
    seenSctid.add(sctid);
    const lower = name.toLowerCase();
    if (seenName.has(lower)) throw new Error(`substances.csv: substance_name "${name}" appears twice. Nothing was written.`);
    seenName.add(lower);

    const synonyms = splitPipes(r["synonyms"] ?? "");
    const active = parseActive("substances.csv", r["active"] ?? "", `substance ${sctid}`);

    if (bySctid.has(sctid)) continue; // this concept is already on a salt row - nothing to do

    // Match by the released name first, then by any synonym: the curator's 29 moieties are named
    // by hand and a release spelling that differs is exactly how a duplicate moiety is born.
    let hit = byName.get(lower);
    if (hit === undefined) {
      for (const syn of synonyms) {
        const h = byName.get(syn.toLowerCase());
        if (h !== undefined) { hit = h; break; }
      }
    }
    if (hit !== undefined) {
      if (hit.sctid !== null && hit.sctid !== sctid) {
        throw new Error(
          `substances.csv: "${name}" (${sctid}) matches the existing moiety "${hit.name}", which already ` +
          `carries a DIFFERENT concept id (${hit.sctid}). Two concept ids for one moiety is a ` +
          "contradiction a loader must not resolve on its own. Nothing was written.",
        );
      }
      const prior = claimedExisting.get(hit.id);
      if (prior !== undefined) {
        throw new Error(
          `substances.csv: both ${prior} and ${sctid} match the existing moiety "${hit.name}". ` +
          "Linking either would leave the other to create a duplicate. Nothing was written.",
        );
      }
      claimedExisting.set(hit.id, sctid);
      saltPlans.push({ kind: "link", sctid, name, aliases: synonyms, active, existingId: hit.id });
    } else {
      saltPlans.push({ kind: "create", sctid, name, aliases: synonyms, active });
    }
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
    genericPlans.push({
      kind: existingGenericSctids.has(sctid) ? "skip" : "create",
      sctid, name, doseForm, routeOfAdministration: route,
      compositionSummary: summary === "" ? null : summary,
      active: parseActive("generics.csv", r["active"] ?? "", `generic ${sctid}`),
    });
  }

  // -- compositions ----------------------------------------------------------------------------
  const plannedSaltSctids = new Set<string>([...seenSctid, ...bySctid.keys()]);
  const plannedGenericSctids = new Set<string>([...seenGeneric, ...existingGenericSctids]);
  const compositionPlans: CompositionPlan[] = [];
  const seenPair = new Set<string>();
  for (const r of compositions) {
    const g = r["generic_sctid"] ?? "";
    const s = r["substance_sctid"] ?? "";
    // Rule 4 - an identifier that does not resolve is refused. A composition row pointing at a
    // generic or a moiety this import does not contain would leave a product with a PARTIAL
    // composition, which reads as complete and silently under-reports what a patient is taking.
    if (!plannedGenericSctids.has(g)) {
      throw new Error(`generic_compositions.csv: generic_sctid ${g} is in no generic row. Nothing was written.`);
    }
    if (!plannedSaltSctids.has(s)) {
      throw new Error(`generic_compositions.csv: substance_sctid ${s} is in no substance row. Nothing was written.`);
    }
    const key = `${g} ${s}`;
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

  const linked = new Set(saltPlans.filter((p) => p.kind === "link").map((p) => p.existingId));
  const unlinked = existingSalts
    .filter((s) => s.sctid === null && !linked.has(s.id))
    .map((s) => s.name)
    .sort();

  return {
    salts: saltPlans, generics: genericPlans, compositions: compositionPlans,
    unlinkedExistingSalts: unlinked, release,
  };
}

/**
 * Rule 1 - ONE TRANSACTION FOR THE WHOLE IMPORT. A failure part-way through 26,711 rows that left
 * the substances committed and the compositions not would produce moieties with no products and
 * products with partial composition, and the operator could not tell which half.
 */
export async function applyPlan(tx: Tx, plan: Plan, actor: string): Promise<void> {
  const saltIdBySctid = new Map<string, string>();

  for (const p of plan.salts) {
    if (p.kind === "link") {
      const id = p.existingId;
      if (id === undefined) throw new Error("internal: link plan with no existingId");
      await tx.update(formularySalts)
        .set({ sctid: p.sctid, updatedBy: actor, updatedAt: new Date() })
        .where(eq(formularySalts.id, id));
      saltIdBySctid.set(p.sctid, id);
    } else {
      const id = newId();
      await tx.insert(formularySalts).values({
        id, name: p.name, aliases: p.aliases, sctid: p.sctid, active: p.active,
        createdBy: actor, updatedBy: actor,
      });
      saltIdBySctid.set(p.sctid, id);
    }
  }
  // Salts already carrying a concept id before this run are still valid composition targets.
  const priorSalts = await tx.select({ id: formularySalts.id, sctid: formularySalts.sctid })
    .from(formularySalts);
  for (const s of priorSalts) if (s.sctid !== null) saltIdBySctid.set(s.sctid, s.id);

  const genericIdBySctid = new Map<string, string>();
  for (const g of plan.generics) {
    if (g.kind === "skip") continue;
    const id = newId();
    await tx.insert(formularyGenerics).values({
      id, sctid: g.sctid, name: g.name, doseForm: g.doseForm,
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
    const saltId = saltIdBySctid.get(c.substanceSctid);
    if (genericId === undefined || saltId === undefined) {
      throw new Error(
        `internal: composition (${c.genericSctid}, ${c.substanceSctid}) did not resolve after planning`,
      );
    }
    await tx.insert(formularyGenericSalts)
      .values({ genericId, saltId, strength: c.strength, unit: c.unit })
      .onConflictDoNothing();
  }
}

export function renderReport(plan: Plan, applied: boolean): string {
  const created = plan.salts.filter((p) => p.kind === "create").length;
  const linkedN = plan.salts.filter((p) => p.kind === "link").length;
  const newGenerics = plan.generics.filter((g) => g.kind === "create").length;
  const skipped = plan.generics.filter((g) => g.kind === "skip").length;
  const lines = [
    "",
    `NRCeS formulary import - release ${plan.release}`,
    applied ? "APPLIED" : "DRY RUN - nothing was written. Re-run with --apply to write.",
    "",
    `  moieties      ${String(created)} new, ${String(linkedN)} linked to an existing curator-named row`,
    `  generics      ${String(newGenerics)} new, ${String(skipped)} already present (skipped)`,
    `  compositions  ${String(plan.compositions.length)}`,
    "",
  ];
  if (plan.unlinkedExistingSalts.length > 0) {
    lines.push(
      `  ${String(plan.unlinkedExistingSalts.length)} EXISTING MOIETIES MATCHED NOTHING IN THIS RELEASE.`,
      "  They keep a null sctid. Each is a place a duplicate could later be created under a",
      "  different spelling, so they are named rather than counted:",
      ...plan.unlinkedExistingSalts.map((n) => `    - ${n}`),
      "",
    );
  }
  return lines.join("\n");
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
  const db: Db = createDb();
  const read = (f: string): string => readFileSync(`${dir}/${f}`, "utf8");

  const existingSalts = await db.select({
    id: formularySalts.id, name: formularySalts.name, sctid: formularySalts.sctid,
  }).from(formularySalts);
  const existingGenerics = await db.select({ sctid: formularyGenerics.sctid }).from(formularyGenerics);

  const plan = planImport(
    read("substances.csv"), read("generics.csv"), read("generic_compositions.csv"),
    existingSalts, new Set(existingGenerics.map((g) => g.sctid)), release,
  );

  if (!apply) {
    process.stdout.write(renderReport(plan, false));
    return;
  }
  await withTx(db, (tx) => applyPlan(tx, plan, actor));
  process.stdout.write(renderReport(plan, true));
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
