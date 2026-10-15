import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser, testCfg } from "./helpers/opd";
import { createSession } from "../src/kernel/auth/sessions";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * PHONE SETTINGS (owner 2026-10-11, spec SPEC-phone-settings-2026-10-11) — the copilot switch is OFF by
 * default, follows the ACCOUNT (a second phone's session reads what the first set), and is the caller's own.
 */
describe("GET/PUT /copilot/setting — the phone's copilot switch", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;

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
  beforeEach(async () => { await truncateAll(db); });

  const http = () => request(app.getHttpServer());

  it("is off for a new person, holding nothing; on after they turn it on, on another phone too; and only their own", async () => {
    const asha = await mkUser(db, "asha.phone", []);
    const ravi = await mkUser(db, "ravi.phone", []);
    expect((await http().get("/copilot/setting").set("Authorization", `Bearer ${asha.token}`).expect(200)).body).toEqual({ phone: false });
    await http().put("/copilot/setting").set("Authorization", `Bearer ${asha.token}`).send({ phone: true }).expect(200, { phone: true });
    const secondPhone = (await createSession(db, testCfg, asha.id)).token;
    expect((await http().get("/copilot/setting").set("Authorization", `Bearer ${secondPhone}`).expect(200)).body).toEqual({ phone: true });
    expect((await http().get("/copilot/setting").set("Authorization", `Bearer ${ravi.token}`).expect(200)).body).toEqual({ phone: false });
    await http().put("/copilot/setting").set("Authorization", `Bearer ${secondPhone}`).send({ phone: false }).expect(200, { phone: false });
    expect((await http().get("/copilot/setting").set("Authorization", `Bearer ${asha.token}`).expect(200)).body).toEqual({ phone: false });
  });

  it("refuses a body that is not true or false, and a caller with no session", async () => {
    const asha = await mkUser(db, "asha.phone", []);
    await http().put("/copilot/setting").set("Authorization", `Bearer ${asha.token}`).send({ phone: "yes" }).expect(400);
    await http().get("/copilot/setting").expect(401);
  });
});
