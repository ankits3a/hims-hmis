import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { resources } from "../src/kernel/db/schema";
import { withTx } from "../src/kernel/db/client";
import { getActiveDefinition } from "../src/kernel/workflow/definitions";
import { OPD_PHARMACY_STORE_CODE, PHARMACY_DISPENSE_DEF_KEY } from "../src/modules/pharmacy";
import { createStore } from "../src/modules/materials";
import { ensurePharmacyCounter } from "../scripts/seed-pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

const actor: Actor = { type: "user", id: "test-seed-pharmacy" };

describe("seed:pharmacy — the counter's store and definition (16c T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("creates PHARM-OPD and activates pharmacy_dispense once; a second run finds both and creates nothing", async () => {
    const first = await ensurePharmacyCounter(db, actor);
    expect(first.created).toEqual([OPD_PHARMACY_STORE_CODE]);
    expect(first.found).toEqual([]);
    expect(first.definitions).toEqual({ activated: [PHARMACY_DISPENSE_DEF_KEY], alreadyActive: [] });
    const [store] = await db.select().from(resources).where(eq(resources.id, first.storeId));
    expect(store).toMatchObject({ kind: "store", code: OPD_PHARMACY_STORE_CODE, attributes: { custodianRoles: ["pharmacy", "pharmacy_assistant"] } });
    expect(first.custodiansSet).toBe(true);
    expect((await withTx(db, (tx) => getActiveDefinition(tx, PHARMACY_DISPENSE_DEF_KEY)))?.status).toBe("active");

    const second = await ensurePharmacyCounter(db, actor);
    expect(second).toEqual({ storeId: first.storeId, created: [], found: [OPD_PHARMACY_STORE_CODE], custodiansSet: false, definitions: { activated: [], alreadyActive: [PHARMACY_DISPENSE_DEF_KEY] } });
    expect(await db.select().from(resources).where(eq(resources.kind, "store"))).toHaveLength(1);
  });

  /**
   * COUNTS: THE PHARMACY'S STAFF KEEP ITS STORE. A store seeded before the custodian attribute
   * existed (production's) gets it on the next deploy, merged into whatever attributes it has.
   */
  it("gives an existing PHARM-OPD its custodian roles on the next run, keeping its other attributes", async () => {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, actor, { code: OPD_PHARMACY_STORE_CODE, name: "OPD pharmacy counter", attributes: { floor: "G" } }));
    const run = await ensurePharmacyCounter(db, actor);
    expect(run).toMatchObject({ storeId: resourceId, found: [OPD_PHARMACY_STORE_CODE], custodiansSet: true });
    const [store] = await db.select().from(resources).where(eq(resources.id, resourceId));
    expect(store?.attributes).toEqual({ floor: "G", custodianRoles: ["pharmacy", "pharmacy_assistant"] });
  });
});
