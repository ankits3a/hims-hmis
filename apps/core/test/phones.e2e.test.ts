import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { asc, eq, gt, isNull, and } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { authDevices, authSessions, events, roles } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { USERS_MANAGE } from "../src/kernel/auth/users-admin.controller";
import { PHONES_PER_USER } from "../src/kernel/auth/devices";
import { AUTH_PHONE_EVENTS } from "../src/kernel/auth/events";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * MOBILE M6a — THE PHONES A PERSON IS SIGNED IN ON (owner 2026-10-06: staff use personal phones).
 *
 * Driven over the REAL routes: the staff app's sign-in names its phone; an administrator reads the
 * list and signs one phone out; that phone's very next call is a 401 while the person's browser and
 * other phone carry on. A browser's sign-in (no `device`) is untouched by all of it.
 */
describe("mobile M6a — the phones a person is signed in on", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const PW = "s3cret-pass-xyz";
  const PHONE_A = { deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", model: "Redmi Note 12", os: "Android 14", appVersion: "0.7.0 (8)" };
  const PHONE_B = { deviceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", model: "Samsung A15", os: "Android 15", appVersion: "0.7.0 (8)" };
  const PHONE_C = { deviceId: "cccccccccccccccccccccccccccccccc", model: "Vivo Y28", os: "Android 14", appVersion: "0.7.0 (8)" };
  let adminToken: string; let adminId: string; let ashaId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    ({ id: adminId } = await createUser(db, { username: "root_admin", fullName: "Root Admin", password: PW }));
    await db.insert(roles).values({ key: "users_admin", title: "users_admin" }).onConflictDoNothing();
    await grantPermissionToRole(db, registry, "users_admin", USERS_MANAGE);
    await assignRole(db, { userId: adminId, roleKey: "users_admin", scopeType: "hospital" });
    adminToken = (await login("root_admin")).body.token as string;
    ({ id: ashaId } = await createUser(db, { username: "asha", fullName: "Asha Devi", password: PW }));
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const login = (username: string, device?: Record<string, unknown>, password = PW) =>
    http().post("/auth/login").set("x-forwarded-for", "203.0.113.7").send({ username, password, ...(device === undefined ? {} : { device }) });
  const me = (token: string) => http().get("/auth/me").set("Authorization", `Bearer ${token}`);
  const phonesOf = (userId: string, token = adminToken) => http().get(`/admin/users/${userId}/phones`).set("Authorization", `Bearer ${token}`);
  const signOut = (userId: string, phoneId: string, token = adminToken) =>
    http().post(`/admin/users/${userId}/phones/${phoneId}/sign-out`).set("Authorization", `Bearer ${token}`).send({});

  type Row = { name: string; actorId: string; payload: Record<string, unknown> };
  async function eventsSince(seq: number): Promise<Row[]> {
    const rows = await db.select({ name: events.name, actorId: events.actorId, payload: events.payload }).from(events).where(gt(events.seq, seq)).orderBy(asc(events.seq));
    return rows.filter((r) => r.name.startsWith("auth.")).map((r) => ({ name: r.name, actorId: r.actorId, payload: r.payload as Record<string, unknown> }));
  }
  async function highWater(): Promise<number> {
    const rows = await db.select({ seq: events.seq }).from(events).orderBy(asc(events.seq));
    return rows.length === 0 ? 0 : Number(rows[rows.length - 1]!.seq);
  }

  it("declares its three events — `auth.*`, module `auth`", () => {
    expect(AUTH_PHONE_EVENTS.map((e) => [e.name, e.module])).toEqual([
      ["auth.phone_bound", "auth"], ["auth.phone_limit_refused", "auth"], ["auth.phone_signed_out", "auth"],
    ]);
  });

  it("a browser's sign-in names no phone: no device row, no phone event, the session points at none", async () => {
    const before = await highWater();
    await login("asha").expect(201);
    expect(await db.select().from(authDevices)).toHaveLength(0);
    const sessions = await db.select().from(authSessions).where(eq(authSessions.userId, ashaId));
    expect(sessions.map((s) => s.deviceRowId)).toEqual([null]);
    expect((await eventsSince(before)).map((e) => e.name)).toEqual(["auth.login_succeeded"]);
    const list = await phonesOf(ashaId).expect(200);
    expect(list.body).toEqual({ limit: PHONES_PER_USER, notificationsConfigured: false, phones: [] });
  });

  it("the app's sign-in binds its phone once: the row, the session on it, `auth.phone_bound` — and the list an administrator reads", async () => {
    const before = await highWater();
    const res = await login("asha", PHONE_A).expect(201);
    expect(Object.keys(res.body)).toEqual(["token"]);
    const devices = await db.select().from(authDevices);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ userId: ashaId, deviceId: PHONE_A.deviceId, model: "Redmi Note 12", osVersion: "Android 14", appVersion: "0.7.0 (8)", lastIp: "203.0.113.7" });
    const sessions = await db.select().from(authSessions).where(eq(authSessions.userId, ashaId));
    expect(sessions.map((s) => s.deviceRowId)).toEqual([devices[0]!.id]);
    const evs = await eventsSince(before);
    expect(evs.map((e) => e.name)).toEqual(["auth.login_succeeded", "auth.phone_bound"]);
    expect(evs[1]!.actorId).toBe(ashaId);
    expect(evs[1]!.payload).toMatchObject({ userId: ashaId, deviceRowId: devices[0]!.id, sessionId: sessions[0]!.id, model: "Redmi Note 12", os: "Android 14", ip: "203.0.113.7" });
    // The app's own device id is never copied into the audit trail.
    expect(JSON.stringify(evs)).not.toContain(PHONE_A.deviceId);

    const list = await phonesOf(ashaId).expect(200);
    expect(list.body.limit).toBe(PHONES_PER_USER);
    expect(list.body.phones).toHaveLength(1);
    expect(list.body.phones[0]).toMatchObject({ id: devices[0]!.id, model: "Redmi Note 12", osVersion: "Android 14", appVersion: "0.7.0 (8)", lastIp: "203.0.113.7", signedIn: true });
    expect(typeof list.body.phones[0].signedInSince).toBe("string");
    // …and the list never carries the device id either.
    expect(JSON.stringify(list.body)).not.toContain(PHONE_A.deviceId);
  });

  it("the same phone signing in again is ONE phone and ONE live session: the earlier one ends, evented as `phone_signed_in_again`", async () => {
    const first = (await login("asha", PHONE_A).expect(201)).body.token as string;
    const before = await highWater();
    const second = (await login("asha", { ...PHONE_A, appVersion: "0.7.1 (9)" }).expect(201)).body.token as string;
    expect(await db.select().from(authDevices)).toHaveLength(1);
    expect((await db.select().from(authDevices))[0]!.appVersion).toBe("0.7.1 (9)");
    await me(first).expect(401);
    await me(second).expect(200);
    const evs = await eventsSince(before);
    expect(evs.map((e) => e.name)).toEqual(["auth.login_succeeded", "auth.session_revoked"]);
    expect(evs[1]!.payload).toMatchObject({ userId: ashaId, reason: "phone_signed_in_again" });
    const live = await db.select().from(authSessions).where(and(eq(authSessions.userId, ashaId), isNull(authSessions.revokedAt)));
    expect(live).toHaveLength(1);
  });

  it("an administrator signs ONE phone out: that phone's next call is 401; the other phone and the browser carry on", async () => {
    const phoneA = (await login("asha", PHONE_A).expect(201)).body.token as string;
    const phoneB = (await login("asha", PHONE_B).expect(201)).body.token as string;
    const browser = (await login("asha").expect(201)).body.token as string;
    const list = await phonesOf(ashaId).expect(200);
    const a = (list.body.phones as { id: string; model: string }[]).find((p) => p.model === "Redmi Note 12")!;

    const before = await highWater();
    const res = await signOut(ashaId, a.id).expect(200);
    expect(res.body).toEqual({ sessionsRevoked: 1 });
    await me(phoneA).expect(401);
    await me(phoneB).expect(200);
    await me(browser).expect(200);

    const evs = await eventsSince(before);
    expect(evs.map((e) => e.name)).toEqual(["auth.session_revoked", "auth.phone_signed_out"]);
    // The ACTOR is the administrator; `userId` is the phone's holder.
    expect(evs.map((e) => e.actorId)).toEqual([adminId, adminId]);
    expect(evs[0]!.payload).toMatchObject({ userId: ashaId, reason: "phone_signed_out" });
    expect(evs[1]!.payload).toEqual({ userId: ashaId, username: "asha", deviceRowId: a.id, model: "Redmi Note 12", sessionsRevoked: 1 });

    // The phone stays on the list — it is the record — now holding no session.
    const after = await phonesOf(ashaId).expect(200);
    expect((after.body.phones as { id: string; signedIn: boolean; signedInSince: string | null }[]).find((p) => p.id === a.id)).toMatchObject({ signedIn: false, signedInSince: null });
    // Signing it out again finds nothing to end, and is still the administrator's recorded act.
    expect((await signOut(ashaId, a.id).expect(200)).body).toEqual({ sessionsRevoked: 0 });
    // The person can sign in on that phone again with their password: sign-out takes the session, not the credential.
    await login("asha", PHONE_A).expect(201);
  });

  it("a phone is only signed out under ITS person, by somebody who manages users", async () => {
    await login("asha", PHONE_A).expect(201);
    const phone = (await db.select().from(authDevices))[0]!;
    // Under another user's id the phone does not exist.
    expect((await signOut(adminId, phone.id).expect(404)).body).toMatchObject({ code: "phone_not_found" });
    expect((await signOut("01HZZZZZZZZZZZZZZZZZZZZZZZ", phone.id).expect(404)).body).toMatchObject({ code: "user_not_found" });
    // Asha herself holds no admin permission: she cannot read the list or sign a phone out over these routes.
    const asha = (await login("asha").expect(201)).body.token as string;
    expect((await phonesOf(ashaId, asha).expect(403)).body.message).toBe(`missing permission ${USERS_MANAGE}`);
    expect((await signOut(ashaId, phone.id, asha).expect(403)).body.message).toBe(`missing permission ${USERS_MANAGE}`);
    const live = await db.select().from(authSessions).where(and(eq(authSessions.deviceRowId, phone.id), isNull(authSessions.revokedAt)));
    expect(live).toHaveLength(1);
  });

  it(`the cap: a person holds a session on at most ${PHONES_PER_USER} phones — the next is refused AFTER the password, told which phones, evented, and not counted as a failed attempt`, async () => {
    await login("asha", PHONE_A).expect(201);
    await login("asha", PHONE_B).expect(201);
    const before = await highWater();
    const res = await login("asha", PHONE_C).expect(409);
    expect(res.body).toMatchObject({ code: "phone_limit_reached", limit: PHONES_PER_USER });
    expect((res.body.phones as { model: string }[]).map((p) => p.model).sort()).toEqual(["Redmi Note 12", "Samsung A15"]);
    // No session was opened and no phone row was left behind for the refused phone.
    expect(await db.select().from(authDevices)).toHaveLength(2);
    expect(await db.select().from(authSessions).where(and(eq(authSessions.userId, ashaId), isNull(authSessions.revokedAt)))).toHaveLength(2);
    const evs = await eventsSince(before);
    expect(evs.map((e) => e.name)).toEqual(["auth.phone_limit_refused"]);
    expect(evs[0]!.payload).toMatchObject({ userId: ashaId, phonesSignedIn: 2, limit: PHONES_PER_USER, model: "Vivo Y28" });

    // A WRONG password on the third phone learns nothing about anybody's phones: the plain 401.
    const wrong = await login("asha", PHONE_C, "not-the-password").expect(401);
    expect(JSON.stringify(wrong.body)).not.toContain("phone");

    // The browser is no phone: it still signs in.
    await login("asha").expect(201);
    // A phone already holding a place signs in again freely.
    await login("asha", PHONE_A).expect(201);
    // Once an administrator signs one out, the third phone takes its place.
    const a = (await db.select().from(authDevices)).find((d) => d.deviceId === PHONE_A.deviceId)!;
    await signOut(ashaId, a.id).expect(200);
    await login("asha", PHONE_C).expect(201);
  });

  it("an expired session frees its place by itself", async () => {
    await login("asha", PHONE_A).expect(201);
    await login("asha", PHONE_B).expect(201);
    const a = (await db.select().from(authDevices)).find((d) => d.deviceId === PHONE_A.deviceId)!;
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(authSessions.deviceRowId, a.id));
    await login("asha", PHONE_C).expect(201);
    const list = await phonesOf(ashaId).expect(200);
    expect((list.body.phones as { model: string; signedIn: boolean }[]).filter((p) => p.signedIn).map((p) => p.model).sort()).toEqual(["Samsung A15", "Vivo Y28"]);
  });

  it("opening the app stamps the phone's last-seen; a browser stamps nothing", async () => {
    const token = (await login("asha", PHONE_A).expect(201)).body.token as string;
    const row = (await db.select().from(authDevices))[0]!;
    await db.update(authDevices).set({ lastSeenAt: new Date("2026-01-01T00:00:00Z"), lastIp: "198.51.100.1" }).where(eq(authDevices.id, row.id));
    await me(token).set("x-forwarded-for", "203.0.113.99").expect(200);
    const after = (await db.select().from(authDevices))[0]!;
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(after.lastIp).toBe("203.0.113.99");
    const browser = (await login("asha").expect(201)).body.token as string;
    await db.update(authDevices).set({ lastSeenAt: new Date("2026-01-01T00:00:00Z") }).where(eq(authDevices.id, row.id));
    await me(browser).expect(200);
    expect((await db.select().from(authDevices))[0]!.lastSeenAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("deactivating the person or resetting their password signs every phone out — the existing rule, now seen on the list", async () => {
    const phoneA = (await login("asha", PHONE_A).expect(201)).body.token as string;
    await http().post(`/admin/users/${ashaId}/password-reset`).set("Authorization", `Bearer ${adminToken}`).send({ newPassword: "an0ther-pass-xyz" }).expect(200);
    await me(phoneA).expect(401);
    expect(((await phonesOf(ashaId).expect(200)).body.phones as { signedIn: boolean }[]).map((p) => p.signedIn)).toEqual([false]);
    const again = (await login("asha", PHONE_A, "an0ther-pass-xyz").expect(201)).body.token as string;
    await http().post(`/admin/users/${ashaId}/deactivate`).set("Authorization", `Bearer ${adminToken}`).send({}).expect(200);
    await me(again).expect(401);
    expect(((await phonesOf(ashaId).expect(200)).body.phones as { signedIn: boolean }[]).map((p) => p.signedIn)).toEqual([false]);
  });

  it("a device claim is bounded text: a malformed id or an over-long label is a 400 and opens nothing", async () => {
    await login("asha", { deviceId: "short" }).expect(400);
    await login("asha", { deviceId: "../../etc/passwd-aaaaaaaaaaaaaaaa" }).expect(400);
    await login("asha", { ...PHONE_A, model: "x".repeat(81) }).expect(400);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, ashaId))).toHaveLength(0);
    // Only the id is required; a phone that says nothing else about itself still binds.
    await login("asha", { deviceId: PHONE_A.deviceId }).expect(201);
    expect((await db.select().from(authDevices))[0]).toMatchObject({ model: null, osVersion: null, appVersion: null });
  });
});
