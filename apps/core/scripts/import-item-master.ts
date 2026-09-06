import { readFileSync } from "node:fs";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { listMedicines } from "../src/modules/formulary";
import { addItemUom, getItem, listItems, registerItem, updateItem } from "../src/modules/materials";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core import:item-master -- --file ./items.csv [--apply]`
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `pharmacy-go-live.md` §2 is the chief pharmacist's week: every medicine the counter sells needs a
 * drug ITEM with its pack unit, its HSN and its GST slab, and **no screen in the application can
 * write two of those three.** `/materials/items` collects neither `gst_rate_bps` nor `hsnCode` — the
 * only writer is `PATCH /materials/items/:id`, one item at a time. A four-hundred-line item master
 * entered that way is a fortnight of typing and a fortnight of typos.
 *
 * This takes the hospital's own file and makes those weeks into an afternoon.
 *
 * ═══ IT NEVER INVENTS A VALUE — AND THE GST COLUMN IS WHY THAT MATTERS MOST ═══
 *
 * A blank cell is BLANK, not zero and not a default. `gst_rate_bps` in particular: a blank leaves the
 * item's slab null, which `gstCategoryFor` maps to `pharmacy_exempt`, which bills the patient exactly
 * the printed MRP. **A loader that helpfully defaulted a blank to 1200 would make the counter charge
 * 12% ABOVE the printed MRP on every line it touched**, because `pricing.ts` adds GST on top of a
 * base that IS the tax-inclusive MRP. The blanks are COUNTED and REPORTED rather than filled.
 *
 * ═══ DRY RUN BY DEFAULT, AND THE WHOLE FILE IS JUDGED BEFORE ANYTHING IS WRITTEN ═══
 *
 * Without `--apply` it writes nothing and prints what it would do. With `--apply` it still refuses
 * the ENTIRE import if any row is bad, because a half-applied item master is the worst outcome
 * available here: the operator cannot tell which half, and re-running is not obviously safe when the
 * first half already exists. Every row is planned against the database first, then applied together.
 *
 * ═══ IT IS AN OPERATOR COMMAND AND IT IS DELIBERATELY NOT IN `deploy.sh` ═══
 *
 * The `import:holder-book` precedent (Plan 09 T5): a seed is configuration the deployment owns and
 * re-running it changes nothing; a file the hospital sent on one day is not that, and a deploy that
 * imported one would be importing data nobody asked it for.
 *
 * ═══ COLUMNS ═══
 *
 *   code             REQUIRED  the item code, e.g. CROC500. Case-insensitively unique.
 *   name             REQUIRED  what it is called on the shelf.
 *   base_uom         REQUIRED on create; on an EXISTING item it must MATCH — `base_uom` is
 *                    deliberately not patchable (items.ts:202: changing it reinterprets every
 *                    qty_base already in the ledger), so a mismatch is refused rather than ignored.
 *   pack_uom         optional  e.g. strip. Needs pack_multiplier.
 *   pack_multiplier  optional  how many base units in one pack, e.g. 10.
 *   hsn_code         optional  blank leaves it unset.
 *   gst_rate_bps     optional  0 / 500 / 1200 / 1800. BLANK IS NOT ZERO — see above.
 *   shelf_life_days  optional  used by the GRN's near-expiry rule.
 *   medicine_brand   REQUIRED to create; links the item to a formulary medicine BY EXACT BRAND NAME.
 *                    DD3: a drug-class item must name the medicine it stocks, because composition,
 *                    salts and the schedule flag live there and are never copied onto the item. A
 *                    brand that does not resolve REFUSES the row — silently leaving it unlinked
 *                    would produce an item the counter cannot sell, which looks fine in a list.
 *                    This also enforces the runbook's order: §2.1 (classify the medicines) before
 *                    §2.2 (create the items).
 */

const COLUMNS = [
  "code", "name", "base_uom", "pack_uom", "pack_multiplier",
  "hsn_code", "gst_rate_bps", "shelf_life_days", "medicine_brand",
] as const;
type Column = (typeof COLUMNS)[number];

/** The four medicine slabs `gstCategoryFor` knows. Anything else has no `pharmacy*` category. */
const SLABS = new Set([0, 500, 1200, 1800]);

export type ParsedRow = {
  /** 1-indexed and matching what a text editor shows: the header is line 1. */
  line: number;
  cells: Partial<Record<Column, string>>;
  reasons: string[];
};

export type ParsedFile = { headerCells: string[]; rows: ParsedRow[]; reasons: string[] };

export function parseItemMaster(csv: string): ParsedFile {
  const lines = csv.split(/\r?\n/);
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    return { headerCells: [], rows: [], reasons: ["empty_file"] };
  }
  const headerCells = headerLine.split(",").map((h) => h.trim().toLowerCase());
  const reasons: string[] = [];
  for (const required of ["code", "name"] as const) {
    if (!headerCells.includes(required)) reasons.push(`missing_column:${required}`);
  }
  const unknown = headerCells.filter((h) => h !== "" && !(COLUMNS as readonly string[]).includes(h));
  /* An unknown column is REFUSED rather than ignored. A file with `gst_rate` where the loader wants
     `gst_rate_bps` would otherwise import every row with a blank slab and report complete success —
     the operator's whole tax column silently dropped, discovered at the counter. */
  if (unknown.length > 0) reasons.push(`unknown_columns:${unknown.join("|")}`);

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    const cells = line.split(",").map((c) => c.trim());
    const row: ParsedRow = { line: i + 1, cells: {}, reasons: [] };
    headerCells.forEach((h, idx) => {
      if ((COLUMNS as readonly string[]).includes(h)) row.cells[h as Column] = cells[idx] ?? "";
    });
    if ((row.cells.code ?? "") === "") row.reasons.push("code_required");
    if ((row.cells.name ?? "") === "") row.reasons.push("name_required");

    const slab = row.cells.gst_rate_bps ?? "";
    if (slab !== "" && !SLABS.has(Number(slab))) row.reasons.push(`gst_rate_bps_not_a_slab:${slab}`);
    const mult = row.cells.pack_multiplier ?? "";
    if (mult !== "" && (!Number.isInteger(Number(mult)) || Number(mult) < 1)) {
      row.reasons.push(`pack_multiplier_not_a_positive_integer:${mult}`);
    }
    if (mult !== "" && (row.cells.pack_uom ?? "") === "") row.reasons.push("pack_multiplier_without_pack_uom");
    if ((row.cells.pack_uom ?? "") !== "" && mult === "") row.reasons.push("pack_uom_without_pack_multiplier");
    const shelf = row.cells.shelf_life_days ?? "";
    if (shelf !== "" && (!Number.isInteger(Number(shelf)) || Number(shelf) < 1)) {
      row.reasons.push(`shelf_life_days_not_a_positive_integer:${shelf}`);
    }
    rows.push(row);
  }
  const seen = new Map<string, number>();
  for (const row of rows) {
    const code = (row.cells.code ?? "").toLowerCase();
    if (code === "") continue;
    const first = seen.get(code);
    /* The FILE contradicting itself is the operator's to fix, not the loader's to pick a winner
       from — last-wins would silently apply whichever row happened to sort later. */
    if (first !== undefined) row.reasons.push(`duplicate_code_also_on_line:${String(first)}`);
    else seen.set(code, row.line);
  }
  return { headerCells, rows, reasons };
}

export type PlannedRow = {
  line: number; code: string;
  verdict: "create" | "update" | "unchanged" | "refuse";
  changes: string[];
  reasons: string[];
  itemId?: string;
  medicineId?: string | null;
  blankGst: boolean;
};

export type ImportPlan = { rows: PlannedRow[]; refusals: number; creates: number; updates: number; unchanged: number; blankGst: number; nonZeroGst: number };

export async function planItemMaster(db: Db, parsed: ParsedFile): Promise<ImportPlan> {
  const existing = new Map((await listItems(db, {})).map((i) => [i.code.toLowerCase(), i]));
  const medicines = new Map((await listMedicines(db)).map((m) => [m.brandName.toLowerCase(), m.id]));
  const rows: PlannedRow[] = [];

  for (const row of parsed.rows) {
    const code = row.cells.code ?? "";
    const planned: PlannedRow = {
      line: row.line, code, verdict: "refuse", changes: [], reasons: [...row.reasons],
      blankGst: (row.cells.gst_rate_bps ?? "") === "",
    };

    const brand = row.cells.medicine_brand ?? "";
    if (brand !== "") {
      const id = medicines.get(brand.toLowerCase());
      if (id === undefined) planned.reasons.push(`unknown_medicine_brand:${brand}`);
      else planned.medicineId = id;
    }

    const found = existing.get(code.toLowerCase());
    if (found === undefined) {
      if ((row.cells.base_uom ?? "") === "") planned.reasons.push("base_uom_required_to_create");
      /**
       * DD3 — `registerItem` REFUSES a drug-class item that names no formulary medicine:
       * "composition, salts and the schedule flag live there and are never copied onto the item".
       * So `medicine_brand` is REQUIRED to create, and it is refused HERE, at plan time, with the
       * brand named — rather than surfacing at apply time as a raw MaterialsError halfway through a
       * file. Judging the whole file before touching the database is only worth anything if the
       * judgement knows every rule the write path will apply.
       *
       * It also enforces the runbook's ordering: §2.1 classifies the medicines, §2.2 creates the
       * items. A file whose brands do not resolve is a file that arrived before the formulary did.
       */
      if (planned.medicineId === undefined && brand === "") {
        planned.reasons.push("medicine_brand_required_to_create_a_drug_item");
      }
      if (planned.reasons.length === 0) { planned.verdict = "create"; planned.changes.push("register"); }
    } else {
      planned.itemId = found.id;
      const wantBase = row.cells.base_uom ?? "";
      /* `base_uom` is not patchable (items.ts:202). Refusing is the honest answer: applying the rest
         of the row would leave the operator believing the file was imported as written. */
      if (wantBase !== "" && wantBase !== found.baseUom) {
        planned.reasons.push(`base_uom_immutable:file=${wantBase} db=${found.baseUom}`);
      }
      if ((row.cells.name ?? "") !== found.name) planned.changes.push("name");
      const hsn = row.cells.hsn_code ?? "";
      if (hsn !== "" && hsn !== (found.hsnCode ?? "")) planned.changes.push("hsnCode");
      const slab = row.cells.gst_rate_bps ?? "";
      if (slab !== "" && Number(slab) !== found.gstRateBps) planned.changes.push("gstRateBps");
      const shelf = row.cells.shelf_life_days ?? "";
      if (shelf !== "" && Number(shelf) !== found.shelfLifeDays) planned.changes.push("shelfLifeDays");
      if (planned.medicineId !== undefined && planned.medicineId !== found.formularyMedicineId) {
        planned.changes.push("formularyMedicineId");
      }
      if (planned.reasons.length === 0) planned.verdict = planned.changes.length > 0 ? "update" : "unchanged";
    }
    rows.push(planned);
  }

  return {
    rows,
    refusals: rows.filter((r) => r.verdict === "refuse").length,
    creates: rows.filter((r) => r.verdict === "create").length,
    updates: rows.filter((r) => r.verdict === "update").length,
    unchanged: rows.filter((r) => r.verdict === "unchanged").length,
    blankGst: rows.filter((r) => r.blankGst).length,
    nonZeroGst: parsed.rows.filter((r) => { const s = r.cells.gst_rate_bps ?? ""; return s !== "" && Number(s) > 0; }).length,
  };
}

/**
 * Applies a plan that has already been judged clean. It re-checks `refusals === 0` rather than
 * trusting its caller: this is the last gate before a production item master is written.
 */
export async function applyItemMaster(
  db: Db, actor: Actor, parsed: ParsedFile, plan: ImportPlan,
): Promise<{ created: number; updated: number }> {
  if (plan.refusals > 0) throw new Error(`refusing to apply: ${String(plan.refusals)} row(s) were refused`);
  const byLine = new Map(parsed.rows.map((r) => [r.line, r]));
  let created = 0;
  let updated = 0;

  for (const planned of plan.rows) {
    const row = byLine.get(planned.line);
    if (row === undefined) continue;
    const num = (v: string | undefined): number | undefined => (v === undefined || v === "" ? undefined : Number(v));

    if (planned.verdict === "create") {
      const packUom = row.cells.pack_uom ?? "";
      const mult = num(row.cells.pack_multiplier);
      await withTx(db, (tx: Tx) => registerItem(tx, actor, {
        code: planned.code, name: row.cells.name ?? "", class: "drug",
        baseUom: row.cells.base_uom ?? "", batchTracked: true,
        formularyMedicineId: planned.medicineId ?? null,
        hsnCode: (row.cells.hsn_code ?? "") === "" ? null : row.cells.hsn_code,
        /* undefined, not null — `registerItem` distinguishes "not supplied" from "explicitly none",
           and a blank cell means the operator's file said nothing about the slab. */
        gstRateBps: num(row.cells.gst_rate_bps) ?? null,
        shelfLifeDays: num(row.cells.shelf_life_days) ?? null,
        uoms: packUom !== "" && mult !== undefined
          ? [{ uom: packUom, toBaseMultiplier: mult, isPurchaseUom: true, isIssueUom: true }]
          : [],
      }));
      created += 1;
    } else if (planned.verdict === "update") {
      const itemId = planned.itemId;
      if (itemId === undefined) continue;
      await withTx(db, async (tx: Tx) => {
        await updateItem(tx, actor, itemId, {
          ...(planned.changes.includes("name") ? { name: row.cells.name } : {}),
          ...(planned.changes.includes("hsnCode") ? { hsnCode: row.cells.hsn_code } : {}),
          ...(planned.changes.includes("gstRateBps") ? { gstRateBps: num(row.cells.gst_rate_bps) } : {}),
          ...(planned.changes.includes("shelfLifeDays") ? { shelfLifeDays: num(row.cells.shelf_life_days) } : {}),
          ...(planned.changes.includes("formularyMedicineId") ? { formularyMedicineId: planned.medicineId } : {}),
        });
        const packUom = row.cells.pack_uom ?? "";
        const mult = num(row.cells.pack_multiplier);
        if (packUom !== "" && mult !== undefined) {
          const item = await getItem(tx, itemId);
          if (!(item?.uoms ?? []).some((u) => u.uom === packUom)) {
            await addItemUom(tx, actor, itemId, { uom: packUom, toBaseMultiplier: mult });
          }
        }
      });
      updated += 1;
    }
  }
  return { created, updated };
}

function parseArgs(argv: string[]): { file: string; apply: boolean; actor: string } {
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = read("--file");
  if (file === undefined || file === "") {
    throw new Error("usage: import:item-master -- --file <path.csv> [--apply] [--actor <name>]");
  }
  return { file, apply: argv.includes("--apply"), actor: read("--actor") ?? "import-item-master" };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const actor: Actor = { type: "user", id: args.actor };
  const parsed = parseItemMaster(readFileSync(args.file, "utf8"));
  if (parsed.reasons.length > 0) throw new Error(`the file cannot be read: ${parsed.reasons.join(", ")}`);

  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const plan = await planItemMaster(db, parsed);
    for (const row of plan.rows) {
      const detail = row.verdict === "refuse" ? row.reasons.join("; ") : row.changes.join(",");
      process.stdout.write(`  line ${String(row.line)}  ${row.verdict.padEnd(9)} ${row.code.padEnd(14)} ${detail}\n`);
    }
    process.stdout.write(
      `\n  create ${String(plan.creates)} · update ${String(plan.updates)} · unchanged ${String(plan.unchanged)} · REFUSE ${String(plan.refusals)}\n`,
    );
    /* SAID EVERY TIME, not only when it is news. A blank slab bills the printed MRP, which is
       correct today — but the operator should learn it from the loader rather than from a bill. */
    process.stdout.write(
      `  ${String(plan.blankGst)} row(s) leave gst_rate_bps BLANK -> pharmacy_exempt -> the patient is billed exactly the printed MRP.\n`,
    );
    if (plan.nonZeroGst > 0) {
      process.stdout.write(
        `\n  WARNING: ${String(plan.nonZeroGst)} row(s) carry a NON-ZERO GST slab.\n` +
          "  Pricing ADDS GST on top of the batch MRP, and an Indian medicine MRP is tax-inclusive by\n" +
          "  statute — so a non-zero slab makes the counter bill ABOVE the printed MRP. The treatment\n" +
          "  question is an open owner ruling; see docs/runbooks/pharmacy-go-live.md §1.9 and §2.2.\n",
    );
    }
    if (plan.refusals > 0) {
      process.stdout.write(`\n  NOTHING WAS WRITTEN. Fix the refused rows and run again — the whole file is applied or none of it.\n`);
      process.exitCode = 1;
      return;
    }
    if (!args.apply) {
      process.stdout.write(`\n  DRY RUN. Nothing was written. Re-run with --apply to write it.\n`);
      return;
    }
    const done = await applyItemMaster(db, actor, parsed, plan);
    process.stdout.write(`\n  applied: ${String(done.created)} created, ${String(done.updated)} updated\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
