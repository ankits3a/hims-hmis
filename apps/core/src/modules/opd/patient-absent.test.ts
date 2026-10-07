import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdEncounters, opdQueueEntries, opdVitals } from "../../kernel/db/schema";
import { registerVitalsStartGuard, startConsultation } from "./consultation";
import { getEncounter, grantFeeBypass, openVisit } from "./encounters";
import { listBench } from "./bench";
import { markPatientAbsent } from "./patient-absent";
import { markConsultedOnPaper, reopenPaperConsult } from "./paper-consult";
import { listQueue } from "./queue";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";
import type { EncounterRow } from "./encounters";

const MON = new Date("2026-08-17T04:00:00.000Z");
const MON2 = new Date(MON.getTime() + 10 * 60_000);
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

/**
 * ═══ THE GUARDIAN CAME WITH THE REPORTS — OWNER 2026-10-07 ═══
 *
 * *"When the patient's guardian comes with the report of the patient as a revisit patient, add an
 * option to skip the vitals taking process, as the patient didn't come."*
 *
 * Real permission reads, the real workflow engine, the real queue: a skip that worked for the wrong
 * seat, the wrong kind of visit, or past the money door would be a hole, not a convenience.
 */
describe("patient absent — a guardian brings a revisit's reports and the visit skips the bay", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let deskOnly: Awaited<ReturnType<typeof mkUser>>;
  let bayOnly: Awaited<ReturnType<typeof mkUser>>;
  let nobody: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let patient: { id: string; uhid: string };
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    /* REAL grants — `ensureRole` mints a role with no permissions, and the service reads one. */
    const registry = new ModuleRegistry();
    registry.install({
      key: "opd", title: "OPD", menu: [], subscriptions: [],
      permissions: ["opd.vitals.record", "opd.visits.open", "opd.visits.read"],
    });
    await syncPermissions(db, registry);
    for (const role of ["pa_desk", "pa_bay", "pa_reader"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "pa_desk", "opd.visits.open");
    await grantPermissionToRole(db, registry, "pa_bay", "opd.vitals.record");
    await grantPermissionToRole(db, registry, "pa_reader", "opd.visits.read");
    deskOnly = await mkUser(db, "deskonly", ["pa_desk"]);
    bayOnly = await mkUser(db, "bayonly", ["pa_bay"]);
    nobody = await mkUser(db, "reader", ["pa_reader"]);
    patient = await mkPatient(db, clerk.actor, {});
  });
  afterEach(() => { unregister?.(); unregister = null; });

  async function opened(visitType: "new" | "revisit" | "renewal" = "revisit"): Promise<EncounterRow> {
    const o = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    /* The classifier needs a prior completed consult to say "revisit"; the kind is what is under test, so it is set. */
    await db.update(opdEncounters).set({ visitType }).where(eq(opdEncounters.id, o.encounter.id));
    return (await getEncounter(db, o.encounter.id))!;
  }

  it("a registered REVISIT moves to waiting with the mark, the token becomes callable, and no chart is written", async () => {
    const enc = await opened();
    const out = await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "father", name: "  Ramesh  " }, MON2);

    expect(out.alreadyMarked).toBe(false);
    expect(out.encounter.status).toBe("waiting");
    expect(out.patientAbsent).toEqual({ relation: "father", name: "Ramesh", by: bayOnly.id, at: MON2 });
    const row = (await getEncounter(db, enc.id))!;
    expect(row).toMatchObject({
      status: "waiting", patientAbsentBy: bayOnly.id, patientAbsentRelation: "father", patientAbsentName: "Ramesh",
    });
    expect(row.patientAbsentAt?.getTime()).toBe(MON2.getTime());

    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc.id));
    expect(entries.map((e) => e.status)).toEqual(["waiting"]);
    expect(entries[0]!.eligibleAt?.getTime()).toBe(MON2.getTime());
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, enc.id))).toHaveLength(0);

    const audit = await db.select().from(events).where(and(eq(events.name, "visit.patient_absent"), eq(events.encounterId, enc.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(bayOnly.id);
    expect(audit[0]!.payload).toMatchObject({ relation: "father", named: true, doctorId: dra.doctorId });

    /* The doctor's line reads it, and the bench has let it go. */
    const q = (await listQueue(db, dra.actor, dra.doctorId, enc.serviceDate, MON2))!;
    const mine = q.ordered.find((e) => e.encounterId === enc.id)!;
    expect(mine.encounter.patientAbsent).toEqual({ relation: "father", name: "Ramesh", by: bayOnly.id, at: MON2 });
    expect(q.waitingVitals).toBe(0);
    const bench = await listBench(db, vd.actor, { serviceDate: enc.serviceDate }, MON2);
    expect(bench.find((b) => b.encounterId === enc.id)).toBeUndefined();
  });

  it("the front desk's grant alone is enough too (the workflow move is the system's, the name is the clerk's)", async () => {
    const enc = await opened();
    const out = await markPatientAbsent(db, deskOnly.actor, enc.id, { relation: "attendant" }, MON2);
    expect(out.encounter.status).toBe("waiting");
    expect(out.patientAbsent).toMatchObject({ relation: "attendant", name: null, by: deskOnly.id });
  });

  it("a NEW visit is refused patient_absent_revisit_only, and nothing moves", async () => {
    const enc = await opened("new");
    await expect(markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "mother" }, MON2))
      .rejects.toMatchObject({ code: "patient_absent_revisit_only" });
    const renewal = await opened("renewal");
    await expect(markPatientAbsent(db, bayOnly.actor, renewal.id, { relation: "mother" }, MON2))
      .rejects.toMatchObject({ code: "patient_absent_revisit_only" });
    expect((await getEncounter(db, enc.id))!.status).toBe("registered");
  });

  it("a visit already past registered (vitals taken) is refused encounter_state_conflict", async () => {
    const enc = await opened();
    await recordVitals(db, vd.actor, enc.id, adultOk, MON);
    await expect(markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "son" }, MON2))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });
    expect((await getEncounter(db, enc.id))!.patientAbsentAt).toBeNull();
  });

  it("an account with neither the bay's nor the desk's grant is refused patient_absent_not_permitted", async () => {
    const enc = await opened();
    await expect(markPatientAbsent(db, nobody.actor, enc.id, { relation: "spouse" }, MON2))
      .rejects.toMatchObject({ code: "patient_absent_not_permitted" });
    await expect(markPatientAbsent(db, { type: "system", id: "x" }, enc.id, { relation: "spouse" }, MON2))
      .rejects.toMatchObject({ code: "user_actor_required" });
    expect((await getEncounter(db, enc.id))!.status).toBe("registered");
  });

  it("a relation off the list, or a name over 80 characters, is refused invalid_patient_absent", async () => {
    const enc = await opened();
    await expect(markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "neighbour" }, MON2))
      .rejects.toMatchObject({ code: "invalid_patient_absent" });
    await expect(markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "father", name: "x".repeat(81) }, MON2))
      .rejects.toMatchObject({ code: "invalid_patient_absent" });
  });

  it("UNPAID refuses exactly as the bay does — same code, same detail — and the front desk's bypass opens it", async () => {
    unregister = registerVitalsStartGuard("test_fee_gate", () =>
      Promise.resolve({ ok: false as const, code: "fee_unsettled", detail: { visitType: "revisit" } }));
    const enc = await opened();
    const bay = await recordVitals(db, vd.actor, enc.id, adultOk, MON).catch((e: unknown) => e) as { code: string; detail: unknown };
    const ours = await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "father" }, MON2).catch((e: unknown) => e) as { code: string; detail: unknown };
    expect(ours.code).toBe("consult_gate_refused");
    expect(ours.code).toBe(bay.code);
    expect(ours.detail).toEqual(bay.detail);
    expect((await getEncounter(db, enc.id))!.status).toBe("registered");

    await grantFeeBypass(db, clerk.actor, enc.id, "VIP — chairman's guest", MON);
    const out = await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "father" }, MON2);
    expect(out.encounter.status).toBe("waiting");
  });

  it("is IDEMPOTENT — a second call answers the existing mark and rewrites nothing", async () => {
    const enc = await opened();
    const first = await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "father", name: "Ramesh" }, MON);
    const again = await markPatientAbsent(db, deskOnly.actor, enc.id, { relation: "mother", name: "Sita" }, MON2);
    expect(again.alreadyMarked).toBe(true);
    expect(again.patientAbsent).toEqual(first.patientAbsent);
    const row = (await getEncounter(db, enc.id))!;
    expect(row).toMatchObject({ patientAbsentBy: bayOnly.id, patientAbsentRelation: "father", patientAbsentName: "Ramesh" });
    const audit = await db.select().from(events).where(and(eq(events.name, "visit.patient_absent"), eq(events.encounterId, enc.id)));
    expect(audit).toHaveLength(1);
  });

  it("a guardian's visit closed from paper by mistake and reopened goes back to the DOCTOR's line, not to the bay", async () => {
    const registry = new ModuleRegistry();
    registry.install({ key: "opd", title: "OPD", menu: [], subscriptions: [], permissions: ["opd.consult.paper", "opd.queue.transfer"] });
    await syncPermissions(db, registry);
    for (const role of ["pa_slip", "pa_sup"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "pa_slip", "opd.consult.paper");
    await grantPermissionToRole(db, registry, "pa_sup", "opd.queue.transfer");
    const slip = await mkUser(db, "slip", ["pa_slip"]);
    const sup = await mkUser(db, "sup", ["pa_sup"]);

    const enc = await opened();
    await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "son" }, MON);
    expect((await markConsultedOnPaper(db, slip.actor, enc.id, { kind: "transcription", id: enc.id }, MON2)).outcome).toBe("marked");
    const back = await reopenPaperConsult(db, sup.actor, enc.id, { reason: "slip filed against the wrong visit" }, MON2);
    expect(back.encounter.status).toBe("waiting");
    const live = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc.id));
    expect(live.map((e) => e.status).sort()).toEqual(["done", "waiting"]);
  });

  it("the doctor can start the consultation of a guardian's visit with no vitals on the chart", async () => {
    const enc = await opened();
    await markPatientAbsent(db, bayOnly.actor, enc.id, { relation: "daughter", name: "Priya" }, MON);
    const started = await startConsultation(db, dra.actor, enc.id, MON2);
    expect(started.encounter.status).toBe("in_consultation");
    expect(started.queueEntry.status).toBe("in_consult");
  });
});
