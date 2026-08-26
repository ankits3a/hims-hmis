import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { approvalFlowDefinition } from "../src/kernel/approvals/flow";
import { patientsManifest, sweepGuardianMajority } from "../src/modules/patients";
import { events, registrationConfig } from "../src/kernel/db/schema";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

// Registered as DATA over HTTP in beforeEach — exactly the go-live runbook flow (README's
// "Patients module (Plan 05)" section). Never imported from module internals: an e2e test
// outside src/modules/patients/ only ever reaches the module through its shipped routes.
const MERGE_TYPE = "patient_merge";
const UNMERGE_TYPE = "patient_unmerge";

describe("patients lifecycle e2e (registration → merge → unmerge → sweep)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let clerkId: string;
  let clerkToken: string;
  let mrdToken: string;

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

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
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "e2e" });

    // clerk: reg_desk — the five patients.* permissions, NO approvals permission anywhere.
    await createRole(db, "reg_desk", "Registration Desk");
    for (const p of patientsManifest.permissions) {
      await grantPermissionToRole(db, registry, "reg_desk", p);
    }
    // mrd: mrd_head (approverRole match, zero permissions of its own) + a role holding the
    // two worklist/decision permissions — the SoD pair's approver side.
    await createRole(db, "mrd_head", "MRD Head");
    await createRole(db, "approvals_decider", "Approvals Decider");
    for (const p of ["approvals.requests.read", "approvals.requests.decide"]) {
      await grantPermissionToRole(db, registry, "approvals_decider", p);
    }
    // drafter/activator: workflow.definitions.* on both; activator alone also gets
    // approvals.types.manage — the Class C SoD pair the go-live runbook documents.
    await createRole(db, "wf_admin", "Workflow Admin");
    for (const p of workflowManifest.permissions) {
      await grantPermissionToRole(db, registry, "wf_admin", p);
    }
    await createRole(db, "approvals_type_admin", "Approval Types Admin");
    await grantPermissionToRole(db, registry, "approvals_type_admin", "approvals.types.manage");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const clerk = await mk("clerk");
    const mrd = await mk("mrd");
    const drafter = await mk("drafter");
    const activator = await mk("activator");
    clerkId = clerk.id;
    clerkToken = clerk.token;
    mrdToken = mrd.token;

    await assignRole(db, { userId: clerk.id, roleKey: "reg_desk", scopeType: "hospital" });
    await assignRole(db, { userId: mrd.id, roleKey: "mrd_head", scopeType: "hospital" });
    await assignRole(db, { userId: mrd.id, roleKey: "approvals_decider", scopeType: "hospital" });
    await assignRole(db, { userId: drafter.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "approvals_type_admin", scopeType: "hospital" });

    // Register BOTH approval types over HTTP — draft (drafter) → activate (activator, a
    // different user: the Class C SoD pair) → POST /approvals/types (activator).
    for (const spec of [
      { typeKey: MERGE_TYPE, title: "Patient Merge", urgencyClass: "routine" as const, actFirstAllowed: false, sla: 240 },
      { typeKey: UNMERGE_TYPE, title: "Patient Unmerge", urgencyClass: "urgent" as const, actFirstAllowed: true, sla: 60 },
    ]) {
      const def = approvalFlowDefinition({
        typeKey: spec.typeKey, title: spec.title, approverRole: "mrd_head", closureSlaMinutes: spec.sla,
      });
      const draft = await request(app.getHttpServer())
        .post("/workflow/definitions").set(...auth(drafter.token))
        .send(def).expect(201);
      const { definitionId } = draft.body as { definitionId: string };
      await request(app.getHttpServer())
        .post(`/workflow/definitions/${definitionId}/activate`)
        .set(...auth(activator.token)).expect(201);
      await request(app.getHttpServer())
        .post("/approvals/types").set(...auth(activator.token))
        .send({
          typeKey: spec.typeKey, title: spec.title, approverRole: "mrd_head",
          urgencyClass: spec.urgencyClass, actFirstAllowed: spec.actFirstAllowed,
        })
        .expect(201);
    }
  });

  it("registration → duplicate detection → merge (SoD) → chain resolution → act-first unmerge (E-15) → guardian majority sweep → event trail", async () => {
    // Leg 1: register the duplicate pair.
    const regA = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Asha Devi", sex: "female", phone: "9876543210", language: "hi" })
      .expect(201);
    const winnerId = regA.body.patient.id as string;
    expect(regA.body.patient.uhid).toMatch(/^HMS\d{8}$/);

    const regB = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Asha Debi", sex: "female", phone: "9876543210", language: "hi" })
      .expect(201);
    const loserId = regB.body.patient.id as string;
    expect(regB.body.patient.uhid).toMatch(/^HMS\d{8}$/);

    const dupSearch = await request(app.getHttpServer())
      .get("/patients/search").query({ q: "98765" }).set(...auth(clerkToken)).expect(200);
    expect(dupSearch.body.items).toHaveLength(2);
    expect(dupSearch.body.items.map((i: { id: string }) => i.id).sort()).toEqual([winnerId, loserId].sort());

    // Leg 2: photo lands on the loser — the attach prompt's raw material. Also capture the
    // loser's pre-merge QR payload here (leg 5 verifies it resolves through the merge chain).
    const bytes = Buffer.alloc(300_000, 7);
    await request(app.getHttpServer())
      .put(`/patients/${loserId}/photo`).set(...auth(clerkToken))
      .send({ imageBase64: bytes.toString("base64") }).expect(200);
    const photoSearch = await request(app.getHttpServer())
      .get("/patients/search").query({ q: "98765" }).set(...auth(clerkToken)).expect(200);
    const loserRow = photoSearch.body.items.find((i: { id: string }) => i.id === loserId) as { hasPhoto: boolean };
    expect(loserRow.hasPhoto).toBe(true);

    const loserQr = await request(app.getHttpServer())
      .get(`/patients/${loserId}/qr`).set(...auth(clerkToken)).expect(200);
    const loserQrPayload = loserQr.body.payload as string;
    expect(loserQrPayload.startsWith("q1.")).toBe(true);

    // Leg 3: merge request over HTTP — the clerk holds only patients.* permissions;
    // createMergeRequest files the approval as a SERVICE call on its own transaction, which
    // carries no route guard, so no approvals permission is needed for this to succeed.
    const mergeReq = await request(app.getHttpServer())
      .post("/patients/merge-requests").set(...auth(clerkToken))
      .send({ winnerId, loserId, note: "same person, duplicate registration" })
      .expect(201);
    const mergeRequestId = mergeReq.body.mergeRequestId as string;
    const mergeApprovalId = mergeReq.body.approvalId as string;

    const mergeDetail = await request(app.getHttpServer())
      .get(`/patients/merge-requests/${mergeRequestId}`).set(...auth(clerkToken)).expect(200);
    expect(mergeDetail.body.approvalStatus).toBe("pending");

    await request(app.getHttpServer())
      .post(`/patients/merge-requests/${mergeRequestId}/execute`).set(...auth(clerkToken)).expect(409);

    // Leg 4: approver's worklist + the SoD pair over HTTP.
    const worklist = await request(app.getHttpServer())
      .get("/approvals").query({ status: "pending" }).set(...auth(mrdToken)).expect(200);
    expect(worklist.body.items).toHaveLength(1);
    expect(worklist.body.items[0]).toMatchObject({ id: mergeApprovalId, typeKey: MERGE_TYPE, urgencyClass: "routine" });

    // The clerk deliberately held zero approvals permissions through legs 1-3 — that is what
    // proves the merge-request service call carries no route guard. For this assertion only,
    // grant approvals.requests.decide so the clerk clears @RequirePermission on the approve
    // route and the refusal below is produced by the SoD check (assertNotSodPair) itself,
    // not by the route guard. There is no permission cache — hasPermission queries the DB
    // per request (kernel/auth/permissions.ts) — so the grant applies immediately.
    await assignRole(db, { userId: clerkId, roleKey: "approvals_decider", scopeType: "hospital" });

    const selfApproval = await request(app.getHttpServer())
      .post(`/approvals/${mergeApprovalId}/approve`).set(...auth(clerkToken))
      .send({ note: "self-approval attempt" }).expect(403); // requester === approver — refused by the SoD check
    expect(selfApproval.body.message).toContain("requester_approver");

    await request(app.getHttpServer())
      .post(`/approvals/${mergeApprovalId}/approve`).set(...auth(mrdToken))
      .send({ note: "verified same person at desk" }).expect(201);

    // Leg 5: execute → merge-chain resolution → the loser's pre-merge QR now verifies to the winner.
    const executed = await request(app.getHttpServer())
      .post(`/patients/merge-requests/${mergeRequestId}/execute`).set(...auth(clerkToken)).expect(201);
    expect(executed.body).toEqual({ winnerId, loserId });

    const afterMerge = await request(app.getHttpServer())
      .get(`/patients/${loserId}`).set(...auth(clerkToken)).expect(200);
    expect(afterMerge.body.patient.id).toBe(winnerId);
    expect(afterMerge.body.resolvedFrom).toBe(loserId);

    const qrVerify = await request(app.getHttpServer())
      .post("/patients/qr/verify").set(...auth(clerkToken))
      .send({ payload: loserQrPayload }).expect(200);
    expect(qrVerify.body.ok).toBe(true);
    expect(qrVerify.body.patient.id).toBe(winnerId);

    // Leg 6: act-first unmerge (E-15) — executes while its own approval is still PENDING;
    // a LATER rejection of that same approval changes nothing (an after-the-fact review, not
    // a rollback path). This is the leg that matters most.
    const unmergeReq = await request(app.getHttpServer())
      .post(`/patients/merge-requests/${mergeRequestId}/unmerge-request`).set(...auth(clerkToken))
      .send({ note: "different persons — DOB mismatch found", actFirst: true })
      .expect(201);
    const unmergeApprovalId = unmergeReq.body.approvalId as string;

    const unmergeApprovalBefore = await request(app.getHttpServer())
      .get(`/approvals/${unmergeApprovalId}`).set(...auth(mrdToken)).expect(200);
    expect(unmergeApprovalBefore.body.approval.status).toBe("pending");

    await request(app.getHttpServer())
      .post(`/patients/merge-requests/${mergeRequestId}/unmerge`).set(...auth(clerkToken)).expect(201);

    const afterUnmerge = await request(app.getHttpServer())
      .get(`/patients/${loserId}`).set(...auth(clerkToken)).expect(200);
    expect(afterUnmerge.body.patient.id).toBe(loserId);
    expect(afterUnmerge.body.patient.status).toBe("active");
    expect(afterUnmerge.body.resolvedFrom).toBeNull();

    // The after-the-fact rejection: a review outcome, never a rollback (E-15).
    await request(app.getHttpServer())
      .post(`/approvals/${unmergeApprovalId}/reject`).set(...auth(mrdToken))
      .send({ note: "review closed after the fact — act-first stands" }).expect(201);

    const afterRejection = await request(app.getHttpServer())
      .get(`/patients/${loserId}`).set(...auth(clerkToken)).expect(200);
    expect(afterRejection.body.patient.id).toBe(loserId);
    expect(afterRejection.body.patient.status).toBe("active"); // still active — the rejection changed nothing
    expect(afterRejection.body.resolvedFrom).toBeNull();

    // Leg 7: guardian majority — read-time enforced, swept idempotently.
    const now = new Date();
    // 18 years minus 10 days ago: the patient turns 18 in 10 days, not yet today.
    const dob = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate() + 10));
    const minorReg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({
        name: "Minor Guardian Test", sex: "other", dob: dob.toISOString(),
        guardian: { name: "Guardian G", relationship: "mother" },
      })
      .expect(201);
    const minorId = minorReg.body.patient.id as string;

    expect(await sweepGuardianMajority(db, now)).toBe(0); // not yet 18
    const tenDaysAhead = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 10));
    expect(await sweepGuardianMajority(db, tenDaysAhead)).toBe(1); // birthday reached

    const guardiansAfterSweep = await request(app.getHttpServer())
      .get(`/patients/${minorId}/guardians`).set(...auth(clerkToken)).expect(200);
    expect(guardiansAfterSweep.body.items[0].guardian.status).toBe("majority_ended");

    expect(await sweepGuardianMajority(db, tenDaysAhead)).toBe(0); // idempotent second run

    // Leg 8: event-trail audit, by name, exact counts.
    const countByName = async (name: string): Promise<number> =>
      (await db.select().from(events).where(eq(events.name, name))).length;
    expect(await countByName("patient.registered")).toBe(3); // winner, loser, minor
    expect(await countByName("patient.updated")).toBe(1); // the leg-2 photo store
    expect(await countByName("patient.merged")).toBe(1);
    expect(await countByName("patient.unmerged")).toBe(1);
    expect(await countByName("guardian.linked")).toBe(1); // the minor's guardian
    expect(await countByName("guardian.authority_changed")).toBe(1); // the majority sweep
    expect(await countByName("approval.requested")).toBe(2); // merge + unmerge
    expect(await countByName("approval.granted")).toBe(1); // the merge approval
    expect(await countByName("approval.rejected")).toBe(1); // the after-the-fact unmerge review
    expect(await countByName("sod.violation_blocked")).toBe(1); // the leg-4 clerk self-approval attempt
  });
});
