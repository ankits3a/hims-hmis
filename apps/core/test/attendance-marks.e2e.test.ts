import { Test } from "@nestjs/testing";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { attAppMarks, attDays, attPunches, events, roles, rosterTeamMemberships, rosterTeams, users } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { orgDepartmentByCode, ROSTER_POSITIONS, seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { attendanceManifest, syncAttendance } from "../src/modules/attendance";
import { forgetAttendanceSecrets } from "../src/modules/attendance/secrets";
import { MAX_MARKS_PER_DAY } from "../src/modules/attendance/marks";
import { istDate } from "../src/modules/attendance/ist";
import { STUB_API_KEY, createBioattendStub } from "../scripts/bioattend-stub";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";
import type { BioattendStub } from "../scripts/bioattend-stub";

/**
 * "MARK ATTENDANCE" FROM THE STAFF APP OVER HTTP (owner 2026-10-10, decision 0061) — the done-means:
 * inside / outside / not shared / doubtful; no latitude or longitude kept anywhere; a mark and the
 * machine's record both show and neither changes the other or the day's word; a unit head sees the
 * team's marks, a person only their own.
 *
 * The site is the server's DEFAULT setting (the owner's centre, 200 m), so this also pins those values.
 * NO DATE IS PINNED: the route reads the real clock, so "today" is asked of it too.
 */
const PW = "s3cret-pass";
const CENTRE = { lat: 25.6892879, lng: 85.2301486 };
const EARTH_M = 6_371_008.8;
/** A point `m` metres due north of the centre — on the meridian the server's haversine gives back exactly `m`. */
const north = (m: number, mocked = false) => ({ latitude: CENTRE.lat + (m / EARTH_M) * (180 / Math.PI), longitude: CENTRE.lng, mocked });
const ENV_KEYS = ["HMIS_BIOATTEND_API_KEY_FILE", "ATTENDANCE_SELF_SHOWS_TIMES", "ATTENDANCE_SITE_LAT", "ATTENDANCE_SITE_LNG", "ATTENDANCE_SITE_RADIUS_M", "DATABASE_URL"] as const;

describe("staff app attendance marks e2e (HTTP)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dir: string;
  let stub: BioattendStub;
  let base: string;
  let today: string;
  let app: NestExpressApplication;
  const saved: Record<string, string | undefined> = {};
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(attendanceManifest);
  let ids: Record<string, string>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (k !== "DATABASE_URL") delete process.env[k]; }
    dir = mkdtempSync(join(tmpdir(), "hmis-att-marks-"));
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.HMIS_BIOATTEND_API_KEY_FILE = join(dir, "api-key.txt");
    today = istDate(new Date());
    stub = createBioattendStub({ today });
    base = await stub.listen(0);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await teardown();
  });

  async function mk(username: string, fullName: string, set: { phone?: string; permissions?: string[] } = {}): Promise<string> {
    const { id } = await createUser(db, { username, fullName, password: PW });
    if (set.phone !== undefined) await db.update(users).set({ phone: set.phone }).where(eq(users.id, id));
    if (set.permissions !== undefined) {
      const roleKey = `role_${username.replace(/\W/g, "_")}`;
      await db.insert(roles).values({ key: roleKey, title: roleKey }).onConflictDoNothing();
      for (const p of set.permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    return id;
  }
  const mobileOf = (pin: string): string => stub.fixture.staff.find((s) => s.pin === pin)!.mobile!;

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    writeFileSync(join(dir, "api-key.txt"), `${STUB_API_KEY}\n`);
    forgetAttendanceSecrets();
    ids = {
      kumar: await mk("a.kumar", "Dr A Kumar", { phone: mobileOf("304") }),
      committee: await mk("jyoti.test", "Committee Member", { permissions: ["attendance.all.read"] }),
      unlinked: await mk("new.clerk", "New Clerk"),
      hod: await mk("hod", "Dr Unit Head", { phone: mobileOf("301") }),
      sr: await mk("sr", "Dr Senior Resident", { phone: mobileOf("303") }),
    };
    const by = { createdBy: ids.hod!, updatedBy: ids.hod! };
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
    await seedOrgDepartments(db); await seedRosterPositions(db);
    const dep = (await orgDepartmentByCode(db, "MED"))!.id;
    await db.insert(rosterTeams).values([{ id: "t-u1", kind: "clinical_unit", departmentId: dep, code: "MED-U1", name: "Unit I", ...by }] as never);
    const member = (id: string, userId: string, roleInTeam: string) =>
      ({ id, teamId: "t-u1", userId, positionKey: ROSTER_POSITIONS[0]!.key, grade: "assistant_professor", roleInTeam, startsAt: new Date(Date.now() - 86_400_000), ...by });
    await db.insert(rosterTeamMemberships).values([member("m1", ids.hod!, "head"), member("m2", ids.sr!, "senior_resident")] as never);
    const out = await syncAttendance(db, { baseUrl: base, syncEnabled: true, selfShowsTimes: false, apiKeyFile: join(dir, "api-key.txt"), webhookSecretFile: null, aadhaarKeyFile: null }, new Date(), { sleep: async () => {} });
    if (!out.ran || out.refused) throw new Error(`the pull did not run: ${JSON.stringify(out)}`);
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const token = async (username: string): Promise<{ Authorization: string }> =>
    ({ Authorization: `Bearer ${(await http().post("/auth/login").send({ username, password: PW }).expect(201)).body.token as string}` });
  const mark = async (as: string, location: ReturnType<typeof north> | null) => http().post("/attendance/me/marks").set(await token(as)).send({ location });
  /** Push every stored mark of a person back past the double-tap window, so the next tap is a new mark. */
  const age = async (userId: string): Promise<void> => {
    await db.update(attAppMarks).set({ markedAt: sql`${attAppMarks.markedAt} - interval '5 minutes'` }).where(eq(attAppMarks.userId, userId));
  };
  const stored = async (userId: string) => db.select({ kind: attAppMarks.kind, place: attAppMarks.place, distanceM: attAppMarks.distanceM, pin: attAppMarks.pin, day: attAppMarks.day })
    .from(attAppMarks).where(eq(attAppMarks.userId, userId)).orderBy(attAppMarks.markedAt);

  it("200 m saves 'inside', 201 m 'outside', refused permission 'location not shared', a mocked reading 'location doubtful' — In, Out, In, Out", async () => {
    const r1 = await mark("a.kumar", north(200));
    expect(r1.status).toBe(200);
    // The person's answer is WORDS: no time, no metres.
    expect(r1.body).toEqual({ created: true, mark: { date: today, kind: "in", place: "inside" } });
    await age(ids.kumar!);
    expect((await mark("a.kumar", north(201))).body.mark).toEqual({ date: today, kind: "out", place: "outside" });
    await age(ids.kumar!);
    expect((await mark("a.kumar", null)).body.mark).toEqual({ date: today, kind: "in", place: "not_shared" });
    await age(ids.kumar!);
    expect((await mark("a.kumar", north(10, true))).body.mark).toEqual({ date: today, kind: "out", place: "doubtful" });
    expect(await stored(ids.kumar!)).toEqual([
      { kind: "in", place: "inside", distanceM: 200, pin: "304", day: today },
      { kind: "out", place: "outside", distanceM: 201, pin: "304", day: today },
      { kind: "in", place: "not_shared", distanceM: null, pin: "304", day: today },
      { kind: "out", place: "doubtful", distanceM: 10, pin: "304", day: today },
    ]);
    const ev = await db.select({ payload: events.payload }).from(events).where(eq(events.name, "attendance.app_marked"));
    expect(ev).toHaveLength(4);
  });

  it("a double tap inside a minute returns the first mark — it is not an Out", async () => {
    await mark("a.kumar", north(50));
    const again = await mark("a.kumar", north(50));
    expect(again.body).toEqual({ created: false, mark: { date: today, kind: "in", place: "inside" } });
    expect(await stored(ids.kumar!)).toHaveLength(1);
  });

  it(`at most ${MAX_MARKS_PER_DAY} marks a day; then 429`, async () => {
    for (let i = 0; i < MAX_MARKS_PER_DAY; i++) { expect((await mark("a.kumar", north(20))).status).toBe(200); await age(ids.kumar!); }
    const over = await mark("a.kumar", north(20));
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: "too_many_marks" });
  });

  it("a login with no machine record cannot mark (409 not_linked); a body with anything else is refused without echoing it", async () => {
    const r = await mark("new.clerk", north(5));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "not_linked" });
    const extra = await http().post("/attendance/me/marks").set(await token("a.kumar")).send({ location: { ...north(5), accuracy: 3 } });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body)).not.toContain("25.68");
    const bad = await http().post("/attendance/me/marks").set(await token("a.kumar")).send({ location: { latitude: 91, longitude: CENTRE.lng } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "bad_body" });
    expect(await db.select().from(attAppMarks)).toHaveLength(0);
  });

  it("NO latitude or longitude is kept: no such column in any att_* table, and no stored row or event holds the reading", async () => {
    const cols = (await db.execute(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'att\\_%'`)).rows as { table_name: string; column_name: string }[];
    expect(cols.filter((c) => /lat|lng|lon|coord|geo|position/i.test(c.column_name))).toEqual([]);
    const reading = north(137);
    await mark("a.kumar", reading);
    const lat = reading.latitude.toString().slice(0, 9);
    const lng = reading.longitude.toString().slice(0, 9);
    const tables = (await db.execute(sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')`)).rows as { name: string }[];
    let everything = "";
    for (const t of tables) everything += ((await db.execute(sql.raw(`select row_to_json(x)::text as j from "${t.name}" x`))).rows as { j: string }[]).map((r) => r.j).join("\n");
    expect(everything).toContain("137"); // the metres are there…
    expect(everything).not.toContain(lat); // …the reading is not
    expect(everything).not.toContain(lng);
    expect(everything).not.toMatch(/"(latitude|longitude|lat|lng)"/);
  });

  it("a machine punch and an app mark on the same day both show, and neither changes the other or the day's word", async () => {
    const punchesBefore = await db.select().from(attPunches).where(eq(attPunches.pin, "304"));
    const daysBefore = await db.select().from(attDays).where(eq(attDays.pin, "304"));
    const meBefore = (await http().get(`/attendance/me?from=${today}&to=${today}`).set(await token("a.kumar"))).body;
    const committee = await token("jyoti.test");
    const personBefore = (await http().get(`/attendance/person/304?from=${today}&to=${today}`).set(committee)).body;
    expect(personBefore.marks).toEqual([]);
    await mark("a.kumar", north(300)); // outside — and still nothing moves
    expect(await db.select().from(attPunches).where(eq(attPunches.pin, "304"))).toEqual(punchesBefore);
    expect(await db.select().from(attDays).where(eq(attDays.pin, "304"))).toEqual(daysBefore);
    const meAfter = (await http().get(`/attendance/me?from=${today}&to=${today}`).set(await token("a.kumar"))).body;
    expect(meAfter.days).toEqual(meBefore.days);
    expect(meAfter.today).toEqual(meBefore.today);
    expect(meAfter.marks).toEqual([{ date: today, kind: "in", place: "outside" }]);

    // The committee sees the mark — time, place, metres — beside the machine's own days.
    const person = (await http().get(`/attendance/person/304?from=${today}&to=${today}`).set(committee)).body;
    expect(person.detail).toBe("full");
    expect(person.days).toEqual(personBefore.days);
    expect(person.today).toEqual(personBefore.today);
    expect(person.marks).toEqual([{ date: today, time: expect.stringMatching(/^\d{2}:\d{2}$/), kind: "in", place: "outside", distanceM: 300 }]);
    const list = (await http().get("/attendance/today").set(committee)).body as { people: { pin: string; appMark: unknown }[] };
    expect(list.people.find((p) => p.pin === "304")!.appMark).toMatchObject({ kind: "in", place: "outside", distanceM: 300 });
    expect(list.people.filter((p) => p.pin !== "304").every((p) => p.appMark === null)).toBe(true);
  });

  it("a unit head sees the team's marks; a person sees only their own", async () => {
    await mark("sr", north(40));
    await mark("a.kumar", north(60));
    const head = await token("hod");
    const team = (await http().get(`/attendance/team?from=${today}&to=${today}`).set(head)).body as { members: { userId: string; marks: { place: string; distanceM: number }[] }[] };
    expect(team.members.find((m) => m.userId === ids.sr)!.marks).toEqual([expect.objectContaining({ kind: "in", place: "inside", distanceM: 40 })]);
    expect(team.members.some((m) => m.userId === ids.kumar)).toBe(false);
    const teamToday = (await http().get("/attendance/team/today").set(head)).body as { members: { userId: string; appMark: unknown }[] };
    expect(teamToday.members.find((m) => m.userId === ids.sr)!.appMark).toMatchObject({ kind: "in", place: "inside", distanceM: 40 });

    const mine = (await http().get(`/attendance/me?from=${today}&to=${today}`).set(await token("a.kumar"))).body;
    expect(mine.marks).toEqual([{ date: today, kind: "in", place: "inside" }]);
    expect(JSON.stringify(mine.marks)).not.toMatch(/distanceM|time/);
    // Somebody else's pin is still closed to a plain member of staff.
    expect((await http().get(`/attendance/person/303?from=${today}&to=${today}`).set(await token("a.kumar"))).status).toBe(403);
    // Their own pin answers the words-only shape, marks included.
    const own = (await http().get(`/attendance/person/304?from=${today}&to=${today}`).set(await token("a.kumar"))).body;
    expect(own).toMatchObject({ detail: "self", marks: [{ date: today, kind: "in", place: "inside" }] });
    expect(await db.select().from(attAppMarks).where(and(eq(attAppMarks.userId, ids.sr!), eq(attAppMarks.pin, "303")))).toHaveLength(1);
  });
});
