import { setupTestDb, truncateAll } from "./helpers/db";
import { resources, roleAssignments, services, stockLedger, tariffVersions } from "../src/kernel/db/schema";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, createRole } from "../src/kernel/auth/permissions";
import { listDefinitions } from "../src/kernel/workflow/definitions";
import { ER_EPISODE_WORKFLOW_DEF_KEY, ER_SATELLITE_STORE_CODE } from "../src/modules/emergency";
import { assertStagingOnly, stageErSetup } from "../scripts/stage-er-setup";
import type { Db } from "../src/kernel/db/client";

/** STAGING ONLY (ER lane 4, #811): the refusals, and the three steps — none approves, activates or stocks anything. */
describe("stage-er-setup — the refusals", () => {
  const uat = { DATABASE_URL: "postgres://u:p@db:5432/hmis", HMIS_SYNTHETIC_DATA_OK: "1", HMIS_ENVIRONMENT_LABEL: "UAT ipd-stage" };
  it("runs on UAT and refuses anywhere else", () => {
    expect(() => assertStagingOnly(uat)).not.toThrow();
    expect(() => assertStagingOnly({ ...uat, HMIS_SYNTHETIC_DATA_OK: undefined })).toThrow(/REFUSED/);
    expect(() => assertStagingOnly({ ...uat, HMIS_ENVIRONMENT_LABEL: "PRODUCTION" })).toThrow(/not a UAT label/);
    expect(() => assertStagingOnly({ ...uat, DATABASE_URL: "postgres://u:p@localhost:5434/hmis" })).toThrow(/production/);
  });
});

describe("stageErSetup against a database", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  it("drafts the episode workflow (never active), creates the EMPTY ER-SAT store, grants er_nurse to the all-roles account — a rerun writes nothing", async () => {
    for (const k of ["owner", "admin", "er_nurse"]) await createRole(db, k, k);
    const { id: all } = await createUser(db, { username: "allroles", fullName: "allroles", password: "p1234567" });
    for (const roleKey of ["owner", "admin"]) await assignRole(db, { userId: all, roleKey, scopeType: "hospital" });

    const first = await stageErSetup(db);
    expect(first.workflow.action).toBe("drafted");
    expect((await listDefinitions(db, ER_EPISODE_WORKFLOW_DEF_KEY)).map((d) => [d.status, d.activatedBy])).toEqual([["draft", null]]);
    expect(first.store.action).toBe("created");
    const stores = (await db.select().from(resources)).filter((r) => r.kind === "store");
    expect(stores.map((s) => s.code)).toEqual([ER_SATELLITE_STORE_CODE]);
    expect(await db.select().from(stockLedger)).toEqual([]);
    expect(first.testingRoles).toMatchObject({ action: "granted", granted: ["er_nurse"] });
    expect((await db.select().from(roleAssignments)).filter((r) => r.userId === all).map((r) => r.roleKey).sort()).toEqual(["admin", "er_nurse", "owner"]);

    // d. the sample ER tariff: a DRAFT version, its services inactive.
    expect(first.sampleTariff.action).toBe("drafted");
    expect(first.sampleTariff.servicesCreated.sort()).toEqual(["ER-DRUG", "ER-OBS", "ER-PHYS", "ER-REG"]);
    const versions = await db.select().from(tariffVersions);
    expect(versions.filter((v) => (v.notes ?? "").includes("UAT SAMPLE")).map((v) => v.status)).toEqual(["draft"]);
    expect((await db.select().from(services)).filter((s) => s.code.startsWith("ER-")).every((s) => s.active === false)).toBe(true);

    const second = await stageErSetup(db);
    expect(second).toMatchObject({
      workflow: { action: "already", definitionId: first.workflow.definitionId, status: "draft" },
      store: { action: "already", storeId: first.store.storeId },
      testingRoles: { action: "already", granted: [] },
      sampleTariff: { action: "already" },
    });
    expect((await db.select().from(resources)).filter((r) => r.kind === "store")).toHaveLength(1);
  });
});
