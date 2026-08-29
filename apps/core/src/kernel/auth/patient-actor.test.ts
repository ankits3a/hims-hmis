import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";
import { defineEvent } from "@hmis/contracts";
import { z } from "zod";
import { appendEvent } from "../events/append";
import { events } from "../db/schema";
import { loadConfig } from "../config";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { startInstance, transition } from "../workflow/instances";
import { createUser } from "./identity";
import { seedSodPairs } from "./sod";
import { PermissionGuard } from "./guards";

import { registerPatient, updatePatient, getPatientSummaries } from "../../modules/patients/registration";
import { registrationConfig, patients as patientsTable } from "../db/schema";
import { createMergeRequest, executeMerge, requestUnmerge, executeUnmerge } from "../../modules/patients/merge";
import { linkGuardian, updateGuardianAuthority, endGuardian } from "../../modules/patients/guardians";
import { addAllergy, markAllergyEnteredInError } from "../../modules/patients/allergies";
import { storePatientPhoto } from "../../modules/patients/photos";
import { visiblePatientIds, searchPatients } from "../../modules/patients/search";
import { verifyQrScan, reissueQrCard } from "../../modules/patients/qr";
import { bookAppointment, rescheduleAppointment, cancelAppointment, checkInAppointment } from "../../modules/opd/appointments";
import { scheduleDoctorLeave, cancelDoctorLeave } from "../../modules/opd/leaves";
import { createDepartment, createRoom, createDoctor } from "../../modules/opd/masters";
import { replaceDoctorSchedules } from "../../modules/opd/schedules";
import { updateOpdConfig } from "../../modules/opd/config";
import { setSessionStatus } from "../../modules/opd/sessions";
import { openVisit, openVisitInTx } from "../../modules/opd/encounters";
import { recordVitals } from "../../modules/opd/vitals";
import { requireTreatingDoctor } from "../../modules/opd/consultation";
import { walkIn } from "../../modules/opd/walk-in";
import { verifyPrescriptionQr, getPrescriptionPrint } from "../../modules/opd/prescriptions";
import { registerApprovalType } from "../approvals/types";
import { requestApproval } from "../approvals/requests";
import { approveRequest } from "../approvals/decisions";
import { listApprovals } from "../approvals/worklist";
import { searchAll } from "../search/registry";

/**
 * PLAN 22c-A T2 — THE AUDIT THAT PROVES NOTHING WIDENED (DD1, Assertion Book A1–A5b).
 *
 * `Actor` gained a fourth member in this phase. The entire risk of that one-line change is that a
 * guard which refuses today starts allowing tomorrow, silently, because it was written as an
 * exhaustive check over three types. So this file is a proof of NON-change: every executable
 * `user_actor_required` site in the tree, called with `{ type: "patient" }`, asserted to refuse.
 *
 * COVERAGE, MEASURED RATHER THAN CLAIMED. `grep -rn user_actor_required --include=*.ts
 * apps/core/src | grep -v '.test.'` returns 48 lines. Seven are not guards: four are error-union
 * members (`patients/uhid.ts:12`, `opd/errors.ts:2`, `approvals/types.ts:17`, `search/types.ts:67`),
 * two are doc comments (`materials.controller.ts:76`, `formulary/masters.ts:33`), and one is an
 * error-code MAPPER that turns the code into a 403 (`search.controller.ts:116`) and guards
 * nothing. That leaves 41 executable refusals. The table reaches 38 of them directly; six OPD
 * masters writers share one `requireUserActor` helper (`masters.ts:94`) and are represented by
 * three calls to it. The remaining three — `alerts.controller.ts:23`, `staff.controller.ts:129`
 * and `opd-masters.controller.ts:207` — are HTTP controller helpers sitting behind
 * `PermissionGuard`, and A5b covers the refusal that actually protects them.
 *
 * THE ASSERTION IS THE ERROR CODE, NEVER MERELY "IT THREW". A patient actor that reached a
 * database and failed on a missing row would also throw, and would prove the opposite of what
 * this file claims. Every row matches /user_actor_required/, and the fixtures are deliberately
 * EMPTY — no patient, no doctor, no appointment exists — so a guard that let a patient actor past
 * would fail with `patient_not_found`, `unknown_appointment` or a null dereference instead, and
 * that mismatch is the signal this file exists to raise.
 */

