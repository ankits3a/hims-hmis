import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import { ensureRole, mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { formularySalts, patientAllergies } from "../src/kernel/db/schema";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

jest.setTimeout(180_000);

/**
 * PHARMACY STAGE D1 — THE ADR REGISTER OVER HTTP: each route under its grant (record, manage, and the reads
 * that take either), the report posted once per idempotency key, the PvPI form, and the patients route that
 * stays closed to the `pharmacy` provenance a typist could otherwise claim.
 */
describe("the ADR register over HTTP (pharmacy stage D1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let fx: PharmacyFixture;
  let ms: Awaited<ReturnType<typeof mkUser>>;
  let para: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.DOCUMENT_STORE_PATH = mkdtempSync(join(tmpdir(), "hmis-adr-e2e-docs-"));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.adr.record");
    await grantPermissionToRole(db, fx.registry, "pharmacy", "patients.update");
    await ensureRole(db, "adr_manager");
    await grantPermissionToRole(db, fx.registry, "adr_manager", "pharmacy.adr.manage");
    ms = await mkUser(db, "the.ms", ["adr_manager"]);
    para = (await db.select({ id: formularySalts.id }).from(formularySalts).where(eq(formularySalts.name, "Paracetamol")))[0]!.id;
  });
  afterEach(() => { fx.unregister(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);
  const body = (): Record<string, unknown> => ({
    patientId: fx.patient.id, reaction: "Angioedema after the first dose", onsetDate: "2026-09-20", seriousness: "life_threatening",
    outcome: "recovered", dechallenge: "yes", rechallenge: "na", suspects: [{ saltId: para, name: "Crocin 500", batchNo: "CR1" }],
  });

  it("guards every route, posts once per key, prints the form, and keeps the patients route closed to the pharmacy source", async () => {
    await request(server()).get("/pharmacy/adr").expect(401);
    await as(fx.clerk.token)(request(server()).get("/pharmacy/adr")).expect(403);
    await as(fx.clerk.token)(request(server()).post("/pharmacy/adr").send(body())).expect(403);
    await as(ms.token)(request(server()).post("/pharmacy/adr").send(body())).expect(403);
    await as(fx.pharmacist.token)(request(server()).get("/pharmacy/adr/salts?q=para")).expect(200)
      .then((r) => expect((r.body as { items: { name: string }[] }).items.map((i) => i.name)).toContain("Paracetamol"));
    await as(fx.pharmacist.token)(request(server()).post("/pharmacy/adr").send({ ...body(), seriousness: "grave" })).expect(400);

    const first = await as(fx.pharmacist.token)(request(server()).post("/pharmacy/adr").set("Idempotency-Key", "adr-k1").send(body())).expect(201);
    const again = await as(fx.pharmacist.token)(request(server()).post("/pharmacy/adr").set("Idempotency-Key", "adr-k1").send(body())).expect(201);
    const { reportId, no } = first.body as { reportId: string; no: string };
    expect((again.body as { reportId: string }).reportId).toBe(reportId);
    expect(no).toBe("ADR-000001");
    expect((await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, fx.patient.id))).map((a) => [a.substance, a.source])).toEqual([["Paracetamol", "pharmacy"]]);

    // The pharmacist may not act on it; the manager may, and reads it without the record grant.
    await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/adr/${reportId}/events`).send({ kind: "causality_assessed", causality: "probable" })).expect(403);
    await as(ms.token)(request(server()).post(`/pharmacy/adr/${reportId}/events`).send({ kind: "causality_assessed", causality: "probable" })).expect(201);
    await as(ms.token)(request(server()).post(`/pharmacy/adr/${reportId}/events`).send({ kind: "closed" })).expect(400);
    const list = await as(ms.token)(request(server()).get("/pharmacy/adr?open=true")).expect(200);
    expect((list.body as { items: { no: string; state: { causality: string } }[] }).items.map((i) => [i.no, i.state.causality])).toEqual([["ADR-000001", "probable"]]);
    await as(ms.token)(request(server()).get("/pharmacy/adr/nope")).expect(404);

    const doc = await as(ms.token)(request(server()).get(`/pharmacy/adr/${reportId}/document`)).expect(200);
    expect((doc.body as { html: string }).html).toContain("Suspected Adverse Drug Reaction Reporting Form");

    // The office's LAW row, for the manager.
    const needs = await as(ms.token)(request(server()).get("/pharmacy/office/needs")).expect(200);
    expect((needs.body as { rows: { id: string; kind: string }[] }).rows.map((r) => [r.id, r.kind])).toEqual([[`law:adr:${reportId}`, "adr_pvpi_serious"]]);

    // A typist cannot claim the ADR register's provenance for an allergy they type.
    await as(fx.pharmacist.token)(request(server()).post(`/patients/${fx.patient.id}/allergies`).send({ substance: "Ibuprofen", source: "pharmacy" })).expect(400);
  });
});
