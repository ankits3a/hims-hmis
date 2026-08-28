import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { newId } from "@hmis/contracts";
import { opdPrescriptions, patients } from "../../kernel/db/schema";
import { getVisit, patientTimeline } from "./encounters";
import { listVitals, recordVitals } from "./vitals";
import { listPrescriptions } from "./prescriptions";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07a T1 — THE READ GATE.
 *
 * `GET /opd/patients/:id/timeline` returned diagnosis and ICD-10 for every past visit behind
 * `opd.visits.read` alone — which `front_office` holds. It resolved the patient with
 * `resolvePatientId`, whose own docstring says "no gate", and its `actor` argument was threaded in
 * from the controller and never read. So the confidential flag hid a sealed patient's NAME
 * (`getPatient` existence-hides them) and left their DIAGNOSES readable to the same clerk.
 *
 * The identical defect was caught one lane over at Plan 11h's close — `search-providers.test.ts`,
 * "A @patient CHIP MUST NOT BYPASS THE SEALED CLASS — the id is not a capability". Search was
 * gated; these three reads were not, and no confidentiality test existed on any of them.
 *
 * THE SHAPE OF THE FIX IS "SAME ANSWER AS NOT-FOUND", NEVER A DISTINCT REFUSAL (07a DD2). A
 * different error for "sealed" than for "absent" is itself the leak: it confirms the patient
 * exists to a caller who may not know that.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST — inside every default template

/** `patients.confidential.read` through the kernel's own registry-checked path, never a raw insert. */
async function grantConfidentialRead(db: Db, roleKey: string): Promise<void> {
  const registry = new ModuleRegistry();
  registry.install({
    key: "patients", title: "Patients", menu: [],
    permissions: ["patients.confidential.read"], subscriptions: [],
  });
  await syncPermissions(db, registry);
  await grantPermissionToRole(db, registry, roleKey, "patients.confidential.read");
}

