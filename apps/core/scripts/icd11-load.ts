/**
 * `pnpm --filter @hmis/core icd11:load --from-who 2026-01 [--sha256 <hex>] [--by <name>]`
 * `pnpm --filter @hmis/core icd11:load <path-to-10To11MapToOneCategory.txt> --release 2026-01 [--by <name>]`
 *
 * In PRODUCTION there is no tsx and no pnpm script — the image runs compiled output. `--help`
 * prints the command, and `USAGE` below is where it is written down.
 *
 * ═══ WHO'S ONE-TO-ONE ICD-10 → ICD-11 TABLE INTO `icd11_map_rows`, BY HAND AND ON THE RECORD ═══
 *
 * NOT RUN BY DEPLOY, NOT RUN BY ANY SEED. The owner ruled on 2026-09-26 that WHO's map may be loaded
 * (licence §1.2.4 settled), and that no WHO data enters the repository: `--from-who` DOWNLOADS the
 * release at run time (`icd11-who-release.ts` — a pinned sha256, one entry out of the zip, in
 * memory). The tables stay empty, and every read answers null, until a person runs this against a
 * database on purpose.
 *
 * ═══ ONE FILE ONCE, ONE RELEASE ONCE, ALL OR NOTHING ═══
 *
 *   · The sha256 is of the TEXT file's bytes, whichever way they arrived — so the same table from
 *     disk and from WHO is the same file. The same bytes a second time are refused, and so is a
 *     second file for a release already loaded — a corrected table is a new release label, not an
 *     overwrite, so the screen can never show two releases' answers for one code. The UNIQUE
 *     constraints on `icd11_map_loads` hold both under a race; the checks here only say which.
 *   · The download, its checksum and the parse all happen BEFORE the transaction opens (and the
 *     download before the database is even connected); the parse refuses the whole file on any bad
 *     line (`cds/icd11-map.ts`), so there is no half-loaded release to find later.
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
import { RELEASE_SHAPE, downloadWhoMap } from "./icd11-who-release";
import type { FetchLike, WhoDownload } from "./icd11-who-release";
import type { Icd11MapKind } from "../src/modules/cds";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * The operator's page. The production command is `deploy.sh`'s own shape for every script it runs
 * (`compose run --rm api node dist/scripts/<name>.js`): a one-off container from the api image, with
 * the api's `.env` (so its DATABASE_URL) and its network — which is how the download leaves the box.
 */
export const USAGE = `usage:
  icd11:load --from-who YYYY-MM [--sha256 <hex>] [--by <name>]
  icd11:load <path-to-10To11MapToOneCategory.txt> --release YYYY-MM [--by <name>]

--from-who downloads https://icdcdn.who.int/static/releasefiles/<YYYY-MM>/mapping.zip, refuses it
unless its sha256 is the one pinned in scripts/icd11-who-release.ts (WHO_MAP_SHA256 — or --sha256
for a release not pinned yet), takes 10To11MapToOneCategory.txt out of it in memory, and loads that.
Nothing is written to disk. --by names who ran it (default: cli:<os user>).

In production (compiled; there is no tsx or pnpm script in the image), from the prod host:
  cd /opt/hmis-prod
  docker compose -p hmis-prod -f docker-compose.prod.yml --project-directory . \\
    run --rm api node dist/scripts/icd11-load.js --from-who 2026-01 --by <your name>

In development:
  pnpm --filter @hmis/core icd11:load --from-who 2026-01 --by <your name>`;

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

export type Icd11Args =
  | { path: string; release: string; by: string | null }
  | { fromWho: string; sha256: string | null; by: string | null };

/** `<path> --release YYYY-MM` or `--from-who YYYY-MM [--sha256 hex]`, `--by name` either way, in any order. */
export function parseArgs(argv: readonly string[]): Icd11Args {
  const usage = (): Error => new Error(USAGE);
  /* A flag that is present must carry a value — `--sha256` with nothing after it is not "no checksum". */
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usage();
    return v;
  };
  const release = flag("--release");
  const by = flag("--by");
  const fromWho = flag("--from-who");
  const sha256 = flag("--sha256");
  const valued = new Set(["--release", "--by", "--from-who", "--sha256"]);
  const path = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
  if (fromWho !== null) {
    if (path !== undefined) throw new Error(`--from-who downloads the file; name a path (${path}) or --from-who, not both`);
    if (release !== null && release !== fromWho) throw new Error(`--release ${release} and --from-who ${fromWho} name two releases`);
    return { fromWho, sha256, by };
  }
  if (sha256 !== null) throw new Error("--sha256 checks a download (--from-who); a local file is recorded by its own sha256");
  if (path === undefined || release === null) throw usage();
  return { path, release, by };
}

export type Icd11Source = { bytes: Buffer; sourceFile: string; release: string; download: WhoDownload | null };

/**
 * The text file's bytes and what to record them as — read from disk, or downloaded from WHO and
 * checked. Either way the result goes to `loadIcd11Map` unchanged; this is the only fork.
 */
export async function readSource(args: Icd11Args, opts: { fetch?: FetchLike } = {}): Promise<Icd11Source> {
  if ("path" in args) {
    return { bytes: readFileSync(args.path), sourceFile: basename(args.path), release: args.release, download: null };
  }
  const download = await downloadWhoMap(args.fromWho, { fetch: opts.fetch, sha256: args.sha256 });
  /* The record names where the bytes came from: WHO's URL and the entry inside it. */
  return { bytes: download.entry, sourceFile: `${download.url}#${download.entryName}`, release: download.release, download };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  /* Before the pool opens: a download that is refused never touches the database. */
  const src = await readSource(args);
  if (src.download !== null) {
    const d = src.download;
    console.log(`downloaded ${d.url} · ${String(d.zipBytes)} bytes · sha256 ${d.zipSha256} (${d.checksum === "pinned" ? "matches the pin" : "matches --sha256"})`);
    console.log(`  extracted ${d.entryName} · ${String(d.entry.length)} bytes`);
  }
  /* A CLI has no session. The operator names themselves, or the OS account ran it. */
  const loadedBy = args.by ?? `cli:${userInfo().username}`;
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const r = await loadIcd11Map(db, { bytes: src.bytes, sourceFile: src.sourceFile, release: src.release, loadedBy });
    if (r.status === "refused") {
      const e = r.existing;
      console.error(`REFUSED (${r.reason}): release ${e.release} was loaded from ${e.sourceFile} · sha256 ${e.sha256.slice(0, 12)} · by ${e.loadedBy} at ${e.loadedAt.toISOString()}`);
      process.exitCode = 1;
      return;
    }
    console.log(`loaded release ${r.release} · ${String(r.rows)} rows · sha256 ${r.sha256.slice(0, 12)} · header stamp ${r.headerStamp ?? "none"} · by ${loadedBy}`);
    console.log(`  mapped ${String(r.kinds.mapped)} · grouping ${String(r.kinds.grouping)} · no mapping ${String(r.kinds.no_mapping)}`);
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
