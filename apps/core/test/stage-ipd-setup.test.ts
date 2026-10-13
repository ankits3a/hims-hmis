import { eq, inArray } from "drizzle-orm";
import { IPD_RATE_COMPONENTS } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { events, roleAssignments, services, tariffVersions } from "../src/kernel/db/schema";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, createRole } from "../src/kernel/auth/permissions";
import { roleAssigned } from "../src/kernel/auth/events";
import { withTx } from "../src/kernel/db/client";
import { listDefinitions } from "../src/kernel/workflow/definitions";
import { getApprovalType } from "../src/kernel/approvals/types";
import { ADMISSION_WORKFLOW_DEF_KEY, IPD_APPROVAL_TYPE_KEYS } from "../src/modules/ipd";
import { IPD_RATED_CLASSES, parseIpdTariffCsv, upsertGstCategory } from "../src/modules/tariff";
import { TESTING_ROLES, assertStagingOnly, grantTestingRoles, stageIpdSetup } from "../scripts/stage-ipd-setup";
import { UAT_SAMPLE_MARKER, uatSampleTariffCsv } from "../scripts/fixtures/ipd-uat-sample-tariff";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/** STAGING ONLY (lane ipd-stage): the refusals, the sample's marking, and the three steps — none of them approves. */
describe("stage-ipd-setup — the refusals", () => {
  const uat = { DATABASE_URL: "postgres://u:p@db:5432/hmis", HMIS_SYNTHETIC_DATA_OK: "1", HMIS_ENVIRONMENT_LABEL: "UAT ipd-stage" };
  it("runs on UAT", () => { expect(() => assertStagingOnly(uat)).not.toThrow(); });
  it("refuses without the synthetic-data door", () => {
    expect(() => assertStagingOnly({ ...uat, HMIS_SYNTHETIC_DATA_OK: undefined })).toThrow(/REFUSED/);
  });
  it("refuses a label that is not UAT", () => {
    expect(() => assertStagingOnly({ ...uat, HMIS_ENVIRONMENT_LABEL: "" })).toThrow(/not a UAT label/);
    expect(() => assertStagingOnly({ ...uat, HMIS_ENVIRONMENT_LABEL: "PRODUCTION" })).toThrow(/not a UAT label/);
  });
  it("refuses production's database port", () => {
    expect(() => assertStagingOnly({ ...uat, DATABASE_URL: "postgres://u:p@localhost:5434/hmis" })).toThrow(/production/);
  });
});

describe("the UAT sample tariff", () => {
  it("parses clean, covers every rated class × every component, and every row carries the marker", () => {
    const parsed = parseIpdTariffCsv(uatSampleTariffCsv());
    expect(parsed.errors).toEqual([]);
    expect(parsed.rates).toHaveLength(IPD_RATED_CLASSES.length * IPD_RATE_COMPONENTS.length);
    expect(parsed.rates.every((r) => r.incumbentName.startsWith(UAT_SAMPLE_MARKER))).toBe(true);
    expect(parsed.rates.find((r) => r.bedClass === "general" && r.component === "room")?.pricePaise).toBe(100000);
    expect(parsed.rates.find((r) => r.bedClass === "icu" && r.component === "room")?.pricePaise).toBe(600000);
  });
});

