import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { createDb } from "../src/kernel/db/client";
import { hasPermission } from "../src/kernel/auth/permissions";
import { istDayString } from "../src/kernel/approvals/cumulative";
import { labCatalogueImports, labOrderables, users } from "../src/kernel/db/schema";
import { seedLabCatalogue } from "./seed-lab-catalogue";
import { LAB_CATALOGUE_STANDARD_DATA } from "./data/lab-catalogue-standard";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";
import type { LabCatalogueFixture } from "./seed-lab-catalogue";

/**
 * `node dist/scripts/load-lab-catalogue-standard.js --reviewed-by <username> [--apply]`
 *
 * ═══ THE STANDARD CATALOGUE INTO A REAL HOSPITAL — ONLY AFTER A PATHOLOGIST HAS SIGNED FOR IT ═══
 *
 * `seed:lab-catalogue` refuses production because its ranges are literature defaults nobody here
 * chose. Owner 2026-10-12: *"I approve to push the 331-test catalogue to production and mark that
 * pathologist (user 'admin') has checked its reference ranges against the lab's kits."* So this door
 * opens on exactly that fact and no other:
 *
 *   · `--reviewed-by` names the user who checked the ranges, and that user must hold the pathologist's
 *     grant (`lab.results.verify`) — the act is theirs, and the rows say so.
 *   · every range's `source` is restamped "Reviewed against this lab's kits by <name> (<username>),
 *     <IST day>" — NABL's question, "where did this range come from", answered on the row.
 *   · it refuses a database that already holds a catalogue: the seed replaces the range book wholesale,
 *     and a hospital's own edited book is not something a loader may overwrite.
 *   · one `lab_catalogue_imports` row records who, when, what and how many.
 *
 * Dry run by default: it reports what it would write and writes nothing.
 */
export const REVIEWED_SOURCE = (fullName: string, username: string, day: string): string =>
  `Reviewed against this lab's kits by ${fullName} (${username}), ${day}`;

export function reviewedCatalogue(data: LabCatalogueFixture, source: string): LabCatalogueFixture {
  return { ...data, referenceRanges: data.referenceRanges.map((r) => ({ ...r, source })) };
}

export async function loadStandardCatalogue(
  db: Db, reviewer: string, apply: boolean, now: Date = new Date(),
): Promise<{ applied: boolean; reviewer: { id: string; fullName: string }; tests: number; parameters: number; ranges: number }> {
  const [u] = await db.select({ id: users.id, fullName: users.fullName, username: users.username }).from(users)
    .where(eq(users.username, reviewer));
  if (!u) throw new Error(`no user ${reviewer}`);
  if (!(await hasPermission(db, u.id, "lab.results.verify", "hospital"))) {
    throw new Error(`${reviewer} does not hold the pathologist's grant (lab.results.verify); the review is a pathologist's act`);
  }
  const n = (await db.select({ n: sql<number>`count(*)::int` }).from(labOrderables))[0]?.n ?? 0;
  if (n > 0) throw new Error(`REFUSED — this database already holds ${String(n)} lab tests; the loader never overwrites a catalogue`);
  const data = reviewedCatalogue(LAB_CATALOGUE_STANDARD_DATA, REVIEWED_SOURCE(u.fullName, u.username, istDayString(now)));
  const counts = { tests: data.orderables.length, parameters: data.analytes.length, ranges: data.referenceRanges.length };
  const reviewerOut = { id: u.id, fullName: u.fullName };
  if (!apply) return { applied: false, reviewer: reviewerOut, ...counts };

  const actor: Actor = { type: "user", id: u.id } as Actor;
  const importId = newId();
  await db.insert(labCatalogueImports).values({
    id: importId, fileNames: "scripts/data/lab-catalogue-standard.ts",
    fileHash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    importedBy: u.id, startedAt: now,
  });
  const report = await seedLabCatalogue(db, actor, data);
  await db.update(labCatalogueImports).set({
    analytesWritten: report.analytes, orderablesWritten: report.orderables, rangesWritten: report.referenceRanges, finishedAt: new Date(),
  }).where(eq(labCatalogueImports.id, importId));
  return { applied: true, reviewer: reviewerOut, tests: report.orderables, parameters: report.analytes, ranges: report.referenceRanges };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("load-lab-catalogue-standard: DATABASE_URL is not set");
  const args = process.argv.slice(2);
  const at = args.indexOf("--reviewed-by");
  const reviewer = at >= 0 ? args[at + 1] : undefined;
  if (reviewer === undefined || reviewer.startsWith("--")) throw new Error("usage: --reviewed-by <username> [--apply]");
  const { db, pool } = createDb(url);
  try {
    const r = await loadStandardCatalogue(db, reviewer, args.includes("--apply"));
    console.log(`load-lab-catalogue-standard — ${JSON.stringify(r)}${r.applied ? "" : " (dry run: add --apply to write)"}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
