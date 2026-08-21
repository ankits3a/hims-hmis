import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createAgent } from "../src/kernel/auth/agents";
import { alerts, events } from "../src/kernel/db/schema";
import { ALERTS_PAGE_LIMIT, markAlertRead } from "../src/kernel/alerts/alerts";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

describe("alerts e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let userA: string;
  let tokenA: string;
  let userB: string;
  let tokenB: string;
  let agentKey: string;

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

  const mk = async (username: string): Promise<{ id: string; token: string }> => {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    return { id, token };
  };

  /** Alert rows are written straight in: the CONSUMER's own semantics are L7-L9's business in
   *  consumer.test.ts, and what these legs exercise is the read/mark surface over HTTP. */
  const seedAlert = async (
    userId: string,
    opts: { title: string; createdAt: Date; readAt?: Date },
  ): Promise<string> => {
    const id = newId();
    await db.insert(alerts).values({
      id,
      userId,
      kind: "escalation",
      title: opts.title,
      body: null,
      refType: "workflow_instance",
      refId: newId(),
      sourceEventId: newId(),
      createdAt: opts.createdAt,
      readAt: opts.readAt ?? null,
    });
    return id;
  };

  beforeEach(async () => {
    await truncateAll(db);
    const a = await mk("alertsa");
    const b = await mk("alertsb");
    userA = a.id;
    tokenA = a.token;
    userB = b.id;
    tokenB = b.token;
    ({ apiKey: agentKey } = await createAgent(db, "alerts-agent"));
  });

  it("L11: GET /alerts returns own rows only, unread first", async () => {
    // The READ alert is the NEWEST, so plain created_at desc would put it first: unread-first
    // is the only ordering that satisfies this fixture.
    const readNewest = await seedAlert(userA, {
      title: "A read (newest)",
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      readAt: new Date("2026-08-20T10:05:00.000Z"),
    });
    const unreadOlder = await seedAlert(userA, {
      title: "A unread (older)",
      createdAt: new Date("2026-08-20T09:00:00.000Z"),
    });
    const bsAlert = await seedAlert(userB, { title: "B unread", createdAt: new Date("2026-08-20T11:00:00.000Z") });

    const res = await request(app.getHttpServer()).get("/alerts").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([unreadOlder, readNewest]);
    expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(bsAlert);
    expect(res.body.unreadCount).toBe(1);

    // And B sees only B's — the isolation runs in both directions.
    const resB = await request(app.getHttpServer()).get("/alerts").set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    expect(resB.body.items.map((i: { id: string }) => i.id)).toEqual([bsAlert]);
  });

  it("L11: GET /alerts is bounded by construction — the page caps at 50 while unreadCount does not", async () => {
    const total = ALERTS_PAGE_LIMIT + 5;
    for (let i = 0; i < total; i += 1) {
      await seedAlert(userA, { title: `A ${i}`, createdAt: new Date(Date.UTC(2026, 7, 20, 9, 0, i)) });
    }
    const res = await request(app.getHttpServer()).get("/alerts").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(ALERTS_PAGE_LIMIT);
    // The badge must stay TRUE even when the page is full — the count is not capped by the page.
    expect(res.body.unreadCount).toBe(total);
    // Newest first within the unread block: the last-seeded second is the first item.
    expect(res.body.items[0].title).toBe(`A ${total - 1}`);
  });

  it("L12: mark-read is owner-only — a foreign id is a 404, not a 403, and the owner's row is untouched", async () => {
    const aAlert = await seedAlert(userA, { title: "A unread", createdAt: new Date("2026-08-20T09:00:00.000Z") });

    const foreign = await request(app.getHttpServer())
      .post(`/alerts/${aAlert}/read`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(foreign.status).toBe(404); // NOT 403: a 403 would confirm the id exists
    expect(foreign.body.message).toContain("unknown_alert");

    const untouched = await db.select({ readAt: alerts.readAt }).from(alerts).where(eq(alerts.id, aAlert));
    expect(untouched[0]!.readAt).toBeNull();
    expect(await db.select().from(events).where(eq(events.name, "alert.read"))).toHaveLength(0);

    // An id nobody owns is the SAME 404 — the foreign case is indistinguishable from absence.
    const unknown = await request(app.getHttpServer())
      .post(`/alerts/${newId()}/read`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(unknown.status).toBe(404);

    // NOT-OVER-BROAD (§3.44): the owner's OWN alert must still be markable.
    const own = await request(app.getHttpServer())
      .post(`/alerts/${aAlert}/read`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(own.status).toBe(201);
    expect(own.body.alreadyRead).toBe(false);
  });

  it("L12: marking read twice sets read_at once and appends exactly one alert.read", async () => {
    const aAlert = await seedAlert(userA, { title: "A unread", createdAt: new Date("2026-08-20T09:00:00.000Z") });

    const first = await request(app.getHttpServer())
      .post(`/alerts/${aAlert}/read`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(first.status).toBe(201);
    expect(first.body.alreadyRead).toBe(false);
    const afterFirst = await db.select({ readAt: alerts.readAt }).from(alerts).where(eq(alerts.id, aAlert));
    expect(afterFirst[0]!.readAt).not.toBeNull();

    const second = await request(app.getHttpServer())
      .post(`/alerts/${aAlert}/read`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(second.status).toBe(201); // a 200-class no-op, not an error
    expect(second.body.alreadyRead).toBe(true);
    const afterSecond = await db.select({ readAt: alerts.readAt }).from(alerts).where(eq(alerts.id, aAlert));
    expect(afterSecond[0]!.readAt!.toISOString()).toBe(afterFirst[0]!.readAt!.toISOString());

    const read = await db.select({ payload: events.payload }).from(events).where(eq(events.name, "alert.read"));
    expect(read).toHaveLength(1);
    expect(read[0]!.payload).toEqual({ alertId: aAlert, userId: userA });

    // The unread badge went to zero, and the row is still in the list (read, not deleted).
    const listed = await request(app.getHttpServer()).get("/alerts").set("Authorization", `Bearer ${tokenA}`);
    expect(listed.body.unreadCount).toBe(0);
    expect(listed.body.items).toHaveLength(1);
  });

  it("markAlertRead writes the `now` it is given, all the way down to the row", async () => {
    // Global Constraint 9, and §3.41's lesson: an optional `now` that no test drives is a
    // signature nobody exercises. Pin it and follow it to the writer.
    const aAlert = await seedAlert(userA, { title: "A unread", createdAt: new Date("2026-08-20T09:00:00.000Z") });
    const pinned = new Date("2026-03-11T07:30:00.000Z");

    const result = await markAlertRead(db, { type: "user", id: userA }, aAlert, pinned);
    expect(result.readAt.toISOString()).toBe(pinned.toISOString());
    const row = await db.select({ readAt: alerts.readAt }).from(alerts).where(eq(alerts.id, aAlert));
    expect(row[0]!.readAt!.toISOString()).toBe(pinned.toISOString());
    const read = await db.select({ occurredAt: events.occurredAt }).from(events).where(eq(events.name, "alert.read"));
    expect(read[0]!.occurredAt.toISOString()).toBe(pinned.toISOString());
  });

  it("L13: an agent key is refused on both routes, in the handler — while the same routes serve a user", async () => {
    // WHY THIS CANNOT BE A DECORATOR: an agent key passes AuthGuard (guards.ts:31-38 mints an
    // agent actor and returns true), and PermissionGuard returns true at guards.ts:64 because
    // these routes declare no requirement. Nothing between the wire and the handler looks at
    // the actor TYPE, so the handler is the only place the refusal can live.
    const aAlert = await seedAlert(userA, { title: "A unread", createdAt: new Date("2026-08-20T09:00:00.000Z") });

    const agentList = await request(app.getHttpServer()).get("/alerts").set("x-agent-key", agentKey);
    expect(agentList.status).toBe(403);
    expect(agentList.body.message).toBe("user_actor_required");

    const agentRead = await request(app.getHttpServer())
      .post(`/alerts/${aAlert}/read`)
      .set("x-agent-key", agentKey);
    expect(agentRead.status).toBe(403);
    expect(agentRead.body.message).toBe("user_actor_required");
    expect((await db.select({ readAt: alerts.readAt }).from(alerts).where(eq(alerts.id, aAlert)))[0]!.readAt).toBeNull();

    // NOT-OVER-BROAD (§3.44): the refusal must refuse AGENTS, not everyone. No mutant in this
    // set catches a guard that is too wide.
    const userList = await request(app.getHttpServer()).get("/alerts").set("Authorization", `Bearer ${tokenA}`);
    expect(userList.status).toBe(200);
    const userRead = await request(app.getHttpServer())
      .post(`/alerts/${aAlert}/read`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(userRead.status).toBe(201);

    // And an unauthenticated caller is still a 401 — the handler refusal did not replace auth.
    expect((await request(app.getHttpServer()).get("/alerts")).status).toBe(401);
  });
});
