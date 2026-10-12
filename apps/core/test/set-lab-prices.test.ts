import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedBillingBase } from "./helpers/billing";
import { ensureRole, mkUser } from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { tariffVersions } from "../src/kernel/db/schema";
import { activePricePaise, resolveActiveTariffVersion } from "../src/modules/tariff";
import { seedLabCatalogue, serviceIdForLabCode } from "../scripts/seed-lab-catalogue";
import { LAB_PRICE_NOTE, setLabPrices } from "../scripts/set-lab-prices";
import { LAB_PRICES_2026_10 } from "../scripts/data/lab-prices-2026-10";
import type { Db } from "../src/kernel/db/client";

/**
 * Owner 2026-10-12 — the lab price list goes into force as a NEW tariff version on the direct road,
 * in the name of a person who holds both tariff grants; every other price carries over; a dry run
 * writes nothing; a code with no lab service is reported, not invented.
 */
describe("set-lab-prices", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  // The real clock: seedBillingBase activates version 1 at "now", and a new version must start after it.
  let NOW: Date;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const base = await seedBillingBase(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await ensureRole(db, "pathologist");
    await grantPermissionToRole(db, registry, "pathologist", "lab.catalogue.manage");
    const { actor: curator } = await mkUser(db, "dr.path", ["pathologist"]);
    await seedLabCatalogue(db, curator);
    await ensureRole(db, "price_admin");
    for (const p of ["tariff.versions.draft", "tariff.versions.activate"]) await grantPermissionToRole(db, registry, "price_admin", p);
    await mkUser(db, "admin.prices", ["price_admin"]);
    await mkUser(db, "clerk", []);
    expect(base.tariffVersionId).toBeTruthy();
    NOW = new Date(Date.now() + 1000);
  });

  it("refuses a person without both tariff grants", async () => {
    await expect(setLabPrices(db, "clerk", true, NOW)).rejects.toThrow(/does not hold tariff.versions.draft/);
  });

  it("dry run writes nothing; --apply puts a new version in force with the lab prices and every other price unchanged; a rerun changes nothing", async () => {
    const before = await resolveActiveTariffVersion(db, NOW);
    const dry = await setLabPrices(db, "admin.prices", false, NOW);
    expect(dry.applied).toBe(false);
    expect(dry.priced).toBe(64); // the golden catalogue's 64 lab services; the rest of the list has no service here
    expect(dry.noService.length).toBe(Object.keys(LAB_PRICES_2026_10).length - 64);
    expect(await db.select().from(tariffVersions)).toHaveLength(1);

    const done = await setLabPrices(db, "admin.prices", true, NOW);
    expect([done.applied, done.priced, done.versionNo]).toEqual([true, 64, 2]);
    const after = await resolveActiveTariffVersion(db, new Date(NOW.getTime() + 1000));
    expect(after!.versionNo).toBe(2);
    expect(await activePricePaise(db, serviceIdForLabCode("CBC"), new Date(NOW.getTime() + 1000))).toBe(LAB_PRICES_2026_10.CBC! * 100);
    const [v2] = await db.select().from(tariffVersions).where(eq(tariffVersions.versionNo, 2));
    expect(v2!.notes).toBe(LAB_PRICE_NOTE);
    expect(before!.versionNo).toBe(1);

    const again = await setLabPrices(db, "admin.prices", true, new Date(NOW.getTime() + 2000));
    expect([again.applied, again.priced, again.unchanged]).toEqual([false, 0, 64]);
  });
});
