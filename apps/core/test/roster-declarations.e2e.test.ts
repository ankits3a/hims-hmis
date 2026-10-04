import { Test } from "@nestjs/testing";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { withTx } from "../src/kernel/db/client";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { events as domainEvents } from "../src/kernel/db/schema";
import { seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { seedUnits, teamByCode } from "../src/modules/roster/teams";
import { seedRosterRules } from "../src/modules/roster/rules";
import { addMembership } from "../src/modules/roster/memberships";
import { amend } from "../src/modules/roster/periods";
import { declareSkeletonMode } from "../src/modules/roster/modes";
import { addIstDays, istDateOfInstant, istWeekday } from "../src/modules/roster/calendar";
import { ROSTER_RESOLVER_FLAG } from "../src/modules/roster/resolve";
import type { INestApplication } from "@nestjs/common";
import type { Db } from "../src/kernel/db/client";
import type { UnitMonth } from "../src/modules/roster/month";
import type { DeclarationsView } from "../src/modules/roster/declarations";
import type { AsItStoodBoard } from "../src/modules/roster/as-it-stood";
import type { OnNowBoard } from "../src/modules/roster/board";

/**
 * 20-U §8 I1 / I2 / I5 / I23 over HTTP — the declarations the medical superintendent makes, and the
 * board an inspector reads.
 *
 *   · **I1/I2** — a holiday declared through the door reaches the proposer (no routine duty that
 *     day, the night and the 08:00 cover still drafted) and the month read (its shading).
 *   · **I5** — skeleton cover: declared and withdrawn through the door, evented, and on the board a
 *     strike day's holes are ONE line per department.
 *   · **I23** — the board AS IT STOOD: the published version at a past instant even after a later
 *     after-the-fact amendment, with that amendment listed; the live board meanwhile reads today's
 *     correction. Both legs, because only the pair shows the knowledge axis is doing the work.
 *   · a reader without `declare` is refused at the act (403 `not_permitted`).
 */
describe("roster declarations + as it stood e2e (20-U I1/I5/I23)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let team: string;
  let ms: { id: string; token: string };
  let reader: { id: string; token: string };
  const jrs: string[] = [];

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
    jrs.length = 0;
    for (let i = 0; i < 4; i += 1) {
      const jr = await mkUser(db, `jr.${String(i)}`, ["doctor"]);
      jrs.push(jr.id);
      await withTx(db, (tx) => addMembership(tx, { type: "user", id: ms.id }, {
        teamId: team, userId: jr.id, positionKey: "ward_jr", grade: "jr2",
        roleInTeam: "junior_resident", kind: "parent", startsAt: new Date("2026-01-01T00:00:00+05:30"),
      }));
    }
  });

  const http = () => request(app.getHttpServer());
  const as = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });
  const draft = async (month: string): Promise<UnitMonth> =>
    (await http().post(`/roster/units/${team}/months/${month}/draft`).set(as(ms)).expect(200)).body as UnitMonth;
  const publish = async (m: UnitMonth): Promise<UnitMonth> =>
    (await http().post(`/roster/periods/${m.period!.periodId}/publish`).set(as(ms))
      .send({ expectedContentHash: m.period!.contentHash }).expect(200)).body as UnitMonth;
  const withFlag = async <T>(fn: () => Promise<T>): Promise<T> => {
    const was = process.env[ROSTER_RESOLVER_FLAG];
    process.env[ROSTER_RESOLVER_FLAG] = "true";
    try { return await fn(); } finally {
      if (was === undefined) delete process.env[ROSTER_RESOLVER_FLAG];
      else process.env[ROSTER_RESOLVER_FLAG] = was;
    }
  };

  it("a reader without `declare` is refused at the act — holiday and skeleton cover alike — and nothing is written", async () => {
    const day = addIstDays(istDateOfInstant(new Date()), 3);
    const h = await http().post("/roster/holidays").set(as(reader)).send({ istDate: day, kind: "declared", pattern: "as_sunday" }).expect(403);
    expect((h.body as { code: string }).code).toBe("not_permitted");
    const med = (await http().get("/roster/units").set(as(reader)).expect(200)).body as { departmentId: string; code: string }[];
    const m = await http().post("/roster/modes").set(as(reader))
      .send({ departmentId: med.find((d) => d.code === "MED")!.departmentId, istDate: day, reason: "strike" }).expect(403);
    expect((m.body as { code: string }).code).toBe("not_permitted");
    const view = (await http().get("/roster/declarations").set(as(reader)).expect(200)).body as DeclarationsView;
    expect(view.holidays).toEqual([]);
    expect(view.modes).toEqual([]);
    expect(view.youMay).toEqual({ holiday: false, hospitalSkeleton: false, departmentSkeleton: false });
  });

  it("I1 — a holiday declared through the door: the proposer drafts no routine duty that day, the take still runs, and the month shows it", async () => {
    // A weekday two months out, so the day is never in the past whatever day this suite runs.
    const now = new Date();
    const ym = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
    const month = `${String(ym.getUTCFullYear())}-${String(ym.getUTCMonth() + 1).padStart(2, "0")}`;
    let day = `${month}-11`;
    while (istWeekday(day) === 0 || istWeekday(day) === 6) day = addIstDays(day, 1);
    const ordinary = addIstDays(day, istWeekday(day) === 5 ? 3 : 1);

    const view = (await http().post("/roster/holidays").set(as(ms))
      .send({ istDate: day, kind: "declared", pattern: "opd_off_ot_proceeds" }).expect(200)).body as DeclarationsView;
    expect(view.holidays).toEqual([expect.objectContaining({ istDate: day, kind: "declared", pattern: "opd_off_ot_proceeds", declaredByName: "roster.head" })]);
    expect(view.youMay.holiday).toBe(true);
    const events = await db.select().from(domainEvents).where(eq(domainEvents.name, "roster.holiday_declared"));
    expect(events).toHaveLength(1);

    const m = await draft(month);
    const routineOn = (d: string) => m.assignments.filter((a) => a.istDate === d && a.userId !== null && !a.night
      && new Date(a.startsAt).toISOString().endsWith("T03:30:00.000Z")); // 09:00 IST
    expect(routineOn(ordinary).length).toBeGreaterThan(0);
    expect(routineOn(day)).toEqual([]);
    expect(m.assignments.some((a) => a.istDate === day && a.night)).toBe(true);
    expect(m.holidays).toEqual([{ istDate: day, kind: "declared", pattern: "opd_off_ot_proceeds" }]);
  });

  it("I1 — a past day is refused at the door: a declaration is for today or a day to come", async () => {
    const res = await http().post("/roster/holidays").set(as(ms))
      .send({ istDate: addIstDays(istDateOfInstant(new Date()), -2), kind: "declared", pattern: "as_sunday" }).expect(422);
    expect((res.body as { code: string }).code).toBe("invalid_window");
  });

  it("I5 — skeleton cover declared and withdrawn through the door, each evented and stamped with who", async () => {
    const day = addIstDays(istDateOfInstant(new Date()), 1);
    const units = (await http().get("/roster/units").set(as(ms)).expect(200)).body as { departmentId: string; code: string }[];
    const medId = units.find((d) => d.code === "MED")!.departmentId;
    const declared = (await http().post("/roster/modes").set(as(ms))
      .send({ departmentId: medId, istDate: day, reason: "Residents' strike called for 08:00" }).expect(200)).body as DeclarationsView;
    const mode = declared.modes.find((x) => x.departmentId === medId)!;
    expect(mode).toMatchObject({ istDate: day, reason: "Residents' strike called for 08:00", declaredByName: "roster.head", withdrawnAt: null });
    expect(declared.departments.map((d) => d.code)).toContain("MED");

    const off = (await http().post(`/roster/modes/${mode.declarationId}/withdraw`).set(as(ms))
      .send({ reason: "strike called off" }).expect(200)).body as DeclarationsView;
    expect(off.modes.find((x) => x.declarationId === mode.declarationId)).toMatchObject({ withdrawnByName: "roster.head", withdrawReason: "strike called off" });
    const again = await http().post(`/roster/modes/${mode.declarationId}/withdraw`).set(as(ms)).send({}).expect(409);
    expect((again.body as { code: string }).code).toBe("mode_already_withdrawn");

    const types = (await db.select({ type: domainEvents.name }).from(domainEvents)).map((e) => e.type).filter((t) => t.startsWith("roster.mode_"));
    expect(types.sort()).toEqual(["roster.mode_declared", "roster.mode_withdrawn"]);
  });

  it("I5 — on a strike day the board's holes are ONE line per department, not one per vacant duty", async () => {
    let m = await draft("2026-10");
    const vacate = m.assignments.filter((a) => a.istDate === "2026-10-06" && a.userId !== null);
    expect(vacate.length).toBeGreaterThan(1);
    for (const a of vacate) {
      m = (await http().put(`/roster/slots/${a.assignmentId}`).set(as(ms)).send({ userId: null }).expect(200)).body as UnitMonth;
    }
    await publish(m);
    const holesAt = async () => ((await http().get("/roster/on-now?at=2026-10-06T00:30:00%2B05:30").set(as(reader)).expect(200)).body as OnNowBoard)
      .holes.filter((h) => h.departmentName === "General Medicine" && istDateOfInstant(new Date(h.from)) === "2026-10-06");

    const before = await holesAt();
    expect(before.filter((h) => h.kind === "vacant_slot")).toHaveLength(vacate.length);

    await withTx(db, (tx) => declareSkeletonMode(tx, { type: "user", id: ms.id }, {
      departmentId: m.unit.departmentId, istDate: "2026-10-06", reason: "residents' strike",
    }));
    const after = await holesAt();
    // The department-level line (no take cycle in this fixture) is already one line and stays.
    expect(after.filter((h) => h.kind !== "no_take_cycle").map((h) => [h.kind, h.count])).toEqual([["skeleton_short", vacate.length]]);
    expect(after.filter((h) => h.kind === "no_take_cycle")).toEqual(before.filter((h) => h.kind === "no_take_cycle"));
    const board = (await http().get("/roster/on-now?at=2026-10-06T00:30:00%2B05:30").set(as(reader)).expect(200)).body as OnNowBoard;
    expect(board.departments.find((d) => d.code === "MED")!.skeleton).toBe(true);
  });

  it("I23 — the board AS IT STOOD returns the published version even after a later after-the-fact amendment, and lists the amendment", async () => {
    const m = await publish(await draft("2026-10"));
    // The month was published on 25 September — set the knowledge axis back, as a month published
    // then would have it. (The domain stamps publish and live-from from the database clock.)
    const then = new Date("2026-09-25T10:00:00+05:30");
    await db.execute(sql`update roster_periods set published_at = ${then} where id = ${m.period!.periodId}`);
    await db.execute(sql`update roster_assignments set live_from = ${then} where period_id = ${m.period!.periodId}`);

    const night = m.assignments.find((a) => a.night && a.istDate === "2026-10-01" && a.userId !== null)!;
    const stranger = await mkUser(db, "jr.cover", ["doctor"]);
    await withTx(db, (tx) => addMembership(tx, { type: "user", id: ms.id }, {
      teamId: team, userId: stranger.id, positionKey: "ward_jr", grade: "jr1",
      roleInTeam: "junior_resident", kind: "parent", startsAt: new Date("2026-01-01T00:00:00+05:30"),
    }));
    // Today, somebody corrects that night after the fact: it was worked by jr.cover.
    await withTx(db, (tx) => amend(tx, { type: "user", id: ms.id }, m.period!.periodId, {
      kind: "correction", reason: "the register shows jr.cover worked this night", requestedBy: ms.id, afterTheFact: true,
      close: [night.assignmentId],
      open: [{
        userId: stranger.id, positionKey: "ward_jr", departmentId: m.unit.departmentId, teamId: team, mode: "presence", kind: "duty",
        startsAt: new Date(night.startsAt), endsAt: new Date(night.endsAt), source: "manual", replacesAssignmentId: night.assignmentId,
      }],
    }));

    const AT = "2026-10-02T02:40:00%2B05:30";
    // The live board reads today's correction…
    const live = await withFlag(async () => ((await http().get(`/roster/on-now?at=${AT}`).set(as(reader)).expect(200)).body as OnNowBoard));
    expect(live.departments.find((d) => d.code === "MED")!.inTheBuilding.map((p) => p.userId)).toEqual([stranger.id]);

    // …the board AS IT STOOD reads what was published then, and lists the correction beside it.
    const stood = (await http().get(`/roster/as-it-stood?at=${AT}`).set(as(reader)).expect(200)).body as AsItStoodBoard;
    const med = stood.departments.find((d) => d.code === "MED")!;
    expect(med.source).toBe("published");
    expect(med.inTheBuilding.map((p) => p.userId)).toEqual([night.userId]);
    expect(med.inTheBuilding.every((p) => p.phone === null)).toBe(true);
    expect(stood.holes).toEqual([]);
    expect(stood.changes).toHaveLength(1);
    expect(stood.changes[0]).toMatchObject({
      kind: "correction", afterTheFact: true, byName: "roster.head", departmentName: "General Medicine",
      removed: [expect.objectContaining({ userId: night.userId })],
      added: [expect.objectContaining({ userId: stranger.id, name: "jr.cover" })],
    });
    expect(JSON.stringify(stood.changes)).not.toContain("register shows");
  });

  it("I23 — `as it stood` is a past instant; a future one is refused", async () => {
    const res = await http().get(`/roster/as-it-stood?at=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`).set(as(reader)).expect(422);
    expect((res.body as { code: string }).code).toBe("invalid_window");
  });
});
