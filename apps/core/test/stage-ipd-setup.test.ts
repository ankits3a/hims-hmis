import { eq, inArray } from "drizzle-orm";
import { IPD_RATE_COMPONENTS } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { events, roleAssignments, services, tariffItems, tariffVersions, users } from "../src/kernel/db/schema";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, createRole } from "../src/kernel/auth/permissions";
import { roleAssigned } from "../src/kernel/auth/events";
import { withTx } from "../src/kernel/db/client";
import { listDefinitions } from "../src/kernel/workflow/definitions";
import { getApprovalType } from "../src/kernel/approvals/types";
import { ADMISSION_WORKFLOW_DEF_KEY, IPD_APPROVAL_TYPE_KEYS } from "../src/modules/ipd";
import { IPD_RATED_CLASSES, importIpdTariff, parseIpdTariffCsv, setDraftVersionNotes, upsertGstCategory } from "../src/modules/tariff";
import { TESTING_ROLES, WARD_TEST_USERS, assertStagingOnly, ensureRateCardDraft, ensureWardTestUsers, grantTestingRoles, stageIpdSetup } from "../scripts/stage-ipd-setup";
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

describe("the decision-0074 rate card", () => {
  it("parses clean, covers every rated class × every component, and every row carries the marker", () => {
    const parsed = parseIpdTariffCsv(uatSampleTariffCsv());
    expect(parsed.errors).toEqual([]);
    expect(parsed.rates).toHaveLength(IPD_RATED_CLASSES.length * IPD_RATE_COMPONENTS.length);
    expect(parsed.rates.every((r) => r.incumbentName.startsWith(UAT_SAMPLE_MARKER))).toBe(true);
    expect(parsed.rates.find((r) => r.bedClass === "general" && r.component === "room")?.pricePaise).toBe(15000);
    expect(parsed.rates.find((r) => r.bedClass === "icu" && r.component === "room")?.pricePaise).toBe(150000);
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

  it("(c) brings an earlier placeholder DRAFT to the rate card in place — rates and note — and leaves a submitted one alone", async () => {
    const legacyNote = "UAT SAMPLE — not hospital rates: IPD placeholder rate card for staging walk-throughs (scripts/stage-ipd-setup.ts)";
    // an earlier placeholder draft: every rate x2 of the card, the old note
    const placeholder = uatSampleTariffCsv().split("\n").map((l, i) => {
      if (i === 0 || l === "") return l;
      const f = l.split(","); f[f.length - 1] = String(Number(f[f.length - 1]) * 2); return f.join(",");
    }).join("\n");
    const r = await importIpdTariff(db, { type: "user", id: "seed-ipd-stage" }, placeholder, { apply: true, notes: legacyNote });
    expect(r.ok).toBe(true);
    const first = await ensureRateCardDraft(db);
    expect(first.action).toBe("updated");
    expect(first.lines[0]).toContain(`${IPD_RATED_CLASSES.length * IPD_RATE_COMPONENTS.length} of ${IPD_RATED_CLASSES.length * IPD_RATE_COMPONENTS.length} rates rewritten, note updated`);
    const [v] = await db.select().from(tariffVersions);
    expect(v!.status).toBe("draft");
    expect(v!.notes).toContain(UAT_SAMPLE_MARKER);
    const items = await db.select({ code: services.code, paise: tariffItems.pricePaise }).from(tariffItems)
      .innerJoin(services, eq(services.id, tariffItems.serviceId)).where(eq(tariffItems.versionId, v!.id));
    const price = new Map(items.map((i) => [i.code, i.paise]));
    expect(price.get("IPD_ROOM_GENERAL")).toBe(15000);
    expect(price.get("IPD_ROOM_ICU")).toBe(150000);
    expect(price.get("IPD_CROSS_VISIT_SUITE")).toBe(70000);
    expect((await ensureRateCardDraft(db)).action).toBe("already");
    await withTx(db, (tx) => tx.update(tariffVersions).set({ status: "submitted" }).where(eq(tariffVersions.id, v!.id)));
    expect(await ensureRateCardDraft(db)).toMatchObject({ action: "already" });
    await expect(withTx(db, (tx) => setDraftVersionNotes(tx, { type: "user", id: "x" }, v!.id, "changed"))).rejects.toMatchObject({ code: "not_draft" });
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

  it("(e) refuses an account whose roles seed:roles has not made, and writes nothing", async () => {
    const r = await ensureWardTestUsers(db);
    expect(r.every((u) => u.action === "refused" && (u.missingRoles?.length ?? 0) > 0)).toBe(true);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("(e) WM-2 (#1009): makes the synthetic agency and student nurses once, with their roles, a random password never reported, a change at first login", async () => {
    for (const k of ["ward_nurse", "agency_nurse", "student_nurse"]) await createRole(db, k, k);
    const first = await ensureWardTestUsers(db);
    expect(first.map((u) => [u.username, u.action]).sort()).toEqual(WARD_TEST_USERS.map((u) => [u.username, "created"]).sort());
    expect(JSON.stringify(first)).not.toMatch(/password/i);
    for (const u of WARD_TEST_USERS) {
      const row = (await db.select().from(users).where(eq(users.username, u.username)))[0]!;
      expect(row.mustChangePassword).toBe(true);
      const held = (await db.select().from(roleAssignments).where(eq(roleAssignments.userId, row.id))).map((r) => r.roleKey).sort();
      expect(held).toEqual([...u.roles].sort());
    }
    const again = await ensureWardTestUsers(db);
    expect(again.every((u) => u.action === "already")).toBe(true);
    expect((await db.select().from(events)).filter((e) => e.name === roleAssigned.name)).toHaveLength(WARD_TEST_USERS.reduce((n, u) => n + u.roles.length, 0));
  });
});
