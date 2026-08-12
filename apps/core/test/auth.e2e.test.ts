import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser, setPin } from "../src/kernel/auth/identity";
import { createAgent, setKillSwitch } from "../src/kernel/auth/agents";
import { requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

describe("auth e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // Point the app at this worker's database so e2e and helper see the same rows.
    // setupTestDb derives "<base>_<JEST_WORKER_ID>" from TEST_DATABASE_URL — mirror it exactly.
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("health stays public", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });

  it("unauthenticated requests to guarded routes get 401", async () => {
    await request(app.getHttpServer()).get("/auth/me").expect(401);
  });

  it("login → me → logout lifecycle", async () => {
    await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass" });
    await request(app.getHttpServer())
      .post("/auth/login").send({ username: "asha", password: "nope" }).expect(401);
    const login = await request(app.getHttpServer())
      .post("/auth/login").send({ username: "asha", password: "s3cret-pass" }).expect(201);
    const token = login.body.token as string;
    const me = await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);
    expect(me.body.actor.type).toBe("user");
    await request(app.getHttpServer())
      .post("/auth/logout").set("Authorization", `Bearer ${token}`).expect(204);
    await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("agent key authenticates; kill switch turns it into 403", async () => {
    const { id, apiKey } = await createAgent(db, "digest-writer");
    const me = await request(app.getHttpServer())
      .get("/auth/me").set("x-agent-key", apiKey).expect(200);
    expect(me.body.actor).toEqual({ type: "agent", id });
    await setKillSwitch(db, id, true);
    await request(app.getHttpServer())
      .get("/auth/me").set("x-agent-key", apiKey).expect(403);
  });

  it("pin fast-switch changes identity on the terminal within budget", async () => {
    await createUser(db, { username: "first", fullName: "F", password: "s3cret-pass" });
    const { id: u2 } = await createUser(db, { username: "second", fullName: "S", password: "s3cret-pass" });
    await setPin(db, u2, "482913");
    const s1 = await request(app.getHttpServer())
      .post("/auth/login").send({ username: "first", password: "s3cret-pass", terminalId: "counter-1" }).expect(201);

    // warm-up switch (JIT, pool) then the measured one — budget guards the steady state
    await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "second", pin: "482913", terminalId: "counter-1" }).expect(201);
    const started = Date.now();
    const switched = await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "second", pin: "482913", terminalId: "counter-1" }).expect(201);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000); // server share of the <2 s spec budget (roadmap trap)

    const me = await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${switched.body.token}`).expect(200);
    expect(me.body.actor.id).toBe(u2);
    await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${s1.body.token}`).expect(401); // outgoing identity dead
  });

  it("bad switch credentials are rejected", async () => {
    await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "second", pin: "000000", terminalId: "t" }).expect(401);
    await request(app.getHttpServer())
      .post("/auth/switch/badge").send({ badgeToken: "b1.x.1.y", terminalId: "t" }).expect(401);
  });
});
