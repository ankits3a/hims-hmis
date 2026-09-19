import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions, assignRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { approvalFlowDefinition } from "../src/kernel/approvals/flow";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { patients, phiAccessLog, registrationConfig } from "../src/kernel/db/schema";
import type { Db } from "../src/kernel/db/client";

const DISCOUNT_DEF = approvalFlowDefinition({
  typeKey: "discount_override",
  title: "Discount Override",
  approverRole: "billing_head",
  closureSlaMinutes: 45,
});

describe("approvals e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let requesterToken: string;
  let approverToken: string;
  let randoToken: string;
  let requesterId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await createRole(db, "wf_admin", "Workflow Admin");
    for (const permission of workflowManifest.permissions) {
      await grantPermissionToRole(db, registry, "wf_admin", permission);
    }
    await createRole(db, "approvals_admin", "Approvals Admin");
    for (const permission of approvalsManifest.permissions) {
      await grantPermissionToRole(db, registry, "approvals_admin", permission);
    }
    await createRole(db, "billing_head", "Billing Head");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const drafter = await mk("drafter");
    const activator = await mk("activator");
    const requester = await mk("requester");
    const approver = await mk("approver");
    const rando = await mk("rando");
    requesterToken = requester.token;
    approverToken = approver.token;
    randoToken = rando.token;
    requesterId = requester.id;
    await assignRole(db, { userId: drafter.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: requester.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: approver.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: approver.id, roleKey: "billing_head", scopeType: "hospital" });

    // The flow definition is authored over Plan 03's own HTTP surface — the two-step
    // registration flow, end to end.
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafter.token}`)
      .send(DISCOUNT_DEF).expect(201);
    const { definitionId } = draft.body as { definitionId: string };
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activator.token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post("/approvals/types").set("Authorization", `Bearer ${activator.token}`)
      .send({ typeKey: "discount_override", title: "Discount Override", approverRole: "billing_head" })
      .expect(201);
  });

  it("guards every route: 401 unauthenticated, 403 without the permission", async () => {
    await request(app.getHttpServer()).post("/approvals").send({}).expect(401);
    await request(app.getHttpServer())
      .post("/approvals/types").set("Authorization", `Bearer ${randoToken}`)
      .send({ typeKey: "x", title: "X", approverRole: "r" }).expect(403);
    await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${randoToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "i1" } }).expect(403);
    await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${randoToken}`).expect(403);
  });

  it("full lifecycle over HTTP: request → worklist → approve → decided", async () => {
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override",
        subject: { type: "invoice", id: "inv1" },
        patientId: "01HPAT000000000000000000A",
        amountPaise: 50_000,
        requestNote: "20% senior-citizen discount",
      })
      .expect(201);
    const { approvalId, instanceId } = created.body as { approvalId: string; instanceId: string };
    expect(approvalId).toBeTruthy();
    expect(instanceId).toBeTruthy();

    // Worklist is role-scoped: the approver sees it, the requester does not.
    const approverList = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${approverToken}`).expect(200);
    expect(approverList.body.total).toBe(1);
    expect(approverList.body.items[0]).toMatchObject({
      id: approvalId, typeKey: "discount_override", urgencyClass: "routine",
      cumulativePatientPaise: 50_000,
    });
    const requesterList = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${requesterToken}`).expect(200);
    expect(requesterList.body).toEqual({ items: [], total: 0 });

    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "verified against policy" })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/approvals/${approvalId}`).set("Authorization", `Bearer ${approverToken}`).expect(200);
    expect(detail.body.approval).toMatchObject({
      status: "granted", decisionNote: "verified against policy",
    });
    // A second decision conflicts.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/reject`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "changed my mind" })
      .expect(409);
  });

  /*
    APPROVALS-UX — the inbox names people. Before this, every row carried `requesterId` and
    `patientId` as bare ids and the screen printed a ULID where the patient should be. The approver
    here holds NO `patients.confidential.read`, so the sealed patient must arrive by alias with no
    legal name, and every patient named must leave a `phi_access_log` row.
  */
  it("the worklist names the requester, the decider and the patient — a sealed one by alias — and logs the read", async () => {
    const PLAIN = "01HPATPLAIN00000000000000A";
    const SEALED = "01HPATSEALED0000000000000A";
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values([
      { id: PLAIN, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" },
      { id: SEALED, uhid: "HMS-00000002-3", name: "Meera Raghavan", alias: "Patient S-14", isConfidential: true,
        sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" },
    ]);
    const file = async (patientId: string, subjectId: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
        .send({ typeKey: "discount_override", subject: { type: "invoice", id: subjectId }, patientId, amountPaise: 50_000 })
        .expect(201);
      return (res.body as { approvalId: string }).approvalId;
    };
    const plainId = await file(PLAIN, "inv1");
    const sealedId = await file(SEALED, "inv2");

    const list = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${approverToken}`).expect(200);
    const byId = new Map((list.body.items as { id: string }[]).map((i) => [i.id, i] as const));
    expect(byId.get(plainId)).toMatchObject({
      requesterName: "requester", decidedByName: null,
      patient: { id: PLAIN, uhid: "HMS-00000001-5", name: "Asha Devi", alias: null, restricted: false },
    });
    expect(byId.get(sealedId)).toMatchObject({
      patient: { id: SEALED, uhid: "HMS-00000002-3", name: null, alias: "Patient S-14", restricted: true },
    });
    expect(JSON.stringify(list.body)).not.toContain("Meera Raghavan");

    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "approvals.worklist"));
    expect(logged.map((r) => [r.patientId, r.sealed]).sort()).toEqual([[PLAIN, false], [SEALED, true]].sort());

    await request(app.getHttpServer())
      .post(`/approvals/${plainId}/approve`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "Approved as requested" }).expect(201);
    const decided = await request(app.getHttpServer())
      .get("/approvals").query({ status: "granted" }).set("Authorization", `Bearer ${approverToken}`).expect(200);
    expect(decided.body.items).toHaveLength(1);
    expect(decided.body.items[0]).toMatchObject({ id: plainId, requesterName: "requester", decidedByName: "approver" });
  });

  it("blocks requester=approver over HTTP with 403 (SoD), leaving the request pending", async () => {
    await assignRole(db, { userId: requesterId, roleKey: "billing_head", scopeType: "hospital" });
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "inv1" } })
      .expect(201);
    const { approvalId } = created.body as { approvalId: string };
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${requesterToken}`)
      .send({ note: "approving my own request" })
      .expect(403);
    const detail = await request(app.getHttpServer())
      .get(`/approvals/${approvalId}`).set("Authorization", `Bearer ${requesterToken}`).expect(200);
    expect(detail.body.approval.status).toBe("pending");
  });

  it("validates bodies and maps engine errors (400 zod, 400 note_required, 404 unknown, 400 duplicate type)", async () => {
    await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override" }) // missing subject
      .expect(400);
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "inv1" } })
      .expect(201);
    const { approvalId } = created.body as { approvalId: string };
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "" }) // zod min(1)
      .expect(400);
    const whitespace = await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "   " }) // passes zod, refused at runtime — note_required
      .expect(400);
    expect(whitespace.body.message).toContain("note"); // parsed body, never JSON.stringify (§3.11)
    await request(app.getHttpServer())
      .get("/approvals/01HNOSUCH0000000000000000")
      .set("Authorization", `Bearer ${approverToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post("/approvals/01HNOSUCH0000000000000000/approve")
      .set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "who dis" })
      .expect(404);
    const dup = await request(app.getHttpServer())
      .post("/approvals/types").set("Authorization", `Bearer ${approverToken}`)
      .send({ typeKey: "discount_override", title: "Again", approverRole: "billing_head" })
      .expect(400);
    expect(dup.body.message).toContain("already exists");
  });
});
