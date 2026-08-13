import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
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
import { runDueTimers } from "../src/kernel/workflow/timers";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { events, workflowInstances, workflowTimers } from "../src/kernel/db/schema";
import type { Db } from "../src/kernel/db/client";

const ICU_DEF = approvalFlowDefinition({
  typeKey: "icu_admission",
  title: "ICU Admission",
  approverRole: "duty_doctor",
  closureSlaMinutes: 30,
  escalation: [
    { afterMinutes: 10, toRole: "supervisor" },
    { afterMinutes: 20, toRole: "department_head" },
  ],
});
const DISCOUNT_DEF = approvalFlowDefinition({
  typeKey: "discount_override",
  title: "Discount Override",
  approverRole: "billing_head",
  closureSlaMinutes: 45,
});

describe("approvals full lifecycle e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let requesterToken: string;
  let dutyDoctorToken: string;
  let dutyDoctorId: string;
  let billingHeadToken: string;
  let supervisorId: string;
  let departmentHeadId: string;

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
    for (const role of ["duty_doctor", "billing_head", "supervisor", "department_head"]) {
      await createRole(db, role, role);
    }

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const drafter = await mk("drafter");
    const activator = await mk("activator");
    const requester = await mk("requester");
    const dutyDoctor = await mk("duty_doctor1");
    const billingHead = await mk("billing_head1");
    const supervisor = await mk("supervisor1");
    const departmentHead = await mk("dept_head1");
    requesterToken = requester.token;
    dutyDoctorToken = dutyDoctor.token;
    dutyDoctorId = dutyDoctor.id;
    billingHeadToken = billingHead.token;
    supervisorId = supervisor.id;
    departmentHeadId = departmentHead.id;
    await assignRole(db, { userId: drafter.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: requester.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: dutyDoctor.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: dutyDoctor.id, roleKey: "duty_doctor", scopeType: "hospital" });
    await assignRole(db, { userId: billingHead.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: billingHead.id, roleKey: "billing_head", scopeType: "hospital" });
    await assignRole(db, { userId: supervisor.id, roleKey: "supervisor", scopeType: "hospital" });
    await assignRole(db, { userId: departmentHead.id, roleKey: "department_head", scopeType: "hospital" });

    for (const [def, typeKey, approverRole, urgencyClass, actFirstAllowed] of [
      [ICU_DEF, "icu_admission", "duty_doctor", "emergency", true],
      [DISCOUNT_DEF, "discount_override", "billing_head", "routine", false],
    ] as const) {
      const draft = await request(app.getHttpServer())
        .post("/workflow/definitions").set("Authorization", `Bearer ${drafter.token}`)
        .send(def).expect(201);
      const { definitionId } = draft.body as { definitionId: string };
      await request(app.getHttpServer())
        .post(`/workflow/definitions/${definitionId}/activate`)
        .set("Authorization", `Bearer ${activator.token}`)
        .expect(201);
      await request(app.getHttpServer())
        .post("/approvals/types").set("Authorization", `Bearer ${activator.token}`)
        .send({ typeKey, title: typeKey, approverRole, urgencyClass, actFirstAllowed })
        .expect(201);
    }
  });

  it("breaches the closure SLA and climbs the ladder through Plan 03's shipped sweep", async () => {
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "icu_admission",
        subject: { type: "encounter", id: "e1" },
        patientId: "01HPAT000000000000000000A",
        actFirst: true,
        requestNote: "patient unstable — admitted first (E-15)",
      })
      .expect(201);
    const { approvalId, instanceId } = created.body as { approvalId: string; instanceId: string };

    // Backdate the open closure-SLA timer 40 minutes (the shipped timers.test convention).
    // Ladder cadence anchors on each timer's dueAt, so with rungs at +10/+20 the whole
    // chain is already due: sweep 1 fires the SLA breach, 2 fires rung 0, 3 fires rung 1,
    // 4 finds nothing. One rung per chain per call — Plan 03's documented semantics.
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 40 * 60_000) })
      .where(eq(workflowTimers.instanceId, instanceId));

    expect(await runDueTimers(db)).toBe(1); // sla.breached
    expect(await runDueTimers(db)).toBe(1); // escalation rung 0
    expect(await runDueTimers(db)).toBe(1); // escalation rung 1
    expect(await runDueTimers(db)).toBe(0); // ladder exhausted, nothing due

    const breaches = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.correlationId).toBe(instanceId);
    expect(breaches[0]!.payload).toMatchObject({
      instanceId, state: "pending", slaMinutes: 30, alerting: "active",
    });

    const escalations = await db.select().from(events)
      .where(eq(events.name, "escalation.triggered")).orderBy(asc(events.seq));
    expect(escalations).toHaveLength(2);
    expect(escalations[0]!.payload).toMatchObject({
      rung: 0, role: "supervisor", resolvedUserIds: [supervisorId],
      fallback: false, fallbackExhausted: false,
    });
    expect(escalations[1]!.payload).toMatchObject({
      rung: 1, role: "department_head", resolvedUserIds: [departmentHeadId],
      fallback: false, fallbackExhausted: false,
    });

    // Escalated but undecided: the item is still pending and actionable.
    const list = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${dutyDoctorToken}`).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([approvalId]);

    // The after-the-fact review closes it — here as a rejection; the consequences of a
    // rejected acted-first item belong to the consumer domain (Plan 08+), not this engine.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/reject`).set("Authorization", `Bearer ${dutyDoctorToken}`)
      .send({ note: "admission not clinically justified on review" })
      .expect(201);
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "rejected", status: "completed" });
    const rejections = await db.select().from(events).where(eq(events.name, "approval.rejected"));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.payload).toMatchObject({ approvalId, actedFirst: true, urgencyClass: "emergency" });
  });

  it("exposes C-12 cumulative snapshots over HTTP (report-only)", async () => {
    const first = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
        patientId: "01HPAT000000000000000000A", amountPaise: 500_000,
      })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override", subject: { type: "invoice", id: "inv2" },
        patientId: "01HPAT000000000000000000A", amountPaise: 300_000,
      })
      .expect(201);
    const other = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override", subject: { type: "invoice", id: "inv3" },
        patientId: "01HPAT000000000000000000B", amountPaise: 100_000,
      })
      .expect(201);

    const firstDetail = await request(app.getHttpServer())
      .get(`/approvals/${(first.body as { approvalId: string }).approvalId}`)
      .set("Authorization", `Bearer ${billingHeadToken}`).expect(200);
    expect(firstDetail.body.approval.cumulativePatientPaise).toBe(500_000);
    const secondDetail = await request(app.getHttpServer())
      .get(`/approvals/${(second.body as { approvalId: string }).approvalId}`)
      .set("Authorization", `Bearer ${billingHeadToken}`).expect(200);
    expect(secondDetail.body.approval.cumulativePatientPaise).toBe(800_000); // same patient, same IST day
    const otherDetail = await request(app.getHttpServer())
      .get(`/approvals/${(other.body as { approvalId: string }).approvalId}`)
      .set("Authorization", `Bearer ${billingHeadToken}`).expect(200);
    expect(otherDetail.body.approval.cumulativePatientPaise).toBe(100_000); // different patient
  });

  it("orders the worklist emergency-first for a multi-role approver", async () => {
    const discount = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "inv1" } })
      .expect(201);
    const icu = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "icu_admission", subject: { type: "encounter", id: "e1" },
        actFirst: true, requestNote: "unstable",
      })
      .expect(201);
    // dutyDoctor additionally picks up billing_head — sees both, emergency first
    // despite the discount item being filed earlier (older requestedAt).
    await assignRole(db, { userId: dutyDoctorId, roleKey: "billing_head", scopeType: "hospital" });
    const list = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${dutyDoctorToken}`).expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([
      (icu.body as { approvalId: string }).approvalId,
      (discount.body as { approvalId: string }).approvalId,
    ]);
  });
});