describe("stageIpdSetup against a database", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const owner: Actor = { type: "user", id: "test-owner" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await withTx(db, async (tx) => {
      for (const category of ["room_rent_icu", "ipd_care"]) {
        await upsertGstCategory(tx, owner, { category, sacCode: "999311", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null });
      }
      await upsertGstCategory(tx, owner, {
        category: "room_rent", sacCode: "999311", exempt: false, rateBps: 500, specialRule: "room_rent_daily_threshold", thresholdPaise: 500000,
      });
    });
  });

  it("registers the approval types, DRAFTS the workflow (never active), drafts the sample tariff — and a rerun writes nothing", async () => {
    const first = await stageIpdSetup(db);
    expect(first.approvalTypes.registered.sort()).toEqual(Object.values(IPD_APPROVAL_TYPE_KEYS).sort());
    for (const k of Object.values(IPD_APPROVAL_TYPE_KEYS)) expect(await withTx(db, (tx) => getApprovalType(tx, k))).toBeTruthy();

    expect(first.workflow.action).toBe("drafted");
    const defs = await listDefinitions(db, ADMISSION_WORKFLOW_DEF_KEY);
    expect(defs.map((d) => d.status)).toEqual(["draft"]);
    expect(defs[0]!.activatedBy).toBeNull();

    expect(first.tariff.action).toBe("drafted");
    const versions = await db.select().from(tariffVersions);
    expect(versions.map((v) => v.status)).toEqual(["draft"]);
    expect(versions[0]!.notes).toContain(UAT_SAMPLE_MARKER);
    const ipd = (await db.select().from(services)).filter((s) => s.code.startsWith("IPD_"));
    expect(ipd).toHaveLength(IPD_RATED_CLASSES.length * IPD_RATE_COMPONENTS.length);
    expect(ipd.every((s) => s.active === false)).toBe(true);

    const second = await stageIpdSetup(db);
    expect(second.approvalTypes.registered).toEqual([]);
    expect(second.workflow).toMatchObject({ action: "already", definitionId: first.workflow.definitionId, status: "draft" });
    expect(second.tariff.action).toBe("already");
    expect(await db.select().from(tariffVersions)).toHaveLength(1);
    expect((await db.select().from(tariffVersions).where(inArray(tariffVersions.status, ["submitted", "activated"])))).toEqual([]);
    expect((await listDefinitions(db, ADMISSION_WORKFLOW_DEF_KEY)).filter((d) => d.status === "active")).toEqual([]);
    expect((await db.select().from(services).where(eq(services.active, true))).filter((s) => s.code.startsWith("IPD_"))).toEqual([]);
  });

  it("(d) grants the testing roles to the ONE all-roles account only, with a role.assigned event each; a rerun grants nothing; a tie refuses", async () => {
    const mk = async (username: string, roleKeys: string[]): Promise<string> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      for (const roleKey of roleKeys) await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
      return id;
    };
    for (const k of ["owner", "admin", "cashier", ...TESTING_ROLES]) await createRole(db, k, k);
    const all = await mk("allroles", ["owner", "admin", "cashier"]);
    const other = await mk("secondowner", ["owner", "admin"]);
    const nurse = await mk("plain", ["cashier"]);

    const first = await grantTestingRoles(db);
    expect(first).toMatchObject({ action: "granted", granted: [...TESTING_ROLES], already: [], missingRoles: [] });
    const rows = await db.select().from(roleAssignments);
    const of = (id: string): string[] => rows.filter((r) => r.userId === id).map((r) => r.roleKey).sort();
    expect(of(all)).toEqual(["owner", "admin", "cashier", ...TESTING_ROLES].sort());
    expect(of(other)).toEqual(["admin", "owner"]);
    expect(of(nurse)).toEqual(["cashier"]);
    const ev = (await db.select().from(events)).filter((e) => e.name === roleAssigned.name);
    expect(ev.map((e) => (e.payload as { userId: string; roleKey: string }).roleKey).sort()).toEqual([...TESTING_ROLES].sort());
    expect(ev.every((e) => (e.payload as { userId: string }).userId === all)).toBe(true);

    expect(await grantTestingRoles(db)).toMatchObject({ action: "already", granted: [], already: [...TESTING_ROLES] });
    expect((await db.select().from(events)).filter((e) => e.name === roleAssigned.name)).toHaveLength(TESTING_ROLES.length);

    // a second account with as many roles → not unique → refused, nothing written
    await mk("twin", ["owner", "admin", "cashier", ...TESTING_ROLES]);
    const before = (await db.select().from(roleAssignments)).length;
    expect(await grantTestingRoles(db)).toMatchObject({ action: "refused" });
    expect((await db.select().from(roleAssignments)).length).toBe(before);
  });
});
