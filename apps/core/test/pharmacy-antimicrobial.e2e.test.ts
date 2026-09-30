import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { openSessionFor } from "./helpers/billing";
import { setupTestDb, truncateAll } from "./helpers/db";
import { issueRx, line, seedPharmacyBase, stockIn } from "./helpers/pharmacy";
import { ensureRole, mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { assignRole, grantPermissionToRole } from "../src/kernel/auth/permissions";
import { formularyMedicines } from "../src/kernel/db/schema";
import { registerPharmacyApprovalTypes } from "../src/modules/pharmacy/approval-types";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

jest.setTimeout(180_000);

/**
 * PHARMACY STAGE D5 — THE RESTRICTED-ANTIMICROBIAL GATE OVER HTTP (the stage's deferred e2e). The three routes it
 * added, each under its own grant: the counter asks the steward (`POST /pharmacy/dispenses/:id/lines/:idx/steward`,
 * `pharmacy.dispense.place`), reads where each line stands (`GET /pharmacy/dispenses/:id/steward`,
 * `pharmacy.dispense.read`), and the steward reads the prescription line beside the inbox card
 * (`GET /pharmacy/steward-requests/:approvalId`, `pharmacy.antimicrobial.approve`). The decision is the kernel's
 * `/approvals` route; the gate is verify. Crocin stands in for meropenem: the gate reads the product's flag.
 */
describe("the restricted-antimicrobial gate over HTTP (pharmacy stage D5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let fx: PharmacyFixture;
  let steward: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.DOCUMENT_STORE_PATH = mkdtempSync(join(tmpdir(), "hmis-antimicrobial-e2e-docs-"));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    // The OPD consult gate wants the fee settled under the booted app; the pharmacist takes it (helpers/pharmacy).
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await registerPharmacyApprovalTypes(db, fx.base.activator);
    // The role as scripts/seed-roles.ts grants it: the approvals pair and the read of the request's prescription line.
    await ensureRole(db, "antimicrobial_steward");
    for (const p of ["approvals.requests.read", "approvals.requests.decide", "pharmacy.antimicrobial.approve"]) {
      await grantPermissionToRole(db, fx.registry, "antimicrobial_steward", p);
    }
    steward = await mkUser(db, "dr.steward", ["antimicrobial_steward"]);
    await db.update(formularyMedicines).set({ antimicrobialRestricted: true, awareCategory: "Reserve" }).where(eq(formularyMedicines.id, fx.med.crocin));
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 200 });
  });
  afterEach(() => { fx.unregister(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);
  const ASK = { indication: "culture-proven ESBL pyelonephritis", cultureSent: true, plannedDays: 7 };

  /** A Crocin ticket scanned and claimed over HTTP: ready for the check. */
  async function claimed(key: string): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { payFee: true });
    const found = await as(fx.pharmacist.token)(request(server()).get("/pharmacy/find").query({ q: issued.qrPayload })).expect(200);
    const id = (found.body as { dispense: { id: string } }).dispense.id;
    await as(fx.pharmacist.token)(request(server()).post("/pharmacy/dispenses").set("idempotency-key", `c-${key}`).send({ dispenseId: id, door: "rx_qr" })).expect(201);
    return id;
  }
  const verify = (id: string, key: string): request.Test =>
    as(fx.pharmacist.token)(request(server()).post(`/pharmacy/dispenses/${id}/verify`).set("idempotency-key", key).send({ lines: [{ lineIdx: 0, qtyBase: 10 }] }));
  const lines = async (id: string): Promise<{ lineIdx: number; status: string; drug: string; appointed: boolean; approvalId: string | null }[]> =>
    ((await as(fx.pharmacist.token)(request(server()).get(`/pharmacy/dispenses/${id}/steward`)).expect(200)).body as { lines: never[] }).lines;

  it("guards each route by its grant; the steward reads the line and grants it over /approvals; verify then passes", async () => {
    const id = await claimed("happy");

    // Unauthenticated, and the wrong grant, on each of the three routes.
    await request(server()).get(`/pharmacy/dispenses/${id}/steward`).expect(401);
    await request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send(ASK).expect(401);
    await as(fx.clerk.token)(request(server()).get(`/pharmacy/dispenses/${id}/steward`)).expect(403);
    await as(fx.clerk.token)(request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send(ASK)).expect(403);
    // The steward decides; the steward does not ask at the counter, nor read the counter's ticket.
    await as(steward.token)(request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send(ASK)).expect(403);
    await as(steward.token)(request(server()).get(`/pharmacy/dispenses/${id}/steward`)).expect(403);
    // A malformed ask is refused before the gate is consulted.
    await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send({ ...ASK, plannedDays: 0 })).expect(400);

    expect(await lines(id)).toEqual([expect.objectContaining({ lineIdx: 0, status: "none", drug: "Crocin 500", appointed: true })]);
    await verify(id, "v-happy-1").expect(409).expect((r) => expect(JSON.stringify(r.body)).toContain("antimicrobial_steward_approval_required"));

    const asked = await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send(ASK)).expect(201);
    const approvalId = (asked.body as { status: string; approvalId: string }).approvalId;
    expect(asked.body).toMatchObject({ status: "pending", approvalId: expect.any(String) });
    // Asking again returns the pending one.
    const again = await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send(ASK)).expect(201);
    expect((again.body as { approvalId: string }).approvalId).toBe(approvalId);

    // The request's prescription line is the steward's to read, not the counter's nor the clerk's.
    await request(server()).get(`/pharmacy/steward-requests/${approvalId}`).expect(401);
    await as(fx.pharmacist.token)(request(server()).get(`/pharmacy/steward-requests/${approvalId}`)).expect(403);
    await as(fx.clerk.token)(request(server()).get(`/pharmacy/steward-requests/${approvalId}`)).expect(403);
    const detail = await as(steward.token)(request(server()).get(`/pharmacy/steward-requests/${approvalId}`)).expect(200);
    expect(detail.body).toMatchObject({ approvalId, lines: [{ lineIdx: 0, drug: "Crocin 500", brandName: "Crocin 500" }], prescriberUserId: fx.doctor.userId });
    await as(steward.token)(request(server()).get("/pharmacy/steward-requests/01HNOSUCHAPPROVAL0000000000")).expect(404);

    // The counter may not decide its own ask; the steward does, in /approvals.
    await as(fx.pharmacist.token)(request(server()).post(`/approvals/${approvalId}/approve`).send({ note: "fine" })).expect(403);
    await as(steward.token)(request(server()).post(`/approvals/${approvalId}/approve`).send({ note: "agreed — 7 days, de-escalate on sensitivities" })).expect(201);
    expect(await lines(id)).toEqual([expect.objectContaining({ status: "granted", approvalId })]);
    await verify(id, "v-happy-2").expect(201).expect((r) => expect(r.body).toMatchObject({ status: "verified" }));
  });

  it("a steward may not approve their own prescription: the prescriber's grant is refused at verify over HTTP, another steward's passes", async () => {
    // The prescribing doctor also holds the steward role (an ID physician who prescribes).
    await assignRole(db, { userId: fx.doctor.userId, roleKey: "antimicrobial_steward", scopeType: "hospital" });
    const id = await claimed("self");
    const first = await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send(ASK)).expect(201);
    const mine = (first.body as { approvalId: string }).approvalId;
    // The inbox card tells the steward whose prescription it is — the prescriber is reading their own.
    const detail = await as(fx.doctor.token)(request(server()).get(`/pharmacy/steward-requests/${mine}`)).expect(200);
    expect((detail.body as { prescriberUserId: string }).prescriberUserId).toBe(fx.doctor.userId);
    await as(fx.doctor.token)(request(server()).post(`/approvals/${mine}/approve`).send({ note: "my patient, my call" })).expect(201);

    expect(await lines(id)).toEqual([expect.objectContaining({ status: "self_approved", approvalId: mine })]);
    const refused = await verify(id, "v-self-1").expect(409);
    expect(JSON.stringify(refused.body)).toContain("antimicrobial_self_approval");
    expect(JSON.stringify(refused.body)).toContain("may not approve their own prescription");

    // The counter asks again; the other steward decides; verify passes.
    const second = await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/dispenses/${id}/lines/0/steward`).send(ASK)).expect(201);
    const theirs = (second.body as { approvalId: string }).approvalId;
    expect(theirs).not.toBe(mine);
    await as(steward.token)(request(server()).post(`/approvals/${theirs}/approve`).send({ note: "agreed" })).expect(201);
    await verify(id, "v-self-2").expect(201);
  });
});
