import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { createDb, withTx } from "../src/kernel/db/client";
import { hasPermission } from "../src/kernel/auth/permissions";
import { istDayString } from "../src/kernel/approvals/cumulative";
import { labAnalytes, labCatalogueImports, labOrderables, services, users } from "../src/kernel/db/schema";
import { putReferenceRange, upsertAnalyte, upsertOrderable } from "../src/modules/lab";
import { serviceIdForLabCode } from "./seed-lab-catalogue";
import { LAB_CATALOGUE_STANDARD_DATA } from "./data/lab-catalogue-standard";
import { LAB_TESTS_ADDED } from "./data/lab-tests-added";
import { REVIEWED_SOURCE } from "./load-lab-catalogue-standard";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";
import type { LabCatalogueFixture } from "./seed-lab-catalogue";

/**
 * `node dist/scripts/add-lab-tests.js --reviewed-by <username> [--apply]`
 *
 * ═══ NEW TESTS INTO A HOSPITAL THAT ALREADY HAS A CATALOGUE ═══
 *
 * `load-lab-catalogue-standard` loads the whole standard catalogue once and refuses a database that
 * already holds one. Tests added to the standard catalogue afterwards reach production through this
 * loader instead: it ADDS the orderables named in `data/lab-tests-added.ts` that the database lacks, the
 * parameters they need that the database lacks, and the ranges of those new parameters only.
 *
 *   · it never edits an existing test, parameter or range — a hospital's own edits stand;
 *   · an orderable already present is skipped and reported, so a second run writes nothing;
 *   · the reviewer must hold the pathologist's grant, and each new range names the review
 *     (owner 2026-10-13: "use text values for the ranges and mark it approved by admin");
 *   · one transaction and one `lab_catalogue_imports` row.
 *
 * Prices are separate: `set-lab-prices.ts` prices the new services afterwards. Dry run by default.
 */
export const LAB_TESTS_TO_ADD: readonly string[] = LAB_TESTS_ADDED;

export async function addLabTests(
  db: Db, reviewer: string, apply: boolean, now: Date = new Date(),
  codes: readonly string[] = LAB_TESTS_TO_ADD, data: LabCatalogueFixture = LAB_CATALOGUE_STANDARD_DATA,
): Promise<{ applied: boolean; tests: string[]; parameters: string[]; ranges: number; skipped: string[] }> {
  const [u] = await db.select({ id: users.id, fullName: users.fullName, username: users.username }).from(users)
    .where(eq(users.username, reviewer));
  if (!u) throw new Error(`no user ${reviewer}`);
  if (!(await hasPermission(db, u.id, "lab.results.verify", "hospital"))) {
    throw new Error(`${reviewer} does not hold the pathologist's grant (lab.results.verify); the review is a pathologist's act`);
  }

  const wanted = codes.map((code) => {
    const o = data.orderables.find((x) => x.code === code);
    if (!o) throw new Error(`${code} is not in the standard catalogue`);
    return o;
  });
  const present = new Set((await db.select({ serviceId: labOrderables.serviceId }).from(labOrderables)
    .where(inArray(labOrderables.serviceId, codes.map(serviceIdForLabCode)))).map((r) => r.serviceId));
  const toAdd = wanted.filter((o) => !present.has(serviceIdForLabCode(o.code)));
  const skipped = wanted.filter((o) => present.has(serviceIdForLabCode(o.code))).map((o) => o.code);

  const needed = [...new Set(toAdd.flatMap((o) => o.analyteCodes))];
  const known = new Set(needed.length === 0 ? [] : (await db.select({ code: labAnalytes.code }).from(labAnalytes)
    .where(inArray(labAnalytes.code, needed))).map((r) => r.code));
  const newAnalytes = needed.filter((c) => !known.has(c)).map((code) => {
    const a = data.analytes.find((x) => x.code === code);
    if (!a) throw new Error(`parameter ${code} is not in the standard catalogue`);
    return a;
  });
  const source = REVIEWED_SOURCE(u.fullName, u.username, istDayString(now));
  const newRanges = data.referenceRanges.filter((r) => newAnalytes.some((a) => a.code === r.analyteCode));

  const result = {
    tests: toAdd.map((o) => o.code), parameters: newAnalytes.map((a) => a.code), ranges: newRanges.length, skipped,
  };
  if (!apply || toAdd.length === 0) return { applied: false, ...result };

  const actor: Actor = { type: "user", id: u.id } as Actor;
  await withTx(db, async (tx: Tx) => {
    const importId = newId();
    await tx.insert(labCatalogueImports).values({
      id: importId, fileNames: "scripts/add-lab-tests.ts",
      fileHash: createHash("sha256").update(JSON.stringify({ toAdd, newAnalytes, newRanges })).digest("hex"),
      importedBy: u.id, startedAt: now,
    });
    for (const o of toAdd) {
      const id = serviceIdForLabCode(o.code);
      const existing = (await tx.select({ id: services.id }).from(services).where(eq(services.id, id)))[0];
      if (!existing) {
        await tx.insert(services).values({
          id, code: `LAB-${o.code}`, name: o.nameEn, category: "investigation", createdBy: u.id, updatedBy: u.id,
        });
      }
    }
    const ids = new Map<string, string>();
    for (const a of newAnalytes) ids.set(a.code, await upsertAnalyte(tx, actor, a));
    for (const o of toAdd) await upsertOrderable(tx, actor, { ...o, serviceId: serviceIdForLabCode(o.code) });
    for (const r of newRanges) {
      await putReferenceRange(tx, actor, {
        analyteId: ids.get(r.analyteCode)!, sex: r.sex as "male" | "female" | "other" | "any",
        ageMinDays: r.ageMinDays, ageMaxDays: r.ageMaxDays, low: r.low, high: r.high, text: r.text,
        criticalLow: r.criticalLow, criticalHigh: r.criticalHigh, source, effectiveFrom: r.effectiveFrom,
      }, now);
    }
    await tx.update(labCatalogueImports).set({
      analytesWritten: newAnalytes.length, orderablesWritten: toAdd.length, rangesWritten: newRanges.length, finishedAt: new Date(),
    }).where(eq(labCatalogueImports.id, importId));
  });
  return { applied: true, ...result };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("add-lab-tests: DATABASE_URL is not set");
  const args = process.argv.slice(2);
  const at = args.indexOf("--reviewed-by");
  const reviewer = at >= 0 ? args[at + 1] : undefined;
  if (reviewer === undefined || reviewer.startsWith("--")) throw new Error("usage: --reviewed-by <username> [--apply]");
  const { db, pool } = createDb(url);
  try {
    const r = await addLabTests(db, reviewer, args.includes("--apply"));
    console.log(`add-lab-tests — ${JSON.stringify(r)}${r.applied ? "" : " (dry run: add --apply to write)"}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
