import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import * as ot from "../../ot";

/**
 * ACCEPTANCE — issue #1086, spec docs/specs/1086-consent-schema-in-kernel.md (owner APPROVED 2026-11-14).
 * The consent schema, the consent-evidence builder and the fasting constants live in `kernel/consent`;
 * imaging reads them from there, and `ot` re-exports the same objects under the same names.
 *
 * D1 is structural: it reads the module specifiers of `gates.ts` and `ir.ts` and resolves each one, so an
 * `import type` or a deep path into `ot` counts as much as a value import from its index. A control on a
 * literal source proves the detector fires, so an empty result cannot pass for a clean one.
 *
 * D2 loads the kernel folder at test time (`jest.requireActual`), not at import time, so that before the
 * folder exists D2 fails on its own and D1 still runs and fails on its own reason. A number cannot be
 * told apart by identity (`6` is `6` wherever it was declared), so for the constants D2 also requires
 * exactly ONE declaration of each name in `apps/core/src`, and that one in `kernel/consent`.
 */
const SRC = resolve(__dirname, "../../..");
const RADIOLOGY = resolve(__dirname, "..");
const THEATRE = resolve(SRC, "modules", "ot");

/** Every module specifier in a source text: `from "x"`, `import "x"`, `import("x")`, `require("x")`. */
function specifiers(source: string): string[] {
  const shapes = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return shapes.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!));
}

/** The specifiers of a file in `dir` that land in the theatre module (its index or anything under it). */
function theatreImports(dir: string, source: string): string[] {
  return specifiers(source).filter((s) => {
    if (s.startsWith(".")) {
      const target = resolve(dir, s);
      return target === THEATRE || target.startsWith(THEATRE + sep);
    }
    return /(^|\/)modules\/ot(\/|$)/.test(s);
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("imaging: consent and fasting read from the kernel, not from theatre (spec #1086)", () => {
  it("spec #1086 D1: gates.ts and ir.ts import nothing from the theatre module", () => {
    // Control: the detector finds a value import, a type import and a deep path into `ot`.
    const control = [
      `import { consentSchema } from "../ot";`,
      `import type { ConsentEvidence } from "../ot/index";`,
      `import { NPO_SOLIDS_HOURS } from "../ot/gates";`,
      `import { patients } from "../patients";`,
    ].join("\n");
    expect(theatreImports(RADIOLOGY, control)).toEqual(["../ot", "../ot/index", "../ot/gates"]);

    for (const file of ["gates.ts", "ir.ts"]) {
      const source = readFileSync(join(RADIOLOGY, file), "utf8");
      expect({ file, read: specifiers(source).length > 5 }).toEqual({ file, read: true });
      expect({ file, theatre: theatreImports(RADIOLOGY, source) }).toEqual({ file, theatre: [] });
    }
  });

  it("spec #1086 D2: ot's index still exports the consent schema and the fasting constants, and they are the kernel's objects", () => {
    const kernel = jest.requireActual<Record<string, unknown>>("../../../kernel/consent");
    const theatre = ot as unknown as Record<string, unknown>;

    // The adult age travels with the fasting hours: `ir.ts` reads it beside them, and D1 forbids `ot`.
    const names = ["consentSchema", "consentEvidence", "NPO_SOLIDS_HOURS", "NPO_CLEAR_FLUIDS_HOURS", "ADULT_AGE_YEARS"];
    for (const name of names) {
      expect({ name, inOt: theatre[name] !== undefined, inKernel: kernel[name] !== undefined })
        .toEqual({ name, inOt: true, inKernel: true });
      expect(theatre[name]).toBe(kernel[name]);
    }

    const constants = ["NPO_SOLIDS_HOURS", "NPO_CLEAR_FLUIDS_HOURS", "ADULT_AGE_YEARS"];
    const files = sourceFiles(SRC).filter((f) => !f.endsWith(".test.ts"));
    for (const name of constants) {
      const declared = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`);
      const where = files.filter((f) => declared.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f).split(sep).join("/"));
      expect({ name, where }).toEqual({ name, where: [expect.stringMatching(/^kernel\/consent\//)] });
    }
  });
});
