import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { issueDuesInvoice, issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase, testCfg } from "./helpers/billing";
import type { BillingBaseFixture } from "./helpers/billing";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest, registerPatient } from "../src/modules/patients";
import { billingManifest } from "../src/modules/billing";
import { phiAccessLog, registrationConfig } from "../src/kernel/db/schema";
import { withTx } from "../src/kernel/db/client";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { Actor } from "@hmis/contracts";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * #852 — `GET /billing/patients/:id/bills-alias` over real HTTP: a sealed record's bills as date,
 * number and status for a seat that may not open the record, audited as `billing.bills_alias`; the
 * front desk's narrow dues grant reads the unsettled ones only; a readable record is a 404.
 */
jest.setTimeout(120_000);

describe("#852 bills-alias e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, billingManifest]) registry.install(m);

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

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await syncPermissions(db, registry);
    cashier = await mkCashier(db, "bae_cashier");
    await openSessionFor(db, cashier, 100_000);
  });

  const seat = async (key: string, perms: string[]): Promise<string> => {
    await createRole(db, key, key);
    for (const p of perms) await grantPermissionToRole(db, registry, key, p);
    const { id } = await createUser(db, { username: key, fullName: key, password: "p1234567" });
    const { token } = await createSession(db, testCfg, id);
    await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
    return token;
  };
  const patient = async (sealed: boolean): Promise<string> => {
    const { patient: p } = await withTx(db, (tx) => registerPatient(tx, { type: "user", id: "bae-clerk" }, {
      name: "Sealed E2E Name", sex: "male", ageYears: 40, phone: "9811200002",
      ...(sealed ? { isConfidential: true, alias: "R-8520" } : {}),
    }));
    return p.id;
  };
  const get = (token: string, id: string) =>
    request(app.getHttpServer()).get(`/billing/patients/${id}/bills-alias`).set("Authorization", `Bearer ${token}`);

  it("a cashier seat: every bill, date · number · status, no amounts — one billing.bills_alias access row", async () => {
    const token = await seat("bae_counter", ["billing.invoice.read", "patients.read"]);
    const id = await patient(true);
    const paid = await issuePaidInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    const due = await issueDuesInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    const res = await get(token, id).expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((r: { invoiceNo: string }) => r.invoiceNo).sort()).toEqual([paid.invoiceNo, due.invoiceNo].sort());
    const wire = JSON.stringify(res.body);
    expect(wire).not.toMatch(/paise|amount|payer|line/i);
    for (const leak of ["Sealed E2E Name", "9811200002", String(paid.totals.netPayablePaise)]) expect(wire).not.toContain(leak);
    const rows = await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, id));
    expect(rows.map((r) => ({ surface: r.surface, sealed: r.sealed }))).toEqual([{ surface: "billing.bills_alias", sealed: true }]);
  });

  it("the front desk's narrow dues grant: the unsettled bills only", async () => {
    const token = await seat("bae_desk", ["billing.dues.patient.read", "patients.read"]);
    const id = await patient(true);
    await issuePaidInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    const due = await issueDuesInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    const res = await get(token, id).expect(200);
    expect(res.body.items).toEqual([expect.objectContaining({ invoiceNo: due.invoiceNo, status: "unpaid" })]);
  });

  it("a record the seat can open is a 404 (the full reads serve it) and logs nothing; no billing grant is a 403", async () => {
    const token = await seat("bae_counter2", ["billing.invoice.read", "patients.read"]);
    const id = await patient(false);
    await issuePaidInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    await get(token, id).expect(404);
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, id))).toEqual([]);
    const none = await seat("bae_none", ["patients.read"]);
    await get(none, await patient(true)).expect(403);
  });
});
