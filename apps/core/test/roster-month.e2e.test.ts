import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { withTx } from "../src/kernel/db/client";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { seedUnits, teamByCode } from "../src/modules/roster/teams";
import { seedRosterRules } from "../src/modules/roster/rules";
import { addMembership } from "../src/modules/roster/memberships";
import { assign } from "../src/modules/roster/periods";
import { ROSTER_RESOLVER_FLAG } from "../src/modules/roster/resolve";
import type { INestApplication } from "@nestjs/common";
import type { Db } from "../src/kernel/db/client";
import type { UnitMonth } from "../src/modules/roster/month";

/**
 * 20-U U5b — the unit's month over HTTP. The CONTENT is `src/modules/roster/month.test.ts`'s; this
 * suite is the door, and the one leg nothing else can prove: **a month published here is what the
 * U5a board reads** — the two screens are connected by the roster, not by each other.
 */
describe("roster month e2e (20-U U5b)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let team: string;
  let ms: { id: string; token: string };
  let reader: { id: string; token: string };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await createRole(db, "roster_head", "Drafts and publishes rosters");
    for (const p of ["roster.read", "roster.periods.manage", "roster.periods.publish"]) {
      await grantPermissionToRole(db, registry, "roster_head", p);
    }
    await createRole(db, "board_reader", "Reads the roster");
    await grantPermissionToRole(db, registry, "board_reader", "roster.read");
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) {
      await createRole(db, key, key);
    }
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await seedRosterRules(db, "t");
    ms = await mkUser(db, "roster.head", ["roster_head"]);
    reader = await mkUser(db, "board.reader", ["board_reader"]);
    team = (await teamByCode(db, "MED-U1"))!.id;
    for (let i = 0; i < 4; i += 1) {
      const jr = await mkUser(db, `jr.${String(i)}`, ["doctor"]);
      await withTx(db, (tx) => addMembership(tx, { type: "user", id: ms.id }, {
        teamId: team, userId: jr.id, positionKey: "ward_jr", grade: "jr2",
        roleInTeam: "junior_resident", kind: "parent", startsAt: new Date("2026-01-01T00:00:00+05:30"),
      }));
    }
  });

  const http = () => request(app.getHttpServer());
  const draft = async (): Promise<UnitMonth> =>
    (await http().post(`/roster/units/${team}/months/2026-10/draft`).set("authorization", `Bearer ${ms.token}`).expect(200)).body as UnitMonth;

  it("a holder of roster.read can open the unit list and the month, and is told they may not publish", async () => {
    const units = await http().get("/roster/units").set("authorization", `Bearer ${reader.token}`).expect(200);
    expect((units.body as { code: string }[]).map((d) => d.code)).toContain("MED");
    await draft();
    const m = await http().get(`/roster/units/${team}/months/2026-10`).set("authorization", `Bearer ${reader.token}`).expect(200);
    expect((m.body as UnitMonth).youMay).toEqual({ draft: false, edit: false, acceptWarning: false, publish: false });
  });

  it("an unauthorised publish is refused at the act (403 not_permitted), and the month stays a draft", async () => {
    const m = await draft();
    const res = await http().post(`/roster/periods/${m.period!.periodId}/publish`)
      .set("authorization", `Bearer ${reader.token}`).send({ expectedContentHash: m.period!.contentHash }).expect(403);
    expect((res.body as { code: string }).code).toBe("not_permitted");
    await http().post(`/roster/units/${team}/months/2026-10/draft`).set("authorization", `Bearer ${reader.token}`).expect(403);
    const after = await http().get(`/roster/units/${team}/months/2026-10`).set("authorization", `Bearer ${ms.token}`).expect(200);
    expect((after.body as UnitMonth).period!.status).toBe("draft");
  });

  it("no session is refused", async () => {
    await http().get(`/roster/units/${team}/months/2026-10`).expect(401);
  });

  it("a publish with a blocking finding is refused (422 blocked_by_findings), the fix clears it, and the who-is-on-now board then reads PUBLISHED", async () => {
    const m = await draft();
    const night = m.assignments.find((a) => a.night && a.istDate === "2026-10-05" && a.userId !== null)!;

    // The night's JR put on a 10:00 list the next morning, two hours after the night ends. (Since
    // roster-correct the proposer's day is 08:00–20:00, contiguous with the night — one stretch for the
    // hours rules, not a rest failure — so the clash is a list of its own, added through the domain.)
    await withTx(db, (tx) => assign(tx, { type: "user", id: ms.id }, m.period!.periodId, {
      userId: night.userId, positionKey: "ward_jr", departmentId: m.unit.departmentId, teamId: team, mode: "presence", kind: "duty",
      startsAt: new Date("2026-10-06T10:00:00+05:30"), endsAt: new Date("2026-10-06T14:00:00+05:30"), source: "manual",
    }));
    const bad = (await http().get(`/roster/units/${team}/months/2026-10`).set("authorization", `Bearer ${ms.token}`).expect(200)).body as UnitMonth;
    expect(bad.findings.filter((f) => f.blocking).map((f) => f.ruleKey)).toEqual(["rest_after_duty"]);
    expect(bad.youMay.publish).toBe(true);

    const refused = await http().post(`/roster/periods/${bad.period!.periodId}/publish`)
      .set("authorization", `Bearer ${ms.token}`).send({ expectedContentHash: bad.period!.contentHash }).expect(422);
    expect((refused.body as { code: string }).code).toBe("blocked_by_findings");

    const fixed = (await http().put(`/roster/slots/${bad.findings.find((f) => f.blocking)!.assignmentId!}`)
      .set("authorization", `Bearer ${ms.token}`).send({ userId: null }).expect(200)).body as UnitMonth;
    expect(fixed.counts.blocking).toBe(0);

    const published = (await http().post(`/roster/periods/${fixed.period!.periodId}/publish`)
      .set("authorization", `Bearer ${ms.token}`).send({ expectedContentHash: fixed.period!.contentHash }).expect(200)).body as UnitMonth;
    expect(published.period!.status).toBe("published");

    // THE TWO SCREENS CONNECT: at 02:40 on 6 Oct the board's Medicine row reads the month just published.
    const was = process.env[ROSTER_RESOLVER_FLAG];
    process.env[ROSTER_RESOLVER_FLAG] = "true";
    try {
      const board = await http().get("/roster/on-now?at=2026-10-06T02:40:00%2B05:30")
        .set("authorization", `Bearer ${reader.token}`).expect(200);
      const med = (board.body as { departments: { code: string; source: string; inTheBuilding: { userId: string }[] }[] })
        .departments.find((d) => d.code === "MED")!;
      expect(med.source).toBe("published");
      expect(med.inTheBuilding.map((p) => p.userId)).toContain(night.userId);
    } finally {
      if (was === undefined) delete process.env[ROSTER_RESOLVER_FLAG];
      else process.env[ROSTER_RESOLVER_FLAG] = was;
    }
  });

  it("a publish without the hash the month was read with is a 422, not a blind publish", async () => {
    const m = await draft();
    const res = await http().post(`/roster/periods/${m.period!.periodId}/publish`)
      .set("authorization", `Bearer ${ms.token}`).send({}).expect(422);
    expect((res.body as { code: string }).code).toBe("invalid_window");
  });

  it("a warning accepted over HTTP comes back with the accepter's name and reason", async () => {
    const m = await draft();
    const warn = m.findings.find((f) => f.severity === "warn" && f.accepted === null)!;
    const body = { ruleKey: warn.ruleKey, assignmentId: warn.assignmentId, userId: warn.userId, reason: "short this month" };
    await http().post(`/roster/periods/${m.period!.periodId}/findings/accept`).set("authorization", `Bearer ${reader.token}`).send(body).expect(403);
    const after = (await http().post(`/roster/periods/${m.period!.periodId}/findings/accept`)
      .set("authorization", `Bearer ${ms.token}`).send(body).expect(200)).body as UnitMonth;
    const same = after.findings.find((f) => f.ruleKey === warn.ruleKey && f.assignmentId === warn.assignmentId && f.userId === warn.userId)!;
    expect(same.accepted).toMatchObject({ byName: "roster.head", reason: "short this month" });
  });
});
