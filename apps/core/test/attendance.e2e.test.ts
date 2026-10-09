import { Test } from "@nestjs/testing";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { alerts, attDays, attMeetingRequests, attPunches, attStaff, events, roles, rosterTeamMemberships, rosterTeams, users } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { orgDepartmentByCode, ROSTER_POSITIONS, seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { attendanceManifest, bioattendSignature, syncAttendance } from "../src/modules/attendance";
import { forgetAttendanceSecrets } from "../src/modules/attendance/secrets";
import { addDays, istDate, previousMonth } from "../src/modules/attendance/ist";
import { STUB_AADHAAR_KEY, STUB_API_KEY, STUB_WEBHOOK_SECRET, createBioattendStub } from "../scripts/bioattend-stub";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";
import type { BioattendStub } from "../scripts/bioattend-stub";

/**
 * STAFF ATTENDANCE OVER HTTP — the webhook, the Users screen's two fields, and the read routes for
 * the three audiences, against the test double (`scripts/bioattend-stub.ts`).
 *
 * The app is built the way `main.ts` builds it (`bodyParser: false` + `configureApp`), because the
 * webhook's signature is over the RAW body and only that path keeps it.
 *
 * NO DATE IS PINNED: the read routes ask the real clock for "today", so the stub's fixture is built
 * for the real IST date and every expectation is read off the fixture.
 */
const PW = "s3cret-pass";
/** The guide's made-up Aadhaar: with the guide's dummy key it hashes to pin 304's `aadhaar_hash`. */
const AADHAAR = "2345 6789 0124";
const AADHAAR_DIGITS = "234567890124";
const TIME_KEYS = ["firstIn", "lastOut", "hoursWorked", "inSince", "punches", "first_in", "last_out"];

const ENV_KEYS = ["HMIS_BIOATTEND_API_KEY_FILE", "HMIS_BIOATTEND_WEBHOOK_SECRET_FILE", "HMIS_BIOATTEND_AADHAAR_KEY_FILE", "ATTENDANCE_SELF_SHOWS_TIMES", "ATTENDANCE_SYNC_ENABLED", "BIOATTEND_BASE_URL", "DATABASE_URL"] as const;

describe("staff attendance e2e (HTTP)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dir: string;
  let stub: BioattendStub;
  let base: string;
  let today: string;
  const saved: Record<string, string | undefined> = {};
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(attendanceManifest);

  const secretFile = (name: string): string => join(dir, name);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "hmis-att-e2e-"));
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.HMIS_BIOATTEND_API_KEY_FILE = secretFile("api-key.txt");
    process.env.HMIS_BIOATTEND_WEBHOOK_SECRET_FILE = secretFile("webhook-secret.txt");
    process.env.HMIS_BIOATTEND_AADHAAR_KEY_FILE = secretFile("aadhaar-key.txt");
    today = istDate(new Date());
    stub = createBioattendStub({ today });
    base = await stub.listen(0);
  });
  afterAll(async () => {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await teardown();
  });

  async function boot(env: Record<string, string> = {}): Promise<NestExpressApplication> {
    delete process.env.ATTENDANCE_SELF_SHOWS_TIMES;
    Object.assign(process.env, env);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    return app;
  }

  function placeSecrets(): void {
    writeFileSync(secretFile("api-key.txt"), `${STUB_API_KEY}\n`);
    writeFileSync(secretFile("webhook-secret.txt"), `${STUB_WEBHOOK_SECRET}\n`);
    writeFileSync(secretFile("aadhaar-key.txt"), `${STUB_AADHAAR_KEY}\n`);
    forgetAttendanceSecrets();
  }

  /** Pull the whole fixture into HMIS, exactly as the worker's job would. */
  async function pull(): Promise<void> {
    const out = await syncAttendance(db, { baseUrl: base, syncEnabled: true, selfShowsTimes: false, apiKeyFile: secretFile("api-key.txt"), webhookSecretFile: null, aadhaarKeyFile: null }, new Date(), { sleep: async () => {} });
    if (!out.ran || out.refused) throw new Error(`the pull did not run: ${JSON.stringify(out)}`);
  }

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

  /** Everything any table holds, as one string — what "is it written anywhere" is asked of. */
  async function everythingStored(): Promise<string> {
    const tables = (await db.execute(sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')`)).rows as { name: string }[];
    let out = "";
    for (const t of tables) {
      const rows = (await db.execute(sql.raw(`select row_to_json(x)::text as j from "${t.name}" x`))).rows as { j: string }[];
      out += rows.map((r) => r.j).join("\n");
    }
    return out;
  }

  describe("with the owner's default: a person's own attendance shows no times", () => {
    let app: NestExpressApplication;
    beforeAll(async () => { app = await boot(); });
    afterAll(async () => { await app.close(); });
    beforeEach(async () => {
      await truncateAll(db);
      await syncPermissions(db, registry);
      placeSecrets();
    });

    const http = (): ReturnType<typeof request> => request(app.getHttpServer());
    const token = async (username: string): Promise<{ Authorization: string }> =>
      ({ Authorization: `Bearer ${(await http().post("/auth/login").send({ username, password: PW }).expect(201)).body.token as string}` });
    const hook = (signed: { body: string; headers: Record<string, string> }) => http().post("/webhooks/bioattend").set(signed.headers).send(signed.body);

    describe("POST /webhooks/bioattend", () => {
      const three = () => [stub.addPunch("304", `${today} 10:00:01`), stub.addPunch("305", `${today} 10:00:02`), stub.addPunch("310", `${today} 10:00:03`, { verify: "fingerprint", device: "Ward-2" })];

      it("a correctly signed delivery answers 204 with no session, and the punches are stored as sent", async () => {
        const punches = three();
        const res = await hook(stub.signedWebhook(punches));
        expect([res.status, res.text]).toEqual([204, ""]);
        const rows = await db.select().from(attPunches).orderBy(attPunches.id);
        expect(rows.map((r) => ({ id: r.id, pin: r.pin, ts: r.ts, day: r.day, verify: r.verify, device: r.device, via: r.receivedVia }))).toEqual(
          punches.map((p) => ({ id: p.id, pin: p.pin, ts: p.ts, day: today, verify: p.verify, device: p.device, via: "webhook" })),
        );
      });

      it("a replay — bioattend delivers at least once — stores nothing twice and is still 204", async () => {
        const signed = stub.signedWebhook(three());
        await hook(signed).expect(204);
        await hook(signed).expect(204);
        await hook(stub.signedWebhook(three().slice(0, 1))).expect(204); // one more new punch (ids move on)
        const n = (await db.select({ n: sql<number>`count(*)::int` }).from(attPunches))[0]!.n;
        expect(n).toBe(4);
      });

      it("a stale timestamp is 401, either side of five minutes, though the signature is right", async () => {
        const nowS = Math.floor(Date.now() / 1000);
        for (const timestamp of [nowS - 400, nowS + 400]) {
          const res = await hook(stub.signedWebhook(three(), { timestamp }));
          expect([res.status, res.body]).toEqual([401, { statusCode: 401, message: "Unauthorized" }]);
        }
        await hook(stub.signedWebhook(three(), { timestamp: nowS - 200 })).expect(204);
      });

      it("a bad signature is 401 with no detail: wrong secret, a body changed after signing, no headers at all", async () => {
        const wrongSecret = await hook(stub.signedWebhook(three(), { secret: "cd".repeat(32) }));
        expect([wrongSecret.status, wrongSecret.body]).toEqual([401, { statusCode: 401, message: "Unauthorized" }]);
        const signed = stub.signedWebhook(three());
        const tampered = await hook({ headers: signed.headers, body: signed.body.replace('"pin":"304"', '"pin":"999"') });
        expect(tampered.status).toBe(401);
        expect((await http().post("/webhooks/bioattend").set("content-type", "application/json").send('{"event":"punches","punches":[]}')).status).toBe(401);
        expect((await db.select({ n: sql<number>`count(*)::int` }).from(attPunches))[0]!.n).toBe(0);
      });

      it("with no signing secret on this host it is 503 — never 204, never a stored punch", async () => {
        rmSync(secretFile("webhook-secret.txt"));
        forgetAttendanceSecrets();
        const res = await hook(stub.signedWebhook(three()));
        expect([res.status, res.body]).toEqual([503, { statusCode: 503, message: "Service Unavailable" }]);
        expect((await db.select({ n: sql<number>`count(*)::int` }).from(attPunches))[0]!.n).toBe(0);
      });

      it("signed but not the guide's shape is 400; more than a hundred punches is 400; an event it does not know is acknowledged", async () => {
        const many = Array.from({ length: 101 }, (_, i) => stub.addPunch("304", `${today} 11:${String(i % 60).padStart(2, "0")}:00`));
        expect((await hook(stub.signedWebhook(many))).status).toBe(400);
        await hook(stub.signedWebhook(many.slice(0, 100))).expect(204);
        const odd = stub.signedWebhook([]);
        const body = '{"event":"staff_changed","pins":["304"]}';
        const ts = odd.headers["x-bioattend-timestamp"]!;
        await hook({ body, headers: { ...odd.headers, "x-bioattend-signature": bioattendSignature(STUB_WEBHOOK_SECRET, ts, Buffer.from(body)) } }).expect(204);
        expect((await db.select({ n: sql<number>`count(*)::int` }).from(attPunches))[0]!.n).toBe(100);
      });

      it("the webhook never moves the pull's cursor — the history before it is still the pull's to fetch", async () => {
        await hook(stub.signedWebhook(three())).expect(204);
        stub.forgetRequests();
        await pull();
        expect(stub.requests().find((r) => r.path === "/punches")!.query).toBe("?after_id=0&limit=1000");
      });
    });

    describe("mobile and Aadhaar on the Users screen", () => {
      let admin: { Authorization: string };
      let target: string;
      beforeEach(async () => {
        await mk("root_admin", "Root Admin", { permissions: ["auth.users.manage"] });
        target = await mk("a.kumar", "Dr A Kumar");
        admin = await token("root_admin");
        await pull();
      });

      it("setting an Aadhaar stores the hash and the last four, answers masked, and LINKS the person", async () => {
        const res = await http().post(`/admin/users/${target}/identity`).set(admin).send({ aadhaar: AADHAAR });
        expect([res.status, res.body]).toEqual([200, { userId: target, mobile: null, aadhaar: "XXXX XXXX 0124", attendance: "linked" }]);
        const u = (await db.select().from(users).where(eq(users.id, target)))[0]!;
        expect([u.aadhaarHash, u.aadhaarLast4]).toEqual(["87072b92e7fe94e13084f46ab4fb7ad8c6690717859485131583ac86a6164905", "0124"]);
        expect((await db.select().from(attStaff).where(eq(attStaff.pin, "304")))[0]).toMatchObject({ userId: target, linkSource: "aadhaar" });
      });

      it("THE PLAIN AADHAAR IS WRITTEN NOWHERE: no table, no event, no audit row, no log line, no response", async () => {
        const logged: string[] = [];
        const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); }));
        const out = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { logged.push(String(chunk)); return true; }) as never);
        const err = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { logged.push(String(chunk)); return true; }) as never);
        const responses: string[] = [];
        try {
          for (const body of [{ aadhaar: AADHAAR }, { aadhaar: "2345-6789-0124" }, { aadhaar: "2345 6789 0125" }, { aadhaar: "234567890124", mobile: "9876501234" }, { aadhaar: null }, { aadhaar: AADHAAR_DIGITS }]) {
            responses.push(JSON.stringify((await http().post(`/admin/users/${target}/identity`).set(admin).send(body)).body));
          }
          responses.push(JSON.stringify((await http().get("/admin/users/identity").set(admin)).body));
          responses.push(JSON.stringify((await http().get("/admin/users").set(admin)).body));
        } finally {
          for (const s of [...spies, out, err]) s.mockRestore();
        }
        const stored = await everythingStored();
        expect(stored).toContain("87072b92e7fe94e13084f46ab4fb7ad8c6690717859485131583ac86a6164905"); // the search can see this table
        expect(stored).toContain("attendance.user_identity_changed"); // …and the events
        for (const [where, text] of [["a table, event or audit row", stored], ["a log line", logged.join("\n")], ["a response", responses.join("\n")]] as const) {
          for (const needle of [AADHAAR_DIGITS, AADHAAR, "2345-6789-0124", "23456789012", "234567890125", "2345 6789 0125"]) {
            expect(`${where}: ${text.includes(needle) ? `CONTAINS ${needle}` : "clean"}`).toBe(`${where}: clean`);
          }
        }
        // What the audit DOES say: who, which field, set or removed — and nothing of the number.
        const audit = (await db.select().from(events).where(eq(events.name, "attendance.user_identity_changed"))).map((e) => e.payload);
        expect(audit).toEqual([
          { userId: target, username: "a.kumar", field: "aadhaar", change: "set" },
          { userId: target, username: "a.kumar", field: "mobile", change: "set" },
          { userId: target, username: "a.kumar", field: "aadhaar", change: "removed" },
          { userId: target, username: "a.kumar", field: "aadhaar", change: "set" },
        ]);
      });

      it("an invalid Aadhaar is refused by the rule it broke — the refusal quotes no digit", async () => {
        for (const [aadhaar, problem] of [["2345 6789 0125", "bad_check_digit"], ["1345 6789 0124", "bad_first_digit"], ["2345 6789", "not_twelve_digits"]] as const) {
          const res = await http().post(`/admin/users/${target}/identity`).set(admin).send({ aadhaar });
          expect([res.status, res.body.code, res.body.problem]).toEqual([400, "aadhaar_invalid", problem]);
          expect(JSON.stringify(res.body)).not.toMatch(/\d{4}/);
        }
        expect((await db.select().from(users).where(eq(users.id, target)))[0]!.aadhaarHash).toBeNull();
      });

      it("Remove clears both columns; the link already made is kept (never re-pointed, never dropped)", async () => {
        await http().post(`/admin/users/${target}/identity`).set(admin).send({ aadhaar: AADHAAR }).expect(200);
        const res = await http().post(`/admin/users/${target}/identity`).set(admin).send({ aadhaar: null });
        expect(res.body).toEqual({ userId: target, mobile: null, aadhaar: null, attendance: "linked" });
        const u = (await db.select().from(users).where(eq(users.id, target)))[0]!;
        expect([u.aadhaarHash, u.aadhaarLast4]).toEqual([null, null]);
      });

      it("with no linking key on this host the Aadhaar cannot be taken, and the list says so; the mobile still works", async () => {
        rmSync(secretFile("aadhaar-key.txt"));
        forgetAttendanceSecrets();
        const res = await http().post(`/admin/users/${target}/identity`).set(admin).send({ aadhaar: AADHAAR });
        expect([res.status, res.body.code]).toEqual([409, "aadhaar_key_not_configured"]);
        expect((await http().get("/admin/users/identity").set(admin)).body.aadhaarConfigured).toBe(false);
        const mobile = await http().post(`/admin/users/${target}/identity`).set(admin).send({ mobile: "+91 98765 01234" });
        expect(mobile.body).toEqual({ userId: target, mobile: "9876501234", aadhaar: null, attendance: "linked" });
      });

      it("the mobile is validated, normalised, removable — and links by itself when it is one person's", async () => {
        expect((await http().post(`/admin/users/${target}/identity`).set(admin).send({ mobile: "12345" })).body.code).toBe("mobile_invalid");
        const set = await http().post(`/admin/users/${target}/identity`).set(admin).send({ mobile: "9876501234" });
        expect(set.body).toMatchObject({ mobile: "9876501234", attendance: "linked" });
        expect((await db.select().from(attStaff).where(eq(attStaff.pin, "304")))[0]).toMatchObject({ userId: target, linkSource: "mobile" });
        const gone = await http().post(`/admin/users/${target}/identity`).set(admin).send({ mobile: null });
        expect(gone.body).toMatchObject({ mobile: null, attendance: "linked" });
      });

      it("the list says, per person, in words: linked / not linked / two matches", async () => {
        const shared = await mk("m.lal", "Mohan Lal", { phone: mobileOf("320") }); // two machine people share this number
        const nobody = await mk("new.clerk", "New Clerk");
        await http().post(`/admin/users/${target}/identity`).set(admin).send({ aadhaar: AADHAAR }).expect(200);
        const list = await http().get("/admin/users/identity").set(admin).expect(200);
        expect(list.body.aadhaarConfigured).toBe(true);
        const by = new Map((list.body.users as { userId: string; mobile: string | null; aadhaar: string | null; attendance: string }[]).map((u) => [u.userId, u]));
        expect(by.get(target)).toEqual({ userId: target, mobile: null, aadhaar: "XXXX XXXX 0124", attendance: "linked" });
        expect(by.get(shared)).toEqual({ userId: shared, mobile: mobileOf("320"), aadhaar: null, attendance: "two_matches" });
        expect(by.get(nobody)).toEqual({ userId: nobody, mobile: null, aadhaar: null, attendance: "not_linked" });
        expect(JSON.stringify(list.body)).not.toMatch(/[0-9a-f]{64}/); // no hash, ever
      });

      it("both routes are the Users screen's own permission: nobody else, signed in or not", async () => {
        await mk("plain", "Plain Person");
        const plain = await token("plain");
        expect((await http().get("/admin/users/identity").set(plain)).status).toBe(403);
        expect((await http().post(`/admin/users/${target}/identity`).set(plain).send({ mobile: "9876501234" })).status).toBe(403);
        expect((await http().get("/admin/users/identity")).status).toBe(401);
        expect((await http().post(`/admin/users/${target}/identity`).send({ aadhaar: AADHAAR })).status).toBe(401);
        expect((await http().post("/admin/users/01JZZZZZZZZZZZZZZZZZZZZZZZ/identity").set(admin).send({ mobile: "9876501234" })).status).toBe(404);
        expect((await http().post(`/admin/users/${target}/identity`).set(admin).send({ aadhaar: AADHAAR, extra: 1 })).body).toEqual({ code: "bad_body" });
      });
    });

    describe("the read routes", () => {
      let kumar: string; // linked to pin 304 — a plain member of staff
      let ids: Record<string, string>;
      const seen: string[] = [];

      beforeEach(async () => {
        kumar = await mk("a.kumar", "Dr A Kumar", { phone: mobileOf("304") });
        ids = {
          kumar,
          committee: await mk("jyoti.test", "Committee Member", { permissions: ["attendance.all.read"] }),
          unlinked: await mk("new.clerk", "New Clerk"),
          twoMatches: await mk("m.lal", "Mohan Lal", { phone: mobileOf("320") }),
          hod: await mk("hod", "Dr Unit Head", { phone: mobileOf("301") }),
          sr: await mk("sr", "Dr Senior Resident", { phone: mobileOf("303") }),
          jr: await mk("jr", "Dr Junior Unlinked"),
          other: await mk("oth", "Dr Other Unit", { phone: mobileOf("305") }),
          manager: await mk("mgr", "Linked Manager", { phone: mobileOf("317"), permissions: ["attendance.all.read"] }),
        };
        const by = { createdBy: ids.hod!, updatedBy: ids.hod! };
        for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
        await seedOrgDepartments(db); await seedRosterPositions(db);
        const dep = (await orgDepartmentByCode(db, "MED"))!.id;
        await db.insert(rosterTeams).values([
          { id: "t-u1", kind: "clinical_unit", departmentId: dep, code: "MED-U1", name: "Unit I", ...by },
          { id: "t-u2", kind: "clinical_unit", departmentId: dep, code: "MED-U2", name: "Unit II", ...by },
        ] as never);
        const started = new Date(Date.now() - 86_400_000);
        const member = (id: string, teamId: string, userId: string, roleInTeam: string) =>
          ({ id, teamId, userId, positionKey: ROSTER_POSITIONS[0]!.key, grade: "assistant_professor", roleInTeam, startsAt: started, ...by });
        await db.insert(rosterTeamMemberships).values([
          member("m1", "t-u1", ids.hod!, "head"), member("m2", "t-u1", ids.sr!, "senior_resident"), member("m3", "t-u1", ids.jr!, "junior_resident"),
          member("m4", "t-u2", ids.other!, "senior_resident"),
        ] as never);
        await pull();
        seen.length = 0;
      });

      /** GET as a user; every body is kept so one test can ask "did ANY route return a mobile or a hash". */
      async function get(as: string, path: string): Promise<request.Response> {
        const res = await http().get(path).set(await token(as));
        seen.push(JSON.stringify(res.body));
        return res;
      }
      const fixtureDays = (pin: string, from: string, to: string) => stub.fixture.days.filter((d) => d.pin === pin && d.date >= from && d.date <= to);

      it("/attendance/me for a LINKED person: five words a day, 'checked in' today — and no time anywhere in the payload", async () => {
        const from = addDays(today, -20);
        const res = await get("a.kumar", `/attendance/me?from=${from}&to=${addDays(today, 7)}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ linked: true, configured: true, showsTimes: false, from, to: addDays(today, 7), person: { pin: "304", name: "Dr A Kumar", dept: "Medicine", post: "Asst Prof" } });
        const days = res.body.days as { date: string; status: string }[];
        expect(days.map((d) => d.date)).toEqual(fixtureDays("304", from, today).map((d) => d.date));
        for (const d of days) {
          expect(Object.keys(d).sort()).toEqual(d.status === "confirm" ? ["date", "reason", "status"] : ["date", "status"]);
          expect(["present", "absent", "leave", "off", "partial", "unknown", "confirm"]).toContain(d.status);
        }
        // A past day with one punch reads `confirm` (never `partial`), and the last 31 days' are listed for the home card.
        const forgot = fixtureDays("304", from, addDays(today, -1)).filter((d) => d.status === "single_punch").map((d) => d.date);
        expect(forgot.length).toBeGreaterThan(0);
        expect(days.filter((d) => d.status === "confirm")).toEqual(forgot.map((date) => ({ date, status: "confirm", reason: "one_punch_only" })));
        expect(res.body.needsConfirm).toEqual(fixtureDays("304", addDays(today, -31), addDays(today, -1)).filter((d) => d.status === "single_punch").map((d) => d.date));
        // "late days simply show as Present"
        const late = fixtureDays("304", from, today).filter((d) => d.status === "late").map((d) => d.date);
        expect(late.length).toBeGreaterThan(0);
        expect(days.filter((d) => late.includes(d.date)).map((d) => d.status)).toEqual(late.map(() => "present"));
        // Today: one of three states by the COUNT of today's punches, the word only once checked out — nothing else.
        const punchesToday = stub.fixture.punches.filter((p) => p.pin === "304" && p.ts.startsWith(today)).length;
        expect(Object.keys(res.body.today).sort()).toEqual(["date", "state", "status"]);
        const out = punchesToday > 0 && punchesToday % 2 === 0; // the stub is shared: earlier tests' punches for today are in the fixture too
        expect(res.body.today).toEqual({ date: today, state: punchesToday === 0 ? "not_checked_in" : out ? "checked_out" : "checked_in", status: out ? expect.any(String) : null });
        // The planned side: the leave three days out, the roster ahead, the holiday.
        expect(res.body.leaves).toEqual([{ date: addDays(today, 3), reason: "Conference" }]);
        expect((res.body.roster as { date: string }[]).map((r) => r.date)).toEqual(Array.from({ length: 9 }, (_, i) => addDays(today, i - 1)));
        expect(res.body.holidays).toEqual([{ date: addDays(today, 5), name: "Diwali", cancelled: false }]);
        // NOT MERELY HIDDEN: none of the time fields is a key anywhere in the answer.
        const text = JSON.stringify({ today: res.body.today, days: res.body.days });
        for (const k of TIME_KEYS) expect(text).not.toContain(`"${k}"`);
        expect(text).not.toMatch(/\d\d:\d\d/);
      });

      it("/attendance/me/punches with the setting off: the day's word and nothing else", async () => {
        const worked = fixtureDays("304", previousMonth(today).from, addDays(today, -1)).find((d) => d.status === "on_time")!;
        const res = await get("a.kumar", `/attendance/me/punches?date=${worked.date}`);
        expect(res.body).toEqual({ linked: true, date: worked.date, showsTimes: false, status: "present" });
        expect((await get("a.kumar", `/attendance/me/punches?date=${addDays(today, 1)}`)).status).toBe(400);
      });

      it("/attendance/me for an UNLINKED person says so, and why", async () => {
        expect((await get("new.clerk", "/attendance/me")).body).toEqual({ linked: false, reason: "no_mobile_or_aadhaar", configured: true, leadsTeam: false });
        expect((await get("m.lal", "/attendance/me")).body).toEqual({ linked: false, reason: "two_matches", configured: true, leadsTeam: false });
        await db.update(users).set({ phone: "9000000009" }).where(eq(users.id, ids.unlinked!));
        expect((await get("new.clerk", "/attendance/me")).body).toEqual({ linked: false, reason: "no_match", configured: true, leadsTeam: false });
        expect((await get("new.clerk", "/attendance/me/punches")).body).toEqual({ linked: false, date: today, showsTimes: false, status: null });
        expect((await http().get("/attendance/me")).status).toBe(401);
      });

      it("a person can NEVER read another person's days by pin — not a colleague's, not a pin that does not exist", async () => {
        for (const pin of ["305", "301", "330", "999", "304%20or%201=1"]) {
          const res = await get("a.kumar", `/attendance/person/${pin}`);
          expect([pin, res.status]).toEqual([pin, 403]);
          expect(res.body).toEqual({ statusCode: 403, message: "Forbidden" });
        }
        expect((await get("new.clerk", "/attendance/person/304")).status).toBe(403);
        // /me takes no parameter that could name somebody else.
        const me = await get("a.kumar", "/attendance/me?pin=305&userId=x");
        expect(me.body.person.pin).toBe("304");
      });

      it("the self shape cannot be bypassed through /person/<own pin>: a plain person gets the five words there too", async () => {
        const from = addDays(today, -10);
        const res = await get("a.kumar", `/attendance/person/304?from=${from}&to=${today}`);
        expect(res.status).toBe(200);
        expect(res.body.detail).toBe("self");
        const me = (await get("a.kumar", `/attendance/me?from=${from}&to=${today}`)).body;
        expect(res.body.days).toEqual(me.days);
        expect(res.body.today).toEqual(me.today);
        const text = JSON.stringify(res.body);
        for (const k of TIME_KEYS) expect(text).not.toContain(`"${k}"`);
      });

      it("a manager reading their OWN pin gets the full detail — the rules do not apply to those who see everything", async () => {
        const from = addDays(today, -10);
        const res = await get("mgr", `/attendance/person/317?from=${from}&to=${today}`);
        expect(res.body.detail).toBe("full");
        const mine = fixtureDays("317", from, today);
        expect((res.body.days as { date: string; status: string; firstIn: string | null }[]).map((d) => [d.date, d.status, d.firstIn])).toEqual(mine.map((d) => [d.date, d.status, d.first_in]));
        // …while /me stays the app's five words for everybody.
        for (const k of TIME_KEYS) expect(JSON.stringify((await get("mgr", "/attendance/me")).body.days)).not.toContain(`"${k}"`);
      });

      it("the COMMITTEE sees everyone on the machine's list, including people with no HMIS login", async () => {
        const res = await get("jyoti.test", "/attendance/today");
        expect(res.status).toBe(200);
        const people = res.body.people as { pin: string; name: string; dept: string; post: string; status: string | null; known: boolean; firstIn: string | null; lastOut: string | null; onDuty: boolean; hasLogin: boolean }[];
        // Twenty-nine: everyone but the one who left last month.
        expect(people.map((p) => p.pin).sort()).toEqual(stub.fixture.staff.filter((s) => s.status === "active").map((s) => s.pin).sort());
        expect(people.filter((p) => p.hasLogin).map((p) => p.pin).sort()).toEqual(["301", "303", "304", "305", "317"]);
        const college = people.find((p) => p.pin === "325")!; // a college professor: on the machine, no login here
        const theirs = stub.fixture.days.find((d) => d.pin === "325" && d.date === today)!;
        expect(college).toEqual({ pin: "325", name: "Prof S Banerjee", dept: "Anatomy", post: "Professor", status: theirs.status, known: true, firstIn: theirs.first_in, lastOut: theirs.last_out, onDuty: theirs.first_in !== null && theirs.last_out === null, hasLogin: false });
        // The summary is counts, and adds up.
        expect(res.body.summary.total).toBe(29);
        expect(Object.values(res.body.summary.byStatus as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(29);
        expect((res.body.summary.byDept as { dept: string; total: number }[]).reduce((a, d) => a + d.total, 0)).toBe(29);
        expect((res.body.summary.byDept as { dept: string; total: number }[]).find((d) => d.dept === "Nursing")!.total).toBe(4);
        // ?dept= narrows it.
        const med = await get("jyoti.test", "/attendance/today?dept=Medicine");
        expect((med.body.people as { pin: string }[]).map((p) => p.pin).sort()).toEqual(["301", "302", "303", "304"]);
        // A no-login person's days, in full, by pin.
        const days = await get("jyoti.test", `/attendance/person/325?from=${addDays(today, -6)}&to=${today}`);
        expect(days.body.detail).toBe("full");
        expect((days.body.days as { date: string }[]).length).toBe(7);
        expect((await get("jyoti.test", "/attendance/person/999")).status).toBe(404);
      });

      it("a status the guide does not list is passed through as it came, flagged `known: false`; to its owner it is `unknown`", async () => {
        const res = await get("jyoti.test", `/attendance/person/330?from=${addDays(today, -1)}&to=${addDays(today, -1)}`);
        expect(res.body.days).toEqual([expect.objectContaining({ date: addDays(today, -1), status: "comp_off", known: false })]);
        await db.update(users).set({ phone: mobileOf("330") }).where(eq(users.id, ids.unlinked!));
        await db.update(attStaff).set({ userId: ids.unlinked!, linkSource: "mobile", linkedAt: new Date() }).where(eq(attStaff.pin, "330"));
        const own = await get("new.clerk", `/attendance/me?from=${addDays(today, -1)}&to=${addDays(today, -1)}`);
        expect(own.body.days).toEqual([{ date: addDays(today, -1), status: "unknown" }]);
      });

      it("everyone-routes need attendance.all.read: a plain person, a unit head and a doctor are all refused", async () => {
        for (const who of ["a.kumar", "hod", "new.clerk"]) {
          for (const path of ["/attendance/today", "/attendance/summary", "/attendance/sync-state"]) {
            const res = await get(who, path);
            expect([who, path, res.status]).toEqual([who, path, 403]);
          }
        }
        expect((await http().get("/attendance/today")).status).toBe(401);
      });

      it("a UNIT HEAD sees exactly their team — its linked members' days in full, an unlinked member by name, nobody else", async () => {
        const todayRes = await get("hod", "/attendance/team/today");
        expect(todayRes.status).toBe(200);
        // The app learns "I lead a team" from /attendance/me — and a member learns they do not.
        expect((await get("hod", "/attendance/me")).body.leadsTeam).toBe(true);
        expect((await get("sr", "/attendance/me")).body.leadsTeam).toBe(false);
        const srToday = stub.fixture.days.find((d) => d.pin === "303" && d.date === today)!;
        expect(todayRes.body.members).toEqual([
          { userId: ids.jr, name: "Dr Junior Unlinked", linked: false, pin: null, today: null },
          { userId: ids.sr, name: "Dr Senior Resident", linked: true, pin: "303", today: { status: srToday.status, known: true, firstIn: srToday.first_in, lastOut: srToday.last_out, onDuty: srToday.first_in !== null && srToday.last_out === null } },
        ]);
        expect(todayRes.body.summary).toMatchObject({ total: 2, linked: 1 });

        const from = addDays(today, -6);
        const range = await get("hod", `/attendance/team?from=${from}&to=${today}`);
        expect((range.body.members as { userId: string }[]).map((m) => m.userId)).toEqual([ids.jr, ids.sr]);
        expect((range.body.members as { days: { date: string; status: string; firstIn: string | null }[] }[])[1]!.days.map((d) => [d.date, d.status, d.firstIn]))
          .toEqual(fixtureDays("303", from, today).map((d) => [d.date, d.status, d.first_in]));
        expect((range.body.members as { days: unknown[] }[])[0]!.days).toEqual([]);

        // A team member's pin opens; the other unit's does not; nor does the head's own team make them "everyone".
        expect((await get("hod", "/attendance/person/303")).body.detail).toBe("full");
        expect((await get("hod", "/attendance/person/305")).status).toBe(403);
        expect((await get("hod", "/attendance/person/325")).status).toBe(403);
        // The head's own pin is the head's own attendance: the five words, like anybody's.
        expect((await get("hod", "/attendance/person/301")).body.detail).toBe("self");
      });

      it("a doctor who leads nothing gets 403 on the team routes — and a member of a unit is not its head", async () => {
        for (const who of ["a.kumar", "sr", "oth", "new.clerk", "jyoti.test"]) {
          for (const path of ["/attendance/team/today", "/attendance/team"]) {
            const res = await get(who, path);
            expect([who, path, res.status, res.body.code]).toEqual([who, path, 403, "no_team"]);
          }
        }
        // A member cannot read their head's days either.
        expect((await get("sr", "/attendance/person/301")).status).toBe(403);
      });

      it("the summary is counts only, by status, department or day, with the five-word tally beside the machine's statuses", async () => {
        const from = previousMonth(today).from;
        const to = previousMonth(today).to;
        const month = stub.fixture.days.filter((d) => d.date >= from && d.date <= to);
        const byStatus = await get("jyoti.test", `/attendance/summary?from=${from}&to=${to}&groupBy=status`);
        const groups = byStatus.body.groups as { key: string; total: number; byStatus: Record<string, number>; byWord: Record<string, number> }[];
        expect(groups.reduce((n, g) => n + g.total, 0)).toBe(month.length);
        expect(groups.find((g) => g.key === "late")).toEqual({
          key: "late", total: month.filter((d) => d.status === "late").length, byStatus: { late: month.filter((d) => d.status === "late").length },
          byWord: { present: month.filter((d) => d.status === "late").length, absent: 0, leave: 0, off: 0, partial: 0, unknown: 0 },
        });
        expect(groups.find((g) => g.key === "approved_leave")!.byWord.leave).toBe(month.filter((d) => d.status === "approved_leave").length);

        const byDept = await get("jyoti.test", `/attendance/summary?from=${from}&to=${to}&groupBy=dept`);
        const depts = byDept.body.groups as { key: string; total: number; byWord: Record<string, number> }[];
        const nursing = month.filter((d) => ["310", "311", "312", "313"].includes(d.pin));
        expect(depts.find((g) => g.key === "Nursing")!.total).toBe(nursing.length);
        const present = ["on_time", "late", "worked_on_holiday", "worked_on_off_day", "on_call_worked"];
        expect(depts.find((g) => g.key === "Nursing")!.byWord.present).toBe(nursing.filter((d) => present.includes(d.status)).length);
        expect(depts.reduce((n, g) => n + Object.values(g.byWord).reduce((a, b) => a + b, 0), 0)).toBe(month.length);

        const byDay = await get("jyoti.test", `/attendance/summary?from=${addDays(today, -2)}&to=${today}&groupBy=day`);
        expect((byDay.body.groups as { key: string }[]).map((g) => g.key)).toEqual([addDays(today, -2), addDays(today, -1), today]);
        // No name, no pin, no time in any of it.
        const text = JSON.stringify([byStatus.body, byDept.body, byDay.body]);
        expect(text).not.toMatch(/"pin"|"name"|"firstIn"|Kumar/);
        expect((await get("jyoti.test", `/attendance/summary?from=${addDays(today, -200)}&to=${today}`)).body).toEqual({ code: "range_too_long" });
      });

      it("the sync state says connected-or-not and as-of-when, and carries no key, URL or error text", async () => {
        const res = await get("jyoti.test", "/attendance/sync-state");
        expect(res.body).toMatchObject({ configured: true, enabled: false, cursor: stub.fixture.punches[stub.fixture.punches.length - 1]!.id, onDutyAsOf: `${today} 16:20:00`, lastErrorClass: null });
        expect(Object.keys(res.body.stages).sort()).toEqual(["months", "punches", "reference", "today"]);
        expect(res.body.stages.punches).toMatchObject({ lastOutcome: "ok" });
        expect(JSON.stringify(res.body)).not.toContain(STUB_API_KEY);
        expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");
        // With the key gone the routes still answer from what is stored, and say `configured: false`.
        rmSync(secretFile("api-key.txt"));
        forgetAttendanceSecrets();
        expect((await get("jyoti.test", "/attendance/sync-state")).body.configured).toBe(false);
        expect((await get("a.kumar", "/attendance/me")).body).toMatchObject({ linked: true, configured: false });
        expect(((await get("jyoti.test", "/attendance/today")).body.people as unknown[]).length).toBe(29);
      });

      it("NO read route returns a mobile number or an Aadhaar hash — every body of every route, for every audience", async () => {
        const from = addDays(today, -30);
        for (const [who, path] of [
          ["a.kumar", `/attendance/me?from=${from}&to=${today}`], ["a.kumar", "/attendance/me/punches"], ["a.kumar", "/attendance/person/304"],
          ["jyoti.test", "/attendance/today"], ["jyoti.test", `/attendance/person/304?from=${from}&to=${today}`], ["jyoti.test", "/attendance/person/320"],
          ["jyoti.test", `/attendance/summary?from=${from}&to=${today}&groupBy=dept`], ["jyoti.test", "/attendance/sync-state"],
          ["hod", "/attendance/team/today"], ["hod", `/attendance/team?from=${from}&to=${today}`], ["hod", "/attendance/person/303"],
          ["mgr", "/attendance/person/317"], ["m.lal", "/attendance/me"],
        ] as const) expect([path, (await get(who, path)).status]).toEqual([path, 200]);
        const all = seen.join("\n");
        expect(seen.length).toBeGreaterThanOrEqual(13);
        const secrets = [...stub.fixture.staff.flatMap((s) => [s.mobile, s.aadhaar_hash]), ...(await db.select({ p: users.phone }).from(users)).map((u) => u.p)].filter((v): v is string => v !== null);
        expect(secrets.length).toBeGreaterThan(55);
        for (const s of secrets) expect(`${all.includes(s) ? `LEAKED ${s}` : "clean"}`).toBe("clean");
        expect(all).not.toMatch(/"(mobile|phone|aadhaar|aadhaarHash|aadhaar_hash|aadhaarLast4)"/);
        expect(all).not.toMatch(/[0-9a-f]{64}/);
        expect(all).not.toMatch(/\b[6-9]\d{9}\b/);
      });

      it("reading OTHER people's attendance is audited, counts only; reading your own is not", async () => {
        await get("a.kumar", "/attendance/me");
        await get("a.kumar", "/attendance/person/304");
        await get("jyoti.test", "/attendance/summary");
        expect(await db.select().from(events).where(eq(events.name, "attendance.read"))).toEqual([]);
        await get("jyoti.test", "/attendance/today");
        await get("jyoti.test", `/attendance/person/325?from=${addDays(today, -6)}&to=${today}`);
        await get("hod", "/attendance/team/today");
        await get("hod", "/attendance/person/303");
        const rows = (await db.select().from(events).where(eq(events.name, "attendance.read")).orderBy(events.seq));
        expect(rows.map((e) => [e.actorId, e.payload])).toEqual([
          [ids.committee, { view: "today", scope: "all", subjectPin: null, from: today, to: today, people: 29, rows: 29 }],
          [ids.committee, { view: "person", scope: "all", subjectPin: "325", from: addDays(today, -6), to: today, people: 1, rows: 7 }],
          [ids.hod, { view: "team_today", scope: "team", subjectPin: null, from: today, to: today, people: 2, rows: 1 }],
          [ids.hod, { view: "person", scope: "team", subjectPin: "303", from: addDays(today, -6), to: today, people: 1, rows: expect.any(Number) }],
        ]);
      });
    });
  });

  describe("today's three states, 'Confirm', and the request to meet the attendance manager", () => {
    let app: NestExpressApplication;
    let ids: { kumar: string; committee: string; second: string; doctor: string; owner: string };
    let confirmDays: string[];
    beforeAll(async () => { app = await boot(); });
    afterAll(async () => { await app.close(); });
    beforeEach(async () => {
      await truncateAll(db);
      await syncPermissions(db, registry);
      placeSecrets();
      // The ROLE is what a request is sent to — created here the way `seed:roles` creates it.
      await db.insert(roles).values({ key: "attendance_committee", title: "Attendance Committee" }).onConflictDoNothing();
      await grantPermissionToRole(db, registry, "attendance_committee", "attendance.all.read");
      ids = {
        kumar: await mk("a.kumar", "Dr A Kumar", { phone: mobileOf("304") }),
        committee: await mk("committee.one", "Committee One"),
        second: await mk("committee.two", "Committee Two"),
        doctor: await mk("dr.plain", "Dr Plain", { phone: mobileOf("305") }),
        owner: await mk("the.owner", "The Owner", { permissions: ["attendance.all.read"] }), // sees everything, is NOT on the committee
      };
      await assignRole(db, { userId: ids.committee, roleKey: "attendance_committee", scopeType: "hospital" });
      await assignRole(db, { userId: ids.second, roleKey: "attendance_committee", scopeType: "hospital" });
      await pull();
      confirmDays = stub.fixture.days.filter((d) => d.pin === "304" && d.status === "single_punch" && d.date < today).map((d) => d.date);
      if (confirmDays.length === 0) throw new Error("the fixture gives pin 304 no forgotten-punch day");
    });

    const http = (): ReturnType<typeof request> => request(app.getHttpServer());
    const token = async (username: string): Promise<{ Authorization: string }> =>
      ({ Authorization: `Bearer ${(await http().post("/auth/login").send({ username, password: PW }).expect(201)).body.token as string}` });
    const alertsOf = async () => (await db.select({ userId: alerts.userId, kind: alerts.kind, title: alerts.title, body: alerts.body }).from(alerts).orderBy(alerts.createdAt, alerts.userId));
    const ordinaryDay = (pin: string): string => stub.fixture.days.find((d) => d.pin === pin && d.status === "on_time" && d.date < today)!.date;

    it("today is not-checked-in, checked-in or checked-out by the COUNT of the day's punches, whatever their direction says", async () => {
      const me = await token("a.kumar");
      const state = async () => (await http().get("/attendance/me").set(me).expect(200)).body.today as { state: string; status: string | null };
      await db.delete(attPunches).where(and(eq(attPunches.pin, "304"), eq(attPunches.day, today)));
      expect(await state()).toEqual({ date: today, state: "not_checked_in", status: null });
      const hook = (p: ReturnType<BioattendStub["addPunch"]>[]) => { const s = stub.signedWebhook(p); return http().post("/webhooks/bioattend").set(s.headers).send(s.body).expect(204); };
      await hook([stub.addPunch("304", `${today} 09:00:00`, { direction: "in" })]);
      expect(await state()).toEqual({ date: today, state: "checked_in", status: null });
      // The evening punch says `in` too (many devices do): two punches is OUT, and now the day has its word.
      await hook([stub.addPunch("304", `${today} 17:00:00`, { direction: "in" })]);
      await db.update(attDays).set({ status: "late", firstIn: "09:00", lastOut: "17:00" }).where(and(eq(attDays.pin, "304"), eq(attDays.date, today)));
      expect(await state()).toEqual({ date: today, state: "checked_out", status: "present" });
      await hook([stub.addPunch("304", `${today} 18:00:00`, { direction: "out" })]);
      expect((await state()).state).toBe("checked_in"); // three: back in
      // And still no time in it.
      expect(JSON.stringify(await state())).not.toMatch(/\d\d:\d\d/);
    });

    it("a request can be raised ONLY for one of the caller's own `confirm` days", async () => {
      const me = await token("a.kumar");
      const ask = (body: unknown, as = me) => http().post("/attendance/me/requests").set(as).send(body as object);
      // An ordinary day of one's own: no.
      expect([(await ask({ date: ordinaryDay("304") })).status, (await ask({ date: ordinaryDay("304") })).body]).toEqual([409, { code: "not_a_confirm_day" }]);
      // Today and the future: no — today's single punch is not a forgotten one yet.
      for (const date of [today, addDays(today, 1), "not-a-date"]) expect((await ask({ date })).body).toEqual({ code: "bad_date" });
      // Somebody else's: there is nowhere to say whose — a pin or a user in the body is refused outright…
      expect((await ask({ date: confirmDays[0], pin: "305" })).status).toBe(400);
      expect((await ask({ date: confirmDays[0], userId: ids.doctor })).status).toBe(400);
      // …and a day that is `confirm` for Dr Kumar is not one for Dr Plain unless it is his own too.
      const hisOnly = confirmDays.find((d) => stub.fixture.days.find((x) => x.pin === "305" && x.date === d)?.status !== "single_punch")!;
      expect((await ask({ date: hisOnly }, await token("dr.plain"))).body).toEqual({ code: "not_a_confirm_day" });
      // An unlinked person has no day to ask about.
      expect((await ask({ date: confirmDays[0] }, await token("committee.one"))).body).toEqual({ code: "not_linked" });
      expect((await http().post("/attendance/me/requests").send({ date: confirmDays[0] })).status).toBe(401);
      expect(await db.select().from(attMeetingRequests)).toEqual([]);
      expect(await alertsOf()).toEqual([]);

      const ok = await ask({ date: confirmDays[0], note: "  Forgot to punch out after the night round  " });
      expect([ok.status, ok.body.created]).toEqual([200, true]);
      expect(ok.body.request).toMatchObject({ date: confirmDays[0], reasonCode: "one_punch_only", note: "Forgot to punch out after the night round", status: "open", closedAt: null });
      expect((await db.select().from(attMeetingRequests))[0]).toMatchObject({ userId: ids.kumar, pin: "304", date: confirmDays[0], status: "open" });
      expect((await ask({ date: confirmDays[0], note: "x".repeat(201) })).status).toBe(400);
    });

    it("the Attendance Committee's holders are told, once each, in fixed words — a doctor is not, and nor is anyone merely able to see everything", async () => {
      const me = await token("a.kumar");
      const first = await http().post("/attendance/me/requests").set(me).send({ date: confirmDays[0] }).expect(200);
      const want = [ids.committee, ids.second].sort().map((userId) => ({ userId, kind: "attendance_meeting_request", title: "Meeting request", body: "Meeting request · Dr A Kumar" }));
      expect((await alertsOf()).sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(want);
      // IDEMPOTENT: asking again returns the first, 200, and tells nobody again.
      const again = await http().post("/attendance/me/requests").set(me).send({ date: confirmDays[0], note: "second try" }).expect(200);
      expect([again.body.created, again.body.request.id, again.body.request.note]).toEqual([false, first.body.request.id, null]);
      expect(await db.select().from(attMeetingRequests)).toHaveLength(1);
      expect(await alertsOf()).toHaveLength(2);
      // One audit event: who, which day, the reason code, how many were told — and not the note.
      const audit = (await db.select().from(events).where(eq(events.name, "attendance.meeting_requested")));
      expect(audit.map((e) => [e.actorId, e.payload])).toEqual([[ids.kumar, { requestId: first.body.request.id, userId: ids.kumar, date: confirmDays[0], reasonCode: "one_punch_only", notified: 2 }]]);
      // A deactivated committee member is not told.
      await db.update(users).set({ active: false }).where(eq(users.id, ids.second));
      if (confirmDays.length > 1) {
        await http().post("/attendance/me/requests").set(me).send({ date: confirmDays[1] }).expect(200);
        expect((await alertsOf()).filter((a) => a.userId === ids.second)).toHaveLength(1);
        expect((await alertsOf()).filter((a) => a.userId === ids.committee)).toHaveLength(2);
      }
    });

    it("at most five open at a time, per person", async () => {
      // Six of this person's past days read `confirm`.
      const six = stub.fixture.days.filter((d) => d.pin === "304" && d.date < today).slice(0, 6).map((d) => d.date);
      for (const date of six) await db.update(attDays).set({ status: "single_punch" }).where(and(eq(attDays.pin, "304"), eq(attDays.date, date)));
      const me = await token("a.kumar");
      for (const date of six.slice(0, 5)) await http().post("/attendance/me/requests").set(me).send({ date }).expect(200);
      const sixth = await http().post("/attendance/me/requests").set(me).send({ date: six[5] });
      expect([sixth.status, sixth.body]).toEqual([429, { code: "too_many_open_requests", max: 5 }]);
      // Asking again about one already open is still the first one back, not a refusal.
      expect((await http().post("/attendance/me/requests").set(me).send({ date: six[0] }).expect(200)).body.created).toBe(false);
      const mine = await http().get("/attendance/me/requests").set(me).expect(200);
      expect((mine.body.requests as { date: string }[]).map((r) => r.date).sort()).toEqual(six.slice(0, 5).sort());
      expect((await http().get("/attendance/me/requests").set(await token("dr.plain"))).body).toEqual({ requests: [] });
    });

    it("the committee's queue, seen and close need attendance.all.read; closing tells the requester once", async () => {
      const me = await token("a.kumar");
      const id = (await http().post("/attendance/me/requests").set(me).send({ date: confirmDays[0], note: "Forgot" }).expect(200)).body.request.id as string;
      // A doctor — and the requester — can neither read the queue nor act on it.
      for (const who of ["a.kumar", "dr.plain"]) {
        const as = await token(who);
        expect((await http().get("/attendance/requests").set(as)).status).toBe(403);
        expect((await http().post(`/attendance/requests/${id}/seen`).set(as)).status).toBe(403);
        expect((await http().post(`/attendance/requests/${id}/close`).set(as).send({ note: "self-service" })).status).toBe(403);
      }
      expect((await db.select().from(attMeetingRequests))[0]!.status).toBe("open");

      const committee = await token("committee.one");
      const queue = await http().get("/attendance/requests").set(committee).expect(200);
      expect(queue.body).toEqual({ status: "open", requests: [expect.objectContaining({ id, name: "Dr A Kumar", dept: "Medicine", post: "Asst Prof", date: confirmDays[0], reasonCode: "one_punch_only", note: "Forgot", status: "open", ageHours: 0 })] });
      expect(JSON.stringify(queue.body)).not.toContain(mobileOf("304"));

      expect((await http().post(`/attendance/requests/${id}/seen`).set(committee).expect(200)).body.request.status).toBe("seen");
      await http().post(`/attendance/requests/${id}/seen`).set(committee).expect(200); // again: nothing changes
      expect((await http().get("/attendance/requests?status=seen").set(committee)).body.requests).toHaveLength(1);
      expect((await http().get("/attendance/requests").set(committee)).body.requests).toEqual([]);
      // Seen is still "one open request for that day": asking again returns it.
      expect((await http().post("/attendance/me/requests").set(me).send({ date: confirmDays[0] })).body).toMatchObject({ created: false, request: { id, status: "seen" } });

      // The owner (sees everything, not on the committee) may handle it too — DECIDED.
      const closed = await http().post(`/attendance/requests/${id}/close`).set(await token("the.owner")).send({ note: "Met on Friday; corrected in bioattend" }).expect(200);
      expect(closed.body.request).toMatchObject({ id, status: "closed", closeNote: "Met on Friday; corrected in bioattend" });
      await http().post(`/attendance/requests/${id}/close`).set(committee).send({}).expect(200); // closing a closed one: no second notice
      expect((await http().post(`/attendance/requests/${id}/seen`).set(committee)).body).toEqual({ code: "already_closed" });
      expect((await http().post("/attendance/requests/01JZZZZZZZZZZZZZZZZZZZZZZZ/close").set(committee).send({})).status).toBe(404);

      const told = (await alertsOf()).filter((a) => a.userId === ids.kumar);
      expect(told).toEqual([{ userId: ids.kumar, kind: "attendance_request_closed", title: "Attendance request closed", body: "Attendance request closed" }]);
      expect((await http().get("/attendance/me/requests").set(me)).body.requests).toEqual([expect.objectContaining({ id, status: "closed", closeNote: "Met on Friday; corrected in bioattend" })]);
      expect((await http().get("/attendance/requests?status=closed").set(committee)).body.requests).toHaveLength(1);
      const names = (await db.select().from(events).orderBy(events.seq)).map((e) => e.name).filter((n) => n.startsWith("attendance.meeting"));
      expect(names).toEqual(["attendance.meeting_requested", "attendance.meeting_request_seen", "attendance.meeting_request_closed"]);
      // The free-text notes are in the row and in NO event.
      expect(JSON.stringify(await db.select().from(events))).not.toMatch(/Forgot|Met on Friday/);
    });

    it("a correction upstream flips the day's word by itself and closes the request as resolved_by_correction", async () => {
      const me = await token("a.kumar");
      const date = confirmDays[confirmDays.length - 1]!;
      const id = (await http().post("/attendance/me/requests").set(me).send({ date }).expect(200)).body.request.id as string;
      const before = (await http().get(`/attendance/me?from=${date}&to=${date}`).set(me)).body;
      expect(before.days).toEqual([{ date, status: "confirm", reason: "one_punch_only" }]);
      expect(before.needsConfirm).toContain(date);

      // An admin adds the missing punch in bioattend; the day is no longer `single_punch` (and, if last month's, was open).
      stub.setDay("304", date, { status: "on_time", last_out: "17:04", hours_worked: 8, locked: false });
      await db.update(attDays).set({ locked: false }).where(and(eq(attDays.pin, "304"), eq(attDays.date, date)));
      const out = await syncAttendance(db, { baseUrl: base, syncEnabled: true, selfShowsTimes: false, apiKeyFile: secretFile("api-key.txt"), webhookSecretFile: null, aadhaarKeyFile: null },
        new Date(`${addDays(today, 1)}T01:40:00+05:30`), { sleep: async () => {} }); // the next nightly re-read
      expect(out).toMatchObject({ ran: true, stages: { months: "ok" } });

      const after = (await http().get(`/attendance/me?from=${date}&to=${date}`).set(me)).body;
      expect(after.days).toEqual([{ date, status: "present" }]);
      expect(after.needsConfirm).not.toContain(date);
      expect((await db.select().from(attMeetingRequests).where(eq(attMeetingRequests.id, id)))[0]).toMatchObject({ status: "resolved_by_correction", closedBy: null });
      expect((await http().get("/attendance/me/requests").set(me)).body.requests[0]).toMatchObject({ id, status: "resolved_by_correction" });
      const closedEvents = (await db.select().from(events).where(eq(events.name, "attendance.meeting_request_closed"))).map((e) => [e.actorType, e.payload]);
      expect(closedEvents).toEqual([["system", { requestId: id, userId: ids.kumar, date, reasonCode: "one_punch_only", how: "resolved_by_correction" }]]);
      // The day is ordinary now: nothing to ask about.
      expect((await http().post("/attendance/me/requests").set(me).send({ date })).body).toEqual({ code: "not_a_confirm_day" });
      // The managers' view kept the machine's own word throughout.
      const full = await http().get(`/attendance/person/304?from=${date}&to=${date}`).set(await token("the.owner"));
      expect(full.body.days).toEqual([expect.objectContaining({ date, status: "on_time", lastOut: "17:04" })]);
    });

    it("managers still see the machine's own `single_punch` for a day its owner sees as `confirm`", async () => {
      const full = await http().get(`/attendance/person/304?from=${confirmDays[0]}&to=${confirmDays[0]}`).set(await token("committee.one")).expect(200);
      expect(full.body.days).toEqual([expect.objectContaining({ date: confirmDays[0], status: "single_punch", known: true })]);
    });

    it("NO notice carries a time, a date, a status or a note — only the fixed wording", async () => {
      const me = await token("a.kumar");
      const committee = await token("committee.one");
      for (const date of confirmDays.slice(0, 2)) {
        const id = (await http().post("/attendance/me/requests").set(me).send({ date, note: "single_punch at 08:58, absent?" }).expect(200)).body.request.id as string;
        await http().post(`/attendance/requests/${id}/close`).set(committee).send({ note: "late on 2026-01-01 at 09:41" }).expect(200);
      }
      const all = await alertsOf();
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const a of all) {
        expect(["Meeting request|Meeting request · Dr A Kumar", "Attendance request closed|Attendance request closed"]).toContain(`${a.title}|${a.body}`);
        expect(`${a.title} ${a.body}`).not.toMatch(/\d|punch|late|absent|present|confirm|partial|leave/i);
      }
      // The events the phone relay reads say which alert and which kind — nothing of the person's day.
      const raised = JSON.stringify((await db.select().from(events).where(eq(events.name, "alert.raised"))).map((e) => e.payload));
      expect(raised).not.toMatch(/08:58|09:41|single_punch|Kumar/);
    });
  });

  describe("with ATTENDANCE_SELF_SHOWS_TIMES=true — the switch for after commissioning, no app build", () => {
    let app: NestExpressApplication;
    beforeAll(async () => { app = await boot({ ATTENDANCE_SELF_SHOWS_TIMES: "true" }); });
    afterAll(async () => { await app.close(); });
    beforeEach(async () => {
      await truncateAll(db);
      await syncPermissions(db, registry);
      placeSecrets();
    });

    it("the self routes also carry first-in, last-out, hours and the day's punches; the words are unchanged", async () => {
      await mk("a.kumar", "Dr A Kumar", { phone: mobileOf("304") });
      await pull();
      const http = request(app.getHttpServer());
      const auth = { Authorization: `Bearer ${(await http.post("/auth/login").send({ username: "a.kumar", password: PW }).expect(201)).body.token as string}` };
      const from = addDays(today, -10);
      const mine = stub.fixture.days.filter((d) => d.pin === "304" && d.date >= from && d.date <= today);
      const me = await http.get(`/attendance/me?from=${from}&to=${today}`).set(auth).expect(200);
      expect(me.body.showsTimes).toBe(true);
      expect((me.body.days as { date: string; firstIn: string | null; lastOut: string | null; hoursWorked: number | null }[]).map((d) => [d.date, d.firstIn, d.lastOut, d.hoursWorked]))
        .toEqual(mine.map((d) => [d.date, d.first_in, d.last_out, d.hours_worked]));
      expect((me.body.days as { status: string }[]).every((d) => ["present", "absent", "leave", "off", "partial", "unknown", "confirm"].includes(d.status))).toBe(true);
      expect(Object.keys(me.body.today).sort()).toEqual(["date", "firstIn", "inSince", "lastOut", "state", "status"]);

      const worked = mine.find((d) => d.last_out !== null)!;
      const punches = await http.get(`/attendance/me/punches?date=${worked.date}`).set(auth).expect(200);
      const theirs = stub.fixture.punches.filter((p) => p.pin === "304" && p.ts.startsWith(worked.date));
      expect(punches.body).toMatchObject({ linked: true, date: worked.date, showsTimes: true });
      expect(punches.body.punches).toEqual(theirs.map((p) => ({ time: p.ts.slice(11), direction: p.direction, device: p.device, verify: p.verify })));
      // Still nobody else's.
      expect((await http.get("/attendance/person/305").set(auth)).status).toBe(403);
    });
  });
});
