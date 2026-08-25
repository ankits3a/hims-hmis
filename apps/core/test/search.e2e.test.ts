import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { withTx } from "../src/kernel/db/client";
import { registrationConfig, searchAudit } from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { registerPatient } from "../src/modules/patients";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 11h CLOSE (independent reviewer, MAJOR 5) — THE HTTP SURFACE A BROWSER ACTUALLY CALLS.
 *
 * T1 and T5's assertions were all against `searchAll` and `recordSearch` AS FUNCTIONS. The route
 * itself — its zod schema, its `entities=` split, the grammar-versus-parameter precedence, the
 * `auditId` echo, the agent-actor refusal and the 404 on `opened` — had no test of any kind, and
 * T1's Files list named this file. Every one of those is a way a green unit suite can sit behind a
 * broken endpoint.
 */
describe("search over HTTP", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv);
  const clerk: Actor = { type: "user", id: "seed-clerk" };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // The app under test must talk to THIS worker's database, not to whatever `DATABASE_URL`
    // happens to hold — the shipped e2e pattern (`alerts.e2e.test.ts`).
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

  async function deskUser(permissions: string[]): Promise<string> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, { username: `u${suffix}`, fullName: "Desk", password: "correct horse battery" });
    const roleKey = `r${suffix}`;
    await createRole(db, roleKey, "Desk");
    for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    return token;
  }

  it("401 without a token — the route is guarded like every other", async () => {
    await request(server()).get("/search?q=asha").expect(401);
  });

  it("returns grouped hits and the audit id, and WRITES exactly one audit row", async () => {
    const token = await deskUser(["patients.read"]);
    await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }));

    const res = await request(server()).get("/search?q=asha").set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body.groups.flatMap((g: { hits: unknown[] }) => g.hits)).toHaveLength(1);
    expect(typeof res.body.auditId).toBe("string");
    const rows = await db.select().from(searchAudit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res.body.auditId, rawQuery: "asha", source: "text" });
  });

  it("A ZERO-HIT SEARCH IS STILL AUDITED over HTTP", async () => {
    const token = await deskUser(["patients.read"]);
    const res = await request(server()).get("/search?q=zzzz").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.groups.every((g: { hits: unknown[] }) => g.hits.length === 0)).toBe(true);
    expect(await db.select().from(searchAudit)).toHaveLength(1);
  });

  it("a caller holding nothing gets an empty answer with every provider NAMED in skipped", async () => {
    const token = await deskUser([]);
    const res = await request(server()).get("/search?q=asha").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.skipped.length).toBeGreaterThan(0);
  });

  it("`entities=` narrows the fan-out", async () => {
    const token = await deskUser(["patients.read", "tariff.read"]);
    const res = await request(server()).get("/search?q=asha&entities=service").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.groups.every((g: { entity: string }) => g.entity === "service")).toBe(true);
  });

  it("THE GRAMMAR'S NARROWING WINS over the query parameter", async () => {
    const token = await deskUser(["patients.read", "tariff.read"]);
    // `@service` typed in the box; `entities=patient` on the URL. The typed one is what the user
    // can see, and it is the one that must apply.
    const res = await request(server())
      .get("/search?q=%40service%20asha&entities=patient")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.groups.every((g: { entity: string }) => g.entity === "service")).toBe(true);
  });

  it("a bad limit is a 400, not a 500", async () => {
    const token = await deskUser(["patients.read"]);
    await request(server()).get("/search?q=asha&limit=999").set("Authorization", `Bearer ${token}`).expect(400);
  });

  describe("POST /search/opened", () => {
    it("records which record was taken, and only for the actor's OWN search", async () => {
      const token = await deskUser(["patients.read"]);
      const other = await deskUser(["patients.read"]);
      const search = await request(server()).get("/search?q=asha").set("Authorization", `Bearer ${token}`).expect(200);
      const auditId = search.body.auditId as string;

      // Somebody else's search is not theirs to annotate.
      await request(server()).post("/search/opened").set("Authorization", `Bearer ${other}`)
        .send({ auditId, entity: "patient", id: "p1" }).expect(404);

      await request(server()).post("/search/opened").set("Authorization", `Bearer ${token}`)
        .send({ auditId, entity: "patient", id: "p1" }).expect(204);

      const row = (await db.select().from(searchAudit).where(eq(searchAudit.id, auditId)))[0];
      expect(row).toMatchObject({ openedEntity: "patient", openedId: "p1" });

      // First-write-wins: a re-render must not rewrite which record was taken.
      await request(server()).post("/search/opened").set("Authorization", `Bearer ${token}`)
        .send({ auditId, entity: "patient", id: "p2" }).expect(404);
    });

    it("an unknown audit id is a 404", async () => {
      const token = await deskUser(["patients.read"]);
      await request(server()).post("/search/opened").set("Authorization", `Bearer ${token}`)
        .send({ auditId: "nope", entity: "patient", id: "p1" }).expect(404);
    });
  });
});
