import { Test } from "@nestjs/testing";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { attStaff, events, roles, users } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { attendanceManifest, syncAttendance } from "../src/modules/attendance";
import { forgetAttendanceSecrets } from "../src/modules/attendance/secrets";
import { istDate } from "../src/modules/attendance/ist";
import { STUB_AADHAAR_KEY, STUB_API_KEY, STUB_WEBHOOK_SECRET, createBioattendStub } from "../scripts/bioattend-stub";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";
import type { BioattendStub } from "../scripts/bioattend-stub";

/**
 * #634 — LINKING STAFF LOGINS TO THE MACHINE'S LIST BY HAND, AND THE COUNT TO WATCH.
 *
 * Against the test double's fixture (`scripts/bioattend-stub.ts`): thirty people, pin 328 has left,
 * pins 320 and 321 share one mobile, pin 304 is the guide's Aadhaar example. No date is pinned.
 */
const PW = "s3cret-pass";
const ENV_KEYS = ["HMIS_BIOATTEND_API_KEY_FILE", "HMIS_BIOATTEND_WEBHOOK_SECRET_FILE", "HMIS_BIOATTEND_AADHAAR_KEY_FILE", "ATTENDANCE_SYNC_ENABLED", "BIOATTEND_BASE_URL", "DATABASE_URL"] as const;

