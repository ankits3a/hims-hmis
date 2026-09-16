/**
 * `pnpm --filter @hmis/core tsx scripts/import-cds-catalogue.ts --bundle <cds-bundle.sql> [--apply]`
 *     `[--accept-drop-rate <fraction>]` raises the refusal budget for one run, and says so in the report.
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
 * `formulary_medicines` is UNIQUE on `lower(brand_name)`, and product names in the bundle really are
 * supplied by more than one manufacturer — five different makers of "NS (sodium chloride) 9 mg/1 ml
 * solution for infusion". Measured: NONE of them is the same generic AND the same manufacturer, so
 * none is a duplicate row in the source; they are one product with several suppliers.
 *
 * THE COUNT IS 825, NOT THE 768 THIS COMMENT USED TO CLAIM. 10,303 generics + 93,905 brands =
 * 104,208 rows in, 103,383 kept. The loader now prints the split on every run, so the number is
 * checkable instead of remembered: all 825 are a brand collapsing over another brand, and NONE is a
 * brand collapsing over a generic of the same name. A number in prose that nothing recomputes is a
 * number that drifts, and this one had.
 *
 * The formulary has no manufacturer column — it models what a drug IS, not who made it — so the
 * import keeps ONE row per product name and REPORTS the collapse rather than letting rows vanish
 * quietly. Which supplier a pharmacy actually stocks is a procurement fact and belongs to the
 * materials module, not here.
 *
 * ═══ A COMPOSITION IS WRITTEN WHOLE OR NOT AT ALL ═══
 *
 * This loader used to emit composition rows with `if (saltId !== undefined) links.push(...)` — it
 * silently dropped any component whose substance ref did not resolve, with no count and no refusal.
 * A product that is really amoxicillin + clavulanic acid could therefore be stored as amoxicillin
 * alone, and NOTHING downstream could tell: every guard in the prescribing and dispensing path
 * tests for an EMPTY salt list and none tests for an INCOMPLETE one. A short list reads as a
 * complete one — it renders as covered, gets `allergyHits: 0` written into the permanent
 * dispense record, and two products differing only on a withheld component are declared generic
 * equivalents and substituted for each other.
 *
 * So the composition is PLANNED before it is written, and a product whose components do not ALL
 * resolve is not written at all. Refusing at the writer is what makes the existing empty-guards
 * correct, and it costs nothing a completeness column would have had to carry for ever.
 *
 * The partition is computable from the BUNDLE ALONE — a ref resolves iff the bundle's own
 * substances list carries it — so the whole report prints on a DRY RUN, before a database is
 * opened, which is what this file's own doctrine demands of it.
 *
 * MEASURED against the bundle on this box (sha256 dbf361a24de2), 2026-09-16:
 *
 *     whole            103,375   written
 *     no_refs                0   written
 *     orphan_generic         8   written
 *     partial_refs           0   REFUSED
 *     dangling_refs          0   REFUSED
 *     drop rate          0.000%
 *
 * So the guard changes nothing about THIS bundle, and that is the right result to get from a guard:
 * it is here for the next release, not this one. It does settle one open question, though. Eight
 * active medicines on the loaded catalogue have no composition, and until this report nobody could
 * say WHICH of the five states they were in — they are `orphan_generic`, brands whose
 * `generic_sctid` names no generic in the bundle. Their composition is unknown rather than empty,
 * and they are written because an empty composition is a state every downstream guard already
 * handles honestly: such a product cannot be found by `searchMedicines`, cannot be substituted, and
 * renders as "not in formulary — advanced checks unavailable".
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
  /** A brand whose `generic_sctid` names no generic in this bundle: its composition is UNKNOWN,
   *  not empty. Tracked because those two states look identical downstream and are not. */
  orphanGeneric?: boolean;
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

