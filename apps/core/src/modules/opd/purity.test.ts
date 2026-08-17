import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The module's pure cores stay pure (Global Constraints): no kernel import, no implicit clock, no randomness, no
 * process access — so every one of them is a total function of its arguments and its tests need no database.
 * T6 adds vitals-rules.ts and T7 adds fhir.ts to this list.
 */
const PURE_FILES = ["time.ts", "slots.ts", "visit-type.ts", "queue-engine.ts", "vitals-rules.ts", "fhir.ts"];
const FORBIDDEN = ['from "../../kernel', "await ", "new Date()", "Math.random", "process."];

describe("opd pure cores", () => {
  it("import nothing from the kernel and never reach for the clock, randomness or the process", () => {
    for (const file of PURE_FILES) {
      const source = readFileSync(join(__dirname, file), "utf8");
      expect({ file, empty: source.trim().length === 0 }).toEqual({ file, empty: false });
      for (const token of FORBIDDEN) {
        expect({ file, token, present: source.includes(token) }).toEqual({ file, token, present: false });
      }
    }
  });
});
