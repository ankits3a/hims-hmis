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
 * PHARMACY STAGE D4 — THE EMERGENCY TRAYS OVER HTTP: each route under its grant (check; manage; the reads that take
 * either), a check posted once per idempotency key, and a deficient tray on the office's STOCK side.
 */
describe("the emergency trays over HTTP (pharmacy stage D4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let fx: PharmacyFixture;
  let head: Awaited<ReturnType<typeof mkUser>>;
  let nurse: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.DOCUMENT_STORE_PATH = mkdtempSync(join(tmpdir(), "hmis-trays-e2e-docs-"));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await ensureRole(db, "tray_manager");
    await grantPermissionToRole(db, fx.registry, "tray_manager", "pharmacy.trays.manage");
    await ensureRole(db, "ot_nurse");
    await grantPermissionToRole(db, fx.registry, "ot_nurse", "pharmacy.trays.check");
    head = await mkUser(db, "the.tray.head", ["tray_manager"]);
    nurse = await mkUser(db, "ot.sister", ["ot_nurse"]);
  });
  afterEach(() => { fx.unregister(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

  it("guards every route, records a check once per key, and a deficient tray is a red STOCK row", async () => {
    await request(server()).get("/pharmacy/trays").expect(401);
    await as(fx.clerk.token)(request(server()).get("/pharmacy/trays")).expect(403);
    await as(nurse.token)(request(server()).post("/pharmacy/trays").send({ name: "OT-1 tray", location: "OT-1", custodianRoles: ["ot_nurse"] })).expect(403);
    await as(head.token)(request(server()).post("/pharmacy/trays").send({ name: "OT-1 tray", location: "OT-1", custodianRoles: ["front_office"] })).expect(400);
    const made = await as(head.token)(request(server()).post("/pharmacy/trays").send({ name: "OT-1 tray", location: "OT-1", custodianRoles: ["ot_nurse"] })).expect(201);
    const { trayId, code } = made.body as { trayId: string; code: string };
    expect(code).toBe("TRAY-OT-1-TRAY");
    await as(nurse.token)(request(server()).post(`/pharmacy/trays/${trayId}/template`).send({ itemId: fx.item.crocin, parQty: 10 })).expect(403);
    await as(head.token)(request(server()).post(`/pharmacy/trays/${trayId}/template`).send({ itemId: fx.item.crocin, parQty: 10 })).expect(201);

    const check = { trayId, kind: "monthly_full", sealNew: "S-1", lines: [{ itemId: fx.item.crocin, qtyPresent: 8, earliestExpiry: "2027-06-30" }] };
    await as(fx.clerk.token)(request(server()).post("/pharmacy/trays/checks").send(check)).expect(403);
    await as(head.token)(request(server()).post("/pharmacy/trays/checks").send(check)).expect(403);
    const first = await as(nurse.token)(request(server()).post("/pharmacy/trays/checks").set("Idempotency-Key", "tc-k1").send(check)).expect(201);
    const again = await as(nurse.token)(request(server()).post("/pharmacy/trays/checks").set("Idempotency-Key", "tc-k1").send(check)).expect(201);
    expect((again.body as { checkId: string }).checkId).toBe((first.body as { checkId: string }).checkId);
    expect(first.body).toMatchObject({ no: "TC-000001", result: "deficient", findings: ["short"], deficit: 2 });
    // The client cannot say the result.
    await as(nurse.token)(request(server()).post("/pharmacy/trays/checks").send({ ...check, result: "ok" })).expect(201).then((r) => expect(r.body).toMatchObject({ result: "deficient" }));

    const trays = await as(nurse.token)(request(server()).get("/pharmacy/trays")).expect(200);
    expect(trays.body.items[0]).toMatchObject({ code: "TRAY-OT-1-TRAY", needsRestock: true, template: [expect.objectContaining({ parQty: 10 })] });
    const history = await as(head.token)(request(server()).get(`/pharmacy/trays/${trayId}/checks`)).expect(200);
    expect(history.body.items).toHaveLength(2);

    const needs = await as(nurse.token)(request(server()).get("/pharmacy/office/needs")).expect(200);
    const rows = (needs.body as { rows: { kind: string; tier: number }[] }).rows.filter((r) => r.kind === "tray_deficient");
    expect(rows).toEqual([expect.objectContaining({ kind: "tray_deficient", tier: 0 })]);

    await as(fx.clerk.token)(request(server()).post(`/pharmacy/trays/checks/${(first.body as { checkId: string }).checkId}/restock`)).expect(403);
    await as(nurse.token)(request(server()).post("/pharmacy/trays/checks/nope/restock")).expect(404);
  });
});
