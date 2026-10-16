import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { tariffManifest } from "../src/modules/tariff";
import { opdManifest } from "../src/modules/opd";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

const adultOk = { heightCm: 165, weightKg: 62, sbp: 118, dbp: 76, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 };

/**
 * ═══ #660 — THE OPD DESK'S DEPARTMENT LINE, OVER HTTP ═══
 *
 * The service suite (`modules/opd/queue.test.ts`) pins that `departmentQueue` answers each doctor's
 * line exactly as `listQueue` does. What only a booted application can show is the route's wiring:
 * the grant it sits behind (the same `opd.queue.read` the per-doctor read uses) and the money rule
 * (`fee-view.ts`) applied per caller — so a caller gets from the department read exactly the rows
 * the per-doctor read gives that same caller, no more.
 */
describe("GET /opd/departments/:id/queue — e2e (#660)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest]) registry.install(m);

  let deptId: string;
  let dept2Id: string;
  let roomId: string;
  let room2Id: string;
  let clerk: { id: string; token: string };
  let vitalsDesk: { id: string; token: string };
  let outsider: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };
  let drb: { doctorId: string; userId: string; token: string };

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
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, dept2Id, roomId, room2Id } = await seedOpdMasters(db));
    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    await mkRole("desk", ["opd.visits.read", "opd.visits.open", "opd.queue.read", "opd.vitals.record", "patients.register", "patients.read", "patients.update"]);
    await mkRole("doc", ["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read"]);
    await mkRole("reader", ["patients.read"]);
    clerk = await mkUser(db, "clerk", ["desk", "front_office"]);
    vitalsDesk = await mkUser(db, "vd", ["desk", "vitals_desk"]);
    outsider = await mkUser(db, "outsider", ["reader"]);
    const allWeek = [0, 1, 2, 3, 4, 5, 6];
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: allWeek });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id, weekdays: allWeek });
    await mkDoctor(db, { username: "drp", departmentId: dept2Id, roomId: room2Id, weekdays: allWeek });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());
  const waitingVisit = async (name: string, phone: string, doctorId: string): Promise<string> => {
    const reg = await http().post("/patients").set(...auth(clerk.token))
      .send({ name, sex: "female", phone, ageYears: 30, acknowledgedDuplicates: true }).expect(201);
    const open = await http().post("/opd/visits").set(...auth(clerk.token))
      .send({ patientId: reg.body.patient.id as string, departmentId: deptId, doctorId }).expect(201);
    const encounterId = open.body.encounter.id as string;
    await http().post(`/opd/visits/${encounterId}/vitals`).set(...auth(vitalsDesk.token)).send(adultOk).expect(201);
    return encounterId;
  };

  it("answers every doctor of the department in one read, each line exactly the per-doctor read's rows for the same caller", async () => {
    const e1 = await waitingVisit("Test Patient One", "9000000001", dra.doctorId);
    const e2 = await waitingVisit("Test Patient Two", "9000000002", dra.doctorId);
    const e3 = await waitingVisit("Test Patient Three", "9000000003", drb.doctorId);

    for (const caller of [clerk.token, dra.token]) {
      const res = await http().get(`/opd/departments/${deptId}/queue`).set(...auth(caller)).expect(200);
      expect(res.body.departmentId).toBe(deptId);
      const ids = (res.body.doctors as { doctor: { id: string } }[]).map((d) => d.doctor.id).sort();
      expect(ids).toEqual([dra.doctorId, drb.doctorId].sort());
      for (const row of res.body.doctors as { doctor: { id: string }; queue: unknown }[]) {
        const one = await http().get(`/opd/queues?doctorId=${row.doctor.id}`).set(...auth(caller)).expect(200);
        expect(row.queue).toEqual(one.body);
      }
      const lineA = (res.body.doctors as { doctor: { id: string }; queue: { ordered: { encounterId: string }[] } }[])
        .find((d) => d.doctor.id === dra.doctorId)!.queue.ordered.map((e) => e.encounterId);
      expect(lineA.sort()).toEqual([e1, e2].sort());
      const lineB = (res.body.doctors as { doctor: { id: string }; queue: { ordered: { encounterId: string }[] } }[])
        .find((d) => d.doctor.id === drb.doctorId)!.queue.ordered.map((e) => e.encounterId);
      expect(lineB).toEqual([e3]);
    }

    // The doctor's copy carries no money key (owner 2026-10-09); the desk's keeps its stamp key.
    const docView = await http().get(`/opd/departments/${deptId}/queue`).set(...auth(dra.token)).expect(200);
    const docRow = docView.body.doctors.find((d: { doctor: { id: string } }) => d.doctor.id === dra.doctorId).queue.ordered[0];
    expect(Object.keys(docRow)).not.toContain("feeStatus");
    const deskView = await http().get(`/opd/departments/${deptId}/queue`).set(...auth(clerk.token)).expect(200);
    const deskRow = deskView.body.doctors.find((d: { doctor: { id: string } }) => d.doctor.id === dra.doctorId).queue.ordered[0];
    expect(Object.keys(deskRow)).toContain("feeStatus");
  });

  it("sits behind opd.queue.read like the per-doctor read, and an unknown department is a 404", async () => {
    await http().get(`/opd/departments/${deptId}/queue`).set(...auth(outsider.token)).expect(403);
    await http().get(`/opd/queues?doctorId=${dra.doctorId}`).set(...auth(outsider.token)).expect(403);
    await http().get("/opd/departments/no-such-department/queue").set(...auth(clerk.token)).expect(404);
    const none = await http().get(`/opd/departments/${deptId}/queue`).set(...auth(clerk.token)).expect(200);
    expect(none.body.doctors.every((d: { queue: unknown; sessionId: unknown }) => d.sessionId === null && d.queue === null)).toBe(true);
  });
});