const PATIENT: Actor = { type: "patient", id: "01PATIENTCRED00000000001" }; // a patient_credentials id (G2)
const AT = new Date("2026-08-29T04:30:00.000Z");
const CFG = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv);

let db: Db;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ db, teardown } = await setupTestDb());
});
afterAll(async () => teardown());
beforeEach(async () => truncateAll(db));

describe("A1 — every executable guard site refuses a patient actor", () => {
  /** Each entry names the guard site it covers, so a reader can re-derive the coverage claim. */
  const cases: ReadonlyArray<readonly [site: string, run: () => Promise<unknown>]> = [
    ["patients/registration.ts:63 registerPatient", () =>
      withTx(db, (tx) => registerPatient(tx, PATIENT, { name: "X", sex: "male" }))],
    ["patients/registration.ts:231 updatePatient", () =>
      withTx(db, (tx) => updatePatient(tx, PATIENT, "p1", { name: "Y" }))],
    ["patients/merge.ts:25 createMergeRequest", () =>
      withTx(db, (tx) => createMergeRequest(tx, PATIENT, { winnerId: "p1", loserId: "p2", note: "dup" }))],
    ["patients/merge.ts:98 executeMerge", () => executeMerge(db, PATIENT, "mr1")],
    ["patients/merge.ts:167 requestUnmerge", () =>
      withTx(db, (tx) => requestUnmerge(tx, PATIENT, { mergeRequestId: "mr1", note: "oops" }))],
    ["patients/merge.ts:195 executeUnmerge", () => executeUnmerge(db, PATIENT, "mr1")],
    ["patients/guardians.ts:78 linkGuardian", () =>
      withTx(db, (tx) => linkGuardian(tx, PATIENT, "p1", { name: "G", relationship: "mother", phone: "9876543210" }))],
    ["patients/guardians.ts:132 updateGuardianAuthority", () =>
      withTx(db, (tx) => updateGuardianAuthority(tx, PATIENT, "g1", { messages: true }))],
    ["patients/guardians.ts:173 endGuardian", () =>
      withTx(db, (tx) => endGuardian(tx, PATIENT, "g1"))],
    ["patients/allergies.ts:23 addAllergy", () =>
      withTx(db, (tx) => addAllergy(tx, PATIENT, "p1", { substance: "penicillin", source: "registration" }))],
    ["patients/allergies.ts:70 markAllergyEnteredInError", () =>
      withTx(db, (tx) => markAllergyEnteredInError(tx, PATIENT, "a1", "wrong patient"))],
    ["patients/photos.ts:19 storePatientPhoto", () =>
      withTx(db, (tx) => storePatientPhoto(tx, PATIENT, "p1", { mimeType: "image/jpeg", bytes: Buffer.from([1, 2, 3]) }))],
    ["patients/search.ts:147 visiblePatientIds", () => visiblePatientIds(db, PATIENT, ["p1"])],
    ["patients/search.ts:204 searchPatients", () => searchPatients(db, PATIENT, "asha")],
    ["patients/qr.ts:36 verifyQrScan", () => verifyQrScan(db, CFG, PATIENT, "payload")],
    ["patients/qr.ts:100 reissueQrCard", () => reissueQrCard(db, CFG, PATIENT, "p1")],
    ["opd/appointments.ts:44 bookAppointment", () =>
      bookAppointment(db, PATIENT, { patientId: "p1", doctorId: "d1", slotStart: AT }, AT)],
    ["opd/appointments.ts:93 rescheduleAppointment", () =>
      rescheduleAppointment(db, PATIENT, "ap1", { slotStart: AT }, AT)],
    ["opd/appointments.ts:149 cancelAppointment", () =>
      cancelAppointment(db, PATIENT, "ap1", "changed mind", AT)],
    ["opd/appointments.ts:182 checkInAppointment", () => checkInAppointment(db, PATIENT, "ap1", AT)],
    ["opd/leaves.ts:24 scheduleDoctorLeave", () =>
      scheduleDoctorLeave(db, PATIENT, { doctorId: "d1", fromDate: "2026-09-01", toDate: "2026-09-02", reason: "x" }, AT)],
    ["opd/leaves.ts:64 cancelDoctorLeave", () => cancelDoctorLeave(db, PATIENT, "l1", AT)],
    ["opd/masters.ts:94 requireUserActor (createDepartment)", () =>
      withTx(db, (tx) => createDepartment(tx, PATIENT, { code: "GEN", name: "General" }))],
    ["opd/masters.ts:94 requireUserActor (createRoom)", () =>
      withTx(db, (tx) => createRoom(tx, PATIENT, { code: "R1", name: "Room 1" }))],
    ["opd/masters.ts:94 requireUserActor (createDoctor)", () =>
      withTx(db, (tx) => createDoctor(tx, PATIENT, { username: "u1", departmentId: "dep1", displayName: "Dr X" }))],
    ["opd/schedules.ts:58 replaceDoctorSchedules", () =>
      withTx(db, (tx) => replaceDoctorSchedules(tx, PATIENT, "d1", []))],
    ["opd/config.ts:137 updateOpdConfig", () =>
      withTx(db, (tx) => updateOpdConfig(tx, PATIENT, { slotMinutes: 10 }, AT))],
    ["opd/sessions.ts:87 setSessionStatus", () =>
      withTx(db, (tx) => setSessionStatus(tx, PATIENT, "s1", "closed"))],
    ["opd/encounters.ts:48 openVisit", () =>
      openVisit(db, PATIENT, { patientId: "p1", departmentId: "dep1", doctorId: "d1" }, AT)],
    ["opd/encounters.ts:57 openVisitInTx", () =>
      withTx(db, (tx) => openVisitInTx(tx, PATIENT, { patientId: "p1", departmentId: "dep1", doctorId: "d1", chainIds: ["p1"] }, AT))],
    ["opd/vitals.ts:47 recordVitals", () =>
      recordVitals(db, PATIENT, "e1", { pulse: 72 }, AT)],
    ["opd/consultation.ts:74 requireTreatingDoctor", () =>
      requireTreatingDoctor(db, PATIENT, { id: "e1", doctorId: "d1" } as never)],
    ["opd/walk-in.ts:87 walkIn", () =>
      walkIn(db, PATIENT, { patientId: "p1", departmentId: "dep1", doctorId: "d1" } as never, undefined, AT)],
    ["opd/prescriptions.ts:485 verifyPrescriptionQr", () =>
      verifyPrescriptionQr(db, CFG, PATIENT, "payload")],
    ["opd/prescriptions.ts:546 getPrescriptionPrint", () =>
      getPrescriptionPrint(db, CFG, PATIENT, "rx1")],
    ["approvals/types.ts:61 registerApprovalType", () =>
      registerApprovalType(db, PATIENT, { typeKey: "t", title: "T", approverRole: "r" })],
    ["approvals/requests.ts:36 requestApproval", () =>
      withTx(db, (tx) => requestApproval(tx, PATIENT, { typeKey: "t", subject: { type: "s", id: "s1" } }))],
    ["approvals/decisions.ts:43 approveRequest", () =>
      approveRequest(db, PATIENT, { approvalId: "a1", note: "ok" })],
    ["approvals/worklist.ts:51 listApprovals", () => listApprovals(db, PATIENT, {})],
    ["search/registry.ts:104 searchAll", () =>
      searchAll(db, { modules: [] } as never, PATIENT, { text: "asha" } as never)],
  ];

  /**
   * THE ASSERTION IS ON `code`, NOT ON `message`, and the first run of this file is why. Every one
   * of these error classes is `new XError(code, detail?)` and stores the DETAIL in `.message` — so
   * `rejects.toThrow(/user_actor_required/)` passed for the eighteen guards that pass no detail
   * and FAILED for the twenty-two that do, with messages like "only user actors register
   * patients". The guards were all firing correctly; the assertion was reading the wrong field and
   * would have been reported as twenty-two defects. Matching the code is both correct and
   * stricter: a guard that threw some other error with a helpful message could not slip past it.
   */
  it.each(cases)("refuses at %s", async (_site, run) => {
    await expect(run()).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("covers 40 guard call sites in one table", () => {
    // Asserted so that deleting a row is a test failure rather than a quiet loss of coverage.
    expect(cases).toHaveLength(40);
  });
});

describe("A2/A3 — the two the plan names explicitly", () => {
  it("A2 — bookAppointment still throws user_actor_required for a patient actor", async () => {
    // 22c-C opens this one deliberately, with its own hold machinery. Until then a patient booking
    // directly would bypass every slot-contention rule that phase exists to build.
    await expect(
      bookAppointment(db, PATIENT, { patientId: "p1", doctorId: "d1", slotStart: AT }, AT),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("A3 — verifyQrScan still refuses a non-user actor", async () => {
    // "scanners are desk surfaces". A patient scanning their own card would never exercise the
    // confidential-alias path the desk scanner depends on.
    await expect(verifyQrScan(db, CFG, PATIENT, "anything")).rejects.toMatchObject({
      code: "user_actor_required",
      message: "scanners are desk surfaces — user actors only",
    });
  });
});

describe("A4 — the event envelope round-trips a patient actor", () => {
  const probe = defineEvent("patient.actor_probe", "patients", z.object({ ok: z.boolean() }));

  it("persists actor_type 'patient' and reads it back", async () => {
    // Provenance is why a fourth type exists at all: an event whose actor cannot say it was the
    // patient is an event that cannot answer "who did this" for the entire app.
    const input = probe.make({ actor: PATIENT, payload: { ok: true }, occurredAt: AT });
    expect(input.actor).toEqual({ type: "patient", id: PATIENT.id });

    const appended = await withTx(db, (tx) => appendEvent(tx, input));
    const rows = await db.select().from(events).where(eq(events.eventId, appended.eventId));
    expect(rows[0]).toMatchObject({ actorType: "patient", actorId: PATIENT.id });
  });
});

describe("A5 — the fall-through the widening created (spike S2)", () => {
  const DEF = {
    key: "patient_actor_probe",
    title: "Patient Actor Probe",
    changeClass: "C",
    initialState: "open",
    states: [{ name: "open", sla: { minutes: 30, alerting: "record_only" } }, { name: "done", terminal: true }],
    transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
  };

  async function seedInstance(): Promise<string> {
    await seedSodPairs(db);
    const { id } = await createUser(db, { username: "wf_admin", fullName: "WF Admin", password: "p1234567" });
    const admin: Actor = { type: "user", id };
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, DEF as never);
    await activateDefinition(db, admin, definitionId);
    const { instanceId } = await withTx(db, (tx) =>
      startInstance(tx, DEF.key, { type: "probe_subject", id: "s1" } as never),
    );
    return instanceId;
  }

  it("REFUSES a patient actor at a governed workflow transition", async () => {
    // Before this phase the chain was `if user {check} else if agent {throw}` and `system` fell
    // through by design. A fourth member would have joined the SYSTEM branch — a patient actor
    // moving a governed workflow with NO role check at all. `pnpm typecheck` saw nothing wrong
    // with that, because an if/else-if chain over a union is not an exhaustiveness check.
    const instanceId = await seedInstance();
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "done", PATIENT)),
    ).rejects.toMatchObject({ code: "role_denied" });
  });

  it("names the patient actor in the refusal rather than calling it an agent", async () => {
    // A message that says "agent grants" for a patient sends the next reader to Plan 12 for an
    // answer that is not there.
    const instanceId = await seedInstance();
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "done", PATIENT)),
    ).rejects.toThrow(/a patient actor holds no workflow roles/);
  });

  it("still lets a system actor through — the bypass that was always intended", async () => {
    // The fix must not close the branch it was protecting. `system` is the application's own
    // automated move and stays exempt; this is the assertion that keeps the fix from being a
    // regression dressed as a hardening.
    const instanceId = await seedInstance();
    const out = await withTx(db, (tx) =>
      transition(tx, instanceId, "done", { type: "system", id: "sweeper" }),
    );
    expect(out).toMatchObject({ state: "done", completed: true });
  });
});