describe("attendance links e2e (#634)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dir: string;
  let stub: BioattendStub;
  let base: string;
  let app: NestExpressApplication;
  const saved: Record<string, string | undefined> = {};
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(attendanceManifest);
  const secretFile = (name: string): string => join(dir, name);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "hmis-att-links-"));
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.HMIS_BIOATTEND_API_KEY_FILE = secretFile("api-key.txt");
    process.env.HMIS_BIOATTEND_WEBHOOK_SECRET_FILE = secretFile("webhook-secret.txt");
    process.env.HMIS_BIOATTEND_AADHAAR_KEY_FILE = secretFile("aadhaar-key.txt");
    stub = createBioattendStub({ today: istDate(new Date()) });
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

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const token = async (username: string): Promise<{ Authorization: string }> =>
    ({ Authorization: `Bearer ${(await http().post("/auth/login").send({ username, password: PW }).expect(201)).body.token as string}` });
  const mobileOf = (pin: string): string => stub.fixture.staff.find((s) => s.pin === pin)!.mobile!;
  const hashOf = (pin: string): string => stub.fixture.staff.find((s) => s.pin === pin)!.aadhaar_hash!;

  async function mk(username: string, fullName: string, set: { phone?: string; aadhaarHash?: string; last4?: string; permissions?: string[] } = {}): Promise<string> {
    const { id } = await createUser(db, { username, fullName, password: PW });
    // Written straight to the row, NOT through the identity route — so the automatic link does not run
    // and the pair is left for a person, as a phone set before #634 or by another screen would be.
    if (set.phone !== undefined) await db.update(users).set({ phone: set.phone }).where(eq(users.id, id));
    if (set.aadhaarHash !== undefined) await db.update(users).set({ aadhaarHash: set.aadhaarHash, aadhaarLast4: set.last4 ?? "0000" }).where(eq(users.id, id));
    if (set.permissions !== undefined) {
      const roleKey = `role_${username.replace(/\W/g, "_")}`;
      await db.insert(roles).values({ key: roleKey, title: roleKey }).onConflictDoNothing();
      for (const p of set.permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    return id;
  }

  let admin: { Authorization: string };
  let committee: { Authorization: string };
  let plain: { Authorization: string };
  let adminId: string;
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    writeFileSync(secretFile("api-key.txt"), `${STUB_API_KEY}\n`);
    writeFileSync(secretFile("webhook-secret.txt"), `${STUB_WEBHOOK_SECRET}\n`);
    writeFileSync(secretFile("aadhaar-key.txt"), `${STUB_AADHAAR_KEY}\n`);
    forgetAttendanceSecrets();
    adminId = await mk("root_admin", "Root Admin", { permissions: ["auth.users.manage"] });
    await mk("att_committee", "Committee Member", { permissions: ["attendance.all.read"] });
    await mk("plain", "Plain Person");
    const out = await syncAttendance(db, { baseUrl: base, syncEnabled: true, selfShowsTimes: false, apiKeyFile: secretFile("api-key.txt"), webhookSecretFile: null, aadhaarKeyFile: null }, new Date(), { sleep: async () => {} });
    if (!out.ran || out.refused) throw new Error(`the pull did not run: ${JSON.stringify(out)}`);
    admin = await token("root_admin");
    committee = await token("att_committee");
    plain = await token("plain");
  });

  /** Nothing any of these routes answers may carry a full mobile or a 64-hex hash. */
  function clean(body: unknown): void {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    for (const s of stub.fixture.staff) if (s.mobile !== null) expect(text.includes(s.mobile) ? `CONTAINS ${s.pin}'s mobile` : "clean").toBe("clean");
  }

  describe("the count and the unlinked list (owner, committee)", () => {
    it("counts active people, linked and not; lists the unlinked with a reason; moves when a login links", async () => {
      const first = await http().get("/attendance/links").set(committee).expect(200);
      expect(first.body.counts).toEqual({ active: 29, linked: 0, unlinked: 29, needsAttention: 0, loginsActive: 3, loginsLinked: 0 });
      expect(first.body.total).toBe(29);
      const pins = (first.body.people as { pin: string }[]).map((p) => p.pin);
      expect(pins).not.toContain("328"); // has left
      expect(first.body.people.find((p: { pin: string }) => p.pin === "301")).toEqual({ pin: "301", name: "Dr Meera Nair", dept: "Medicine", post: "Professor", reason: "no_match" });
      clean(first.body);

      // The Users screen's mobile links pin 304 by itself; a shared number is flagged, not linked.
      const kumar = await mk("a.kumar", "Dr A Kumar");
      await http().post(`/admin/users/${kumar}/identity`).set(admin).send({ mobile: mobileOf("304") }).expect(200);
      const lal = await mk("m.lal", "M Lal");
      await http().post(`/admin/users/${lal}/identity`).set(admin).send({ mobile: mobileOf("320") }).expect(200);

      const after = await http().get("/attendance/links").set(committee).expect(200);
      expect(after.body.counts).toEqual({ active: 29, linked: 1, unlinked: 28, needsAttention: 2, loginsActive: 5, loginsLinked: 1 });
      expect(after.body.people.find((p: { pin: string }) => p.pin === "304")).toBeUndefined();
      expect(after.body.people.find((p: { pin: string }) => p.pin === "320")).toMatchObject({ reason: "mobile_shared_on_machine" });
      clean(after.body);
    });

    it("searches by pin, name or department, and pages by a hundred", async () => {
      const byDept = await http().get("/attendance/links?q=nursing").set(committee).expect(200);
      expect((byDept.body.people as { dept: string }[]).every((p) => p.dept === "Nursing")).toBe(true);
      expect(byDept.body.total).toBe(4);
      expect((await http().get("/attendance/links?q=301").set(committee)).body.people.map((p: { pin: string }) => p.pin)).toEqual(["301"]);
      expect((await http().get("/attendance/links?offset=20").set(committee)).body.people).toHaveLength(9);
      expect((await http().get("/attendance/links?offset=-1").set(committee)).status).toBe(400);
    });

    it("is attendance.all.read's: a plain person and the Users administrator are refused, nobody signed out", async () => {
      expect((await http().get("/attendance/links").set(plain)).status).toBe(403);
      expect((await http().get("/attendance/links").set(admin)).status).toBe(403);
      expect((await http().get("/attendance/links")).status).toBe(401);
    });
  });

  describe("linking by hand (the Users screen's administrator)", () => {
    it("the search finds machine people by pin, name or department, saying who is linked to whom", async () => {
      const kumar = await mk("a.kumar", "Dr A Kumar");
      await http().post(`/admin/users/${kumar}/identity`).set(admin).send({ mobile: mobileOf("304") }).expect(200);
      const res = await http().get("/admin/users/attendance-links?q=dr%20a%20kumar").set(admin).expect(200);
      expect(res.body.counts).toMatchObject({ linked: 1, active: 29 });
      expect(res.body.people).toEqual([
        { pin: "304", name: "Dr A Kumar", dept: "Medicine", post: "Asst Prof", status: "active", needsAttention: null, login: { userId: kumar, username: "a.kumar", fullName: "Dr A Kumar", source: "mobile" } },
      ]);
      expect((await http().get("/admin/users/attendance-links?q=328").set(admin)).body.people[0]).toMatchObject({ pin: "328", status: "left", login: null });
      expect((await http().get("/admin/users/attendance-links").set(admin)).body.people).toEqual([]);
      clean(res.body);
    });

    it("suggestions are exact mobile matches only — shared numbers marked — and a click links one", async () => {
      const one = await mk("d.nair", "D Nair", { phone: mobileOf("301") }); // written straight, so not linked yet
      const shared = await mk("m.lal", "M Lal", { phone: mobileOf("320") });
      await mk("nobody", "No Match", { phone: "9000000001" });
      const list = await http().get("/admin/users/attendance-links/suggestions").set(admin).expect(200);
      expect(list.body.suggestions).toEqual([
        { person: { pin: "301", name: "Dr Meera Nair", dept: "Medicine", post: "Professor" }, login: { userId: one, username: "d.nair", fullName: "D Nair" }, last4: mobileOf("301").slice(-4), shared: false },
        { person: { pin: "320", name: "Mohan Lal", dept: "Housekeeping", post: "Attendant" }, login: { userId: shared, username: "m.lal", fullName: "M Lal" }, last4: "0020", shared: true },
        { person: { pin: "321", name: "Sohan Lal", dept: "Housekeeping", post: "Attendant" }, login: { userId: shared, username: "m.lal", fullName: "M Lal" }, last4: "0020", shared: true },
      ]);
      clean(list.body);

      const linked = await http().post("/admin/users/attendance-links").set(admin).send({ pin: "321", userId: shared });
      expect([linked.status, linked.body.pin, linked.body.userId, linked.body.source, linked.body.counts.linked]).toEqual([200, "321", shared, "mobile", 1]);
      expect((await db.select().from(attStaff).where(eq(attStaff.pin, "321")))[0]).toMatchObject({ userId: shared, linkSource: "mobile", needsAttention: null });
      // The login is somebody's now: neither 320 nor 321 is offered it again.
      const left = (await http().get("/admin/users/attendance-links/suggestions").set(admin)).body.suggestions as { person: { pin: string } }[];
      expect(left.map((s) => s.person.pin)).toEqual(["301"]);
      // The event is the automatic rule's own, and its actor is the administrator who clicked.
      const ev = (await db.select().from(events).where(eq(events.name, "attendance.person_linked"))).filter((e) => (e.payload as { pin: string }).pin === "321");
      expect(ev.map((e) => [e.actorType, e.actorId, e.payload])).toEqual([["user", adminId, { pin: "321", userId: shared, source: "mobile" }]]);
    });

    it("candidates: the logins that match a person by mobile or Aadhaar, and a login search that says whether each matches", async () => {
      const a = await mk("twin.a", "Twin A", { aadhaarHash: hashOf("305"), last4: "1111" });
      const b = await mk("twin.b", "Twin B", { aadhaarHash: hashOf("305"), last4: "1111" });
      const other = await mk("s.verma.new", "S Verma");
      const res = await http().get("/admin/users/attendance-links/305/candidates?q=verma").set(admin).expect(200);
      expect(res.body.person).toMatchObject({ pin: "305", name: "Dr Sunil Verma", login: null });
      expect(res.body.matches.map((m: { userId: string; match: string; aadhaar: string }) => [m.userId, m.match, m.aadhaar])).toEqual([[a, "aadhaar", "XXXX XXXX 1111"], [b, "aadhaar", "XXXX XXXX 1111"]]);
      expect(res.body.found).toEqual([{ userId: other, username: "s.verma.new", fullName: "S Verma", staffCode: expect.any(String), linkedPin: null, match: null, hasMobile: false, aadhaar: null }]);
      clean(res.body);
      expect((await http().get("/admin/users/attendance-links/999/candidates").set(admin)).body).toEqual({ code: "unknown_person" });

      // Two logins gave one Aadhaar: the automatic rule withheld it; the administrator picks one.
      const done = await http().post("/admin/users/attendance-links").set(admin).send({ pin: "305", userId: b }).expect(200);
      expect(done.body.source).toBe("aadhaar");
    });

    it("A MATCH IS STILL NEEDED: a login with neither key is refused until its mobile or Aadhaar is given", async () => {
      const bare = await mk("new.clerk", "New Clerk");
      const res = await http().post("/admin/users/attendance-links").set(admin).send({ pin: "314", userId: bare });
      expect([res.status, res.body]).toEqual([409, { code: "no_match" }]);
      expect((await db.select().from(attStaff).where(eq(attStaff.pin, "314")))[0]!.userId).toBeNull();
      // A wrong mobile is no better.
      await db.update(users).set({ phone: "9000000002" }).where(eq(users.id, bare));
      expect((await http().post("/admin/users/attendance-links").set(admin).send({ pin: "314", userId: bare })).body).toEqual({ code: "no_match" });
      // The right one through the Users screen's route links by itself (one person, one login).
      const set = await http().post(`/admin/users/${bare}/identity`).set(admin).send({ mobile: mobileOf("314") }).expect(200);
      expect(set.body.attendance).toBe("linked");
    });

    it("refusals by name: either side taken, an inactive login, an unknown pin or login, a bad body", async () => {
      const one = await mk("d.nair", "D Nair", { phone: mobileOf("301") });
      await http().post("/admin/users/attendance-links").set(admin).send({ pin: "301", userId: one }).expect(200);
      const again = await mk("d.nair2", "D Nair Two", { phone: mobileOf("301") });
      expect((await http().post("/admin/users/attendance-links").set(admin).send({ pin: "301", userId: again })).body).toEqual({ code: "person_linked" });
      await db.update(users).set({ phone: mobileOf("302") }).where(eq(users.id, one));
      expect((await http().post("/admin/users/attendance-links").set(admin).send({ pin: "302", userId: one })).body).toEqual({ code: "login_linked" });
      const gone = await mk("gone", "Gone", { phone: mobileOf("303") });
      await db.update(users).set({ active: false }).where(eq(users.id, gone));
      expect((await http().post("/admin/users/attendance-links").set(admin).send({ pin: "303", userId: gone })).body).toEqual({ code: "login_inactive" });
      const nope = await http().post("/admin/users/attendance-links").set(admin).send({ pin: "999", userId: one });
      expect([nope.status, nope.body]).toEqual([404, { code: "unknown_person" }]);
      expect((await http().post("/admin/users/attendance-links").set(admin).send({ pin: "303", userId: "01JZZZZZZZZZZZZZZZZZZZZZZZ" })).body).toEqual({ code: "user_not_found" });
      expect((await http().post("/admin/users/attendance-links").set(admin).send({ pin: "303", userId: gone, extra: 1 })).body).toEqual({ code: "bad_body" });
    });

    it("every admin route is the Users screen's permission: the committee and a plain person are refused", async () => {
      for (const who of [committee, plain]) {
        expect((await http().get("/admin/users/attendance-links?q=a").set(who)).status).toBe(403);
        expect((await http().get("/admin/users/attendance-links/suggestions").set(who)).status).toBe(403);
        expect((await http().get("/admin/users/attendance-links/301/candidates").set(who)).status).toBe(403);
        expect((await http().post("/admin/users/attendance-links").set(who).send({ pin: "301", userId: adminId })).status).toBe(403);
      }
      expect((await http().get("/admin/users/attendance-links/suggestions")).status).toBe(401);
    });
  });
});
