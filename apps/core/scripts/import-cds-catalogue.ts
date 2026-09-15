/**
 * `pnpm --filter @hmis/core tsx scripts/import-cds-catalogue.ts --bundle <cds-bundle.sql> [--apply]`
 *
 * ═══ THE OWNER'S DRUG CATALOGUE INTO THE HOSPITAL'S OWN FORMULARY ═══
 *
 * Owner ruling, 2026-09-14: the bundle's catalogue goes into `formulary_*` — the same tables the
 * prescription's allergy, interaction and duplicate checks already read — rather than into a second
 * catalogue beside them. One drug list, one safety layer. The alternative was two truths about what
 * a drug IS, which is the defect those checks exist to prevent.
 *
 * It follows `import-lab-catalogue.ts`: PARSE, PLAN, and write nothing without `--apply`. A dry run
 * prints exactly what an applied run would do, because a loader whose plan and act can disagree is
 * a loader nobody can review.
 *
 * ═══ WHAT IS IMPORTED, AND THE TWO THINGS THAT ARE NOT ═══
 *
 *   3,283 substances → `formulary_salts`      (name + synonyms as aliases)
 *  10,303 generics   → `formulary_medicines`  (the doctor's picker: name, form, strength, D-code)
 *  93,905 brands     → `formulary_medicines`  (the brand a patient arrives holding)
 *
 * NOT the per-drug monographs and NOT the FAQs. Measured before any of this was written: the
 * bundle's 43-column `clinical_knowledge` holds SIX distinct values per column across 10,303 drugs
 * (`storage`: one, for every drug), and its 42,819 FAQs are 27 pairs repeated — fanned out by class,
 * so the ampicillin row cites azithromycin's ATC code. Importing that as molecule-level knowledge
 * would industrialise a confident error.
 *
 * ═══ THE 768 NAMES THAT COLLIDE, AND WHY THEY COLLAPSE ═══
 *
 * `formulary_medicines` is UNIQUE on `lower(brand_name)`, and 768 product names in the bundle are
 * supplied by more than one manufacturer — five different makers of "NS (sodium chloride) 9 mg/1 ml
 * solution for infusion". Measured: NONE of them is the same generic AND the same manufacturer, so
 * none is a duplicate row in the source; they are one product with several suppliers.
 *
 * The formulary has no manufacturer column — it models what a drug IS, not who made it — so the
 * import keeps ONE row per product name and REPORTS the collapse rather than letting rows vanish
 * quietly. Which supplier a pharmacy actually stocks is a procurement fact and belongs to the
 * materials module, not here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { formularyMedicineSalts, formularyMedicines, formularySalts } from "../src/kernel/db/schema";
import type { Tx } from "../src/kernel/db/client";

type Substance = { sctid: string; name: string; synonyms: string[] };
type Product = {
  sourceRef: string; name: string; form: string; strength: string | null;
  route: string; code: string | null; substanceRefs: string[];
};

/**
 * THE BUNDLE IS A SQLITE DUMP AND THIS READS IT AS TEXT, deliberately: adding a SQLite driver to
 * this server to read a file that arrives once a year is a dependency the deploy carries for ever.
 * The parser below understands exactly the three INSERT shapes the dump uses and refuses anything
 * else, which is a smaller surface than a general SQL parser and fails loudly rather than guessing.
 */
