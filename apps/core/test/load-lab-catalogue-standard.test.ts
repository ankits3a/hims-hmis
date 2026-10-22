import { setupTestDb, truncateAll } from "./helpers/db";
import { ensureRole, mkUser } from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { labCatalogueImports, labOrderables, labReferenceRanges, registrationConfig } from "../src/kernel/db/schema";
import { labManifest } from "../src/modules/lab/manifest";
import { loadStandardCatalogue } from "../scripts/load-lab-catalogue-standard";
import type { Db } from "../src/kernel/db/client";

/**
 * Owner 2026-10-12 — the standard catalogue goes to production only on a pathologist's review: the
 * reviewer must hold the pathologist's grant, every range names the review, a dry run writes nothing,
 * and a database that already holds a catalogue is refused rather than overwritten.
 */
describe("load-lab-catalogue-standard", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const NOW = new Date("2026-10-12T05:00:00Z");

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
    await mkUser(db, "dr.archana", ["pathologist"]);
    await mkUser(db, "lab.desk", ["lab_reception"]);
  });

  it("refuses a reviewer who is not a pathologist, and an unknown user", async () => {
    await expect(loadStandardCatalogue(db, "lab.desk", true, NOW)).rejects.toThrow(/pathologist's grant/);
    await expect(loadStandardCatalogue(db, "nobody", true, NOW)).rejects.toThrow(/no user nobody/);
  });

  it("a dry run writes nothing; --apply loads 709 tests with every range naming its review, records the import, and a second run is refused", async () => {
    const dry = await loadStandardCatalogue(db, "dr.archana", false, NOW);
    expect([dry.applied, dry.tests, dry.parameters, dry.ranges]).toEqual([false, 709, 1010, 1001]);
    expect(await db.select().from(labOrderables)).toHaveLength(0);

    const done = await loadStandardCatalogue(db, "dr.archana", true, NOW);
    expect([done.applied, done.tests, done.parameters, done.ranges]).toEqual([true, 709, 1010, 1001]);
    const sources = new Set((await db.select().from(labReferenceRanges)).map((r) => r.source));
    expect([...sources]).toEqual(["Reviewed against this lab's kits by dr.archana (dr.archana), 2026-10-12"]);
    const [imp] = await db.select().from(labCatalogueImports);
    expect([imp!.orderablesWritten, imp!.analytesWritten, imp!.rangesWritten, imp!.finishedAt !== null]).toEqual([709, 1010, 1001, true]);

    await expect(loadStandardCatalogue(db, "dr.archana", true, NOW)).rejects.toThrow(/already holds 709 lab tests/);
  });
});
