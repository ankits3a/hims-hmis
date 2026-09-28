import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import { ensureRole, mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

jest.setTimeout(180_000);

/**
 * PHARMACY STAGE D2 — THE MEDICATION INCIDENT LOG OVER HTTP: each route under its grant (record, review, and
 * the reads that take either), a record posted once per idempotency key, and BLAME-FREE measured on the wire:
 * the response a recorder receives carries the reporter's role and not their name; the reviewer's carries both.
 */
describe("the medication incident log over HTTP (pharmacy stage D2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let fx: PharmacyFixture;
  let ms: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.DOCUMENT_STORE_PATH = mkdtempSync(join(tmpdir(), "hmis-incidents-e2e-docs-"));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.incidents.record");
    await grantPermissionToRole(db, fx.registry, "pharmacy_assistant", "pharmacy.incidents.record");
    await ensureRole(db, "incident_reviewer");
    await grantPermissionToRole(db, fx.registry, "incident_reviewer", "pharmacy.incidents.review");
    ms = await mkUser(db, "the.ms", ["incident_reviewer"]);
  });
  afterEach(() => { fx.unregister(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);
  const body = (): Record<string, unknown> => ({
    kind: "near_miss", stage: "dispensing", type: "wrong_strength", category: "B", factors: ["look_alike_packaging"],
    whatHappened: "Dolo 650 picked for Crocin 500; caught at the second check",
  });

  it("guards every route, posts once per key, and tells the name to the reviewer only", async () => {
    await request(server()).get("/pharmacy/incidents").expect(401);
    await as(fx.clerk.token)(request(server()).get("/pharmacy/incidents")).expect(403);
    await as(fx.clerk.token)(request(server()).post("/pharmacy/incidents").send(body())).expect(403);
    await as(ms.token)(request(server()).post("/pharmacy/incidents").send(body())).expect(403);
    await as(fx.pharmacist.token)(request(server()).post("/pharmacy/incidents").send({ ...body(), category: "E" })).expect(400);

    const first = await as(fx.pharmacist.token)(request(server()).post("/pharmacy/incidents").set("Idempotency-Key", "mi-k1").send(body())).expect(201);
    const again = await as(fx.pharmacist.token)(request(server()).post("/pharmacy/incidents").set("Idempotency-Key", "mi-k1").send(body())).expect(201);
    const { incidentId, no } = first.body as { incidentId: string; no: string };
    expect((again.body as { incidentId: string }).incidentId).toBe(incidentId);
    expect(no).toBe("MI-000001");

    // BLAME-FREE, the recorder's side: the role, never the name, anywhere in the response.
    const theirs = await as(fx.aide.token)(request(server()).get("/pharmacy/incidents")).expect(200);
    const row = (theirs.body as { items: { reporter: { role: string; name: string | null } }[] }).items[0]!;
    expect(row.reporter).toMatchObject({ role: "pharmacy", name: null });
    expect(JSON.stringify(theirs.body)).not.toContain("ph.mehta");
    expect(JSON.stringify(theirs.body)).not.toContain(fx.pharmacist.id);
    const one = await as(fx.aide.token)(request(server()).get(`/pharmacy/incidents/${incidentId}`)).expect(200);
    expect(JSON.stringify(one.body)).not.toContain("ph.mehta");

    // The reviewer's side: the name, beside the role.
    const mine = await as(ms.token)(request(server()).get(`/pharmacy/incidents/${incidentId}`)).expect(200);
    expect((mine.body as { reporter: { role: string; name: string } }).reporter).toMatchObject({ role: "pharmacy", name: "ph.mehta" });

    // Review and close are the reviewer's; the recorder may not.
    await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/incidents/${incidentId}/events`).send({ kind: "closed" })).expect(403);
    const needs = await as(ms.token)(request(server()).get("/pharmacy/office/needs")).expect(200);
    expect((needs.body as { rows: { id: string; kind: string }[] }).rows.map((r) => [r.id, r.kind])).toEqual([[`law:incident:${incidentId}`, "incident_review"]]);
    await as(ms.token)(request(server()).post(`/pharmacy/incidents/${incidentId}/events`).send({ kind: "closed" })).expect(400);
    await as(ms.token)(request(server()).post(`/pharmacy/incidents/${incidentId}/events`).send({ kind: "reviewed", rootCause: "Boxes shelved side by side", actionTaken: "Moved apart" })).expect(201);
    await as(ms.token)(request(server()).post(`/pharmacy/incidents/${incidentId}/events`).send({ kind: "closed" })).expect(201);
    await as(ms.token)(request(server()).post(`/pharmacy/incidents/${incidentId}/events`).send({ kind: "closed" })).expect(409);
    await as(ms.token)(request(server()).get("/pharmacy/incidents/nope")).expect(404);

    // The indicator: counts, no person.
    const ind = await as(fx.aide.token)(request(server()).get("/pharmacy/incidents/indicator?months=3")).expect(200);
    const months = (ind.body as { months: { month: string; nearMisses: number }[] }).months;
    expect(months).toHaveLength(3);
    expect(months.reduce((n, m) => n + m.nearMisses, 0)).toBe(1);
    expect(JSON.stringify(ind.body)).not.toMatch(/ph\.mehta|reporter/);
  });
});
