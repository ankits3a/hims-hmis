/**
 * `pnpm --filter @hmis/core tsx scripts/import-icd10-catalogue.ts --bundle <icd10-catalog.sql> [--apply]`
 *
 * ═══ THE OWNER'S ICD-10 TABULAR LIST INTO `icd10_codes` ═══
 *
 * Owner, 2026-09-14, asked for the diagnosis field to suggest from a real catalogue and supplied
 * one. It arrives as `icd10_catalog` appended to the clinical bundle, whose first 136,240,059 bytes
 * are byte-identical to the bundle already imported — so only the appended section is kept, at
 * `/opt/hmis-context/cds-bundle/icd10-catalog.sql`, checksummed beside it.
 *
 * Like `import-cds-catalogue.ts`: PARSE, PLAN, and write nothing without `--apply`.
 *
 * ═══ THIS TABLE IS WRITTEN DIFFERENTLY FROM THE REST OF THE BUNDLE, AND THAT IS A TRAP ═══
 *
 * The drug tables use `INSERT OR REPLACE INTO t (col, col, ...) VALUES (...)` and the existing
 * loader parses them BY COLUMN NAME, because the bundle uses two verbs and explicit column lists.
 * `icd10_catalog` uses neither: it is `INSERT INTO icd10_catalog VALUES (...)`, positional, no
 * column list at all. A parser that keys on names reads nothing here and reports success — so this
 * one reads POSITIONS and asserts the arity of every tuple instead, which is the only check a
 * positional format can offer. 97,296 of 97,296 must parse or the run aborts.
 *
 * ═══ WHAT IS KEPT, AND THE ONE FIELD THAT IS DERIVED ═══
 *
 * Everything the release ships is kept as released. `chapterNo` is the only derived column: parsed
 * out of the chapter label ("Chapter 19: Injury, poisoning ... (S00-T88)") so the search can rank
 * by chapter without matching on English prose at query time. The label is kept beside it.
 *
 * ═══ IDEMPOTENT BY CODE ═══
 *
 * The code is the primary key and the release's own identity, so a re-run inserts what is absent
 * and leaves the rest. Nothing here updates a row that already exists: a changed description would
 * be a new RELEASE, and adopting one is a decision with a date on it, not a side effect of running
 * a loader twice.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { icd10Codes } from "../src/kernel/db/schema";
import type { Tx } from "../src/kernel/db/client";

const PREFIX = "INSERT INTO icd10_catalog VALUES (";

/**
 * One SQLite `VALUES (...)` tuple: bare integers and `'`-quoted strings in which `''` is a literal
 * quote. Descriptions carry commas ("Cholera due to Vibrio cholerae 01, biovar cholerae"), so a
 * `split(",")` misaligns every column after the first one and reports success — the same defect
 * #186 found in `import-item-master`, in a different file format.
 */
export function parseTuple(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === " " || s[i] === ",")) i += 1;
    if (i >= s.length) break;
    if (s[i] === "'") {
      i += 1;
      let v = "";
      for (;;) {
        if (i >= s.length) throw new Error("unterminated string in tuple");
        if (s[i] === "'" && s[i + 1] === "'") { v += "'"; i += 2; continue; }
        if (s[i] === "'") { i += 1; break; }
        v += s[i]; i += 1;
      }
      out.push(v);
    } else {
      let v = "";
      while (i < s.length && s[i] !== ",") { v += s[i]; i += 1; }
      out.push(v.trim());
    }
  }
  return out;
}

/**
 * ═══ HOW GENERAL A CODE IS — THE ONE DERIVED RANKING SIGNAL ═══
 *
 * ICD-10 ranked on text similarity answers the wrong question for an outpatient desk. Measured on
 * the real catalogue before this existed: `diabet` returned **Diabetes insipidus** above type 2
 * diabetes, `hyperten` never reached **I10** in ten rows, `asthma` put "Other asthma" above
 * "Unspecified asthma, uncomplicated", and `typh` offered Typhoid pneumonia, arthritis and
 * meningitis before Typhoid fever. One cause each time: a short, rare, SPECIFIC name outscoring the
 * general code the desk actually assigns.
 *
 * The book marks the general code two ways, and this reads both:
 *
 *   · IN WORDS — "unspecified", "unqualified", "uncomplicated", "without complication", "NOS".
 *     ICD-10-CM's own vocabulary for "this is the residual code for the category".
 *   · IN THE CODE — a three-character code that is ITSELF billable is a whole category with no
 *     subdivisions, which is as general as an assignable code gets: I10, A09, R51.
 *
 * They are added rather than ordered so neither alone decides. I10 (three characters, no
 * "unspecified") and I16.9 ("Hypertensive crisis, unspecified") both score 3 — and the tabular
 * order then puts I10 first, which is the answer. That is the design, not a coincidence: the
 * generality score gets the right HANDFUL to the top and the book's own order picks among them.
 *
 * NOT a clinical judgement and not a frequency table — nobody here is ranking diseases. It reads
 * two properties the release already states about its own codes.
 */
