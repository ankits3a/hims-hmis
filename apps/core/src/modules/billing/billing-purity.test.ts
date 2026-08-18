import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Plan 08 Global Constraints. Two sweeps over the module's own source:
 *  1. the pure cores stay pure — no kernel import, no await, no implicit clock, no randomness, so each
 *     is a total function of its arguments and its tests need no database;
 *  2. money stays integer paise everywhere under modules/billing — no float rounding, no float parsing,
 *     no zod coercion. Every division goes through the tariff engine's `divHalfUp`.
 * T4 adds "cash-math.ts" to PURE_FILES — one line.
 */
const PURE_FILES = ["totals.ts", "credit-share.ts", "settlement.ts", "time.ts", "cash-math.ts"];
const IMPURE_TOKENS = ['from "../../kernel', "await ", "new Date()", "Math.random"];
// Assembled from fragments so that this sweep covers its OWN file too: a literal token here would
// make the test the only violation it can ever find.
const FLOAT_TOKENS = ["Math" + ".round", "to" + "Fixed", "parse" + "Float", "* " + "0.", "z." + "coerce"];

function everyFileUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...everyFileUnder(full));
    else out.push(full);
  }
  return out.sort();
}

describe("billing pure cores and integer-paise discipline", () => {
  it("the pure cores import nothing from the kernel and never await, read a clock or reach for randomness", () => {
    for (const file of PURE_FILES) {
      const source = readFileSync(join(__dirname, file), "utf8");
      expect({ file, empty: source.trim().length === 0 }).toEqual({ file, empty: false });
      for (const token of IMPURE_TOKENS) {
        expect({ file, token, present: source.includes(token) }).toEqual({ file, token, present: false });
      }
    }
  });

  it("no float arithmetic anywhere under modules/billing — fixtures and tests included", () => {
    const files = everyFileUnder(__dirname);
    expect(files.length).toBeGreaterThan(PURE_FILES.length); // the sweep is never vacuous
    for (const path of files) {
      const file = relative(__dirname, path);
      const source = readFileSync(path, "utf8");
      for (const token of FLOAT_TOKENS) {
        expect({ file, token, present: source.includes(token) }).toEqual({ file, token, present: false });
      }
    }
  });
});