function splitSqlValues(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (inStr) {
      if (ch === "'") {
        if (row[i + 1] === "'") { cur += "'"; i += 1; } else { inStr = false; }
      } else cur += ch;
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((v) => (v === "NULL" ? "" : v));
}

/**
 * ROWS KEYED BY COLUMN NAME, NOT BY POSITION. The dump writes an explicit column list on every
 * statement and uses two verbs — `INSERT INTO` for most tables and `INSERT OR REPLACE INTO` for
 * `substances` — so a positional reader would have silently mis-read one table and found nothing in
 * the other. Reading the header the dump itself supplies is both more robust and self-checking: a
 * column this importer names and the bundle stops shipping becomes `undefined` here rather than
 * whatever value happens to sit at that index.
 */
function rowsOf(sqlText: string, table: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const head = new RegExp(`^INSERT (?:OR REPLACE )?INTO ${table} \\(([^)]*)\\) VALUES`, "i");
  for (const line of sqlText.split("\n")) {
    const m = head.exec(line);
    if (m === null) continue;
    const cols = m[1]!.split(",").map((c) => c.trim());
    const body = line.slice(m[0].length).trim().replace(/;$/, "");
    // one or more parenthesised tuples on the line
    let depth = 0; let start = -1; let inStr = false;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]!;
      if (inStr) { if (ch === "'") { if (body[i + 1] === "'") i += 1; else inStr = false; } continue; }
      if (ch === "'") { inStr = true; continue; }
      if (ch === "(") { if (depth === 0) start = i + 1; depth += 1; continue; }
      if (ch === ")") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const vals = splitSqlValues(body.slice(start, i));
          const row: Record<string, string> = {};
          cols.forEach((c, n) => { row[c] = vals[n] ?? ""; });
          out.push(row);
        }
      }
    }
  }
  return out;
}

/**
 * `route_class` is CHECKed to 'systemic' | 'topical' — DD7's two buckets, and the bucket decides
 * whether an interaction applies. So the mapping is FAIL-SAFE: only routes whose action is
 * unambiguously local become topical, and everything else — including nasal, rectal and oromucosal,
 * which absorb — stays systemic, because a missed interaction is the costly direction.
 */
function routeClassOf(route: string): "systemic" | "topical" {
  const r = route.toLowerCase();
  const local = ["cutaneous", "ophthalmic", "auricular", "otic", "transdermal"];
  return local.some((x) => r.includes(x)) && !r.includes("intravenous") ? "topical" : "systemic";
}

