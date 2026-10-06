import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { authDevices, authSessions, events, phonePushSends, roles } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { USERS_MANAGE } from "../src/kernel/auth/users-admin.controller";
import { PHONES_PER_USER } from "../src/kernel/auth/devices";
import { PUSH_PER_USER_PER_HOUR, relayAlertToPhones, sendTestPush } from "../src/kernel/push/phone-push";
import { PHONE_PUSH_FRESH_MS, phonePushConsumer } from "../src/kernel/push/consumer";
import type { DispatchedEvent } from "../src/kernel/events/subscriptions";
import { fixedPhonePushSource } from "../src/kernel/push/sender";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";
import type { PhoneMessage, PhonePushSender } from "../src/kernel/push/fcm";

/**
 * MOBILE M6b — A NOTIFICATION ON A STAFF PHONE (owner 2026-10-06).
 *
 * The phone's own routes are driven for real; the Firebase edge is a fake that records what it was
 * handed. What is proved: a phone is told only while it holds a LIVE session and has given an
 * address; what it is told is the fixed sentence and two words; signing out — by the person, by an
 * administrator, by deactivation or a password reset — makes it silent; a redelivery sends nothing
 * twice; a dead address is forgotten; and nothing here returns, logs or events the address.
 */
describe("mobile M6b — a notification on a staff phone", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const PW = "s3cret-pass-xyz";
  const PHONE_A = { deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", model: "Redmi Note 12", os: "Android 14", appVersion: "0.8.0 (9)" };
  const PHONE_B = { deviceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", model: "Samsung A15", os: "Android 15", appVersion: "0.8.0 (9)" };
  const TOKEN_A = "fGxA:APA91b-address-of-phone-a-0123456789abcdef";
  const TOKEN_B = "fGxB:APA91b-address-of-phone-b-0123456789abcdef";
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
  const login = (username: string, device?: Record<string, unknown>) =>
    http().post("/auth/login").send({ username, password: PW, ...(device === undefined ? {} : { device }) });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const state = (token: string) => http().get("/auth/phone/notifications").set(bearer(token));
  const put = (token: string, body: Record<string, unknown>) => http().put("/auth/phone/notifications").set(bearer(token)).send(body);
  const me = (token: string) => http().get("/auth/me").set(bearer(token));
  const phonesOf = (userId: string) => http().get(`/admin/users/${userId}/phones`).set(bearer(adminToken));

  /** A phone signed in for asha with its address handed over. Returns its session token and row id. */
  async function phoneOn(device: typeof PHONE_A, address: string, language: "en" | "hi" = "en"): Promise<{ token: string; rowId: string }> {
    const token = (await login("asha", device)).body.token as string;
    expect((await put(token, { token: address, language })).status).toBe(200);
    const rows = await db.select({ id: authDevices.id }).from(authDevices).where(eq(authDevices.deviceId, device.deviceId));
    return { token, rowId: rows[0]!.id };
  }

  /** The Firebase edge, faked: records what it was handed and answers as told. */
  function fake(answer: (token: string) => "sent" | "gone" | Error = () => "sent"): { sender: PhonePushSender; sent: { token: string; message: PhoneMessage }[] } {
    const sent: { token: string; message: PhoneMessage }[] = [];
    return {
      sent,
      sender: {
        send: (token, message) => {
          const a = answer(token);
          if (a instanceof Error) return Promise.reject(a);
          sent.push({ token, message });
          return Promise.resolve(a);
        },
      },
    };
  }
  const alertFor = (userId: string, kind = "escalation") => ({ id: newId(), userId, kind });
  const addressOf = async (rowId: string): Promise<string | null> =>
    (await db.select({ t: authDevices.pushToken }).from(authDevices).where(eq(authDevices.id, rowId)))[0]!.t;

  it("the phone's own routes: only a phone has them, the address is write-only, and a category can be switched off", async () => {
    const browser = (await login("asha")).body.token as string;
    expect((await state(browser)).status).toBe(409);
    expect((await state(browser)).body).toMatchObject({ code: "not_a_phone" });

    const phone = (await login("asha", PHONE_A)).body.token as string;
    // This suite runs with no Firebase key: the server says it cannot send, and the phone asks for nothing.
    expect((await state(phone)).body).toEqual({ configured: false, registered: false, muted: [], categories: ["alert", "roster"], addressAt: null, lastSentAt: null, lastTestAt: null });
    const after = await put(phone, { token: TOKEN_A, language: "hi", muted: ["roster"] });
    expect(after.body).toMatchObject({ configured: false, registered: true, muted: ["roster"], categories: ["alert", "roster"], lastSentAt: null, lastTestAt: null });
    expect(typeof after.body.addressAt).toBe("string");
    expect(JSON.stringify(after.body)).not.toContain(TOKEN_A);
    expect((await db.select().from(authDevices))[0]).toMatchObject({ pushToken: TOKEN_A, pushLanguage: "hi", pushMuted: ["roster"] });

    // Bounded input: a sentence is not an address, an unknown category is not a category.
    expect((await put(phone, { token: "not an address" })).status).toBe(400);
    expect((await put(phone, { muted: ["everything"] })).status).toBe(400);

    // The administrator's list says ON or OFF and never the address; nor does any event.
    const listed = await phonesOf(ashaId);
    expect(listed.body).toMatchObject({ limit: PHONES_PER_USER, notificationsConfigured: false, phones: [{ notifications: true }] });
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN_A);
    expect(JSON.stringify(await db.select({ payload: events.payload }).from(events))).not.toContain(TOKEN_A);

    expect((await http().delete("/auth/phone/notifications").set(bearer(phone))).body).toMatchObject({ registered: false });
    expect((await db.select().from(authDevices))[0]).toMatchObject({ pushToken: null, pushTokenAt: null });
  });

  it("an alert is relayed to every signed-in phone of its person, in that phone's language, as the fixed sentence and two words", async () => {
    const a = await phoneOn(PHONE_A, TOKEN_A, "en");
    await phoneOn(PHONE_B, TOKEN_B, "hi");
    const { sender, sent } = fake();
    const result = await relayAlertToPhones(db, sender, alertFor(ashaId, "roster_flag"));
    expect(result).toEqual({ sent: 2, gone: 0, skipped: 0, limited: false });
    expect(sent.sort((x, y) => x.token.localeCompare(y.token))).toEqual([
      { token: TOKEN_A, message: { title: "HMIS", body: "The duty board needs you. Open HMIS to see it.", data: { category: "roster", link: "onNow" } } },
      { token: TOKEN_B, message: { title: "HMIS", body: "ड्यूटी बोर्ड पर आपकी ज़रूरत है। देखने के लिए HMIS खोलें।", data: { category: "roster", link: "onNow" } } },
    ]);
    // What is kept is a category and a phone — no sentence, no address.
    const kept = await db.select().from(phonePushSends).orderBy(asc(phonePushSends.createdAt));
    expect(kept.map((k) => [k.userId, k.category, k.outcome])).toEqual([[ashaId, "roster", "sent"], [ashaId, "roster", "sent"]]);
    expect(Object.keys(kept[0]!).sort()).toEqual(["alertId", "category", "createdAt", "deviceRowId", "id", "outcome", "userId"]);
    expect(kept.some((k) => k.deviceRowId === a.rowId)).toBe(true);
  });

  it("nobody else's phone is told, a switched-off category is not sent, and a phone with no address is not asked", async () => {
    await phoneOn(PHONE_A, TOKEN_A);
    const quiet = (await login("asha", PHONE_B)).body.token as string; // signed in, never handed an address
    expect((await state(quiet)).body).toMatchObject({ registered: false });
    const { sender, sent } = fake();
    await relayAlertToPhones(db, sender, alertFor(adminId)); // the administrator has no phone
    expect(sent).toEqual([]);
    await put((await login("asha", PHONE_A)).body.token as string, { muted: ["roster"] });
    await relayAlertToPhones(db, sender, alertFor(ashaId, "roster_flag"));
    expect(sent).toEqual([]);
    await relayAlertToPhones(db, sender, alertFor(ashaId, "escalation"));
    expect(sent.map((s) => [s.token, s.message.data.category])).toEqual([[TOKEN_A, "alert"]]);
  });

  it("signed out is silent: by the person, by an administrator, by deactivation — the address is gone AND a phone with no session is not asked", async () => {
    // (1) the person logs out of the phone.
    const a = await phoneOn(PHONE_A, TOKEN_A);
    expect((await http().post("/auth/logout").set(bearer(a.token))).status).toBe(204);
    expect(await addressOf(a.rowId)).toBeNull();

    // (2) an administrator signs the phone out.
    const again = await phoneOn(PHONE_A, TOKEN_A);
    expect((await http().post(`/admin/users/${ashaId}/phones/${again.rowId}/sign-out`).set(bearer(adminToken)).send({})).body).toEqual({ sessionsRevoked: 1 });
    expect(await addressOf(again.rowId)).toBeNull();

    // (3) THE GUARD ITSELF: an address left behind by any road is still not used once the session is dead.
    const third = await phoneOn(PHONE_A, TOKEN_A);
    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.deviceRowId, third.rowId));
    expect(await addressOf(third.rowId)).toBe(TOKEN_A);
    const { sender, sent } = fake();
    expect(await relayAlertToPhones(db, sender, alertFor(ashaId))).toEqual({ sent: 0, gone: 0, skipped: 0, limited: false });
    expect(sent).toEqual([]);
    // …and an expired session is the same as a revoked one.
    const fourth = await phoneOn(PHONE_A, TOKEN_A);
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.deviceRowId, fourth.rowId));
    await relayAlertToPhones(db, sender, alertFor(ashaId));
    expect(sent).toEqual([]);

    // (4) deactivating the person ends every session and forgets every address.
    const b = await phoneOn(PHONE_B, TOKEN_B);
    expect((await http().post(`/admin/users/${ashaId}/deactivate`).set(bearer(adminToken)).send({})).status).toBe(200);
    expect(await addressOf(b.rowId)).toBeNull();
    expect(await addressOf(fourth.rowId)).toBeNull();
  });

  it("a password reset by the administrator forgets every address too", async () => {
    const a = await phoneOn(PHONE_A, TOKEN_A);
    const reset = await http().post(`/admin/users/${ashaId}/password-reset`).set(bearer(adminToken)).send({ newPassword: "an0ther-long-secret" });
    expect(reset.status).toBe(200);
    expect(await addressOf(a.rowId)).toBeNull();
  });

  it("one phone, one row: an address that turns up on another row leaves the row it was on", async () => {
    const a = await phoneOn(PHONE_A, TOKEN_A);
    const { id: binduId } = await createUser(db, { username: "bindu", fullName: "Bindu", password: PW });
    const bindu = (await http().post("/auth/login").send({ username: "bindu", password: PW, device: PHONE_A })).body.token as string;
    expect((await put(bindu, { token: TOKEN_A })).status).toBe(200); // the same physical phone, handed to a colleague
    expect(await addressOf(a.rowId)).toBeNull();
    const { sender, sent } = fake();
    await relayAlertToPhones(db, sender, alertFor(ashaId));
    expect(sent).toEqual([]);
    await relayAlertToPhones(db, sender, alertFor(binduId));
    expect(sent.map((s) => s.token)).toEqual([TOKEN_A]);
  });

  it("a redelivery sends nothing twice; a refusal is thrown for the retry, which then sends only what is missing", async () => {
    await phoneOn(PHONE_A, TOKEN_A);
    await phoneOn(PHONE_B, TOKEN_B);
    const alert = alertFor(ashaId);
    let bDown = true;
    const { sender, sent } = fake((token) => (token === TOKEN_B && bDown ? new Error("fcm: send refused with 503 UNAVAILABLE") : "sent"));
    await expect(relayAlertToPhones(db, sender, alert)).rejects.toThrow("fcm: send refused with 503 UNAVAILABLE");
    expect(sent.map((s) => s.token)).toEqual([TOKEN_A]); // the other phone was still told
    bDown = false;
    expect(await relayAlertToPhones(db, sender, alert)).toEqual({ sent: 1, gone: 0, skipped: 1, limited: false });
    expect(sent.map((s) => s.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(await relayAlertToPhones(db, sender, alert)).toEqual({ sent: 0, gone: 0, skipped: 2, limited: false });
    expect(sent).toHaveLength(2);
  });

  it("a dead address is forgotten and recorded as gone; the phone is not asked again", async () => {
    const a = await phoneOn(PHONE_A, TOKEN_A);
    const { sender, sent } = fake(() => "gone");
    expect(await relayAlertToPhones(db, sender, alertFor(ashaId))).toEqual({ sent: 0, gone: 1, skipped: 0, limited: false });
    expect(await addressOf(a.rowId)).toBeNull();
    expect((await db.select().from(phonePushSends)).map((r) => r.outcome)).toEqual(["gone"]);
    await relayAlertToPhones(db, sender, alertFor(ashaId));
    expect(sent).toHaveLength(1); // only the first, refused, hand-over: the phone was not asked again
  });

  it(`a phone is told at most ${String(PUSH_PER_USER_PER_HOUR)} times an hour — the next alert waits in the bell, not on the lock screen`, async () => {
    await phoneOn(PHONE_A, TOKEN_A);
    const { sender, sent } = fake();
    for (let i = 0; i < PUSH_PER_USER_PER_HOUR; i += 1) await relayAlertToPhones(db, sender, alertFor(ashaId));
    expect(sent).toHaveLength(PUSH_PER_USER_PER_HOUR);
    expect(await relayAlertToPhones(db, sender, alertFor(ashaId))).toEqual({ sent: 0, gone: 0, skipped: 1, limited: true });
    expect(sent).toHaveLength(PUSH_PER_USER_PER_HOUR);
    // An hour later the budget is whole again.
    const later = new Date(Date.now() + 61 * 60 * 1000);
    await db.update(authSessions).set({ expiresAt: new Date(later.getTime() + 60_000) });
    expect((await relayAlertToPhones(db, sender, alertFor(ashaId), later)).sent).toBe(1);
  });

  it("the consumer relays `alert.raised` — and with no Firebase key it does nothing and is DONE", async () => {
    await phoneOn(PHONE_A, TOKEN_A);
    const event = (kind: string, occurredAt = new Date()): DispatchedEvent => ({
      eventId: newId(), seq: 1, name: "alert.raised", correlationId: null, patientId: null, occurredAt,
      payload: { alertId: newId(), userId: ashaId, kind, refType: "x", refId: "y", sourceEventId: newId() },
    });
    const { sender, sent } = fake();
    await phonePushConsumer(db, fixedPhonePushSource(null))(event("escalation"));
    expect(sent).toEqual([]);
    expect(await db.select().from(phonePushSends)).toEqual([]);
    // A notification is about NOW: a replayed backlog fills the bell, not a lock screen.
    await phonePushConsumer(db, fixedPhonePushSource(sender))(event("escalation", new Date(Date.now() - PHONE_PUSH_FRESH_MS - 1000)));
    expect(sent).toEqual([]);
    await phonePushConsumer(db, fixedPhonePushSource(sender))(event("roster_flag"));
    expect(sent.map((s) => s.message.data)).toEqual([{ category: "roster", link: "onNow" }]);
  });

  it("an administrator's test: the route answers what happened, events the act without the address, and only a user manager may", async () => {
    const a = await phoneOn(PHONE_A, TOKEN_A);
    const test = (phoneId: string, token = adminToken) => http().post(`/admin/users/${ashaId}/phones/${phoneId}/test-notification`).set(bearer(token)).send({});
    // No Firebase key in this suite: the honest answer, and still an event.
    expect((await test(a.rowId)).body).toEqual({ outcome: "not_configured" });
    const evented = (await db.select({ name: events.name, payload: events.payload, actorId: events.actorId }).from(events)).filter((e) => e.name === "auth.phone_push_tested");
    expect(evented).toEqual([{ name: "auth.phone_push_tested", actorId: adminId, payload: { userId: ashaId, username: "asha", deviceRowId: a.rowId, outcome: "not_configured" } }]);
    expect((await test("no-such-phone")).status).toBe(404);
    expect((await test(a.rowId, a.token)).status).toBe(403);

    // With a sender: the fixed test sentence, to that phone only, recorded with no alert.
    const { sender, sent } = fake();
    expect(await sendTestPush(db, sender, ashaId, a.rowId)).toBe("sent");
    expect(sent).toEqual([{ token: TOKEN_A, message: { title: "HMIS", body: "Test — this phone can receive HMIS notifications.", data: { category: "alert", link: "home" } } }]);
    expect((await db.select().from(phonePushSends)).map((r) => [r.alertId, r.category, r.outcome])).toEqual([[null, "test", "sent"]]);
    expect(await sendTestPush(db, fake(() => new Error("down")).sender, ashaId, a.rowId)).toBe("failed");
    expect(await sendTestPush(db, sender, adminId, a.rowId)).toBeNull(); // not that person's phone
    await http().delete("/auth/phone/notifications").set(bearer(a.token));
    expect(await sendTestPush(db, sender, ashaId, a.rowId)).toBe("no_address");
  });

  /**
   * THE OWNER'S PHONE, 2026-10-06. The app was updated in place and kept a session that an older
   * build had opened WITHOUT naming its phone: the notification screen sat on "Checking…" and the
   * administrator's Phones list was empty. The app now links the session it already holds.
   */
  it("a session opened before the app named its phone is LINKED to it — then it is a phone like any other", async () => {
    const old = (await login("asha")).body.token as string; // what a build older than 0.7.0 opened: no `device`
    expect((await state(old)).body).toMatchObject({ code: "not_a_phone" });
    expect((await phonesOf(ashaId)).body.phones).toEqual([]);

    const link = (token: string, device: Record<string, unknown>) => http().post("/auth/phone/link").set(bearer(token)).send({ device });
    const linked = await link(old, PHONE_A);
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual({ linked: true });
    expect((await state(old)).status).toBe(200);
    expect((await put(old, { token: TOKEN_A })).body).toMatchObject({ registered: true });
    expect((await phonesOf(ashaId)).body.phones).toMatchObject([{ model: "Redmi Note 12", signedIn: true, notifications: true }]);
    const evented = (await db.select({ name: events.name, payload: events.payload }).from(events)).filter((e) => e.name === "auth.phone_linked");
    expect(evented).toHaveLength(1);
    expect(evented[0]!.payload).toMatchObject({ userId: ashaId, bound: true, model: "Redmi Note 12" });

    // Again is a no-op, and a session never moves to ANOTHER phone.
    expect((await link(old, PHONE_A)).body).toEqual({ linked: false });
    expect((await link(old, PHONE_B)).body).toEqual({ linked: false });
    expect(await db.select().from(authDevices)).toHaveLength(1);

    // It is a real phone now: an alert reaches it, and signing it out silences it.
    const { sender, sent } = fake();
    await relayAlertToPhones(db, sender, alertFor(ashaId));
    expect(sent.map((s) => s.token)).toEqual([TOKEN_A]);

    // Bounded input, and nobody links without a session.
    expect((await link(old, { deviceId: "short" })).status).toBe(400);
    expect((await http().post("/auth/phone/link").send({ device: PHONE_A })).status).toBe(401);
  });

  it("linking respects the cap: with two phones signed in, a third session's link is refused and told which phones", async () => {
    await login("asha", PHONE_A); await login("asha", PHONE_B);
    const old = (await login("asha")).body.token as string;
    const refused = await http().post("/auth/phone/link").set(bearer(old)).send({ device: { deviceId: "cccccccccccccccccccccccccccccccc", model: "Vivo Y28" } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "phone_limit_reached", limit: PHONES_PER_USER });
    expect((await me(old)).status).toBe(200); // the session itself is untouched
  });

  it("the phone's state carries what its own diagnosis shows: when it handed its address over, when it was last sent to, the last test", async () => {
    const a = await phoneOn(PHONE_A, TOKEN_A);
    const { sender } = fake();
    expect((await state(a.token)).body).toMatchObject({ lastSentAt: null, lastTestAt: null });
    await relayAlertToPhones(db, sender, alertFor(ashaId));
    const afterAlert = (await state(a.token)).body as { addressAt: string; lastSentAt: string | null; lastTestAt: string | null };
    expect(typeof afterAlert.lastSentAt).toBe("string");
    expect(afterAlert.lastTestAt).toBeNull();
    await sendTestPush(db, sender, ashaId, a.rowId);
    expect(typeof ((await state(a.token)).body as { lastTestAt: string | null }).lastTestAt).toBe("string");
  });

  it(`the cap is unchanged: ${String(PHONES_PER_USER)} phones per person`, () => {
    expect(PHONES_PER_USER).toBe(2);
  });
});
