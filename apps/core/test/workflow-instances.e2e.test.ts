import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions, assignRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { runDueTimers } from "../src/kernel/workflow/timers";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { events, workflowTimers } from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

const DEF_V1 = {
  key: "e2e_lifecycle",
  title: "Lifecycle v1",
  changeClass: "C",
  initialState: "open",
  states: [
    {
      name: "open",
      sla: { minutes: 30, alerting: "active", escalation: [{ afterMinutes: 10, toRole: "duty_manager" }] },
    },
    { name: "in_progress", sla: { minutes: 60, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress", roles: ["nurse"] },
    { from: "in_progress", to: "done", roles: ["nurse"] },
  ],
};
const DEF_V2 = {
  ...DEF_V1,
  title: "Lifecycle v2",
  // PLAN DEFECT (verify-by-execution finding): the plan's fixture spreads DEF_V1 without
  // overriding initialState, leaving "open" — a state that does not exist in v2's states
  // list below. defineWorkflow's validation correctly rejects that with 400
  // `initialState "open" is not a declared state`. initialState is overridden here to
  // "received" (the state the migrate stateMapping in this test maps "open" onto) so the
  // draft validates; see the task report for the confirmed 400 body.
  initialState: "received",
  states: [
    { name: "received", sla: { minutes: 5, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "received", to: "done", roles: ["nurse"] }],
};

describe("workflow instances e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let adminToken: string;   // wf_admin: every workflow permission
  let nurseToken: string;   // nurse role + instances.transition permission
  let nurseId: string;
  let dmId: string;

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
    await createRole(db, "wf_operator", "Workflow Operator");
    await grantPermissionToRole(db, registry, "wf_operator", "workflow.instances.transition");
    await createRole(db, "nurse", "Nurse");
    await createRole(db, "duty_manager", "Duty Manager");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const admin = await mk("admin1");
    const nurse = await mk("nurse1");
    const dm = await mk("dm1");
    adminToken = admin.token;
    nurseToken = nurse.token;
    nurseId = nurse.id;
    dmId = dm.id;
    await assignRole(db, { userId: admin.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: nurse.id, roleKey: "wf_operator", scopeType: "hospital" });
    await assignRole(db, { userId: nurse.id, roleKey: "nurse", scopeType: "hospital" });
    await assignRole(db, { userId: dm.id, roleKey: "duty_manager", scopeType: "hospital" });

    // an activator distinct from the drafter (SoD): admin drafts, second admin activates
    const activator = await mk("activator");
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${adminToken}`)
      .send(DEF_V1).expect(201);
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${(draft.body as { definitionId: string }).definitionId}/activate`)
      .set("Authorization", `Bearer ${activator.token}`)
      .expect(201);
  });

  async function startInstanceViaApi(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/workflow/instances").set("Authorization", `Bearer ${adminToken}`)
      .send({ defKey: "e2e_lifecycle", subject: { type: "test", id: "s1", patientId: "01HPAT000000000000000000A" } })
      .expect(201);
    expect(res.body.state).toBe("open");
    return (res.body as { instanceId: string }).instanceId;
  }

  it("start → breach (runDueTimers) → escalate → transition → complete, end to end", async () => {
    const instanceId = await startInstanceViaApi();

    // Breach: backdate the SLA timer, then run the (unscheduled) ticker — the test IS
    // the scheduler until Plan 11 wires pg-boss.
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(eq(workflowTimers.instanceId, instanceId));
    expect(await runDueTimers(db)).toBe(1);
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")));
    expect(await runDueTimers(db)).toBe(1);
    const breached = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breached).toHaveLength(1);
    const escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated).toHaveLength(1);
    expect((escalated[0]!.payload as { resolvedUserIds: string[] }).resolvedUserIds).toEqual([dmId]);

    // Transition with the allowed role; a permissioned user without the nurse role is denied 409.
    await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/transition`).set("Authorization", `Bearer ${adminToken}`)
      .send({ to: "in_progress" }).expect(409); // admin holds no 'nurse' role → role_denied
    const moved = await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/transition`).set("Authorization", `Bearer ${nurseToken}`)
      .send({ to: "in_progress", note: "picked up" }).expect(201);
    expect(moved.body).toEqual({ state: "in_progress", completed: false });

    const done = await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/transition`).set("Authorization", `Bearer ${nurseToken}`)
      .send({ to: "done" }).expect(201);
    expect(done.body).toEqual({ state: "done", completed: true });

    const detail = await request(app.getHttpServer())
      .get(`/workflow/instances/${instanceId}`).set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(detail.body.instance).toMatchObject({ status: "completed", currentState: "done" });
    expect(detail.body.transitions).toHaveLength(2);
    expect(detail.body.transitions[0].actorId).toBe(nurseId);
    expect(detail.body.openTimers).toHaveLength(0);
  });

  it("migrate to v2 and abort, both permission-gated and evented", async () => {
    const instanceId = await startInstanceViaApi();
    // activate v2 (admin drafts, activator activates — SoD)
    const activator2 = await createUser(db, { username: "activator2", fullName: "A2", password: "p1234567" });
    await assignRole(db, { userId: activator2.id, roleKey: "wf_admin", scopeType: "hospital" });
    const activator2Session = await createSession(db, cfg, activator2.id);
    const draft2 = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${adminToken}`)
      .send(DEF_V2).expect(201);
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${(draft2.body as { definitionId: string }).definitionId}/activate`)
      .set("Authorization", `Bearer ${activator2Session.token}`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/migrate`).set("Authorization", `Bearer ${nurseToken}`)
      .send({ stateMapping: { open: "received" }, reason: "def fix" })
      .expect(403); // nurse lacks workflow.instances.remediate

    const migrated = await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/migrate`).set("Authorization", `Bearer ${adminToken}`)
      .send({ stateMapping: { open: "received" }, reason: "def fix" })
      .expect(201);
    expect(migrated.body).toMatchObject({ toVersion: 2, state: "received" });

    await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/abort`).set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "test cleanup" })
      .expect(201);
    const aborted = await db.select().from(events).where(eq(events.name, "instance.aborted"));
    expect(aborted).toHaveLength(1);
    const migratedEvents = await db.select().from(events).where(eq(events.name, "instance.migrated"));
    expect(migratedEvents).toHaveLength(1);
  });
});
