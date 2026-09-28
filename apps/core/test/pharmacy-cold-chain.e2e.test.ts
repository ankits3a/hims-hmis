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
 * PHARMACY STAGE D3 — THE FRIDGE LOG OVER HTTP: each route under its grant (record; manage; the reads that take
 * either), a reading posted once per idempotency key, and the open excursion on the office's STOCK side.
 */
describe("the fridge log over HTTP (pharmacy stage D3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let fx: PharmacyFixture;
  let head: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.DOCUMENT_STORE_PATH = mkdtempSync(join(tmpdir(), "hmis-cold-e2e-docs-"));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.coldchain.record");
    await ensureRole(db, "cold_manager");
    await grantPermissionToRole(db, fx.registry, "cold_manager", "pharmacy.coldchain.manage");
    head = await mkUser(db, "the.head", ["cold_manager"]);
  });
  afterEach(() => { fx.unregister(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

  it("guards every route, posts a reading once per key, and an out-of-range one opens a red STOCK row", async () => {
    await request(server()).get("/pharmacy/cold-chain/units").expect(401);
    await as(fx.clerk.token)(request(server()).get("/pharmacy/cold-chain/units")).expect(403);
    await as(fx.pharmacist.token)(request(server()).post("/pharmacy/cold-chain/units").send({ storeResourceId: fx.storeId, label: "Fridge A" })).expect(403);
    await as(fx.pharmacist.token)(request(server()).get("/pharmacy/cold-chain/stores")).expect(403);
    expect((await as(head.token)(request(server()).get("/pharmacy/cold-chain/stores")).expect(200)).body.items.map((s: { code: string }) => s.code)).toContain("PHARM-OPD");

    const made = await as(head.token)(request(server()).post("/pharmacy/cold-chain/units").send({ storeResourceId: fx.storeId, label: "Fridge A" })).expect(201);
    const { unitId } = made.body as { unitId: string };
    await as(head.token)(request(server()).post(`/pharmacy/cold-chain/units/${unitId}`).send({ label: "Fridge A", lowC: 8, highC: 2 })).expect(400);

    const reading = { unitId, currentC: 5.0, minC: 3.0, maxC: 9.1 };
    await as(head.token)(request(server()).post("/pharmacy/cold-chain/readings").send(reading)).expect(403);
    const first = await as(fx.pharmacist.token)(request(server()).post("/pharmacy/cold-chain/readings").set("Idempotency-Key", "cr-k1").send(reading)).expect(201);
    const again = await as(fx.pharmacist.token)(request(server()).post("/pharmacy/cold-chain/readings").set("Idempotency-Key", "cr-k1").send(reading)).expect(201);
    expect((again.body as { readingId: string }).readingId).toBe((first.body as { readingId: string }).readingId);
    expect(first.body).toMatchObject({ outOfRange: true, opened: { no: "CE-000001", batches: 0 } });

    const units = await as(fx.pharmacist.token)(request(server()).get("/pharmacy/cold-chain/units")).expect(200);
    expect(units.body.items[0]).toMatchObject({ label: "Fridge A", openExcursion: { no: "CE-000001" } });
    const history = await as(head.token)(request(server()).get(`/pharmacy/cold-chain/units/${unitId}/readings?days=2`)).expect(200);
    expect(history.body.items).toHaveLength(1);

    const needs = await as(head.token)(request(server()).get("/pharmacy/office/needs")).expect(200);
    const cold = (needs.body as { rows: { kind: string; tier: number }[] }).rows.filter((r) => r.kind === "cold_excursion_open");
    expect(cold).toEqual([expect.objectContaining({ kind: "cold_excursion_open", tier: 0 })]);

    const ex = await as(fx.pharmacist.token)(request(server()).get("/pharmacy/cold-chain/excursions?open=true")).expect(200);
    const exId = (ex.body as { items: { id: string }[] }).items[0]!.id;
    await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/cold-chain/excursions/${exId}/close`).send({ decisions: [] })).expect(403);
    await as(head.token)(request(server()).post(`/pharmacy/cold-chain/excursions/${exId}/close`).send({ decisions: [], note: "no cold stock on hand" })).expect(201);
    await as(head.token)(request(server()).post(`/pharmacy/cold-chain/excursions/${exId}/close`).send({ decisions: [] })).expect(409);
    await as(head.token)(request(server()).post("/pharmacy/cold-chain/excursions/nope/close").send({ decisions: [] })).expect(404);
  });
});
