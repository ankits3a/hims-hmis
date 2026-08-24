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

    // warm-up switch (JIT, pool) then the measured ones — budget guards the steady state
    let switched = await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "second", pin: "482913", terminalId: "counter-1" }).expect(201);

    /**
     * PLAN 11f T3 — BEST-OF-N, the idiom `perf-opd-queue.test.ts` measures with, and for its
     * reason. What stood here was a SINGLE sample, and a single sample conflates the code's speed
     * with the runner's mood: this budget covers an argon2id verify (memoryCost 19456) on a shared
     * 4-core CI runner, where contention can only ever ADD time and nothing can make a verify look
     * faster than it is. The minimum is therefore the least-noisy estimator of the thing being
     * gated, while a genuine regression raises the floor and still fails — the property that makes
     * the change safe rather than merely quieter. The BUDGET is unchanged; what changed is which
     * number is compared against it.
     *
     * Until this task this was the suite's ONLY single-sample wall-clock assertion; the two perf
     * suites had already been converted, and the reasoning there (measured, with the swing that
     * bought it) is not restated here.
     */
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = Date.now();
      switched = await request(app.getHttpServer())
        .post("/auth/switch/pin").send({ username: "second", pin: "482913", terminalId: "counter-1" }).expect(201);
      times.push(Date.now() - started);
    }
    const fastest = Math.min(...times);
    console.log(`pin switch timings ms: ${times.join(", ")} (fastest ${fastest})`);
    expect(fastest).toBeLessThan(1000); // server share of the <2 s spec budget (roadmap trap)

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

  /**
   * ═══ PLAN 11g / T-D4, DD4 — THE CREDENTIAL PATHS OVER REAL HTTP ═══
   *
   * The 2026-08-24 synthetic smoke test measured five consecutive wrong passwords answering 401,
   * 401, 401, 401, 401, with the correct one succeeding immediately afterwards. These legs are
   * that measurement, inverted into an assertion.
   *
   * `throttle.test.ts` owns the arithmetic — window, cap, clearing, concurrency — with an injected
   * clock. What is asserted HERE is only what the WIRE does: the status, the code, the header, and
   * the two properties a wire test is the only place to see (that the 401 is unchanged for the
   * first four, and that an unknown username is indistinguishable from a known one).
   */
  it("T-D4 R1 — the 6th wrong password is 429 with Retry-After; the first five are the unchanged 401", async () => {
    await createUser(db, { username: "brute", fullName: "Brute Target", password: "s3cret-pass" });

    for (let i = 1; i <= 5; i += 1) {
      const refused = await request(app.getHttpServer())
        .post("/auth/login").send({ username: "brute", password: "nope" }).expect(401);
      // The throttle must not change what a wrong password LOOKS like until it refuses.
      expect(refused.headers["retry-after"]).toBeUndefined();
    }

    const throttled = await request(app.getHttpServer())
      .post("/auth/login").send({ username: "brute", password: "nope" }).expect(429);
    expect(throttled.body.code).toBe("too_many_attempts");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttled.body.retryAfterSeconds).toBe(Number(throttled.headers["retry-after"]));

    // AND THE CORRECT PASSWORD IS REFUSED TOO, which is the whole point: a throttle that let the
    // right password through would be no obstacle to somebody who has just guessed it.
    await request(app.getHttpServer())
      .post("/auth/login").send({ username: "brute", password: "s3cret-pass" }).expect(429);
  });

  it("T-D4 R2 — a success inside the threshold clears the counter, so a fumbling user is never locked out", async () => {
    await createUser(db, { username: "fumbler", fullName: "Fumbling User", password: "s3cret-pass" });

    for (let round = 0; round < 2; round += 1) {
      for (let i = 1; i <= 4; i += 1) {
        await request(app.getHttpServer())
          .post("/auth/login").send({ username: "fumbler", password: "nope" }).expect(401);
      }
      // Eight wrong passwords in total across the two rounds — and never a refusal, because each
      // round ends in a success. A counter that did not clear would 429 the second round's 5th.
      await request(app.getHttpServer())
        .post("/auth/login").send({ username: "fumbler", password: "s3cret-pass" }).expect(201);
    }
  });

  it("T-D4 R3 — login and pin do not share a counter: the terminal switch survives a poisoned password", async () => {
    const { id } = await createUser(db, { username: "switcher", fullName: "Switcher", password: "s3cret-pass" });
    await setPin(db, id, "482913");

    for (let i = 1; i <= 6; i += 1) {
      await request(app.getHttpServer()).post("/auth/login").send({ username: "switcher", password: "nope" });
    }
    await request(app.getHttpServer())
      .post("/auth/login").send({ username: "switcher", password: "s3cret-pass" }).expect(429);

    // The clinician at the shared desk still gets in with their pin.
    await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "switcher", pin: "482913", terminalId: "counter-9" })
      .expect(201);
  });

  it("T-D4 R3b — the pin path throttles on its own: a four-digit keyspace is the sharper half", async () => {
    const { id } = await createUser(db, { username: "pinned", fullName: "Pinned", password: "s3cret-pass" });
    await setPin(db, id, "482913");

    for (let i = 1; i <= 5; i += 1) {
      await request(app.getHttpServer())
        .post("/auth/switch/pin").send({ username: "pinned", pin: "000000", terminalId: "t" }).expect(401);
    }
    const throttled = await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "pinned", pin: "482913", terminalId: "t" }).expect(429);
    expect(throttled.body.code).toBe("too_many_attempts");
  });

  it("T-D4 R4 — an UNKNOWN username throttles identically, so the 429 is not a membership oracle", async () => {
    await createUser(db, { username: "real-person", fullName: "Real Person", password: "s3cret-pass" });

    const attempts = async (username: string): Promise<number[]> => {
      const statuses: number[] = [];
      for (let i = 1; i <= 6; i += 1) {
        const res = await request(app.getHttpServer()).post("/auth/login").send({ username, password: "nope" });
        statuses.push(res.status);
      }
      return statuses;
    };

    // Byte-identical status sequences for an account that exists and one that never has.
    expect(await attempts("real-person")).toEqual([401, 401, 401, 401, 401, 429]);
    expect(await attempts("no-such-person-anywhere")).toEqual([401, 401, 401, 401, 401, 429]);
  });
});
