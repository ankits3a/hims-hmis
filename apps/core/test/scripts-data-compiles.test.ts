import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file in `scripts/data/` that a script reads BY DEFAULT must be a TypeScript module.
 *
 * `apps/core`'s build is a bare `tsc -p tsconfig.build.json` and the server image copies only
 * `dist/` (see `src/kernel/printing/crest.ts` for the measurement). A `.json` beside a script passes
 * under jest and tsx and is MISSING inside the production image. It happened on 2026-10-04:
 * `setup:units` read `scripts/data/crkmch-units-2026-10.json`, and the production run had to mount
 * the file into the container by hand.
 *
 * A file a script takes as an ARGUMENT (`--list <csv>`) is the operator's to supply, and is listed
 * here by name with the script that takes it.
 */
const TAKEN_BY_ARGUMENT: Record<string, string> = {
  "pharmacy-starter-list.csv": "load-pharmacy-shelf.ts --list",
};

describe("scripts/data ships inside the server image", () => {
  const dir = join(__dirname, "..", "scripts", "data");
  const files = readdirSync(dir);

  it("reads a non-empty directory", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("holds only TypeScript modules, except the files a script takes as an argument", () => {
    const stranded = files.filter((f) => !f.endsWith(".ts") && !(f in TAKEN_BY_ARGUMENT));
    expect(stranded).toEqual([]);
  });
});
