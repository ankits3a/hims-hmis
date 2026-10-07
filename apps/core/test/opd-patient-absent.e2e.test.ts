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

/**
 * ═══ THE GUARDIAN CAME WITH THE REPORTS, OVER HTTP — OWNER 2026-10-07 ═══
 *
 * The service suite (`modules/opd/patient-absent.test.ts`) executes every rule. What only a booted
 * application shows is the route's door — two grants on one route, through `alsoAdmits` — the body's
 * shape, and the mark reaching the read the consultation screen makes (`GET /opd/visits/:id`).
 */
describe("patient absent — e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest]) registry.install(m);

  let deptId: string;
  let roomId: string;
  let clerk: { id: string; token: string };
  let bay: { id: string; token: string };
  let reader: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };

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
    ({ deptId, roomId } = await seedOpdMasters(db));
    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    /* The front desk WITHOUT the bay's grant, the bay WITHOUT the desk's, and a reader with neither. */
    await mkRole("desk", ["opd.visits.read", "opd.visits.open", "opd.queue.read", "patients.register", "patients.read"]);
    await mkRole("bay", ["opd.visits.read", "opd.vitals.record", "opd.queue.read", "patients.read"]);
    await mkRole("readonly", ["opd.visits.read", "opd.queue.read", "patients.read"]);
    await mkRole("doc", ["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read"]);
    clerk = await mkUser(db, "clerk", ["desk", "front_office"]);
    bay = await mkUser(db, "bay", ["bay", "vitals_desk"]);
    reader = await mkUser(db, "reader", ["readonly"]);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());
  const visit = async (name: string, phone: string, kind: "new" | "revisit" | "renewal"): Promise<string> => {
    const reg = await http().post("/patients").set(...auth(clerk.token))
      .send({ name, sex: "male", phone, ageYears: 60, acknowledgedDuplicates: true }).expect(201);
    const open = await http().post("/opd/visits").set(...auth(clerk.token))
      .send({ patientId: reg.body.patient.id as string, departmentId: deptId, doctorId: dra.doctorId }).expect(201);
    const encounterId = open.body.encounter.id as string;
    if (kind !== "new") {
      await http().post(`/opd/visits/${encounterId}/reclassify`).set(...auth(clerk.token))
        .send({ visitType: kind, reason: "seen last month" }).expect(201);
    }
    return encounterId;
  };
  const absent = (encounterId: string, token: string, body: unknown) =>
    http().post(`/opd/visits/${encounterId}/patient-absent`).set(...auth(token)).send(body as object);

  it("either seat's grant admits; a reader is refused at the door; a bad body is 400; a renewal is admitted; a new visit is 409", async () => {
    const a = await visit("Suresh Prasad", "9000000101", "revisit");
    await absent(a, reader.token, { relation: "father" }).expect(403);
    await absent(a, bay.token, { relation: "neighbour" }).expect(400);
    const marked = await absent(a, bay.token, { relation: "father", name: "Ramesh" }).expect(201);
    expect(marked.body).toMatchObject({ alreadyMarked: false, patientAbsent: { relation: "father", name: "Ramesh", by: bay.id } });

    /* The consultation screen's read carries the mark. */
    const read = await http().get(`/opd/visits/${a}`).set(...auth(dra.token)).expect(200);
    expect(read.body.encounter.status).toBe("waiting");
    expect(read.body.patientAbsent).toMatchObject({ relation: "father", name: "Ramesh", by: bay.id, at: expect.any(String) });

    const b = await visit("Mohan Lal", "9000000102", "renewal");
    await absent(b, clerk.token, { relation: "attendant" }).expect(201);

    const c = await visit("Ravi Kumar", "9000000103", "new");
    const refused = await absent(c, clerk.token, { relation: "son" }).expect(409);
    expect(refused.body.code).toBe("patient_absent_returning_only");
    const plain = await http().get(`/opd/visits/${c}`).set(...auth(clerk.token)).expect(200);
    expect(plain.body.patientAbsent).toBeNull();
  });
});