/**
 * ═══ THE FIVE STATES A PRODUCT'S COMPOSITION CAN BE IN ═══
 *
 * Only `whole` and the two genuinely-empty states are written. `partial_refs` and `dangling_refs`
 * are the ones that would produce a SHORT composition, and a short composition is indistinguishable
 * from a complete one to every guard downstream — see the header.
 *
 * `no_refs` and `orphan_generic` both end up as a product with no composition rows, which the
 * existing empty-guards already handle correctly: it renders as "not in formulary — advanced checks
 * unavailable", it cannot be found by `searchMedicines` (both its branches require a composition
 * row), and it cannot be substituted (`equivalence.ts` refuses an empty `want`). They are kept
 * apart anyway, because "the bundle says this product has no components" and "we could not find
 * this product's generic at all" are different facts and an operator reading the report should not
 * have them added together.
 */
export type Verdict = "whole" | "partial_refs" | "dangling_refs" | "no_refs" | "orphan_generic";

export function verdictFor(p: Product, knownRefs: ReadonlySet<string>): Verdict {
  if (p.orphanGeneric === true) return "orphan_generic";
  if (p.substanceRefs.length === 0) return "no_refs";
  const resolved = p.substanceRefs.filter((r) => knownRefs.has(r)).length;
  if (resolved === p.substanceRefs.length) return "whole";
  return resolved === 0 ? "dangling_refs" : "partial_refs";
}

/**
 * THE FUSE IS A PARSE-SANITY CHECK, NOT A QUALITY BAR. A handful of unresolvable products is the
 * ordinary untidiness of a national release. Thousands of them means the substance list and the
 * composition list were not read from the same bundle, or a column moved — and quietly importing a
 * catalogue with a tenth of its compositions missing is exactly the silent partial this whole
 * change exists to prevent, one level up.
 *
 * The override is a FLAG, not a constant. A fuse whose only override is editing the source is a
 * fuse that gets widened silently to make a run pass; one that has to be typed on the command line
 * appears in the operator's shell history and in the report line below it.
 */
export const DROP_BUDGET = 0.01;

export function assertDropRate(refused: number, total: number, accept: number): void {
  if (total === 0) return;
  const rate = refused / total;
  const budget = Math.max(DROP_BUDGET, accept);
  console.log(`  drop rate ${(rate * 100).toFixed(3)}% against a budget of ${(budget * 100).toFixed(3)}%`
    + `${accept > DROP_BUDGET ? " (raised by --accept-drop-rate)" : ""}`);
  if (rate > budget) {
    throw new Error(
      `${refused} of ${total} products could not have their composition resolved (${(rate * 100).toFixed(2)}%), `
      + `over the ${(budget * 100).toFixed(2)}% budget. That is usually a bundle read wrongly rather than an `
      + `untidy release — check the substances table parsed. To import anyway, pass `
      + `--accept-drop-rate ${(Math.ceil(rate * 10000) / 10000).toString()}`,
    );
  }
}

/** Printed identically on a dry run and an apply, because a plan that can differ from the act is
 *  not a plan. A sample, not the whole list: twenty names is enough to recognise a pattern. */
