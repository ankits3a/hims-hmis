import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createAgent } from "../src/kernel/auth/agents";
import { alerts, authDevices, events, userReminders } from "../src/kernel/db/schema";
import { raiseNotice } from "../src/kernel/alerts/notices";
import { relayAlertToPhones } from "../src/kernel/push/phone-push";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { registerAllJobs, type JobIntervals } from "../src/kernel/worker/jobs";
import { PERSONAL_REMINDER_KIND, createReminder, reminderKey, runDueReminders } from "../src/kernel/reminders";
import { setupTestDb, truncateAll } from "./helpers/db";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";
import type { JobSpec, Scheduler } from "../src/kernel/worker/scheduler";
import type { PhoneMessage, PhonePushSender } from "../src/kernel/push/fcm";

/**
 * E1.2 — PERSONAL REMINDERS (decision 0064; spec /opt/hmis-context/SPEC-reminders-2026-10-11.md,
 * owner yes 2026-10-11). The spec's eight done-means, each numbered below where it is proved. Every
 * instant a CREATE checks is taken from the real clock (the route reads it), so creates are dated
 * from `Date.now()`; the sweep takes its `now` as an argument and is driven at chosen instants.
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PW = "s3cret-pass-xyz";
const INTERVALS: JobIntervals = {
  workerDispatchIntervalMs: 2000, workerTimersIntervalMs: 20_000, workerTempRolesIntervalMs: 60_000,
  workerNotifyIntervalMs: 5000, workerReachIntervalMs: 60_000, notifyStuckAfterMs: 300_000,
  retentionEnabled: false, retentionEventsMonths: 120, notifyRetainDays: 180,
  workerInterfaceSweepIntervalMs: 60_000, workerLabSweepIntervalMs: 60_000,
};

describe("E1.2 — personal reminders", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  let ashaId: string; let ashaToken: string; let balaToken: string;

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

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const login = (username: string, device?: Record<string, unknown>) =>
    http().post("/auth/login").send({ username, password: PW, ...(device === undefined ? {} : { device }) });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const create = (token: string, body: Record<string, unknown>) => http().post("/reminders").set(bearer(token)).send(body);
  const list = (token: string) => http().get("/reminders").set(bearer(token));
  const cancel = (token: string, id: string) => http().post(`/reminders/${id}/cancel`).set(bearer(token));
  const inMinutes = (m: number) => new Date(Date.now() + m * MIN).toISOString();
  const bellRows = (userId: string) => db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.kind, PERSONAL_REMINDER_KIND)));
  const raisedEvents = async () => (await db.select().from(events).where(eq(events.name, "alert.raised")))
    .filter((e) => (e.payload as { kind?: string }).kind === PERSONAL_REMINDER_KIND);

  beforeEach(async () => {
    await truncateAll(db);
    ({ id: ashaId } = await createUser(db, { username: "asha", fullName: "Asha Devi", password: PW }));
    await createUser(db, { username: "bala", fullName: "Bala Kumar", password: PW });
    ashaToken = (await login("asha")).body.token as string;
    balaToken = (await login("bala")).body.token as string;
  });

  it("(1) fires within 60 s of its time: nothing before, the bell row on the 20 s tick after — through the registered runDueTimers job", async () => {
    const made = await create(ashaToken, { text: "see bed 12", at: inMinutes(5), repeat: "none" });
    expect(made.status).toBe(201);
    const due = new Date(made.body.dueAt as string);

    expect(await runDueReminders(db, new Date(due.getTime() - 1000))).toBe(0);
    expect(await bellRows(ashaId)).toHaveLength(0);

    // The tick is the EXISTING runDueTimers job (spec: no new job name, so no census moves).
    const specs: JobSpec[] = [];
    registerAllJobs({ register: (s: JobSpec) => { specs.push(s); } } as unknown as Scheduler, db, new ModuleRegistry(), {}, INTERVALS);
    const timersJob = specs.find((s) => s.name === "runDueTimers")!;
    expect(specs.map((s) => s.name)).not.toContain("runDueReminders");
    await timersJob.run(new Date(due.getTime() + 20_000));

    const rows = await bellRows(ashaId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Reminder", body: "see bed 12", refType: "user_reminder", refId: made.body.id });
    const [stored] = await db.select().from(userReminders).where(eq(userReminders.id, made.body.id as string));
    expect(stored!.firedAt).not.toBeNull();
    expect((await list(ashaToken)).body.items).toEqual([]); // a fired one-off is no longer active
  });

  it("(2) fires once: a second tick, two concurrent ticks, and a crash between raise and claim each leave one bell row and one announcement", async () => {
    const a = await create(ashaToken, { text: "call lab", at: inMinutes(2), repeat: "none" });
    const b = await create(ashaToken, { text: "sign discharge", at: inMinutes(3), repeat: "none" });
    const c = await create(ashaToken, { text: "round ward 4", at: inMinutes(4), repeat: "none" });
    const t = (m: number) => new Date(Date.now() + m * MIN);

    // a: a tick, then the tick after it (a restarted worker re-reading the same instant).
    expect(await runDueReminders(db, t(2.5))).toBe(1);
    expect(await runDueReminders(db, t(2.5))).toBe(0);
    // b: two workers at once.
    const both = await Promise.all([runDueReminders(db, t(3.5)), runDueReminders(db, t(3.5))]);
    expect(both[0] + both[1]).toBe(1);
    // c: the previous process raised the row and died before its claim. The next tick raises nothing new and claims it.
    const [cRow] = await db.select().from(userReminders).where(eq(userReminders.id, c.body.id as string));
    await raiseNotice(db, { userId: ashaId, kind: PERSONAL_REMINDER_KIND, title: "Reminder", body: "round ward 4", refType: "user_reminder", refId: cRow!.id, sourceKey: reminderKey(cRow!.id, cRow!.dueAt), at: t(4.2) });
    await runDueReminders(db, t(4.5));
    await runDueReminders(db, t(4.6));

    const rows = await bellRows(ashaId);
    expect(rows.map((r) => r.refId).sort()).toEqual([a.body.id, b.body.id, c.body.id].sort());
    expect(await raisedEvents()).toHaveLength(3); // one alert.raised each — the phone relay hangs off this event
    const left = await db.select().from(userReminders).where(eq(userReminders.userId, ashaId));
    expect(left.every((r) => r.firedAt !== null)).toBe(true);
  });

  it("(3) a repeating reminder is listed with its next time, moves on when it fires, and after cancel raises nothing", async () => {
    const made = await create(ashaToken, { text: "OPD review", at: inMinutes(10), repeat: "daily" });
    expect(made.status).toBe(201);
    const due = new Date(made.body.dueAt as string);
    const listed = (await list(ashaToken)).body.items as { id: string; repeat: string; dueAt: string }[];
    expect(listed).toEqual([expect.objectContaining({ id: made.body.id, repeat: "daily", dueAt: due.toISOString(), text: "OPD review" })]);

    expect(await runDueReminders(db, new Date(due.getTime() + 20_000))).toBe(1);
    const moved = (await list(ashaToken)).body.items as { dueAt: string }[];
    expect(moved).toHaveLength(1);
    expect(new Date(moved[0]!.dueAt).getTime()).toBe(due.getTime() + DAY);

    expect((await cancel(ashaToken, made.body.id as string)).status).toBe(200);
    expect((await list(ashaToken)).body.items).toEqual([]);
    expect(await runDueReminders(db, new Date(due.getTime() + DAY + 20_000))).toBe(0);
    expect(await bellRows(ashaId)).toHaveLength(1);
  });

  it("(4) the phone is told the fixed sentence and two words — never the reminder's text or title", async () => {
    const device = { deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", model: "Redmi Note 12", os: "Android 14", appVersion: "0.18.0 (30)" };
    const phoneToken = (await login("asha", device)).body.token as string;
    expect((await http().put("/auth/phone/notifications").set(bearer(phoneToken)).send({ token: "fGxA:APA91b-address-of-phone-a-0123456789abcdef", language: "en" })).status).toBe(200);
    // Even a phone that somehow muted the word still hears a reminder its person set themselves.
    await db.update(authDevices).set({ pushMuted: ["personal"] }).where(eq(authDevices.deviceId, device.deviceId));

    const made = await create(ashaToken, { text: "see bed 12 Ramesh", at: inMinutes(2), repeat: "none" });
    await runDueReminders(db, new Date(Date.now() + 3 * MIN));
    const [row] = await bellRows(ashaId);

    const sent: PhoneMessage[] = [];
    const sender: PhonePushSender = { send: (_t, m) => { sent.push(m); return Promise.resolve("sent"); } };
    expect(await relayAlertToPhones(db, sender, { id: row!.id, userId: ashaId, kind: row!.kind })).toMatchObject({ sent: 1 });
    expect(sent).toEqual([{ title: "HMIS", body: "You have a reminder. Open HMIS to see it.", data: { category: "personal", link: "reminders" } }]);
    const wire = JSON.stringify(sent);
    for (const leak of ["bed 12", "Ramesh", "Reminder", made.body.id as string]) expect(wire).not.toContain(leak);
    // …and the announcement the relay reads carries no title or body either.
    for (const e of await raisedEvents()) expect(JSON.stringify(e.payload)).not.toContain("bed 12");
  });

  it("(5) a reminder is its person's alone: absent from another's list, 404 to another's cancel, 403 to an agent key", async () => {
    const made = await create(ashaToken, { text: "mine", at: inMinutes(30), repeat: "none" });
    expect((await list(balaToken)).body.items).toEqual([]);
    expect((await cancel(balaToken, made.body.id as string)).status).toBe(404);
    expect((await cancel(ashaToken, "no-such-id")).status).toBe(404);
    expect((await list(ashaToken)).body.items).toHaveLength(1);

    const { apiKey } = await createAgent(db, "reminders-agent");
    await http().get("/reminders").set("x-agent-key", apiKey).expect(403);
    await http().post("/reminders").set("x-agent-key", apiKey).send({ text: "x", at: inMinutes(30), repeat: "none" }).expect(403);
    await http().get("/reminders").expect(401);
    // The function the copilot act will call refuses a non-user too.
    await expect(createReminder(db, { type: "agent", id: "a-1" }, { text: "x", at: inMinutes(30), repeat: "none" })).rejects.toThrow(/user_actor_required/);
  });

  it("(6) twenty active is the most; the 21st, an 81-character text, a past time and an unknown repeat are refused", async () => {
    for (let i = 0; i < 20; i += 1) expect((await create(ashaToken, { text: `r${String(i)}`, at: inMinutes(30 + i), repeat: "none" })).status).toBe(201);
    const over = await create(ashaToken, { text: "one more", at: inMinutes(90), repeat: "none" });
    expect(over.status).toBe(409);
    expect(over.body.message).toBe("reminder_limit");
    // A cancelled one frees its place.
    const first = ((await list(ashaToken)).body.items as { id: string }[])[0]!;
    await cancel(ashaToken, first.id);
    expect((await create(ashaToken, { text: "one more", at: inMinutes(90), repeat: "none" })).status).toBe(201);

    expect((await create(balaToken, { text: "x".repeat(81), at: inMinutes(30), repeat: "none" })).status).toBe(400);
    expect((await create(balaToken, { text: "x".repeat(80), at: inMinutes(30), repeat: "none" })).status).toBe(201);
    expect((await create(balaToken, { text: "  ", at: inMinutes(30), repeat: "none" })).status).toBe(400);
    expect((await create(balaToken, { text: "late", at: inMinutes(-5), repeat: "none" })).status).toBe(400);
    expect((await create(balaToken, { text: "far", at: new Date(Date.now() + 400 * DAY).toISOString(), repeat: "none" })).status).toBe(400);
    expect((await create(balaToken, { text: "odd", at: inMinutes(30), repeat: "hourly" })).status).toBe(400);
  });
});
