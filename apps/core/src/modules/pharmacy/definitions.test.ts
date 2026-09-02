import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { getActiveDefinition, listDefinitions } from "../../kernel/workflow/definitions";
import { activatePharmacyDefinitions, PHARMACY_DEF_KEYS } from "./definitions";
import type { Db } from "../../kernel/db/client";

describe("activatePharmacyDefinitions (16c T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); await seedSodPairs(db); await ensureRole(db, "owner"); });

  it("activates the dispense definition once; a second call mints no second version", async () => {
    const { actor } = await mkUser(db, "pharmacy.def.activator", []);
    const first = await activatePharmacyDefinitions(db, actor);
    expect(first).toEqual({ activated: [...PHARMACY_DEF_KEYS], alreadyActive: [] });
    const active = await withTx(db, (tx) => getActiveDefinition(tx, "pharmacy_dispense"));
    expect(active?.status).toBe("active");
    expect(active?.changeClass).toBe("C");
    const second = await activatePharmacyDefinitions(db, actor);
    expect(second).toEqual({ activated: [], alreadyActive: [...PHARMACY_DEF_KEYS] });
    expect(await listDefinitions(db, "pharmacy_dispense")).toHaveLength(1);
  });
});
