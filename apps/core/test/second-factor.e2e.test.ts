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

    const { secret } = await enrollAndConfirm(id);

    // wrong code still 403
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${token}`).set("x-totp-code", "000000").expect(403);

    // valid code passes and stamps the session. The NEXT step's code, because the confirm above
    // spent the current one (WASA M-02: a code is single-use).
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${token}`)
      .set("x-totp-code", authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret))
      .expect(201);

    // within the window no code is needed
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act").set("Authorization", `Bearer ${token}`).expect(201);
  });

  /**
   * WASA M-02 (ASVS 2.8.4) — the `X-Totp-Code` header is a TOTP verification like any other, so the
   * code it spends is spent. A second session presenting the same code inside its window used to
   * pass; an attacker who shoulder-surfs one code must not get a second signature out of it.
   */
  it("WASA M-02 — a header code accepted once cannot be replayed from another session", async () => {
    const { id } = await createUser(db, { username: "signer", fullName: "S", password: "p1234567" });
    await createRole(db, "signer", "Signer");
    await grantPermissionToRole(db, registry, "signer", "auth.roles.manage");
    await assignRole(db, { userId: id, roleKey: "signer", scopeType: "hospital" });
    const first = await createSession(db, cfg, id);
    const second = await createSession(db, cfg, id);

    const { secret } = await enrollAndConfirm(id);
    const code = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret);

    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${first.token}`).set("x-totp-code", code).expect(201);
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${second.token}`).set("x-totp-code", code).expect(403);
  });

  it("WASA M-02 — the header path shares the TOTP throttle: after five misses it answers 429", async () => {
    const { id } = await createUser(db, { username: "signer", fullName: "S", password: "p1234567" });
    await createRole(db, "signer", "Signer");
    await grantPermissionToRole(db, registry, "signer", "auth.roles.manage");
    await assignRole(db, { userId: id, roleKey: "signer", scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    const { secret } = await enrollAndConfirm(id);
    const valid = new Set([-1, 0, 1].map((o) => authenticator.clone({ epoch: Date.now() + o * 30_000 }).generate(secret)));
    const wrong = ["000000", "111111", "222222"].find((c) => !valid.has(c))!;

    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post("/stepup-test/signature-act")
        .set("Authorization", `Bearer ${token}`).set("x-totp-code", wrong).expect(403);
    }
    const throttled = await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${token}`)
      .set("x-totp-code", authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret))
      .expect(429);
    expect(throttled.body.code).toBe("too_many_attempts");
  });

  /** Enrol (proven by the password, WASA M-02) and confirm through the kernel. */
  async function enrollAndConfirm(id: string): Promise<{ secret: string }> {
    const r = await enrollTotp(db, cfg, id, { password: "p1234567" });
    if (!r.ok) throw new Error(`enrol refused: ${r.reason}`);
    expect((await confirmTotp(db, cfg, id, authenticator.generate(r.secret))).ok).toBe(true);
    return { secret: r.secret };
  }
});
