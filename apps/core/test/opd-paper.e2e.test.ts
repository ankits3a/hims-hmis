import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { formularyManifest } from "../src/modules/formulary";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

const adultOk = { heightCm: 165, weightKg: 62, sbp: 118, dbp: 76, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 };
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString("base64");
const PARA = { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false };

/**
 * ═══ CONSULTED ON PAPER, OVER HTTP — OWNER RULING 2026-10-06 ═══
 *
 * The service suite (`modules/opd/paper-consult.test.ts`) executes every rule. What only a booted
 * application can show is the WIRING, and there are two pieces of it nothing else touches:
 *
 *   · the slip desk files through ANOTHER MODULE's route (`POST /patients/:id/documents`), and the
 *     visit is closed by a hook the OPD registers at module init. If that registration is ever
 *     dropped, every service test stays green and no photographed slip closes a visit again;
 *   · the three seats' routes carry three different grants on one controller.
 */
describe("consulted on paper — e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest, formularyManifest]) registry.install(m);

  let deptId: string;
  let roomId: string;
  let clerk: { id: string; token: string };
  let vitalsDesk: { id: string; token: string };
  let slipDesk: { id: string; token: string };
  let scribe: { id: string; token: string };
  let supervisor: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.DOCUMENT_STORE_PATH = mkdtempSync(join(tmpdir(), "hmis-paper-e2e-docs-"));
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
    const desk = ["opd.visits.read", "opd.visits.open", "opd.queue.read", "opd.vitals.record", "patients.register", "patients.read", "patients.update"];
    await mkRole("desk", desk);
    /* The production shapes of the two paper seats (`seed-roles.ts`), cut to what these routes read. */
    await mkRole("slip", ["opd.consult.paper", "opd.visits.read", "opd.queue.read", "patients.read", "patients.update"]);
    await mkRole("scribe", ["opd.prescription.transcribe", "opd.consult.paper", "opd.visits.read", "patients.read", "patients.update"]);
    await mkRole("sup", [...desk, "opd.queue.transfer"]);
    await mkRole("doc", ["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read"]);
    clerk = await mkUser(db, "clerk", ["desk", "front_office"]);
    vitalsDesk = await mkUser(db, "vd", ["desk", "vitals_desk"]);
    slipDesk = await mkUser(db, "slip", ["slip"]);
    scribe = await mkUser(db, "scribe", ["scribe"]);
    supervisor = await mkUser(db, "sup", ["sup", "front_office_supervisor"]);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());
  const waitingVisit = async (name: string, phone: string): Promise<{ patientId: string; encounterId: string }> => {
    const reg = await http().post("/patients").set(...auth(clerk.token))
      .send({ name, sex: "female", phone, ageYears: 30, acknowledgedDuplicates: true }).expect(201);
    const patientId = reg.body.patient.id as string;
    const open = await http().post("/opd/visits").set(...auth(clerk.token)).send({ patientId, departmentId: deptId, doctorId: dra.doctorId }).expect(201);
    const encounterId = open.body.encounter.id as string;
    await http().post(`/opd/visits/${encounterId}/vitals`).set(...auth(vitalsDesk.token)).send(adultOk).expect(201);
    return { patientId, encounterId };
  };
  const statusOf = async (encounterId: string): Promise<string> =>
    (await http().get(`/opd/visits/${encounterId}`).set(...auth(clerk.token)).expect(200)).body.encounter.status as string;
  const slip = (patientId: string, encounterId: string, token: string) =>
    http().post(`/patients/${patientId}/documents`).set(...auth(token))
      .send({ imageBase64: TINY_JPEG, mimeType: "image/jpeg", kind: "consult_prescription", encounterId });

  it("THE HOOK IS WIRED: a slip filed through the patients route closes the visit for the slip desk — and for nobody else", async () => {
    const a = await waitingVisit("Geeta Devi", "9000000001");
    /* The front desk holds `patients.update` and files a slip exactly as before. It closes nothing. */
    const byClerk = await slip(a.patientId, a.encounterId, clerk.token).expect(201);
    expect(byClerk.body.effects["opd.paper"]).toMatchObject({ outcome: "not_permitted", consulted: false });
    expect(await statusOf(a.encounterId)).toBe("waiting");

    const byDesk = await slip(a.patientId, a.encounterId, slipDesk.token).expect(201);
    expect(byDesk.body.documentId).toEqual(expect.any(String));
    expect(byDesk.body.effects["opd.paper"]).toMatchObject({ outcome: "marked", consulted: true, encounterId: a.encounterId });
    expect(await statusOf(a.encounterId)).toBe("completed");
    /* Off the doctor's line. */
    const serviceDate = (await http().get(`/opd/visits/${a.encounterId}`).set(...auth(clerk.token)).expect(200)).body.encounter.serviceDate as string;
    const queue = await http().get(`/opd/queues?doctorId=${dra.doctorId}&serviceDate=${serviceDate}`).set(...auth(dra.token)).expect(200);
    expect((queue.body.ordered as { encounterId: string }[]).map((q) => q.encounterId)).not.toContain(a.encounterId);
  });

  it("the three seats: the scribe types, the doctor looks, the supervisor reopens — each behind its own grant", async () => {
    const b = await waitingVisit("Vikash Kumar", "9000000002");

    /* The slip desk may close a visit; it may not type a prescription. */
    await http().post(`/opd/paper/visits/${b.encounterId}/transcription`).set(...auth(slipDesk.token)).send({ lines: [PARA] }).expect(403);
    const typed = await http().post(`/opd/paper/visits/${b.encounterId}/transcription`).set(...auth(scribe.token))
      .send({ lines: [PARA], advisedTests: [{ serviceId: "svc-cbc", code: "LAB-CBC", name: "Complete blood count", pricePaise: 25000 }] }).expect(201);
    expect(typed.body).toMatchObject({ paper: { outcome: "marked", consulted: true }, prescription: { version: 1, lineCount: 1 }, held: [] });
    expect(await statusOf(b.encounterId)).toBe("completed");
    /* The print of what was typed says it was typed, and by whom. */
    const print = await http().get(`/opd/prescriptions/${typed.body.prescription.prescriptionId as string}/print`).set(...auth(dra.token)).expect(200);
    expect(print.body.transcribedByName).toEqual(expect.any(String));

    /* The doctor's own list, and only a supervisor's eyes on the whole hospital's. */
    const mine = await http().get("/opd/paper/consults?scope=mine").set(...auth(dra.token)).expect(200);
    expect((mine.body.items as { encounterId: string }[]).map((r) => r.encounterId)).toEqual([b.encounterId]);
    expect(mine.body.items[0]).toMatchObject({ completedVia: "paper", evidenceKind: "transcription", confirmedAt: null });
    await http().get("/opd/paper/consults?scope=all").set(...auth(dra.token)).expect(403);
    await http().get("/opd/paper/consults?scope=all").set(...auth(supervisor.token)).expect(200);

    /* "Looks right" is the treating doctor's; a scribe holds no `opd.consult` and is stopped at the door. */
    await http().post(`/opd/paper/visits/${b.encounterId}/confirm`).set(...auth(scribe.token)).expect(403);
    const looked = await http().post(`/opd/paper/visits/${b.encounterId}/confirm`).set(...auth(dra.token)).expect(200);
    expect(looked.body.confirmedAt).toEqual(expect.any(String));

    /* Reopen: the supervisor's, with a reason; the doctor's grant does not open this door. */
    await http().post(`/opd/paper/visits/${b.encounterId}/reopen`).set(...auth(dra.token)).send({ reason: "wrong visit" }).expect(403);
    await http().post(`/opd/paper/visits/${b.encounterId}/reopen`).set(...auth(supervisor.token)).send({ reason: " " }).expect(400);
    await http().post(`/opd/paper/visits/${b.encounterId}/reopen`).set(...auth(supervisor.token)).send({ reason: "slip was typed on the wrong visit" }).expect(200);
    expect(await statusOf(b.encounterId)).toBe("waiting");
  });
  it("ask the desk to re-check: the doctor sends it back with a reason, it lands on the desk's list, and a look or a retype answers it", async () => {
    const c = await waitingVisit("Sanjay Mahto", "9000000003");
    await http().post(`/opd/paper/visits/${c.encounterId}/transcription`).set(...auth(scribe.token)).send({ lines: [PARA] }).expect(201);
    /* A photographed slip nobody has typed is counted for the desk's card — a count, and it goes when typed. */
    const d = await waitingVisit("Lalita Devi", "9000000004");
    await slip(d.patientId, d.encounterId, slipDesk.token).expect(201);
    /* Nothing sent back yet. */
    expect((await http().get("/opd/paper/sent-back").set(...auth(scribe.token)).expect(200)).body).toEqual({ items: [], toType: 1 });
    await http().post(`/opd/paper/visits/${d.encounterId}/transcription`).set(...auth(scribe.token)).send({ lines: [PARA] }).expect(201);
    expect((await http().get("/opd/paper/sent-back").set(...auth(scribe.token)).expect(200)).body.toType).toBe(0);
    /* The desk cannot send its own work back, a reason is required, and the doctor's list is not the desk's. */
    await http().post(`/opd/paper/visits/${c.encounterId}/recheck`).set(...auth(scribe.token)).send({ reason: "line 1" }).expect(403);
    await http().post(`/opd/paper/visits/${c.encounterId}/recheck`).set(...auth(dra.token)).send({ reason: "  " }).expect(409);
    await http().get("/opd/paper/sent-back").set(...auth(dra.token)).expect(403);

    const asked = await http().post(`/opd/paper/visits/${c.encounterId}/recheck`).set(...auth(dra.token)).send({ reason: "Line 1 — I wrote 650, not 500" }).expect(200);
    expect(asked.body.recheck).toMatchObject({ reason: "Line 1 — I wrote 650, not 500", doneAt: null });
    const back = await http().get("/opd/paper/sent-back").set(...auth(scribe.token)).expect(200);
    expect((back.body.items as { encounterId: string }[]).map((r) => r.encounterId)).toEqual([c.encounterId]);

    /* "I have looked again" answers it; a second answer has nothing to answer. */
    const done = await http().post(`/opd/paper/visits/${c.encounterId}/recheck-done`).set(...auth(scribe.token)).send({ note: "matches the paper — 500" }).expect(200);
    expect(done.body.recheck).toMatchObject({ doneNote: "matches the paper — 500" });
    expect(done.body.recheck.doneAt).toEqual(expect.any(String));
    await http().post(`/opd/paper/visits/${c.encounterId}/recheck-done`).set(...auth(scribe.token)).send({}).expect(409);
    expect((await http().get("/opd/paper/sent-back").set(...auth(scribe.token)).expect(200)).body.items).toEqual([]);

    /* Sent back again — and this time the desk RETYPES it: the save is the answer. */
    await http().post(`/opd/paper/visits/${c.encounterId}/recheck`).set(...auth(dra.token)).send({ reason: "still wrong" }).expect(200);
    await http().post(`/opd/paper/visits/${c.encounterId}/transcription`).set(...auth(scribe.token)).send({ lines: [{ ...PARA, dose: "650 mg" }] }).expect(201);
    expect((await http().get("/opd/paper/sent-back").set(...auth(scribe.token)).expect(200)).body.items).toEqual([]);
    const mine = await http().get("/opd/paper/consults?scope=mine").set(...auth(dra.token)).expect(200);
    expect((mine.body.items as { encounterId: string; recheck: { doneAt: string } | null }[]).find((r) => r.encounterId === c.encounterId)!.recheck!.doneAt).toEqual(expect.any(String));
  });
});
