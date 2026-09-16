import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * ═══ NO CODE OUTSIDE THE FORMULARY NAMES A FORMULARY TABLE — INCLUDING IN RAW SQL ═══
 *
 * `eslint.config.mjs` closes the formulary's tables to other modules by refusing an IMPORTED table
 * object (`formularySalts`, …). Its own comment says what it cannot see: a table named inside a
 * `sql` string. `modules/cds/allergens.ts` did exactly that, reading `formulary_salts` in raw SQL,
 * and the lint stayed green (handoff 2026-09-16 §5). A green lint was being read as an enforced
 * boundary.
 *
 * This is the other half: a scan of the source TEXT, with comments stripped, for any formulary
 * table name outside `modules/formulary` and the schema that defines the tables. Prose about a
 * table is fine. Code that names one is a query that belongs behind `modules/formulary/index.ts`.
 *
 * ═══ AN EMPTY RESULT IS EVIDENCE ABOUT THE SEARCH, SO THE SEARCH IS PROVED FIRST ═══
 *
 * The first leg shows the scanner finds these names where they legitimately live (the formulary
 * module's own queries) and counts the files it read. A scanner that read nothing, or whose
 * pattern matched nothing, would pass the second leg for ever.
 */
const SRC = resolve(__dirname, "../src");
const OWNERS = [join("modules", "formulary"), join("kernel", "db", "schema")];
const TABLE = /\bformulary_(?:salts|medicines|medicine_salts|interactions|staging|substances|generics|generic_substances|mapping_proposals)\b/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/**
 * Block comments, then line comments that start a line or follow whitespace or code punctuation,
 * so "https://" inside a string is not taken for one. Replaced with blanks to keep line numbers.
 */
function stripComments(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

function hits(file: string): string[] {
  const text = stripComments(readFileSync(file, "utf8"));
  const out: string[] = [];
  for (const m of text.matchAll(TABLE)) {
    const line = text.slice(0, m.index).split("\n").length;
    out.push(`${relative(SRC, file)}:${String(line)}  ${m[0]}`);
  }
  return out;
}

const files = sourceFiles(SRC);
const owned = (f: string): boolean => OWNERS.some((o) => relative(SRC, f).startsWith(o));

describe("the formulary's tables are named only by the formulary", () => {
  it("the scanner reads the source and sees the names where they belong", () => {
    expect(files.length).toBeGreaterThan(300);
    const ownerHits = files.filter(owned).flatMap(hits);
    // The formulary's own raw queries (mapping.ts, search.ts, reads.ts, …) name them many times.
    expect(ownerHits.length).toBeGreaterThan(20);
    expect(ownerHits.some((h) => h.startsWith(join("modules", "formulary", "mapping.ts")))).toBe(true);
    // A comment is not code; code after a URL in a string still is.
    const once = new RegExp(TABLE.source);
    expect(stripComments("// reads formulary_salts\nconst x = 1; /* formulary_medicines */")).not.toMatch(once);
    expect(stripComments("const u = \"https://x\"; const t = sql`from formulary_salts`;")).toMatch(once);
  });

  it("no other file in src names a formulary table in code", () => {
    const offenders = files.filter((f) => !owned(f)).flatMap(hits);
    // Joined, so a failure prints every offending line. Ask modules/formulary's index.ts instead.
    expect(offenders.join("\n")).toBe("");
  });
});