describe("opd read gate — the sealed class on timeline, vitals and prescriptions (07a T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;   // opd.visits.read, NOT patients.confidential.read
  let mrd: Awaited<ReturnType<typeof mkUser>>;     // may see the sealed class
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let sealed: { id: string; uhid: string };
  let open: { id: string; uhid: string };
  let sealedEncounterId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    // `nurse` is the WORKFLOW role `registered→waiting` declares; `mrd_officer_t` carries the
    // `patients.confidential.read` PERMISSION. Recording vitals needs both — the dual authorisation
    // the engine enforces separately from the HTTP permission.
    mrd = await mkUser(db, "mrd1", ["mrd_officer_t", "nurse"]);
    await grantConfidentialRead(db, "mrd_officer_t");

    sealed = await mkPatient(db, mrd.actor, {
      name: "Asha Confidential", phone: "9111111111", isConfidential: true, alias: "Guest One",
    });
    open = await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540002" });
    ({ encounterId: sealedEncounterId } = await openOpdVisit(
      db, { clerk: clerk.actor, patientId: sealed.id, departmentId: deptId, doctorId: dra.doctorId }, T0,
    ));
  });

  /** A1 — the finding itself. */
  it("A1: a caller without patients.confidential.read cannot read a sealed patient's timeline", async () => {
    await expect(patientTimeline(db, clerk.actor, sealed.id)).rejects.toThrow(OpdError);
    await expect(patientTimeline(db, clerk.actor, sealed.id)).rejects.toMatchObject({ code: "patient_not_found" });
  });

  /** A2 — sealed and absent must be INDISTINGUISHABLE, or the error is the leak. */
  it("A2: sealed and never-existed produce the same code — the refusal does not confirm existence", async () => {
    const sealedErr = await patientTimeline(db, clerk.actor, sealed.id).catch((e: unknown) => e);
    const absentErr = await patientTimeline(db, clerk.actor, newId()).catch((e: unknown) => e);
    expect(sealedErr).toBeInstanceOf(OpdError);
    expect(absentErr).toBeInstanceOf(OpdError);
    expect((sealedErr as OpdError).code).toBe((absentErr as OpdError).code);
  });

  /** A3 — over-gating is its own failure: clinicians route around a system that refuses them. */
  it("A3: a caller WITH the permission reads the sealed timeline normally", async () => {
    const items = await patientTimeline(db, mrd.actor, sealed.id);
    expect(items.map((i) => i.encounterId)).toEqual([sealedEncounterId]);
  });

  /** A4 — it is a CLASS of hole, not one route. Vitals and prescriptions take a raw encounter id. */
  it("A4: vitals on a sealed patient's encounter are empty for the clerk and present for the permitted caller", async () => {
    await recordVitals(db, mrd.actor, sealedEncounterId, { heightCm: 165, weightKg: 62, sbp: 120, dbp: 80, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 }, T0);
    expect(await listVitals(db, mrd.actor, sealedEncounterId)).toHaveLength(1);
    expect(await listVitals(db, clerk.actor, sealedEncounterId)).toEqual([]);
  });

  it("A4b: prescriptions on a sealed patient's encounter are empty for the clerk and present for the permitted caller", async () => {
    await db.insert(opdPrescriptions).values({
      id: newId(), encounterId: sealedEncounterId, patientId: sealed.id, doctorId: dra.doctorId,
      version: 1, lines: [], document: {}, allergyOverrides: [], issuedBy: dra.userId,
    });
    expect(await listPrescriptions(db, mrd.actor, sealedEncounterId)).toHaveLength(1);
    expect(await listPrescriptions(db, clerk.actor, sealedEncounterId)).toEqual([]);
  });

  /**
   * A4c — THE ROUTE THE FIRST FIX MISSED. `GET /opd/visits/:id` returns the encounter's diagnosis
   * and ICD-10 AND the visit's vitals AND its prescriptions in one payload. Only the patient's NAME
   * was ever protected here, by the controller aliasing it through `getPatientSummaries`; the
   * clinical body went to any holder of `opd.visits.read`.
   */
  it("A4c: the whole visit is invisible to the clerk for a sealed patient, and intact for the permitted caller", async () => {
    await recordVitals(db, mrd.actor, sealedEncounterId, { heightCm: 165, weightKg: 62, sbp: 120, dbp: 80, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 }, T0);
    const seen = await getVisit(db, mrd.actor, sealedEncounterId);
    expect(seen?.encounter.id).toBe(sealedEncounterId);
    expect(seen?.vitals).toHaveLength(1);
    expect(await getVisit(db, clerk.actor, sealedEncounterId)).toBeNull();
  });

  /** A5 — gating must not be implemented by dropping the merge chain, which would truncate history. */
  it("A5: the merge chain is still spanned for a permitted caller after gating", async () => {
    const loser = await mkPatient(db, mrd.actor, {
      name: "Asha Old", phone: "9111111112", isConfidential: true, alias: "Guest Two",
    });
    const older = await openOpdVisit(
      db, { clerk: clerk.actor, patientId: loser.id, departmentId: deptId, doctorId: dra.doctorId },
      new Date("2026-08-10T04:00:00.000Z"),
    );
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: sealed.id })
      .where(eq(patients.id, loser.id));

    const items = await patientTimeline(db, mrd.actor, sealed.id);
    expect(items.map((i) => i.encounterId)).toEqual([sealedEncounterId, older.encounterId]);
    // and the loser id still resolves to the same history for a permitted caller
    expect((await patientTimeline(db, mrd.actor, loser.id)).map((i) => i.encounterId))
      .toEqual(items.map((i) => i.encounterId));
  });

  /** The non-sealed path must be untouched — an over-gate would break every ordinary read. */
  it("a non-confidential patient is readable by the clerk exactly as before", async () => {
    const { encounterId } = await openOpdVisit(
      db, { clerk: clerk.actor, patientId: open.id, departmentId: deptId, doctorId: dra.doctorId }, T0,
    );
    expect((await patientTimeline(db, clerk.actor, open.id)).map((i) => i.encounterId)).toEqual([encounterId]);
    await recordVitals(db, mrd.actor, encounterId, { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 }, T0);
    expect(await listVitals(db, clerk.actor, encounterId)).toHaveLength(1);
  });
});
