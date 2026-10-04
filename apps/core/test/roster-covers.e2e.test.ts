import { Test } from "@nestjs/testing";
import { confirmSeededUnits } from "./helpers/units";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { withTx } from "../src/kernel/db/client";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { orgDepartments } from "../src/kernel/db/schema";
import { seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { seedUnits, teamByCode } from "../src/modules/roster/teams";
import { seedRosterRules } from "../src/modules/roster/rules";
import { addMembership } from "../src/modules/roster/memberships";
import { assign, draftPeriod, publishPeriod } from "../src/modules/roster/periods";
import { ROSTER_RESOLVER_FLAG } from "../src/modules/roster/resolve";
import type { INestApplication } from "@nestjs/common";
import type { Db } from "../src/kernel/db/client";
import type { CoverOptions, CoverRequestView } from "../src/modules/roster/swaps";
import type { MyDuties } from "../src/modules/roster/my-duties";

/**
 * 20-U U5c/U6 over HTTP — the door, and the one leg nothing else proves: **a cover asked on the
 * resident's phone, said yes to by the person asked and approved by the MS, is what the U5a board
 * reads at that instant.** The rules themselves are `src/modules/roster/swaps.test.ts`'s.
 */
describe("roster covers e2e (20-U U5c/U6)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let ms: { id: string; token: string };
  let meena: { id: string; token: string };
  let rohit: { id: string; token: string };
  let nurse: { id: string; token: string };
  let MED: string;
  let night: string;
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);

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
    for (const p of ["roster.read", "roster.periods.manage", "roster.periods.publish"]) await grantPermissionToRole(db, registry, "roster_head", p);
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await createRole(db, key, key);
    await grantPermissionToRole(db, registry, "doctor", "roster.read");
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await confirmSeededUnits(db); // only a confirmed unit counts (owner 2026-10-04)
    await seedRosterRules(db, "t");
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
    ms = await mkUser(db, "roster.head", ["roster_head"]);
    meena = await mkUser(db, "meena", ["doctor"]);
    rohit = await mkUser(db, "rohit", ["doctor"]);
    nurse = await mkUser(db, "ward.nurse", ["doctor"]);
    const team = (await teamByCode(db, "MED-U2"))!.id;
    const actor = { type: "user" as const, id: ms.id };
    for (const u of [meena, rohit]) {
      await withTx(db, (tx) => addMembership(tx, actor, {
        teamId: team, userId: u.id, positionKey: "ward_jr", grade: "jr1", roleInTeam: "junior_resident", kind: "parent", startsAt: ist("2026-01-01T00:00"),
      }));
    }
    const { periodId } = await withTx(db, (tx) => draftPeriod(tx, actor, {
      scopeType: "team", scopeId: team, departmentId: MED, teamId: team, title: "November", coversPositions: ["ward_jr"],
      startsAt: ist("2026-11-01T00:00"), endsAt: ist("2026-12-01T00:00"),
    }));
    night = (await withTx(db, (tx) => assign(tx, actor, periodId, {
      userId: meena.id, positionKey: "ward_jr", departmentId: MED, teamId: team, mode: "presence", kind: "duty",
      startsAt: ist("2026-11-10T20:00"), endsAt: ist("2026-11-11T08:00"),
    }))).assignmentId;
    await withTx(db, (tx) => publishPeriod(tx, actor, periodId));
  });

  const http = () => request(app.getHttpServer());
  const as = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });

  it("no session is refused at every new door", async () => {
    await http().get("/roster/my-duties").expect(401);
    await http().get(`/roster/duties/${night}/cover-options`).expect(401);
    await http().post("/roster/covers").send({}).expect(401);
    await http().post("/roster/flags").send({}).expect(401);
  });

  it("I can't do this → Rohit says yes → the MS approves → the board names Rohit at 02:40", async () => {
    const mine = (await http().get("/roster/my-duties?at=2026-11-10T07:40:00%2B05:30").set(as(meena)).expect(200)).body as MyDuties;
    expect(mine.duties.map((d) => d.assignmentId)).toEqual([night]);
    const opts = (await http().get(`/roster/duties/${night}/cover-options`).set(as(meena)).expect(200)).body as CoverOptions;
    expect(opts.canTake.map((c) => c.userId)).toEqual([rohit.id]);
    // Somebody else's duty is not Rohit's to give away.
    expect(((await http().post("/roster/covers").set(as(rohit)).send({ assignmentId: night, counterpartId: nurse.id }).expect(403)).body as { code: string }).code).toBe("not_permitted");

    const { requestId } = (await http().post("/roster/covers").set(as(meena)).send({ assignmentId: night, counterpartId: rohit.id }).expect(200)).body as { requestId: string };
    // Not before he says yes.
    expect(((await http().post(`/roster/covers/${requestId}/decide`).set(as(ms)).send({ approve: true }).expect(409)).body as { code: string }).code).toBe("cover_not_accepted");
    await http().post(`/roster/covers/${requestId}/answer`).set(as(rohit)).send({ accept: true }).expect(200);
    const asked = (await http().get("/roster/covers").set(as(ms)).expect(200)).body as CoverRequestView[];
    expect(asked.map((r) => [r.status, r.youMay.approve])).toEqual([["accepted", true]]);
    expect(((await http().post(`/roster/covers/${requestId}/decide`).set(as(ms)).send({ approve: true }).expect(200)).body as { status: string }).status).toBe("approved");

    const was = process.env[ROSTER_RESOLVER_FLAG];
    process.env[ROSTER_RESOLVER_FLAG] = "true";
    try {
      const board = await http().get("/roster/on-now?at=2026-11-11T02:40:00%2B05:30").set(as(nurse)).expect(200);
      const med = (board.body as { departments: { departmentId: string; inTheBuilding: { userId: string }[] }[] }).departments.find((d) => d.departmentId === MED)!;
      expect(med.inTheBuilding.map((p) => p.userId)).toEqual([rohit.id]);
    } finally {
      if (was === undefined) delete process.env[ROSTER_RESOLVER_FLAG];
      else process.env[ROSTER_RESOLVER_FLAG] = was;
    }
  });

  it("\"this is wrong\": a reader flags a name; the board carries the flag until the MS deals with it", async () => {
    const { flagId } = (await http().post("/roster/flags").set(as(nurse))
      .send({ departmentId: MED, userId: meena.id, at: "2026-11-11T02:40:00+05:30", note: "Dr. Meena went home at 22:00" }).expect(200)).body as { flagId: string };
    const board = (await http().get("/roster/on-now").set(as(nurse)).expect(200)).body as { flags: { flagId: string; note: string; youMayResolve: boolean }[] };
    expect(board.flags.map((f) => [f.flagId, f.note, f.youMayResolve])).toEqual([[flagId, "Dr. Meena went home at 22:00", false]]);
    await http().post(`/roster/flags/${flagId}/resolve`).set(as(nurse)).expect(403);
    await http().post(`/roster/flags/${flagId}/resolve`).set(as(ms)).expect(200);
    expect(((await http().get("/roster/on-now").set(as(nurse)).expect(200)).body as { flags: unknown[] }).flags).toEqual([]);
  });
});
