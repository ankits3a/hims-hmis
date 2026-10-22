import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { ensureRole, mkUser } from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { labAnalytes, labCatalogueImports, labOrderables, labReferenceRanges, registrationConfig } from "../src/kernel/db/schema";
import { labManifest } from "../src/modules/lab/manifest";
import { LAB_TESTS_TO_ADD, addLabTests } from "../scripts/add-lab-tests";
import { LAB_CATALOGUE_STANDARD_DATA } from "../scripts/data/lab-catalogue-standard";
import { seedLabCatalogue, serviceIdForLabCode } from "../scripts/seed-lab-catalogue";
import type { Db } from "../src/kernel/db/client";

/**
 * Owner 2026-10-13 — Active B12, HIV rapid card, the thyroid menu, TIBC, CK-MB and the ~700-test menu added to a
 * hospital that already holds the standard catalogue: only the missing rows are written, nothing
 * existing is touched, the new ranges name the review, and a rerun writes nothing.
 */
describe("add-lab-tests", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const NOW = new Date("2026-10-13T05:00:00Z");
  const d = LAB_CATALOGUE_STANDARD_DATA;
  // The catalogue production holds: the standard one as loaded on 2026-10-12, before the added tests.
  const baseline = d.orderables.filter((o) => !LAB_TESTS_TO_ADD.includes(o.code));
  const baselineUsed = new Set(baseline.flatMap((o) => o.analyteCodes));
  // Parameters the 2026-10-12 load held although no test of it named them.
  const UNUSED_IN_BASELINE = ["PSMEAR", "T3", "T4"];
  const NEW_PARAMETERS = d.analytes.filter((a) => !baselineUsed.has(a.code) && !UNUSED_IN_BASELINE.includes(a.code)).map((a) => a.code);
  const NEW_RANGES = d.referenceRanges.filter((r) => NEW_PARAMETERS.includes(r.analyteCode)).length;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    const registry = new ModuleRegistry();
    registry.install(labManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "pathologist");
    for (const p of ["lab.catalogue.manage", "lab.results.verify"]) await grantPermissionToRole(db, registry, "pathologist", p);
    const { actor } = await mkUser(db, "admin", ["pathologist"]);
    await mkUser(db, "lab.desk", ["lab_reception"]);
    await seedLabCatalogue(db, actor, {
      ...d,
      orderables: baseline,
      analytes: d.analytes.filter((a) => !NEW_PARAMETERS.includes(a.code)),
      referenceRanges: d.referenceRanges.filter((r) => !NEW_PARAMETERS.includes(r.analyteCode)),
    });
  });

  it("refuses a reviewer who is not a pathologist", async () => {
    await expect(addLabTests(db, "lab.desk", true, NOW)).rejects.toThrow(/pathologist's grant/);
  });

  it("the baseline is the 2026-10-12 production load (331 tests, 583 parameters) plus #934's four differential parameters", () => {
    // #934 added GRAN, GRAN_ABS, MID and MID_ABS to the standard data: 583 -> 587.
    expect([baseline.length, d.analytes.length - NEW_PARAMETERS.length]).toEqual([331, 587]);
  });

  it("dry run writes nothing; --apply adds the 378 tests, their new parameters and reviewed ranges; existing rows stand; a rerun writes nothing", async () => {
    const t3Before = await db.select().from(labReferenceRanges)
      .innerJoin(labAnalytes, eq(labAnalytes.id, labReferenceRanges.analyteId)).where(eq(labAnalytes.code, "T3"));

    const dry = await addLabTests(db, "admin", false, NOW);
    expect([dry.applied, dry.tests.length, [...dry.parameters].sort(), dry.ranges]).toEqual([false, 378, [...NEW_PARAMETERS].sort(), NEW_RANGES]);
    expect(await db.select().from(labOrderables)).toHaveLength(331);

    const done = await addLabTests(db, "admin", true, NOW);
    expect([done.applied, done.tests.length, done.ranges, done.skipped]).toEqual([true, 378, NEW_RANGES, []]);
    expect(await db.select().from(labOrderables)).toHaveLength(709);

    const [rapid] = await db.select().from(labOrderables).where(eq(labOrderables.serviceId, serviceIdForLabCode("HIV_RAPID")));
    expect([rapid!.consentRequired, rapid!.sensitive]).toEqual([false, true]);

    const fresh = await db.select({ code: labAnalytes.code, source: labReferenceRanges.source, text: labReferenceRanges.text })
      .from(labReferenceRanges).innerJoin(labAnalytes, eq(labAnalytes.id, labReferenceRanges.analyteId));
    expect(fresh.filter((r) => NEW_PARAMETERS.includes(r.code)).map((r) => r.source))
      .toEqual(Array(NEW_RANGES).fill("Reviewed against this lab's kits by admin (admin), 2026-10-13"));
    const t3After = await db.select().from(labReferenceRanges)
      .innerJoin(labAnalytes, eq(labAnalytes.id, labReferenceRanges.analyteId)).where(eq(labAnalytes.code, "T3"));
    expect(t3After).toEqual(t3Before);

    const [imp] = await db.select().from(labCatalogueImports);
    expect([imp!.orderablesWritten, imp!.analytesWritten, imp!.rangesWritten]).toEqual([378, NEW_PARAMETERS.length, NEW_RANGES]);

    const again = await addLabTests(db, "admin", true, NOW);
    expect([again.applied, again.tests, again.skipped.length]).toEqual([false, [], 378]);
    expect(await db.select().from(labCatalogueImports)).toHaveLength(1);
  });
});
