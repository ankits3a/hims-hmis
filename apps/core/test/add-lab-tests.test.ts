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
 * Owner 2026-10-13 — Active B12, HIV rapid card, the thyroid menu, TIBC and CK-MB added to a
 * hospital that already holds the standard catalogue: only the missing rows are written, nothing
 * existing is touched, the new ranges name the review, and a rerun writes nothing.
 */
describe("add-lab-tests", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const NOW = new Date("2026-10-13T05:00:00Z");
  const NEW_PARAMETERS = ["HIV_RAPID", "HOLOTC"];

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
    // The catalogue production holds: the standard one as loaded on 2026-10-12, before these tests.
    const d = LAB_CATALOGUE_STANDARD_DATA;
    await seedLabCatalogue(db, actor, {
      ...d,
      orderables: d.orderables.filter((o) => !LAB_TESTS_TO_ADD.includes(o.code)),
      analytes: d.analytes.filter((a) => !NEW_PARAMETERS.includes(a.code)),
      referenceRanges: d.referenceRanges.filter((r) => !NEW_PARAMETERS.includes(r.analyteCode)),
    });
  });

  it("refuses a reviewer who is not a pathologist", async () => {
    await expect(addLabTests(db, "lab.desk", true, NOW)).rejects.toThrow(/pathologist's grant/);
  });

  it("dry run writes nothing; --apply adds the 9 tests, 2 parameters and their 2 reviewed ranges; existing rows stand; a rerun writes nothing", async () => {
    const t3Before = await db.select().from(labReferenceRanges)
      .innerJoin(labAnalytes, eq(labAnalytes.id, labReferenceRanges.analyteId)).where(eq(labAnalytes.code, "T3"));

    const dry = await addLabTests(db, "admin", false, NOW);
    expect([dry.applied, dry.tests.length, [...dry.parameters].sort(), dry.ranges]).toEqual([false, 9, ["HIV_RAPID", "HOLOTC"], 2]);
    expect(await db.select().from(labOrderables)).toHaveLength(331);

    const done = await addLabTests(db, "admin", true, NOW);
    expect([done.applied, done.tests.length, done.ranges, done.skipped]).toEqual([true, 9, 2, []]);
    expect(await db.select().from(labOrderables)).toHaveLength(340);

    const [rapid] = await db.select().from(labOrderables).where(eq(labOrderables.serviceId, serviceIdForLabCode("HIV_RAPID")));
    expect([rapid!.consentRequired, rapid!.sensitive]).toEqual([false, true]);

    const fresh = await db.select({ code: labAnalytes.code, source: labReferenceRanges.source, text: labReferenceRanges.text })
      .from(labReferenceRanges).innerJoin(labAnalytes, eq(labAnalytes.id, labReferenceRanges.analyteId));
    expect(fresh.filter((r) => NEW_PARAMETERS.includes(r.code)).map((r) => r.source))
      .toEqual(Array(2).fill("Reviewed against this lab's kits by admin (admin), 2026-10-13"));
    const t3After = await db.select().from(labReferenceRanges)
      .innerJoin(labAnalytes, eq(labAnalytes.id, labReferenceRanges.analyteId)).where(eq(labAnalytes.code, "T3"));
    expect(t3After).toEqual(t3Before);

    const [imp] = await db.select().from(labCatalogueImports);
    expect([imp!.orderablesWritten, imp!.analytesWritten, imp!.rangesWritten]).toEqual([9, 2, 2]);

    const again = await addLabTests(db, "admin", true, NOW);
    expect([again.applied, again.tests, again.skipped.length]).toEqual([false, [], 9]);
    expect(await db.select().from(labCatalogueImports)).toHaveLength(1);
  });
});