describe("A5b — PermissionGuard refuses a patient actor at the HTTP boundary", () => {
  /**
   * `PermissionGuard.canActivate` needs a Reflector and an ExecutionContext, so both are stubbed
   * to the two calls it actually makes. This is the guard that protects the three controller-level
   * `user_actor_required` sites A1's table cannot reach as unit calls
   * (`alerts.controller.ts:23`, `staff.controller.ts:129`, `opd-masters.controller.ts:207`).
   */
  function ctxFor(actor: Actor | undefined): never {
    return {
      switchToHttp: () => ({ getRequest: () => ({ hmisActor: actor, headers: {}, params: {}, query: {} }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as never;
  }
  const reflector = { getAllAndOverride: () => ({ permission: "patients.read", scope: "hospital" }) } as never;

  it("throws ForbiddenException for a patient actor before any permission lookup", async () => {
    // Default-refuse survives the widening. The consequence for 22c-B, recorded here rather than
    // rediscovered: a patient route CANNOT reuse PermissionGuard, and `AuthGuard` mints
    // `{ type: "user", id: session.userId }` unconditionally (guards.ts:73) — the patient session
    // needs its own minting site and its own guard.
    const guard = new PermissionGuard(db, CFG, reflector);
    await expect(guard.canActivate(ctxFor(PATIENT))).rejects.toThrow(/agents hold no permissions yet/);
  });

  it("lets a USER actor reach the permission lookup — the branch discriminates on type, not on luck", async () => {
    // The positive control. A user actor with no grants is refused too, but for a DIFFERENT
    // reason — `missing permission …` rather than `agents hold no permissions yet`. Without this
    // assertion the test above would pass against a guard that refused everybody, which is not
    // the property being claimed.
    const { id } = await createUser(db, { username: "reader1", fullName: "Reader", password: "p1234567" });
    const guard = new PermissionGuard(db, CFG, reflector);
    await expect(guard.canActivate(ctxFor({ type: "user", id }))).rejects.toThrow(/missing permission patients\.read/);
  });
});

describe("D11 — the aliasing class the review found (recorded, not yet reachable)", () => {
  it("getPatientSummaries does NOT refuse a patient actor — it ALIASES, which IS the finding", async () => {
    /**
     * CLOSE REVIEW m10 — THIS TEST USED TO PASS AN EMPTY ARRAY AND THEREFORE ASSERTED NOTHING.
     * `getPatientSummaries` returns `[]` before it ever looks at the actor, so the old form was
     * green against the current code, against a fixed 22c-E, and against a build that threw only
     * for non-empty input. It now uses a real CONFIDENTIAL patient, which is the only shape that
     * exhibits D11: `hasPermission` against a `patient_credentials` id returns FALSE, so a
     * confidential patient reading their OWN record is aliased to themselves.
     *
     * Nothing routes a patient actor here yet — no route opens in this phase (DD1) — so what is
     * pinned is the behaviour 22c-E must change. When it does, this test fails and says why.
     */
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, { type: "user", id: "01USERCLERK00000000000001" }, {
        name: "VIP Patient", sex: "female", ageYears: 40,
      } as never));

    const [summary] = await getPatientSummaries(db, PATIENT, [patient.id]);
    // A non-confidential patient is returned by name to anybody, so this half is unremarkable…
    expect(summary!.name).toBe("VIP Patient");
    expect(summary!.restricted).toBe(false);

    // …and this is D11 itself. The patient actor's id is a `patient_credentials` row, so the
    // permission lookup finds no user and returns false, which the summary reads as "may not see".
    await db.update(patientsTable).set({ isConfidential: true, alias: "P-4821" })
      .where(eq(patientsTable.id, patient.id));
    const [restricted] = await getPatientSummaries(db, PATIENT, [patient.id]);
    expect(restricted!.restricted).toBe(true);
    expect(restricted!.name).toBeNull();
    expect(restricted!.alias).toBe("P-4821");
  });
});
