/**
 * `pnpm --filter @hmis/core icd11:load <path-to-10To11MapToOneCategory.txt> --release 2026-01 [--by <name>]`
 *
 * ═══ WHO'S ONE-TO-ONE ICD-10 → ICD-11 TABLE INTO `icd11_map_rows`, BY HAND AND ON THE RECORD ═══
 *
 * NOT RUN BY DEPLOY, NOT RUN BY ANY SEED. WHO's licence §1.2.4 puts "mapping or producing
 * crosswalks" under a separate written agreement and the owner has not ruled, so the tables ship
 * empty and every read answers null until a person runs this, against a database, on purpose.
 *
 * ═══ ONE FILE ONCE, ONE RELEASE ONCE, ALL OR NOTHING ═══
 *
 *   · The sha256 is of the file's BYTES. The same bytes a second time are refused, and so is a
 *     second file for a release already loaded — a corrected table is a new release label, not an
 *     overwrite, so the screen can never show two releases' answers for one code. The UNIQUE
 *     constraints on `icd11_map_loads` hold both under a race; the checks here only say which.
 *   · The parse happens BEFORE the transaction opens and refuses the whole file on any bad line
 *     (`cds/icd11-map.ts`), so there is no half-loaded release to find later.
 *   · The load row and every map row commit together, or neither does.
 *
 * No `--apply` dry run, unlike the catalogue importers: this writes only tables nothing else
 * writes, and a refusal already reports what it read.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { userInfo } from "node:os";
import { eq, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { icd11MapLoads, icd11MapRows } from "../src/kernel/db/schema";
import { parseWhoOneToOneMap } from "../src/modules/cds";
import type { Icd11MapKind } from "../src/modules/cds";
import type { Db, Tx } from "../src/kernel/db/client";

/** `YYYY-MM`, which is how WHO names ICD-11 releases — and the shape the read path sorts on. */
export const RELEASE_SHAPE = /^[0-9]{4}-[0-9]{2}$/;

export type Icd11LoadInput = { bytes: Buffer; sourceFile: string; release: string; loadedBy: string };

export type Icd11LoadResult =
  | { status: "loaded"; loadId: string; release: string; sha256: string; rows: number; kinds: Record<Icd11MapKind, number>; headerStamp: string | null }
  | {
    status: "refused"; reason: "same_file" | "same_release";
    existing: { id: string; release: string; sourceFile: string; sha256: string; loadedBy: string; loadedAt: Date };
  };

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The whole load. Exported so `test/icd11-load.test.ts` runs it — and so tsc checks this file at all. */
export async function loadIcd11Map(db: Db, input: Icd11LoadInput): Promise<Icd11LoadResult> {
  if (!RELEASE_SHAPE.test(input.release)) throw new Error(`--release must be YYYY-MM (got "${input.release}")`);
  if (input.loadedBy.trim() === "") throw new Error("loadedBy is required — a load is on the record");
  const sha256 = sha256Of(input.bytes);
  const parsed = parseWhoOneToOneMap(input.bytes.toString("utf8"));

  return withTx(db, async (tx: Tx): Promise<Icd11LoadResult> => {
    const [existing] = await tx.select().from(icd11MapLoads)
      .where(or(eq(icd11MapLoads.sha256, sha256), eq(icd11MapLoads.release, input.release)));
    if (existing !== undefined) {
      return {
        status: "refused", reason: existing.sha256 === sha256 ? "same_file" : "same_release",
        existing: {
          id: existing.id, release: existing.release, sourceFile: existing.sourceFile,
          sha256: existing.sha256, loadedBy: existing.loadedBy, loadedAt: existing.loadedAt,
        },
      };
    }
    const loadId = newId();
    await tx.insert(icd11MapLoads).values({
      id: loadId, release: input.release, sourceFile: input.sourceFile, sha256,
      rowCount: parsed.rows.length, loadedBy: input.loadedBy,
    });
    const values = parsed.rows.map((r) => ({
      release: input.release,
      icd10Code: r.icd10Code, icd10Title: r.icd10Title,
      icd11Code: r.icd11Code, icd11Title: r.icd11Title, icd11Chapter: r.icd11Chapter,
      icd11ClassKind: r.icd11ClassKind, icd11ReleaseUri: r.icd11ReleaseUri, icd11FoundationUri: r.icd11FoundationUri,
      mapKind: r.mapKind,
    }));
    /* 1,000 rows × 10 columns per statement stays far under the 65,535 bind parameters Postgres allows. */
    for (let i = 0; i < values.length; i += 1000) await tx.insert(icd11MapRows).values(values.slice(i, i + 1000));
    const kinds: Record<Icd11MapKind, number> = { mapped: 0, grouping: 0, no_mapping: 0 };
    for (const r of parsed.rows) kinds[r.mapKind] += 1;
    return { status: "loaded", loadId, release: input.release, sha256, rows: parsed.rows.length, kinds, headerStamp: parsed.headerStamp };
  });
}

/** `<path> --release YYYY-MM [--by name]`, in any order. Exported for the test; `main` is the only other caller. */
export function parseArgs(argv: readonly string[]): { path: string; release: string; by: string | null } {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    const v = i === -1 ? undefined : argv[i + 1];
    return v === undefined || v.startsWith("--") ? null : v;
  };
  const release = flag("--release");
  const by = flag("--by");
  const valued = new Set(["--release", "--by"]);
  const path = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
  if (path === undefined || release === null) {
    throw new Error("usage: icd11:load <path-to-10To11MapToOneCategory.txt> --release YYYY-MM [--by <name>]");
  }
  return { path, release, by };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bytes = readFileSync(args.path);
  /* A CLI has no session. The operator names themselves, or the OS account ran it. */
  const loadedBy = args.by ?? `cli:${userInfo().username}`;
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const r = await loadIcd11Map(db, { bytes, sourceFile: basename(args.path), release: args.release, loadedBy });
    if (r.status === "refused") {
      const e = r.existing;
      console.error(`REFUSED (${r.reason}): release ${e.release} was loaded from ${e.sourceFile} · sha256 ${e.sha256.slice(0, 12)} · by ${e.loadedBy} at ${e.loadedAt.toISOString()}`);
      process.exitCode = 1;
      return;
    }
    console.log(`loaded release ${r.release} · ${r.rows} rows · sha256 ${r.sha256.slice(0, 12)} · header stamp ${r.headerStamp ?? "none"}`);
    console.log(`  mapped ${r.kinds.mapped} · grouping ${r.kinds.grouping} · no mapping ${r.kinds.no_mapping}`);
  } finally {
    await pool.end();
  }
}

/* Only when RUN — a module that called main() on import would run the loader inside the test process. */
if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
