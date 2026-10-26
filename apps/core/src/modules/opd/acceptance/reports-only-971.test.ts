import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../../test/helpers/opd";
import { events, opdEncounters, opdVitals } from "../../../kernel/db/schema";
import { registerVitalsStartGuard } from "../consultation";
import { getEncounter, openVisit } from "../encounters";
import { listBench } from "../bench";
import { markPatientAbsent, undoPatientAbsent } from "../patient-absent";
import { listQueue } from "../queue";
import type { Db } from "../../../kernel/db/client";
import type { EncounterRow } from "../encounters";

/**
 * ACCEPTANCE — issue #971, spec docs/specs/971-reports-only-skip-vitals.md (owner APPROVED 2026-10-26):
 * "Reports only — Skip vitals", with Self in "Who came?". The server half: Self is accepted, stores no
 * name, reaches the doctor's line with no vitals, and the fee door, the audit event and Undo treat it
 * exactly as a guardian's visit.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const MON2 = new Date(MON.getTime() + 10 * 60_000);

describe("#971 — Self skips vitals on the server", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let bayOnly: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let patient: { id: string; uhid: string };
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    let roomId: string;
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    const registry = new ModuleRegistry();
    registry.install({ key: "opd", title: "OPD", menu: [], subscriptions: [], permissions: ["opd.vitals.record", "opd.visits.open", "opd.visits.read"] });
    await syncPermissions(db, registry);
    await ensureRole(db, "ro_bay");
    await grantPermissionToRole(db, registry, "ro_bay", "opd.vitals.record");
    bayOnly = await mkUser(db, "bayonly", ["ro_bay"]);
    patient = await mkPatient(db, clerk.actor, {});
  });
  afterEach(() => { unregister?.(); unregister = null; });

  async function opened(): Promise<EncounterRow> {
    const o = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await db.update(opdEncounters).set({ visitType: "revisit" }).where(eq(opdEncounters.id, o.encounter.id));
    return (await getEncounter(db, o.encounter.id))!;
  }

  it("spec #971 D2: Self is accepted and stores no name, even when one is sent", async () => {
    const enc = await opened();
    const out = await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "self", name: "Suresh" }, MON2);
    expect(out.patientAbsent).toEqual({ relation: "self", name: null, by: bayOnly.id, at: MON2 });
    expect((await getEncounter(db, enc.id))!).toMatchObject({ patientAbsentRelation: "self", patientAbsentName: null });
  });

  it("spec #971 D3: a Self visit reaches the doctor's line with no vitals and leaves the bench", async () => {
    const enc = await opened();
    await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "self" }, MON2);
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, enc.id))).toHaveLength(0);
    const q = (await listQueue(db, dra.actor, dra.doctorId, enc.serviceDate, MON2))!;
    expect(q.ordered.find((e) => e.encounterId === enc.id)!.encounter.patientAbsent).toMatchObject({ relation: "self", name: null });
    const bench = await listBench(db, vd.actor, { serviceDate: enc.serviceDate }, MON2);
    expect(bench.find((b) => b.encounterId === enc.id)).toBeUndefined();
  });

  it("spec #971 D5: Self writes the same audit event, meets the same fee door, and Undo puts it back on the bench", async () => {
    const enc = await opened();
    await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "self" }, MON2);
    const audit = await db.select().from(events).where(and(eq(events.name, "visit.patient_absent"), eq(events.encounterId, enc.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ relation: "self", named: false });

    await undoPatientAbsent(db, bayOnly.actor, enc.id, MON2);
    expect((await getEncounter(db, enc.id))!).toMatchObject({ patientAbsentAt: null, patientAbsentRelation: null });
    const bench = await listBench(db, vd.actor, { serviceDate: enc.serviceDate }, MON2);
    expect(bench.find((b) => b.encounterId === enc.id)).toBeDefined();

    const unpaid = await opened();
    unregister = registerVitalsStartGuard("test_fee_gate", () =>
      Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "revisit" } }));
    await expect(markPatientAbsent(db, bayOnly.actor, unpaid.id, { relation: "self" }, MON2))
      .rejects.toMatchObject({ code: "consult_gate_refused" });
  });
});