function main(): void {
  const args = process.argv.slice(2);
  const bundle = args[args.indexOf("--bundle") + 1];
  const apply = args.includes("--apply");
  if (bundle === undefined || bundle.startsWith("--")) throw new Error("usage: --bundle <cds-bundle.sql> [--apply]");

  const text = readFileSync(bundle, "utf8");
  const sha = createHash("sha256").update(text).digest("hex");

  const substances: Substance[] = rowsOf(text, "substances").map((r) => ({
    sctid: r["substance_sctid"] ?? "",
    name: (r["substance_name"] ?? "").replace(/\s*\(substance\)\s*$/i, "").trim(),
    synonyms: (r["synonyms"] ?? "").split("|").map((x) => x.trim()).filter((x) => x !== ""),
  })).filter((s) => s.sctid !== "" && s.name !== "");

  const generics: Product[] = rowsOf(text, "generics").map((r) => ({
    sourceRef: r["generic_sctid"] ?? "",
    code: (r["hmis_code"] ?? "") === "" ? null : r["hmis_code"]!,
    name: (r["generic_name"] ?? "").trim(),
    form: (r["dose_form"] ?? "").trim() || "unspecified",
    route: r["route_of_administration"] ?? "",
    substanceRefs: (r["substance_sctids"] ?? "").split(/[,;+|]/).map((x) => x.trim()).filter((x) => x !== ""),
    strength: (r["strength"] ?? "").trim() === "" ? null : (r["strength"] ?? "").trim(),
  })).filter((g) => g.sourceRef !== "" && g.name !== "");

  const genericByRef = new Map(generics.map((g) => [g.sourceRef, g] as const));
  const brands: Product[] = rowsOf(text, "medicines_brands").map((r) => {
    const g = genericByRef.get(r["generic_sctid"] ?? "");
    return {
      sourceRef: r["medicine_sctid"] ?? "", name: (r["medicine_name"] ?? "").trim(), code: null,
      form: g?.form ?? "unspecified", route: g?.route ?? "", strength: g?.strength ?? null,
      substanceRefs: g?.substanceRefs ?? [],
    };
  }).filter((b) => b.sourceRef !== "" && b.name !== "");

  /* ONE ROW PER PRODUCT NAME. The collapse is counted and printed — see the header. */
  const seen = new Set<string>();
  const products: Product[] = [];
  let collapsed = 0;
  for (const p of [...generics, ...brands]) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) { collapsed += 1; continue; }
    seen.add(key);
    products.push(p);
  }

  console.log(`bundle ${bundle.split("/").pop()} · sha256 ${sha.slice(0, 12)}`);
  console.log(`  substances ${substances.length} · generics ${generics.length} · brands ${brands.length}`);
  console.log(`  products after the name collapse: ${products.length} (${collapsed} names supplied by more than one manufacturer)`);
  console.log(`  topical ${products.filter((p) => routeClassOf(p.route) === "topical").length} · systemic ${products.filter((p) => routeClassOf(p.route) === "systemic").length}`);
  if (!apply) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); return; }

  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url);
  void (async () => {
    const written = await withTx(db, async (tx: Tx) => {
      const existingSalts = new Map(
        (await tx.select({ id: formularySalts.id, name: formularySalts.name }).from(formularySalts))
          .map((r) => [r.name.toLowerCase(), r.id] as const),
      );
      const saltIdByRef = new Map<string, string>();
      const newSalts: typeof formularySalts.$inferInsert[] = [];
      for (const s of substances) {
        const have = existingSalts.get(s.name.toLowerCase());
        if (have !== undefined) { saltIdByRef.set(s.sctid, have); continue; }
        const id = newId();
        saltIdByRef.set(s.sctid, id);
        existingSalts.set(s.name.toLowerCase(), id);
        newSalts.push({ id, name: s.name, aliases: s.synonyms, sourceRef: s.sctid, createdBy: "cds-import", updatedBy: "cds-import" });
      }
      for (let i = 0; i < newSalts.length; i += 500) await tx.insert(formularySalts).values(newSalts.slice(i, i + 500));

      const existingMeds = new Set(
        (await tx.select({ name: formularyMedicines.brandName }).from(formularyMedicines)).map((r) => r.name.toLowerCase()),
      );
      const meds: typeof formularyMedicines.$inferInsert[] = [];
      const links: typeof formularyMedicineSalts.$inferInsert[] = [];
      for (const p of products) {
        if (existingMeds.has(p.name.toLowerCase())) continue;
        const id = newId();
        meds.push({
          id, brandName: p.name, form: p.form, routeClass: routeClassOf(p.route),
          strengthLabel: p.strength, code: p.code, sourceRef: p.sourceRef,
          createdBy: "cds-import", updatedBy: "cds-import",
        });
        for (const ref of p.substanceRefs) {
          const saltId = saltIdByRef.get(ref);
          if (saltId !== undefined) links.push({ medicineId: id, saltId, strength: p.strength });
        }
      }
      for (let i = 0; i < meds.length; i += 500) await tx.insert(formularyMedicines).values(meds.slice(i, i + 500));
      /* A fixed-dose combination names the same moiety twice in the bundle; the join's primary key
         refuses the repeat, so the insert says so rather than aborting a hundred thousand rows. */
      for (let i = 0; i < links.length; i += 500) {
        await tx.insert(formularyMedicineSalts).values(links.slice(i, i + 500)).onConflictDoNothing();
      }
      /*
        THE RANKING SIGNAL, RECOMPUTED FROM WHAT WAS JUST WRITTEN. It is derived data with exactly
        one owner — this import — so it is set here and nowhere else, for every salt rather than
        only the new ones: a second bundle that adds products to an existing moiety must move it.
      */
      await tx.execute(sql`
        update formulary_salts s
           set product_count = coalesce((
                 select count(*) from formulary_medicine_salts l where l.salt_id = s.id
               ), 0)
      `);
      /* And denormalised onto the product, which is where the typeahead sorts on it. */
      await tx.execute(sql`
        update formulary_medicines m
           set salt_rank = coalesce((
                 select max(s.product_count) from formulary_medicine_salts l
                   join formulary_salts s on s.id = l.salt_id
                  where l.medicine_id = m.id
               ), 0)
      `);
      return { salts: newSalts.length, meds: meds.length, links: links.length };
    });
    console.log(`\nAPPLIED · salts +${written.salts} · medicines +${written.meds} · compositions +${written.links}`);
    const counts = await db.execute(sql`select
      (select count(*) from formulary_salts) as salts,
      (select count(*) from formulary_medicines) as meds,
      (select count(*) from formulary_medicine_salts) as links`);
    console.log(`catalogue now: ${JSON.stringify(counts.rows[0])}`);
    await pool.end();
  })();
}

main();
