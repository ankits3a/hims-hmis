import { Test } from "@nestjs/testing";
import { Controller, INestApplication, Post } from "@nestjs/common";
import request from "supertest";
import { authenticator } from "otplib";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { enrollTotp, confirmTotp } from "../src/kernel/auth/totp";
import { RequirePermission } from "../src/kernel/auth/decorators";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

@Controller("stepup-test")
class StepupTestController {
  @RequirePermission("auth.roles.manage", "hospital", { secondFactor: true })
  @Post("signature-act")
  act(): { ok: boolean } { return { ok: true }; }
}

describe("second factor e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [StepupTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); await syncPermissions(db, registry); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("requires, accepts, then remembers the second factor within the window", async () => {
    const { id } = await createUser(db, { username: "signer", fullName: "S", password: "p1234567" });
    await createRole(db, "signer", "Signer");
    await grantPermissionToRole(db, registry, "signer", "auth.roles.manage");
    await assignRole(db, { userId: id, roleKey: "signer", scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);

    // permission alone is not enough
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act").set("Authorization", `Bearer ${token}`).expect(403);

    const { secret } = await enrollTotp(db, cfg, id);
    await confirmTotp(db, cfg, id, authenticator.generate(secret));

    // wrong code still 403
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${token}`).set("x-totp-code", "000000").expect(403);

    // valid code passes and stamps the session
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${token}`).set("x-totp-code", authenticator.generate(secret)).expect(201);

    // within the window no code is needed
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act").set("Authorization", `Bearer ${token}`).expect(201);
  });
});
