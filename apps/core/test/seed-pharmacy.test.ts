import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { resources } from "../src/kernel/db/schema";
import { withTx } from "../src/kernel/db/client";
import { getActiveDefinition } from "../src/kernel/workflow/definitions";
import { CONTROLLED_STORE_CODE, OPD_PHARMACY_STORE_CODE, PHARMACY_DISPENSE_DEF_KEY, RETAIL_PHARMACY_STORE_CODE } from "../src/modules/pharmacy";
import { createStore, isControlledStore } from "../src/modules/materials";
import { ensurePharmacyCounter } from "../scripts/seed-pharmacy";
import { classifyAwareGoLive } from "../scripts/classify-aware";
import { mkUser } from "./helpers/opd";
import { addMedicine, addSalt } from "../src/modules/formulary";
import { formularyMedicines } from "../src/kernel/db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

const actor: Actor = { type: "user", id: "test-seed-pharmacy" };

describe("seed:pharmacy — the counter's store and definition (16c T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("creates PHARM-OPD, PHARM-RETAIL (P19) and the controlled cabinet PHARM-NDPS (P6), and activates pharmacy_dispense once; a second run finds them and creates nothing", async () => {
    const first = await ensurePharmacyCounter(db, actor);
    expect(first.created).toEqual([OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE, CONTROLLED_STORE_CODE]);
    expect(first.found).toEqual([]);
    expect(first.definitions).toEqual({ activated: [PHARMACY_DISPENSE_DEF_KEY], alreadyActive: [] });
    // STAGE D5 — the steward's approval type is a deploy fact (else `unknown_type` at the first ask in production).
    expect(first.approvalTypes).toEqual({ registered: ["pharmacy_restricted_antimicrobial", "pharmacy_discount_incharge", "pharmacy_discount_owner"], already: [] });
    const [store] = await db.select().from(resources).where(eq(resources.id, first.storeId));
    expect(store).toMatchObject({ kind: "store", code: OPD_PHARMACY_STORE_CODE, attributes: { custodianRoles: ["pharmacy", "pharmacy_assistant"] } });
    expect(first.custodiansSet).toBe(true);
    expect((await withTx(db, (tx) => getActiveDefinition(tx, PHARMACY_DISPENSE_DEF_KEY)))?.status).toBe("active");

    const second = await ensurePharmacyCounter(db, actor);
    expect(second).toEqual({
      storeId: first.storeId, created: [], found: [OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE, CONTROLLED_STORE_CODE], custodiansSet: false,
      definitions: { activated: [], alreadyActive: [PHARMACY_DISPENSE_DEF_KEY] },
      approvalTypes: { registered: [], already: ["pharmacy_restricted_antimicrobial", "pharmacy_discount_incharge", "pharmacy_discount_owner"] },
    });
    const stores = await db.select().from(resources).where(eq(resources.kind, "store"));
    expect(stores).toHaveLength(3);
    // P6 — the cabinet is the one CONTROLLED store: the ledger wants two keys there, and nowhere else.
    expect(stores.filter((r) => isControlledStore(r)).map((r) => r.code)).toEqual([CONTROLLED_STORE_CODE]);
    // The retail store's staff keep it too: they may not count their own shelf (14c).
    expect(stores.find((r) => r.code === RETAIL_PHARMACY_STORE_CODE)?.attributes).toEqual({ custodianRoles: ["pharmacy", "pharmacy_assistant"] });
  });

  /**
   * COUNTS: THE PHARMACY'S STAFF KEEP ITS STORE. A store seeded before the custodian attribute
   * existed (production's) gets it on the next deploy, merged into whatever attributes it has.
   */
  it("gives an existing PHARM-OPD its custodian roles on the next run, keeping its other attributes", async () => {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, actor, { code: OPD_PHARMACY_STORE_CODE, name: "OPD pharmacy counter", attributes: { floor: "G" } }));
    const run = await ensurePharmacyCounter(db, actor);
    expect(run).toMatchObject({ storeId: resourceId, found: [OPD_PHARMACY_STORE_CODE], created: [RETAIL_PHARMACY_STORE_CODE, CONTROLLED_STORE_CODE], custodiansSet: true });
    const [store] = await db.select().from(resources).where(eq(resources.id, resourceId));
    expect(store?.attributes).toEqual({ floor: "G", custodianRoles: ["pharmacy", "pharmacy_assistant"] });
  });

  /**
   * STAGE D5 GO-LIVE IS ITS OWN ACT. deploy.sh runs this seed on every deploy, so a seed that classified the
   * catalogue would restrict every carbapenem and Reserve antibiotic in production the moment the code shipped —
   * refused at both counters while nobody yet holds antimicrobial_steward. The classification lives in
   * `scripts/classify-aware.ts`, which deploy.sh never calls, and which refuses until a steward is appointed.
   */
  it("classifies and restricts nothing — a deploy leaves the D5 gate dormant", async () => {
    const meronem = await withTx(db, async (tx) => {
      const mero = await addSalt(tx, actor, { name: "meropenem" });
      return (await addMedicine(tx, actor, { brandName: "Meronem 1 g", form: "Powder for solution for injection", routeClass: "systemic", strengthLabel: null, salts: [{ saltId: mero.saltId }] })).medicineId;
    });
    await ensurePharmacyCounter(db, actor);
    const [row] = await db.select({ c: formularyMedicines.awareCategory, r: formularyMedicines.antimicrobialRestricted }).from(formularyMedicines).where(eq(formularyMedicines.id, meronem));
    expect(row).toEqual({ c: null, r: false });
  });

  it("aware:classify refuses while nobody holds antimicrobial_steward, and classifies once one does", async () => {
    const meronem = await withTx(db, async (tx) => {
      const mero = await addSalt(tx, actor, { name: "meropenem" });
      return (await addMedicine(tx, actor, { brandName: "Meronem 1 g", form: "Powder for solution for injection", routeClass: "systemic", strengthLabel: null, salts: [{ saltId: mero.saltId }] })).medicineId;
    });
    await expect(classifyAwareGoLive(db, actor)).rejects.toThrow(/antimicrobial_steward/);
    const read = async () => (await db.select({ c: formularyMedicines.awareCategory, r: formularyMedicines.antimicrobialRestricted }).from(formularyMedicines).where(eq(formularyMedicines.id, meronem)))[0];
    expect(await read()).toEqual({ c: null, r: false });
    await mkUser(db, "dr.steward", ["antimicrobial_steward"]);
    const report = await classifyAwareGoLive(db, actor);
    expect(report.restricted).toBe(1);
    expect(await read()).toEqual({ c: "Watch", r: true });
  });
});
