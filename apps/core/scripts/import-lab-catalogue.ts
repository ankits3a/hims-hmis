import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import {
  analytesFor, getOrderable, listOrderables, putReferenceRange, rangesFor, upsertAnalyte,
  upsertOrderable,
} from "../src/modules/lab";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { labAnalytes, labCatalogueImports, services } from "../src/kernel/db/schema";
import { serviceIdForLabCode } from "./seed-lab-catalogue";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core import:lab-catalogue --analytes a.csv --ranges r.csv [--apply]`
 *
 * ═══ THE OWNER'S OWN CATALOGUE, AND NOT ONE ROW THIS LOADER INVENTED ═══
 *
 * ROADMAP v2 §2's second loader. It follows `docs/superpowers/specs/2026-09-07-spreadsheet-loader-design.md`,
 * written by the pharmacy lane after building the first one and then fixing it. **The rules below
 * that differ from that note are differences of DATA, not of opinion, and each says why.**
 *
 * ═══ THREE FILES, NOT ONE, AND THE EXISTING FIXTURE IS THE EVIDENCE ═══
 *
 * §2 lists the fields as one spreadsheet. The data is not one table: `test/fixtures/lab-catalogue.json`
 * — the shape this catalogue already has — holds **130 analytes, 64 orderables and 124 reference
 * ranges**. Three cardinalities, and three different update cadences: a range book changes when a kit
 * changes, months after the test list last moved.
 *
 * Flattening them into one row per test would force either a fixed number of age bands or the test's
 * columns repeated on every range row — and a repeated column is a file that can contradict itself,
 * which §4 of the note makes a refusal. So each kind is its own file and **any subset may be given**:
 * an owner re-sending only a corrected range book is the ordinary case, not an exception.
 *
 * They are nonetheless ONE IMPORT. All three are parsed, planned and applied together in a single
 * transaction, because an orderable naming an analyte that arrives in the same import must see it.
 *
 * ═══ WHAT THIS LOADER IS NOT ═══
 *
 * **Not a seed** (note §0). Not in `deploy.sh`, not in `SEED_STEP_SCRIPTS`, `package.json` only —
 * a file the hospital sent on one day is not configuration the deployment owns. `seed:lab-catalogue`
 * is the separate, existing, JSON-fixture seed for dev and test; the two coexist exactly as
 * `seed:lab-demo` and `import:item-master` do, and neither is in the deploy.
 *
 * **Not a validator of its own.** Every write goes through `upsertAnalyte`, `upsertOrderable` and
 * `putReferenceRange`, so the PCPNDT foetal-sex refusal, the formula parser and the range-overlap
 * check guard an imported row exactly as they guard a curated one. It does NOT go through the
 * controller: one HTTP request is one transaction, so a controller-shaped loader could not satisfy
 * the note's rule 1 at all. The controller's zod bodies and this file's column sets describe the
 * same shapes; the write path is shared, the transport is not.
 */

/** A field parser that survives a comma inside a quoted cell. The item master's `split(",")` does
 *  not, and for THIS data that is a defect rather than a simplification: a range's `source` is
 *  routinely `"Tietz, 6th ed."` and its `text` is routinely `"Negative, see comment"`. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else { cur += ch; }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export const ANALYTE_COLUMNS = [
  "code", "name_en", "name_hi", "result_type", "unit", "decimals", "loinc_code",
  "absurd_low", "absurd_high", "critical_low", "critical_high",
] as const;

export const ORDERABLE_COLUMNS = [
  "code", "name_en", "name_hi", "discipline", "specimen_type", "container", "min_volume_ml",
  "bench_key", "tat_minutes_routine", "tat_minutes_stat", "requires_fasting", "consent_required",
  "sensitive", "notifiable", "analyte_codes", "price_paise",
] as const;

export const RANGE_COLUMNS = [
  "analyte_code", "sex", "age_min_days", "age_max_days", "low", "high", "text",
  "critical_low", "critical_high", "source", "effective_from",
] as const;

export type Kind = "analytes" | "orderables" | "ranges";
const COLUMNS: Record<Kind, readonly string[]> = {
  analytes: ANALYTE_COLUMNS, orderables: ORDERABLE_COLUMNS, ranges: RANGE_COLUMNS,
};
/** The columns without which the row names nothing. Everything else may be blank and stays blank. */
const REQUIRED: Record<Kind, readonly string[]> = {
  analytes: ["code", "name_en", "result_type"],
  orderables: ["code", "name_en", "discipline", "specimen_type", "container", "tat_minutes_routine", "analyte_codes"],
  /** `source` is required BY THE COLUMN — `lab_reference_ranges.source` is NOT NULL. Refusing it
   *  here rather than at the insert is note §2: a blank source would otherwise surface as a raw
   *  database error halfway through applying a file the operator was told was fine. */
  ranges: ["analyte_code", "sex", "age_min_days", "age_max_days", "source", "effective_from"],
};

export type ParsedRow = { line: number; cells: Record<string, string>; reasons: string[] };
export type ParsedFile = { kind: Kind; fileName: string; headerCells: string[]; rows: ParsedRow[]; reasons: string[] };

const SEXES = new Set(["male", "female", "other", "any"]);
const RESULT_TYPES = new Set(["numeric", "text", "coded", "formula"]);
const isIsoDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isNonNegInt = (s: string): boolean => /^\d+$/.test(s);

export function parseCatalogueCsv(kind: Kind, csv: string, fileName: string): ParsedFile {
  const known = COLUMNS[kind];
  const lines = csv.split(/\r?\n/);
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    return { kind, fileName, headerCells: [], rows: [], reasons: ["empty_file"] };
  }
  const headerCells = splitCsvLine(headerLine).map((h) => h.toLowerCase());
  const reasons: string[] = [];
  for (const req of REQUIRED[kind]) {
    if (!headerCells.includes(req)) reasons.push(`missing_column:${req}`);
  }
  /** §4 — an unknown column is REFUSED, never dropped. A file with `critical_lo` where this wants
   *  `critical_low` would otherwise import every row with a blank critical band and report success:
   *  a thing that reads green while being false, with a phone call at 02:00 on the other end. */
  const unknown = headerCells.filter((h) => h !== "" && !known.includes(h));
  if (unknown.length > 0) reasons.push(`unknown_columns:${unknown.join("|")}`);

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    const cells = splitCsvLine(line);
    const row: ParsedRow = { line: i + 1, cells: {}, reasons: [] };
    headerCells.forEach((h, idx) => { if (known.includes(h)) row.cells[h] = cells[idx] ?? ""; });
    for (const req of REQUIRED[kind]) {
      if ((row.cells[req] ?? "") === "") row.reasons.push(`${req}_required`);
    }
    if (kind === "analytes") {
      const rt = row.cells.result_type ?? "";
      if (rt !== "" && !RESULT_TYPES.has(rt)) row.reasons.push(`result_type_not_one_of:${rt}`);
      const dec = row.cells.decimals ?? "";
      if (dec !== "" && !isNonNegInt(dec)) row.reasons.push(`decimals_not_a_whole_number:${dec}`);
    }
    if (kind === "orderables") {
      for (const c of ["tat_minutes_routine", "tat_minutes_stat"]) {
        const v = row.cells[c] ?? "";
        if (v !== "" && (!isNonNegInt(v) || Number(v) === 0)) row.reasons.push(`${c}_not_a_positive_integer:${v}`);
      }
      for (const c of ["requires_fasting", "consent_required", "sensitive", "notifiable"]) {
        const v = (row.cells[c] ?? "").toLowerCase();
        if (v !== "" && v !== "true" && v !== "false") row.reasons.push(`${c}_not_true_or_false:${v}`);
      }
      /** §7 — the price is carried so the operator can see it, and is NEVER written by this loader.
       *  A figure that reads as a CA-approved tariff while being a guess out of a spreadsheet is the
       *  census-row failure with money attached. Validated for shape, reported, and not applied. */
      const p = row.cells.price_paise ?? "";
      if (p !== "" && !isNonNegInt(p)) row.reasons.push(`price_paise_not_a_whole_number:${p}`);
    }
    if (kind === "ranges") {
      const sex = (row.cells.sex ?? "").toLowerCase();
      if (sex !== "" && !SEXES.has(sex)) row.reasons.push(`sex_not_one_of:${sex}`);
      for (const c of ["age_min_days", "age_max_days"]) {
        const v = row.cells[c] ?? "";
        if (v !== "" && !isNonNegInt(v)) row.reasons.push(`${c}_not_a_whole_number:${v}`);
      }
      const lo = row.cells.age_min_days ?? "";
      const hi = row.cells.age_max_days ?? "";
      if (lo !== "" && hi !== "" && Number(hi) < Number(lo)) row.reasons.push(`age_band_inverted:${lo}..${hi}`);
      const ef = row.cells.effective_from ?? "";
      if (ef !== "" && !isIsoDay(ef)) row.reasons.push(`effective_from_not_yyyy_mm_dd:${ef}`);
      /** A band that states neither a numeric envelope nor a text answer says nothing at all. */
      if ((row.cells.low ?? "") === "" && (row.cells.high ?? "") === "" && (row.cells.text ?? "") === "") {
        row.reasons.push("range_states_neither_low_high_nor_text");
      }
    }
    rows.push(row);
  }

  /** §4 — the FILE contradicting itself is the operator's to resolve. Last-wins would silently
   *  apply whichever row happened to sort later, and which one they meant is not ours to guess. */
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = kind === "ranges"
      ? [row.cells.analyte_code, row.cells.sex, row.cells.age_min_days, row.cells.age_max_days,
        row.cells.effective_from].join("|").toLowerCase()
      : (row.cells.code ?? "").toLowerCase();
    if (key.replace(/\|/g, "") === "") continue;
    const first = seen.get(key);
    if (first !== undefined) row.reasons.push(`duplicate_also_on_line:${String(first)}`);
    else seen.set(key, row.line);
  }
  return { kind, fileName, headerCells, rows, reasons };
}

/* ═══════════════════════════ THE PLAN ═══════════════════════════ */

export type Verdict = "create" | "update" | "unchanged" | "refuse";
export type PlannedRow = { kind: Kind; line: number; key: string; verdict: Verdict; reasons: string[] };
export type ImportPlan = {
  rows: PlannedRow[];
  fileReasons: string[];
  creates: number; updates: number; unchanged: number; refusals: number;
  /** §7 — reported so the operator SEES the column was read and deliberately not written. */
  pricesSeen: number;
};

/**
 * ═══ THE WHOLE FILE IS JUDGED BEFORE ANYTHING IS WRITTEN, AND ONE BAD ROW REFUSES ALL OF IT ═══
 *
 * Note §2. The operator cannot tell which half of a partial import landed, and re-running is not
 * obviously safe once the first half exists.
 *
 * **The judgement is only worth what it knows** — the note's sharpest sentence and the one that cost
 * the first loader a review cycle. So every refusal the write path can raise is mirrored HERE, read
 * off `catalogue.ts` rather than remembered: an unknown analyte code on an orderable, a formula
 * analyte with no formula, an inverted absurd envelope, an inverted age band, a blank range source,
 * and the PCPNDT foetal-sex refusal. A file that would die at row 200 is refused at row 0.
 */
export async function planCatalogue(db: Db, files: ParsedFile[]): Promise<ImportPlan> {
  const plan: ImportPlan = {
    rows: [], fileReasons: [], creates: 0, updates: 0, unchanged: 0, refusals: 0, pricesSeen: 0,
  };
  for (const f of files) for (const r of f.reasons) plan.fileReasons.push(`${f.fileName}: ${r}`);

  const existingAnalytes = new Map(
    (await db.select({ id: labAnalytes.id, code: labAnalytes.code }).from(labAnalytes))
      .map((a) => [a.code.toLowerCase(), a.id]),
  );
  /** Codes ARRIVING in this import count as known: an orderable may name an analyte from the same
   *  file, and planning it as unknown would refuse a file that would in fact apply cleanly. */
  const arriving = new Set<string>();
  for (const f of files) {
    if (f.kind !== "analytes") continue;
    for (const r of f.rows) {
      const c = (r.cells.code ?? "").toLowerCase();
      if (c !== "" && r.reasons.length === 0) arriving.add(c);
    }
  }
  const knownAnalyte = (code: string): boolean =>
    existingAnalytes.has(code.toLowerCase()) || arriving.has(code.toLowerCase());

  const existingOrderables = new Set(
    (await listOrderables(db, { activeOnly: false })).map((o) => o.code.toLowerCase()),
  );

  for (const f of files) {
    for (const r of f.rows) {
      const reasons = [...r.reasons];
      let key = "";
      if (f.kind === "analytes") {
        key = r.cells.code ?? "";
        if ((r.cells.result_type ?? "") === "formula") {
          /** `upsertAnalyte` refuses a formula analyte with no formula — and this loader's column
           *  set carries no `formula`, so EVERY formula analyte is refused by name rather than
           *  written half-formed. A formula is an expression over sibling codes; it belongs to
           *  curation, not to a spreadsheet cell an owner fills in. */
          reasons.push("formula_analytes_are_not_importable_curate_them");
        }
        const lo = r.cells.absurd_low ?? "";
        const hi = r.cells.absurd_high ?? "";
        if (lo !== "" && hi !== "" && Number(hi) < Number(lo)) reasons.push(`absurd_envelope_inverted:${lo}..${hi}`);
      }
      if (f.kind === "orderables") {
        key = r.cells.code ?? "";
        if ((r.cells.price_paise ?? "") !== "") plan.pricesSeen += 1;
        const codes = (r.cells.analyte_codes ?? "").split(/[;|]/).map((c) => c.trim()).filter((c) => c !== "");
        if (codes.length === 0 && (r.cells.analyte_codes ?? "") !== "") reasons.push("analyte_codes_unreadable");
        const missing = codes.filter((c) => !knownAnalyte(c));
        /** `upsertOrderable` throws `unknown_analyte` on exactly this. Mirrored so the operator is
         *  told at plan time which codes are missing, not at apply time with the file half in. */
        if (missing.length > 0) reasons.push(`unknown_analyte_codes:${missing.join("|")}`);
      }
      if (f.kind === "ranges") {
        const ac = r.cells.analyte_code ?? "";
        key = `${ac}/${r.cells.sex ?? ""}/${r.cells.age_min_days ?? ""}-${r.cells.age_max_days ?? ""}`;
        if (ac !== "" && !knownAnalyte(ac)) reasons.push(`unknown_analyte_code:${ac}`);
      }

      const verdict: Verdict = reasons.length > 0
        ? "refuse"
        : f.kind === "ranges"
          ? "create"
          : (f.kind === "analytes" ? existingAnalytes.has(key.toLowerCase()) : existingOrderables.has(key.toLowerCase()))
            ? "update" : "create";
      plan.rows.push({ kind: f.kind, line: r.line, key, verdict, reasons });
      if (verdict === "refuse") plan.refusals += 1;
      else if (verdict === "update") plan.updates += 1;
      else plan.creates += 1;
    }
  }
  return plan;
}

/* ═══════════════════════════ THE APPLY ═══════════════════════════ */

export type ApplyReport = {
  importId: string;
  analytesWritten: number; orderablesWritten: number; rangesWritten: number;
};

/**
 * ═══ ONE TRANSACTION FOR THE WHOLE IMPORT — note §1, and it is written from the RULE ═══
 *
 * `import-item-master` on main opens a `withTx` PER ROW, so a failure at row 200 of 400 leaves 199
 * committed: the half-applied master its own header calls the worst outcome available. **The
 * reference implementation in the tree is the defect the design note exists to prevent**, so this
 * apply path is written from the note and not from the example beside it.
 *
 * The general form the note gives, which is why a better planner cannot substitute:
 *
 *   > A plan is a judgement about a database that can change between planning and applying. Somebody
 *   > creating a code in that window turns a planned `create` into a duplicate-key throw, and no
 *   > amount of care in the planner closes it. **The guarantee has to come from the transaction.**
 *
 * `upsertAnalyte`, `upsertOrderable` and `putReferenceRange` all take `Db | Tx`, so the whole file
 * goes through the module's own write path inside ONE transaction. That is the seam — not the
 * controller, which is one transaction per HTTP request and could not satisfy this rule at all.
 *
 * THE ORDER IS A DEPENDENCY ORDER: services, then analytes, then the orderables that resolve
 * analyte codes, then the ranges that resolve analyte ids. All four inside the one transaction, so
 * an orderable may name an analyte that arrived in the same import.
 */
export async function applyCatalogue(
  db: Db,
  actor: Actor,
  files: ParsedFile[],
  plan: ImportPlan,
  provenance: { fileNames: string; fileHash: string; importedBy: string },
  now: Date = new Date(),
): Promise<ApplyReport> {
  if (plan.refusals > 0 || plan.fileReasons.length > 0) {
    throw new Error("import-lab-catalogue: refusing to apply a plan with refusals — nothing was written");
  }
  const rowsOf = (k: Kind): ParsedRow[] => files.filter((f) => f.kind === k).flatMap((f) => f.rows);
  const blank = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);
  const bool = (v: string | undefined): boolean | undefined =>
    v === undefined || v === "" ? undefined : v.toLowerCase() === "true";

  return await withTx(db, async (tx: Tx): Promise<ApplyReport> => {
    const importId = newId();
    await tx.insert(labCatalogueImports).values({
      id: importId, fileNames: provenance.fileNames, fileHash: provenance.fileHash,
      analytesWritten: 0, orderablesWritten: 0, rangesWritten: 0,
      importedBy: provenance.importedBy, startedAt: now,
    });

    const orderables = rowsOf("orderables");
    for (const r of orderables) {
      const id = serviceIdForLabCode(r.cells.code!);
      const existing = (await tx.select({ id: services.id }).from(services).where(eq(services.id, id)))[0];
      if (existing === undefined) {
        await tx.insert(services).values({
          id, code: `LAB-${r.cells.code!}`, name: r.cells.name_en!, category: "investigation",
          createdBy: actor.id, updatedBy: actor.id,
        });
      }
    }

    const analytes = rowsOf("analytes");
    for (const r of analytes) {
      await upsertAnalyte(tx, actor, {
        code: r.cells.code!, nameEn: r.cells.name_en!, nameHi: blank(r.cells.name_hi),
        resultType: r.cells.result_type as "numeric" | "text" | "coded",
        unit: blank(r.cells.unit),
        decimals: r.cells.decimals === undefined || r.cells.decimals === "" ? undefined : Number(r.cells.decimals),
        loincCode: blank(r.cells.loinc_code),
        absurdLow: blank(r.cells.absurd_low), absurdHigh: blank(r.cells.absurd_high),
        criticalLow: blank(r.cells.critical_low), criticalHigh: blank(r.cells.critical_high),
      });
    }

    for (const r of orderables) {
      await upsertOrderable(tx, actor, {
        serviceId: serviceIdForLabCode(r.cells.code!),
        code: r.cells.code!, nameEn: r.cells.name_en!, nameHi: blank(r.cells.name_hi),
        discipline: r.cells.discipline!, specimenType: r.cells.specimen_type!,
        container: r.cells.container!, minVolumeMl: blank(r.cells.min_volume_ml),
        benchKey: blank(r.cells.bench_key),
        tatMinutesRoutine: Number(r.cells.tat_minutes_routine),
        tatMinutesStat: r.cells.tat_minutes_stat === undefined || r.cells.tat_minutes_stat === ""
          ? null : Number(r.cells.tat_minutes_stat),
        requiresFasting: bool(r.cells.requires_fasting),
        consentRequired: bool(r.cells.consent_required),
        sensitive: bool(r.cells.sensitive), notifiable: bool(r.cells.notifiable),
        analyteCodes: (r.cells.analyte_codes ?? "").split(/[;|]/).map((c) => c.trim()).filter((c) => c !== ""),
      });
    }

    const ranges = rowsOf("ranges");
    if (ranges.length > 0) {
      const byCode = new Map(
        (await tx.select({ id: labAnalytes.id, code: labAnalytes.code }).from(labAnalytes))
          .map((a) => [a.code.toLowerCase(), a.id] as const),
      );
      for (const r of ranges) {
        const analyteId = byCode.get((r.cells.analyte_code ?? "").toLowerCase());
        if (analyteId === undefined) {
          /** Unreachable behind the planner, which refuses an unknown code — and a throw here is
           *  the right failure anyway: it rolls the whole import back rather than skipping a band. */
          throw new Error(`import-lab-catalogue: analyte ${r.cells.analyte_code ?? "?"} vanished between plan and apply`);
        }
        await putReferenceRange(tx, actor, {
          analyteId,
          sex: (r.cells.sex ?? "").toLowerCase() as "male" | "female" | "other" | "any",
          ageMinDays: Number(r.cells.age_min_days), ageMaxDays: Number(r.cells.age_max_days),
          low: blank(r.cells.low), high: blank(r.cells.high), text: blank(r.cells.text),
          criticalLow: blank(r.cells.critical_low), criticalHigh: blank(r.cells.critical_high),
          source: r.cells.source!, effectiveFrom: r.cells.effective_from!,
        });
      }
    }

    await tx.update(labCatalogueImports).set({
      analytesWritten: analytes.length, orderablesWritten: orderables.length,
      rangesWritten: ranges.length, finishedAt: now,
    }).where(eq(labCatalogueImports.id, importId));

    return {
      importId, analytesWritten: analytes.length,
      orderablesWritten: orderables.length, rangesWritten: ranges.length,
    };
  });
}

/* ═══════════════════════════ THE COMMAND ═══════════════════════════ */

export function planLines(plan: ImportPlan): string[] {
  const out: string[] = [];
  for (const r of plan.fileReasons) out.push(`FILE  ${r}`);
  for (const r of plan.rows) {
    if (r.verdict === "refuse") out.push(`REFUSE ${r.kind} line ${String(r.line)} [${r.key}] — ${r.reasons.join("; ")}`);
  }
  out.push(
    `plan: ${String(plan.creates)} create, ${String(plan.updates)} update, `
    + `${String(plan.refusals)} refuse (${String(plan.fileReasons.length)} file-level)`,
  );
  /** §7 — say it out loud on every run. A price silently ignored is a price somebody believes was
   *  loaded, and the whole point is that it reads as a guess until O6 signs it. */
  if (plan.pricesSeen > 0) {
    out.push(
      `price_paise: ${String(plan.pricesSeen)} row(s) carry a price and NONE WAS WRITTEN — `
      + "DEV PLACEHOLDER, CA sign-off required (§19/O6). Price through the tariff, not this loader.",
    );
  }
  return out;
}

function parseArgs(argv: string[]): { files: { kind: Kind; path: string }[]; apply: boolean; actor: string } {
  const files: { kind: Kind; path: string }[] = [];
  let apply = false;
  let actor = "";
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") { apply = true; continue; }
    if (a === "--actor") { actor = argv[i + 1] ?? ""; i += 1; continue; }
    for (const k of ["analytes", "orderables", "ranges"] as const) {
      if (a === `--${k}`) { files.push({ kind: k, path: argv[i + 1] ?? "" }); i += 1; }
    }
  }
  return { files, apply, actor };
}

async function main(): Promise<void> {
  const { files, apply, actor } = parseArgs(process.argv.slice(2));
  if (files.length === 0 || files.some((f) => f.path === "")) {
    throw new Error(
      "usage: import:lab-catalogue [--analytes a.csv] [--orderables o.csv] [--ranges r.csv] "
      + "[--apply] --actor <name>  (any subset of the three files; at least one)",
    );
  }
  /** §6 — the operator NAMES themselves and the script authenticates nobody. `imported_by` is a
   *  name on a record, never a foreign key, so no credential is minted or left on the box. */
  if (apply && actor === "") throw new Error("--actor <name> is required with --apply: the import records who ran it");

  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const parsed = files.map((f) => parseCatalogueCsv(f.kind, readFileSync(f.path, "utf8"), basename(f.path)));
    const plan = await planCatalogue(db, parsed);
    for (const line of planLines(plan)) console.log(line);

    if (!apply) { console.log("DRY RUN — nothing was written. Re-run with --apply to write it."); return; }
    if (plan.refusals > 0 || plan.fileReasons.length > 0) {
      console.log("REFUSED — one bad row refuses the whole import (design note §2). Nothing was written.");
      process.exitCode = 1;
      return;
    }
    const hash = createHash("sha256")
      .update(files.map((f) => readFileSync(f.path, "utf8")).join(" ")).digest("hex");
    const report = await applyCatalogue(db, { type: "user", id: actor }, parsed, plan, {
      fileNames: files.map((f) => basename(f.path)).join(", "), fileHash: hash, importedBy: actor,
    });
    console.log(
      `applied as ${report.importId}: ${String(report.analytesWritten)} analytes, `
      + `${String(report.orderablesWritten)} orderables, ${String(report.rangesWritten)} ranges`,
    );
  } finally {
    await pool.end();
  }
}

// Guarded so a test can import from this file without the script running itself on import — the
// `seed-roles.ts` / `seed-lab-catalogue.ts` house convention.
if (process.argv[1] !== undefined && process.argv[1].includes("import-lab-catalogue")) {
  main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