export function generalityOf(code: string, description: string): number {
  let g = 0;
  /* THE RESIDUAL CODE FOR A CATEGORY — the strongest marker, and worth more than the next one. */
  if (/\b(unspecified|unqualified|not specified|NOS)\b/i.test(description)) g += 2;
  /*
    Weaker, because it qualifies rather than generalises: "Mild intermittent asthma, UNCOMPLICATED"
    is a specific severity. Splitting these two apart is what stops J45.20 outranking J45.909
    ("Unspecified asthma, uncomplicated"), which scores on both — measured, it did.
  */
  if (/\b(uncomplicated)\b|without complication/i.test(description)) g += 1;

  const undotted = code.replace(".", "");
  /* A three-character code that is itself billable is a whole category with no subdivisions. */
  if (undotted.length <= 3) g += 3;
  else if (undotted.length === 4) g += 1;

  /*
    ═══ THE SEVENTH CHARACTER IS AN EPISODE, NOT A DIFFERENT INJURY ═══

    ICD-10-CM extends almost every injury code with a 7th character for the encounter: A initial,
    D subsequent routine, G delayed healing, K nonunion, P malunion, S sequela (and B/C for open
    fractures). One broken skull is therefore seven codes, and `fracture of` spent five of its ten
    slots on S02.109 A, B, D, G and K — the same fracture, five times. Measured, and it is why
    chapter 19 is 53,944 of the 97,296 rows.
    
    `A` is the one an outpatient desk writes: the encounter where the injury is first treated. The
    rest are demoted so they sit below every distinct injury rather than crowding it out. They are
    still reachable — a follow-up visit is real — and a doctor who types further still finds them.
  */
  if (undotted.length === 7 && /[A-Z]/.test(undotted[6]!) && undotted[6] !== "A") g -= 1;
  return g;
}

/** "Chapter 19: Injury, poisoning and external causes (S00-T88)" -> 19. */
export function chapterNoOf(label: string): number {
  const m = /^Chapter\s+(\d+)\s*:/.exec(label.trim());
  if (m === null) throw new Error(`unparseable chapter label: ${label}`);
  return Number(m[1]);
}

export type Icd10Row = {
  code: string; rawCode: string; orderNumber: number; billable: boolean;
  shortDescription: string; longDescription: string; chapterNo: number; chapterName: string;
  generality: number;
};

export function parseCatalogue(text: string): Icd10Row[] {
  const rows: Icd10Row[] = [];
  let seen = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(PREFIX)) continue;
    seen += 1;
    const inner = line.slice(PREFIX.length, line.lastIndexOf(")"));
    const t = parseTuple(inner);
    /* POSITIONAL, so arity is the only structural check available. Never skip a bad row quietly. */
    if (t.length !== 7) throw new Error(`row ${seen}: expected 7 columns, got ${t.length} — ${line.slice(0, 120)}`);
    const [order, code, raw, bill, short, long, chapter] = t as [string, string, string, string, string, string, string];
    rows.push({
      code, rawCode: raw, orderNumber: Number(order), billable: bill === "1",
      shortDescription: short, longDescription: long,
      chapterNo: chapterNoOf(chapter), chapterName: chapter,
      generality: generalityOf(code, short),
    });
  }
  return rows;
}

function main(): void {
  const args = process.argv.slice(2);
  const bundle = args[args.indexOf("--bundle") + 1];
  const apply = args.includes("--apply");
  if (bundle === undefined || bundle.startsWith("--")) throw new Error("usage: --bundle <icd10-catalog.sql> [--apply]");

  const text = readFileSync(bundle, "utf8");
  const sha = createHash("sha256").update(text).digest("hex");
  const rows = parseCatalogue(text);

  const codes = new Set(rows.map((r) => r.code));
  const byChapter = new Map<number, number>();
  for (const r of rows) byChapter.set(r.chapterNo, (byChapter.get(r.chapterNo) ?? 0) + 1);

  console.log(`bundle ${bundle.split("/").pop()} · sha256 ${sha.slice(0, 12)}`);
  console.log(`  rows ${rows.length} · distinct codes ${codes.size} · billable ${rows.filter((r) => r.billable).length}`);
  console.log(`  distinct short descriptions ${new Set(rows.map((r) => r.shortDescription)).size} · chapters ${byChapter.size}`);
  const gen = new Map<number, number>();
  for (const r of rows) gen.set(r.generality, (gen.get(r.generality) ?? 0) + 1);
  console.log(`  generality: ${[...gen.entries()].sort((a, b) => b[0] - a[0]).map(([g, n]) => `${g}->${n}`).join(" · ")}`);
  if (codes.size !== rows.length) throw new Error("duplicate codes in the release — the primary key would refuse them");
  if (!apply) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); return; }

  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url);
  void (async () => {
    const written = await withTx(db, async (tx: Tx) => {
      const have = new Set((await tx.select({ code: icd10Codes.code }).from(icd10Codes)).map((r) => r.code));
      const fresh = rows.filter((r) => !have.has(r.code));
      for (let i = 0; i < fresh.length; i += 1000) await tx.insert(icd10Codes).values(fresh.slice(i, i + 1000));
      return fresh.length;
    });
    console.log(`applied: ${written} codes inserted, ${rows.length - written} already present`);
    await pool.end();
  })();
}

/* Only when RUN. The parsing halves are imported by `test/import-icd10.test.ts`, and a module that
   calls main() on import runs the loader inside the test process — it did, and read `-w` as a path. */
if (require.main === module) main();
