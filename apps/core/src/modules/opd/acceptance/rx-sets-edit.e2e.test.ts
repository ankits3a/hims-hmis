import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { newId } from "@hmis/contracts";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { createRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { orgDepartments, roles, rosterTeamMemberships, rosterTeams } from "../../../kernel/db/schema";
import { requireEnv } from "../../../kernel/config";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkDoctor, seedOpdBase, seedOpdMasters } from "../../../../test/helpers/opd";
import { ROSTER_POSITIONS, seedRosterPositions } from "../../roster";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../../../kernel/db/client";

/**
 * ═══ #610 — EDIT A SAVED SET: THE OWNER'S "DONE MEANS" ═══
 *
 * Spec /opt/hmis-context/SPEC-consult-sets-edit-2026-10-10.md, approved by the owner 2026-10-10. LOCKED
 * once merged: add new checks, never edit one.
 *   - Edit own set: change one medicine and the name, save, reopen: the change is there.
 *   - Another doctor's set: the route refuses with 403.
 *   - A head edits a department set; a non-head cannot.
 * (The phone's half — no Edit on a set the doctor cannot edit — is the phone suite's.)
 */
jest.setTimeout(120_000);

describe("#610 — edit a saved prescription set (acceptance)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  type Doc = Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dra: Doc;
  let drb: Doc;
  let drc: Doc;

  const http = () => request(app.getHttpServer());
  const as = (d: Doc) => ["Authorization", `Bearer ${d.token}`] as const;
  const PARA = { drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", medicineId: null };
  const CET = { drug: "Cetirizine 10 mg Tablet", dose: "1 tab", route: "oral", frequency: "HS", durationDays: 5, instructions: null, medicineId: null };
  const body = (lines: unknown[]) => ({ lines, tests: [], advice: "Plenty of fluids", reviewDays: 5 });
  const list = async (d: Doc) => (await http().get("/opd/rx-sets").set(...as(d)).expect(200)).body.items as { id: string; name: string; body: { lines: { drug: string }[] }; signed: boolean }[];

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
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    let roomId: string;
    ({ deptId, roomId } = await seedOpdMasters(db));
    await createRole(db, "doctor", "Doctor");
    await grantPermissionToRole(db, registry, "doctor", "opd.consult");
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId });
    drc = await mkDoctor(db, { username: "drc", departmentId: deptId, roomId });
  });

  /** `userId` becomes the unit head of the OPD department's unit (roster `role_in_team = 'head'`). */
  async function makeHead(userId: string): Promise<void> {
    const org = newId();
    await db.insert(orgDepartments).values({ id: org, code: "MED", name: "General Medicine", kind: "clinical", admitting: true, opdDepartmentId: deptId, createdBy: "t", updatedBy: "t" });
    for (const key of ["duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
    await seedRosterPositions(db);
    await db.insert(rosterTeams).values({ id: "t-u1", kind: "clinical_unit", departmentId: org, code: "MED-U1", name: "Unit I", active: true, createdBy: "t", updatedBy: "t" } as never);
    await db.insert(rosterTeamMemberships).values({
      id: newId(), teamId: "t-u1", userId, positionKey: ROSTER_POSITIONS[0]!.key, grade: "assistant_professor", roleInTeam: "head",
      startsAt: new Date(Date.now() - 86_400_000), createdBy: "t", updatedBy: "t",
    } as never);
  }

  it("edit own set: change one medicine and the name, save, reopen — the change is there", async () => {
    const { setId } = (await http().post("/opd/rx-sets").set(...as(dra)).send({ scope: "doctor", name: "Viral fever", body: body([PARA]) }).expect(201)).body;
    await http().put(`/opd/rx-sets/${setId as string}`).set(...as(dra)).send({ name: "Viral fever — adult", body: body([CET]) }).expect(200);
    const mine = await list(dra);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(setId);
    expect(mine[0]!.name).toBe("Viral fever — adult");
    expect(mine[0]!.body.lines.map((l) => l.drug)).toEqual(["Cetirizine 10 mg Tablet"]);
  });

  it("another doctor's set: the route refuses with 403 and the set is unchanged", async () => {
    const { setId } = (await http().post("/opd/rx-sets").set(...as(dra)).send({ scope: "doctor", name: "Viral fever", body: body([PARA]) }).expect(201)).body;
    const res = await http().put(`/opd/rx-sets/${setId as string}`).set(...as(drb)).send({ name: "Mine now", body: body([CET]) });
    expect(res.status).toBe(403);
    const mine = await list(dra);
    expect(mine.map((s) => [s.name, s.body.lines.map((l) => l.drug)])).toEqual([["Viral fever", ["Paracetamol 500 mg Tablet"]]]);
  });

  it("a head edits a department set; a non-head cannot", async () => {
    await makeHead(dra.userId);
    const { setId } = (await http().post("/opd/rx-sets").set(...as(dra)).send({ scope: "department", name: "URTI — adult", body: body([PARA]) }).expect(201)).body;
    await http().post(`/opd/rx-sets/${setId as string}/sign`).set(...as(dra)).expect(201);
    expect((await list(drc)).map((s) => s.name)).toEqual(["URTI — adult"]);

    // A doctor of the department who is not its head (and did not draft it): refused.
    const res = await http().put(`/opd/rx-sets/${setId as string}`).set(...as(drc)).send({ name: "URTI", body: body([CET]) });
    expect(res.status).toBe(403);
    expect((await list(drc)).map((s) => [s.name, s.body.lines.map((l) => l.drug)])).toEqual([["URTI — adult", ["Paracetamol 500 mg Tablet"]]]);

    // The head: saved; the edit needs re-signing before doctors see it again.
    await http().put(`/opd/rx-sets/${setId as string}`).set(...as(dra)).send({ name: "URTI — adult", body: body([PARA, CET]) }).expect(200);
    const head = (await list(dra)).find((s) => s.id === setId)!;
    expect(head.body.lines.map((l) => l.drug)).toEqual(["Paracetamol 500 mg Tablet", "Cetirizine 10 mg Tablet"]);
    expect(head.signed).toBe(false);
    expect(await list(drc)).toEqual([]);
  });
});
