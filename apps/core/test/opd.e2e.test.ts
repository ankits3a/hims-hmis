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
import { OPD_VISIT_DEFINITION_JSON, opdManifest } from "../src/modules/opd";
import { formularyManifest } from "../src/modules/formulary";
import { addDays, istDate } from "../src/modules/opd/time";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/** A complete, in-range adult reading — every field the adult band requires, no danger flag. */
const adultOk = { heightCm: 165, weightKg: 62, sbp: 118, dbp: 76, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 };
const penicillinLine = {
  drug: "Tab Penicillin V", dose: "500 mg", route: "oral", frequency: "TDS",
  durationDays: 5, instructions: null, noSubstitution: false,
};
/** The exact public shape of a board item — the "no identity on the board" proof (§11.5). */
const BOARD_ITEM_KEYS = [
  "departmentName", "doctorId", "doctorName", "next", "nowServing",
  "roomCode", "roomId", "sessionId", "status", "waitingCount",
];

describe("opd e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  registry.install(tariffManifest);
  registry.install(opdManifest);
  // PLAN 16a T5 — this suite grants `formulary.*` to a curator role, and `grantPermissionToRole`
  // refuses any string no INSTALLED manifest declares (spec §4). The refusal is the point: it is
  // what stops a permission being invented in a test that no module actually publishes.
  registry.install(formularyManifest);

  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let clerk: { id: string; token: string };
  let vitalsDesk: { id: string; token: string };
  let supervisor: { id: string; token: string };
  let flowHolder: { id: string; token: string };
  let display: { id: string; token: string };
  let pharmacy: { id: string; token: string };
  let formularyAdmin: { id: string; token: string };
  let rando: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };
  let drb: { doctorId: string; userId: string; token: string };

  beforeAll(async () => {
    // setupTestDb FIRST: it creates and MIGRATES this worker's database, and AppModule's realtime
    // tail reads `select max(seq) from events` at boot — compiling against an unmigrated database
    // fails there. Then the per-worker DATABASE_URL, and only then the module compile.
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Single-argument overload: TestingModule treats a first argument that is not an HTTP
    // adapter AS the options bag, so passing `undefined` first would silently drop them.
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
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));

    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    // patients.update is what POST /patients/:id/allergies requires (test 3 records the allergy over HTTP).
    const deskPermissions = [
      "opd.appointments.read", "opd.appointments.manage", "opd.visits.read", "opd.visits.open",
      "opd.queue.read", "opd.vitals.record", "patients.register", "patients.read", "patients.update",
    ];
    await mkRole("desk", deskPermissions);
    // `formulary.read` mirrors DD10's production grant: a prescriber reads the formulary (the
    // consult autocomplete needs it) and curates nothing. The 403 leg below is what pins the second
    // half of that sentence.
    await mkRole("doc", [
      "opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read", "formulary.read",
    ]);
    await mkRole("sup", [...deskPermissions, "opd.queue.transfer", "opd.masters.read", "opd.masters.manage", "opd.config.manage"]);
    // RC-1 T2 — a holder of ONLY the flow lock, to pin the narrowness in both directions.
    await mkRole("flow", ["opd.counter.flow.manage"]);
    await mkRole("disp", ["opd.display.read"]);
    await mkRole("pharm", ["opd.prescriptions.verify"]);
    // PLAN 16a T5 — the formulary is curated at the pharmacy (DD10), and this e2e curates it over
    // HTTP rather than by inserting rows: the point of the test is that the whole path works.
    await mkRole("formulary_admin", ["formulary.read", "formulary.manage"]);

    clerk = await mkUser(db, "clerk", ["desk", "front_office"]);
    vitalsDesk = await mkUser(db, "vd", ["desk", "vitals_desk"]);
    supervisor = await mkUser(db, "sup", ["sup", "front_office_supervisor"]);
    flowHolder = await mkUser(db, "flowsup", ["flow"]);
    display = await mkUser(db, "disp", ["disp"]);
    pharmacy = await mkUser(db, "pharm", ["pharm"]);
    formularyAdmin = await mkUser(db, "formadmin", ["formulary_admin"]);
    rando = await mkUser(db, "rando", []);
    // Every weekday, so the suite is not calendar-dependent: the doctor is always scheduled today.
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: drb.userId, roleKey: "doc", scopeType: "hospital" });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  /** Register a patient over HTTP and return its id. */
  const registerPatientOverHttp = async (name: string, phone: string): Promise<string> => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerk.token))
      .send({ name, sex: "female", phone, ageYears: 30 }).expect(201);
    return reg.body.patient.id as string;
  };

  /** Walk-in open → vitals → the doctor's call. Returns the ids every later leg needs. */
  const openAndSeat = async (patientId: string): Promise<{ encounterId: string; sessionId: string; serviceDate: string }> => {
    const open = await request(app.getHttpServer())
      .post("/opd/visits").set(...auth(clerk.token))
      .send({ patientId, departmentId: deptId, doctorId: dra.doctorId }).expect(201);
    const encounterId = open.body.encounter.id as string;
    await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/vitals`).set(...auth(vitalsDesk.token)).send(adultOk).expect(201);
    return { encounterId, sessionId: open.body.sessionId as string, serviceDate: open.body.encounter.serviceDate as string };
  };

  it("auth and permission edges, and the definition JSON is served verbatim", async () => {
    await request(app.getHttpServer()).get("/opd/queues/summary").expect(401);
    await request(app.getHttpServer()).get("/opd/queues/summary").set(...auth(rando.token)).expect(403);
    await request(app.getHttpServer())
      .post("/opd/visits").set(...auth(display.token))
      .send({ patientId: "01NOSUCH00000000000000000", departmentId: deptId, doctorId: dra.doctorId })
      .expect(403);
    const def = await request(app.getHttpServer())
      .get("/opd/definition").set(...auth(supervisor.token)).expect(200);
    expect(def.body).toEqual(OPD_VISIT_DEFINITION_JSON);
  });

  it("the walk-in flow: open → vitals → call → consult → complete → timeline", async () => {
    const patientId = await registerPatientOverHttp("Asha Devi", "9876543210");

    const open = await request(app.getHttpServer())
      .post("/opd/visits").set(...auth(clerk.token))
      .send({ patientId, departmentId: deptId, doctorId: dra.doctorId }).expect(201);
    expect(open.body.encounter.status).toBe("registered");
    expect(open.body.encounter.visitType).toBe("new");
    expect(open.body.tokenNo).toBe(1);
    expect(open.body.roomId).toBe(roomId);
    expect(open.body.doctorScheduledToday).toBe(true);
    const encounterId = open.body.encounter.id as string;
    const sessionId = open.body.sessionId as string;
    const serviceDate = open.body.encounter.serviceDate as string;

    const before = await request(app.getHttpServer())
      .get("/opd/queues").query({ doctorId: dra.doctorId, serviceDate }).set(...auth(clerk.token)).expect(200);
    expect(before.body.waitingVitals).toBe(1);
    expect(before.body.ordered).toEqual([]);

    const vitals = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/vitals`).set(...auth(vitalsDesk.token)).send(adultOk).expect(201);
    expect(vitals.body.flags).toEqual([]);
    expect(vitals.body.encounter.status).toBe("waiting");

    const after = await request(app.getHttpServer())
      .get("/opd/queues").query({ doctorId: dra.doctorId, serviceDate }).set(...auth(clerk.token)).expect(200);
    expect(after.body.ordered[0].tokenNo).toBe(1);
    expect(typeof after.body.ordered[0].patient.uhid).toBe("string");

    const called = await request(app.getHttpServer())
      .post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    expect(called.body.entry.status).toBe("called");
    expect(called.body.entry.tokenNo).toBe(1);

    const started = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    expect(started.body.encounter.status).toBe("in_consultation");

    await request(app.getHttpServer())
      .put(`/opd/visits/${encounterId}/consult/note`).set(...auth(dra.token))
      .send({ diagnosis: "Acute pharyngitis", icd10Code: "J02.9" }).expect(200);

    const completed = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: false }).expect(201);
    expect(completed.body.encounter.status).toBe("completed");
    expect(completed.body.encounter.followUpDays).toBe(7);

    const timeline = await request(app.getHttpServer())
      .get(`/opd/patients/${patientId}/timeline`).set(...auth(clerk.token)).expect(200);
    expect(timeline.body.items).toHaveLength(1);
    expect(timeline.body.items[0].doctorName).toBe("Dr dra");
    expect(timeline.body.items[0].icd10Code).toBe("J02.9");
  });

  it("the e-Rx: the allergy hard-warning body, the reasoned override, print and pharmacy verify", async () => {
    const patientId = await registerPatientOverHttp("Rina Kumari", "9876543211");
    await request(app.getHttpServer())
      .post(`/patients/${patientId}/allergies`).set(...auth(clerk.token))
      .send({ substance: "Penicillin", source: "registration" }).expect(201);

    const { encounterId, sessionId } = await openAndSeat(patientId);
    await request(app.getHttpServer()).post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    await request(app.getHttpServer()).post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);

    const conflict = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({ lines: [penicillinLine] }).expect(409);
    expect(conflict.body.statusCode).toBe(409);
    expect(conflict.body.code).toBe("allergy_conflict");
    expect(conflict.body.detail.matches).toEqual([{ lineIndex: 0, substance: "Penicillin" }]);

    const issued = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({
        lines: [penicillinLine],
        overrides: [{ lineIndex: 0, substance: "Penicillin", reason: "tolerated in 2024" }],
      }).expect(201);
    expect(issued.body.version).toBe(1);
    expect(issued.body.allergyOverrideCount).toBe(1);
    expect(typeof issued.body.qrPayload).toBe("string");

    const print = await request(app.getHttpServer())
      .get(`/opd/prescriptions/${issued.body.prescriptionId}/print`).set(...auth(dra.token)).expect(200);
    expect(print.body.letterhead.name).toBe("CRK MEDICAL COLLEGE & HOSPITAL");
    expect(print.body.lines).toHaveLength(1);
    expect(print.body.qrPayload).toBe(issued.body.qrPayload);

    const ok = await request(app.getHttpServer())
      .post("/opd/prescriptions/verify").set(...auth(pharmacy.token))
      .send({ payload: issued.body.qrPayload }).expect(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.doctor.displayName).toBe("Dr dra");

    const payload = issued.body.qrPayload as string;
    const tampered = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
    const bad = await request(app.getHttpServer())
      .post("/opd/prescriptions/verify").set(...auth(pharmacy.token)).send({ payload: tampered }).expect(200);
    expect(bad.body).toEqual({ ok: false, reason: "invalid_signature" });
  });

  /**
   * PLAN 16a T5 — the formulary safety layer, end to end over HTTP.
   *
   * It curates the formulary through the pharmacist's own routes, pre-checks as the consult screen
   * will, gets refused, and then issues with a reasoned override — the whole loop, with no function
   * called directly. What it proves that the unit legs cannot: the refusal reaches the client as a
   * 409 carrying its hits (not a 400 and not a 500), and the pre-check needs no write permission.
   */
  it("the formulary safety layer: curate, pre-check, refuse, override (16a)", async () => {
    const salt = async (name: string, drugClass: string | null): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post("/formulary/salts").set(...auth(formularyAdmin.token))
        .send({ name, drugClass }).expect(201);
      return res.body.saltId as string;
    };
    const medicine = async (brandName: string, saltId: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post("/formulary/medicines").set(...auth(formularyAdmin.token))
        .send({ brandName, form: "tablet", routeClass: "systemic", salts: [{ saltId }] }).expect(201);
      return res.body.medicineId as string;
    };
    const warfarin = await salt("warfarin", null);
    const aspirin = await salt("aspirin", "nsaid");
    await request(app.getHttpServer())
      .post("/formulary/interactions").set(...auth(formularyAdmin.token))
      .send({
        saltAId: warfarin, saltBId: aspirin, severity: "severe",
        note: "bleeding risk — avoid or monitor INR closely", source: "seed-2026-08",
      }).expect(201);
    const warfMed = await medicine("Warf 5", warfarin);
    const asaMed = await medicine("Ecosprin 75", aspirin);

    // A doctor may READ the formulary — the autocomplete needs it — and may not curate it.
    await request(app.getHttpServer()).get("/formulary/medicines").set(...auth(dra.token)).expect(200);
    await request(app.getHttpServer())
      .post("/formulary/salts").set(...auth(dra.token)).send({ name: "invented" }).expect(403);

    const patientId = await registerPatientOverHttp("Meena Bai", "9876543219");
    const { encounterId, sessionId } = await openAndSeat(patientId);
    await request(app.getHttpServer()).post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    await request(app.getHttpServer()).post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);

    const line = (drug: string, medicineId: string): Record<string, unknown> => ({
      drug, dose: "1 tab", route: "oral", frequency: "OD", durationDays: 5,
      instructions: null, noSubstitution: false, medicineId,
    });
    const lines = [line("Warf 5", warfMed), line("Ecosprin 75", asaMed)];

    // The pre-check: the screen sees the hit before the doctor presses submit, and nothing is written.
    const pre = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/rx-precheck`).set(...auth(dra.token))
      .send({ lines }).expect(201);
    expect(pre.body.interactions).toHaveLength(1);
    expect(pre.body.interactions[0].severity).toBe("severe");
    expect(pre.body.notices).toEqual([]);
    expect((await request(app.getHttpServer())
      .get(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token)).expect(200)).body.items).toHaveLength(0);

    // The refusal: 409 with its hits, in `allergy_conflict`'s exact grammar (DD3).
    const conflict = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({ lines }).expect(409);
    expect(conflict.body.code).toBe("interaction_conflict");
    expect(conflict.body.detail.hits).toHaveLength(1);
    expect(conflict.body.detail.hits[0].note).toBe("bleeding risk — avoid or monitor INR closely");

    /**
     * TWO DIFFERENT REFUSALS, and the close review (C5) is why they are now distinguishable.
     *
     * An override that names no pair clears NOTHING — so the severe hit is still uncovered and the
     * answer is `interaction_conflict`, not a complaint about the reason. That is the fail-safe
     * direction: a client that forgets the identity sees the warning again rather than slipping an
     * unexamined override past the gate.
     */
    const noIdentity = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({ lines, interactionOverrides: [{ lineIndex: 1, reason: "ok" }] }).expect(409);
    expect(noIdentity.body.code).toBe("interaction_conflict");

    /**
     * With the pair named, the override MATCHES — and now the reason gate is what answers. 400, not
     * 409, and that is the SHIPPED mapping for `override_reason_required`: a malformed request
     * (the reason is too short), not a state conflict.
     */
    const saltPair = pre.body.interactions[0].saltPair as [string, string];
    const shortReason = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({ lines, interactionOverrides: [{ lineIndex: 1, reason: "ok", saltPair }] }).expect(400);
    expect(shortReason.body.code).toBe("override_reason_required");

    const issued = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({
        lines,
        interactionOverrides: [{ lineIndex: 1, reason: "cardiology advised dual therapy, INR weekly", saltPair }],
      }).expect(201);
    expect(issued.body.interactionOverrideCount).toBe(1);
    expect(issued.body.allergyOverrideCount).toBe(0);
    expect(issued.body.notices).toEqual([]);
  });

  it("the desk's error contract: every refusal carries its OPD code", async () => {
    const patientId = await registerPatientOverHttp("Sita Devi", "9876543212");
    const { encounterId, sessionId } = await openAndSeat(patientId);

    const noReason = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/abandon`).set(...auth(clerk.token)).send({ reason: "" }).expect(400);
    expect(noReason.body.code).toBe("reason_required");

    await request(app.getHttpServer()).post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    const secondCall = await request(app.getHttpServer())
      .post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(409);
    expect(secondCall.body.code).toBe("call_conflict");

    await request(app.getHttpServer()).post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: false }).expect(201);
    const secondComplete = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: false }).expect(409);
    expect(secondComplete.body.code).toBe("encounter_state_conflict");

    const implausible = await request(app.getHttpServer())
      .post(`/opd/visits/${encounterId}/vitals`).set(...auth(vitalsDesk.token)).send({ spo2: 101 }).expect(400);
    expect(implausible.body.code).toBe("invalid_vitals");

    const unknown = await request(app.getHttpServer())
      .get("/opd/visits/01NOSUCH00000000000000000").set(...auth(clerk.token)).expect(404);
    expect(unknown.body.code).toBe("unknown_encounter");

    const badConfig = await request(app.getHttpServer())
      .put("/opd/config").set(...auth(supervisor.token))
      .send({ dangerRanges: { weightRequiredUnderYears: 18, bands: [{ key: "adult", upToAgeYears: 13, required: [], ranges: {} }] } })
      .expect(400);
    expect(badConfig.body.code).toBe("invalid_config");

    const goodConfig = await request(app.getHttpServer())
      .put("/opd/config").set(...auth(supervisor.token)).send({ slotMinutes: 15 }).expect(200);
    expect(goodConfig.body.slotMinutes).toBe(15);
    const read = await request(app.getHttpServer())
      .get("/opd/config").set(...auth(supervisor.token)).expect(200);
    expect(read.body.slotMinutes).toBe(15);
    await request(app.getHttpServer())
      .put("/opd/config").set(...auth(clerk.token)).send({ slotMinutes: 20 }).expect(403);
  });

  /*
   * RC-1 T2 / D5 — the flow lock is NARROWER than `opd.config.manage`, pinned in BOTH directions
   * by execution: the config admin is refused on the pill, the pill holder is refused on the
   * config, and the pill's body cannot reach any other config key no matter what it carries.
   * A guard decorated with the broad permission instead of the narrow one inverts the first leg
   * (200 where 403 is asserted) — the mutant-shaped assertion, inline (18a precedent, disclosed).
   */
  it("RC-1 T2: the counter-flow lock — narrow permission, narrow body, defaults are today's behaviour", async () => {
    const read = await request(app.getHttpServer())
      .get("/opd/config").set(...auth(supervisor.token)).expect(200);
    expect(read.body.counterSequence).toBe("queue_first"); // the migration default IS the shipped behaviour
    expect(read.body.tokenLane).toBe("token_first");

    // Direction 1: `opd.config.manage` alone does NOT reach the pill…
    const refusedBroad = await request(app.getHttpServer())
      .put("/opd/config/counter-flow").set(...auth(supervisor.token))
      .send({ counterSequence: "bill_first" }).expect(403);
    expect(refusedBroad.body.message).toContain("opd.counter.flow.manage");
    // …and the desk clerk certainly does not.
    await request(app.getHttpServer())
      .put("/opd/config/counter-flow").set(...auth(clerk.token))
      .send({ counterSequence: "bill_first" }).expect(403);

    // The holder flips the pill; the body's stray keys are STRIPPED, not applied.
    const flipped = await request(app.getHttpServer())
      .put("/opd/config/counter-flow").set(...auth(flowHolder.token))
      .send({ counterSequence: "bill_first", tokenLane: "token_on_payment", slotMinutes: 55 }).expect(200);
    expect(flipped.body.counterSequence).toBe("bill_first");
    expect(flipped.body.tokenLane).toBe("token_on_payment");
    expect(flipped.body.slotMinutes).toBe(10); // untouched — the narrow body cannot carry it

    // An unknown sequence is refused 400 (the OPD controllers' zod refusals ride Nest's default
    // BadRequest shape, not a module code) and the stored row is unchanged.
    await request(app.getHttpServer())
      .put("/opd/config/counter-flow").set(...auth(flowHolder.token))
      .send({ counterSequence: "single_window" }).expect(400);
    const after = await request(app.getHttpServer())
      .get("/opd/config").set(...auth(supervisor.token)).expect(200);
    expect(after.body.counterSequence).toBe("bill_first");

    // Direction 2: the pill holder is refused on the full config editor.
    const refusedNarrow = await request(app.getHttpServer())
      .put("/opd/config").set(...auth(flowHolder.token)).send({ slotMinutes: 20 }).expect(403);
    expect(refusedNarrow.body.message).toContain("opd.config.manage");

    // D7 — the wait-v0 pace knob: defaults to 6, edited where departments are, served on the list.
    await request(app.getHttpServer())
      .patch(`/opd/departments/${deptId}`).set(...auth(supervisor.token))
      .send({ avgConsultMinutes: 9 }).expect(200);
    const depts = await request(app.getHttpServer())
      .get("/opd/departments").set(...auth(supervisor.token)).expect(200);
    const dept = depts.body.items.find((d: { id: string }) => d.id === deptId);
    expect(dept.avgConsultMinutes).toBe(9);
  });

  it("the public board carries tokens, rooms and doctors — and no patient identity", async () => {
    const first = await registerPatientOverHttp("Board One", "9876543213");
    const second = await registerPatientOverHttp("Board Two", "9876543214");
    const seated = await openAndSeat(first);
    await openAndSeat(second);
    await request(app.getHttpServer()).post(`/opd/queues/${seated.sessionId}/call-next`).set(...auth(dra.token)).expect(201);

    const board = await request(app.getHttpServer())
      .get("/opd/queues/board").query({ serviceDate: istDate(new Date()) }).set(...auth(display.token)).expect(200);
    expect(board.body.items).toHaveLength(1);
    const item = board.body.items[0];
    expect(Object.keys(item).sort()).toEqual(BOARD_ITEM_KEYS);
    expect(item.nowServing).toBe(1);
    expect(item.next).toEqual([2]);

    await request(app.getHttpServer())
      .get("/opd/queues").query({ doctorId: dra.doctorId, serviceDate: seated.serviceDate })
      .set(...auth(display.token)).expect(403);
  });

  it("route ordering: the four literal routes beat their ':id' siblings, and an ISO slot body coerces", async () => {
    const serviceDate = istDate(new Date());

    const summary = await request(app.getHttpServer())
      .get("/opd/queues/summary").query({ serviceDate }).set(...auth(supervisor.token)).expect(200);
    expect(Array.isArray(summary.body.items)).toBe(true);

    const board = await request(app.getHttpServer())
      .get("/opd/queues/board").query({ serviceDate }).set(...auth(display.token)).expect(200);
    expect(Array.isArray(board.body.items)).toBe(true);

    const transfer = await request(app.getHttpServer())
      .post("/opd/queues/transfer").set(...auth(supervisor.token))
      .send({ fromDoctorId: dra.doctorId, toDoctorId: drb.doctorId, serviceDate, consented: true, reason: "doctor called away" })
      .expect(201);
    expect(transfer.body.transferred).toBe(0);
    expect(typeof transfer.body.toSessionId).toBe("string");

    const verify = await request(app.getHttpServer())
      .post("/opd/prescriptions/verify").set(...auth(pharmacy.token)).send({ payload: "not-a-payload" }).expect(200);
    expect(verify.body).toEqual({ ok: false, reason: "malformed" });

    // The slot grid serializes Dates as ISO strings and the booking body reads them back with z.coerce.date()
    // — the one boundary in this contract where the wire type and the service type differ.
    const tomorrow = addDays(serviceDate, 1);
    const grid = await request(app.getHttpServer())
      .get("/opd/slots").query({ doctorId: dra.doctorId, date: tomorrow }).set(...auth(supervisor.token)).expect(200);
    expect(grid.body.slots.length).toBeGreaterThan(0);
    const slotStart = grid.body.slots[0].start as string;
    expect(typeof slotStart).toBe("string");
    const patientId = await registerPatientOverHttp("Slot S", "9876543215");
    const booked = await request(app.getHttpServer())
      .post("/opd/appointments").set(...auth(supervisor.token))
      .send({ patientId, doctorId: dra.doctorId, slotStart }).expect(201);
    expect(booked.body.appointment.serviceDate).toBe(tomorrow);
    expect(new Date(booked.body.appointment.slotStart).toISOString()).toBe(new Date(slotStart).toISOString());
  });
});