function reportComposition(
  written: Product[], refused: { product: Product; verdict: Verdict }[], knownRefs: ReadonlySet<string>,
): void {
  const tally = new Map<Verdict, number>();
  for (const p of written) {
    const v = verdictFor(p, knownRefs);
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  for (const { verdict } of refused) tally.set(verdict, (tally.get(verdict) ?? 0) + 1);

  console.log("  composition:");
  for (const v of ["whole", "no_refs", "orphan_generic", "partial_refs", "dangling_refs"] as Verdict[]) {
    const n = tally.get(v) ?? 0;
    const fate = v === "partial_refs" || v === "dangling_refs" ? "REFUSED" : "written";
    console.log(`    ${v.padEnd(15)} ${String(n).padStart(7)}  ${fate}`);
  }
  if (refused.length > 0) {
    console.log(`  refused products (first 20 of ${String(refused.length)}):`);
    for (const { product, verdict } of refused.slice(0, 20)) {
      const missing = product.substanceRefs.filter((r) => !knownRefs.has(r));
      console.log(`    [${verdict}] ${product.name}  — unresolved refs: ${missing.join(", ")}`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const bundle = args[args.indexOf("--bundle") + 1];
  const apply = args.includes("--apply");
  const acceptRaw = args.indexOf("--accept-drop-rate") === -1 ? undefined : args[args.indexOf("--accept-drop-rate") + 1];
  const acceptDropRate = acceptRaw === undefined ? 0 : Number(acceptRaw);
  if (Number.isNaN(acceptDropRate) || acceptDropRate < 0 || acceptDropRate > 1) {
    throw new Error(`--accept-drop-rate takes a fraction between 0 and 1 (got ${String(acceptRaw)})`);
  }
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
      substanceRefs: g?.substanceRefs ?? [], orphanGeneric: g === undefined,
    };
  }).filter((b) => b.sourceRef !== "" && b.name !== "");

  /*
    RESOLVE BEFORE COLLAPSING. The order matters: collapsing first would pick an arbitrary one of
    two same-named products and decide its composition afterwards, so which of them is refused
    would depend on bundle order rather than on the data.
  */
  const knownRefs = new Set(substances.map((s) => s.sctid));
  const planned = [
    ...generics.map((p) => ({ product: p, isBrand: false })),
    ...brands.map((p) => ({ product: p, isBrand: true })),
  ].map((e) => ({ ...e, verdict: verdictFor(e.product, knownRefs) }));

  /* ONE ROW PER PRODUCT NAME. The collapse is counted and printed — see the header. */
  const seen = new Set<string>();
  const products: Product[] = [];
  const refused: { product: Product; verdict: Verdict }[] = [];
  let collapsed = 0;
  let collapsedBrandOverBrand = 0;
  const keptKind = new Map<string, boolean>();
  for (const { product, verdict, isBrand } of planned) {
    const key = product.name.toLowerCase();
    if (seen.has(key)) {
      collapsed += 1;
      if (isBrand && keptKind.get(key) === true) collapsedBrandOverBrand += 1;
      continue;
    }
    seen.add(key);
    keptKind.set(key, isBrand);
    if (verdict === "partial_refs" || verdict === "dangling_refs") { refused.push({ product, verdict }); continue; }
    products.push(product);
  }

  console.log(`bundle ${bundle.split("/").pop()} · sha256 ${sha.slice(0, 12)}`);
  console.log(`  substances ${substances.length} · generics ${generics.length} · brands ${brands.length}`);
  console.log(`  products after the name collapse: ${products.length + refused.length} kept of ${planned.length}`
    + ` — ${collapsed} collapsed (${collapsedBrandOverBrand} brand over brand,`
    + ` ${collapsed - collapsedBrandOverBrand} brand over a generic of the same name)`);
  console.log(`  topical ${products.filter((p) => routeClassOf(p.route) === "topical").length} · systemic ${products.filter((p) => routeClassOf(p.route) === "systemic").length}`);

  reportComposition(products, refused, knownRefs);
  assertDropRate(refused.length, products.length + refused.length, acceptDropRate);

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
          /*
            UNREACHABLE BY CONSTRUCTION, and it throws rather than skipping. `products` holds only
            what `verdictFor` passed, and it passes a product only when every ref is in `knownRefs`
            — the same set `saltIdByRef` is built from. If this ever fires, the plan and the write
            have diverged, which is the one thing this loader's doctrine says must not happen; the
            transaction rolls back and nobody gets a short composition out of it.
          */
          if (saltId === undefined) {
            throw new Error(`"${p.name}" planned as whole but ref ${ref} did not resolve — plan and write disagree`);
          }
          links.push({ medicineId: id, saltId, strength: p.strength, source: "derived" });
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

/* Guarded so a test can import the planner without the script running itself — the same guard
   `import-icd10-catalogue.ts` carries, and for the same reason. */
if (require.main === module) main();
