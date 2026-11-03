import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { issuePaidInvoice, openSessionFor, seedBillingBase } from "../../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../../test/helpers/opd";
import { withTx } from "../../../kernel/db/client";
import { events, opdConfig, opdQueueEntries, opdVitals, printJobs } from "../../../kernel/db/schema";
import { ROLE_MODEL } from "../../../../scripts/seed-roles";
import { issueInvoice } from "../../billing";
import { moveVisitDepartment } from "../department-move";
import { getEncounter, moveEncounter, openVisit } from "../encounters";
import { recordVitals } from "../vitals";
import { moveDepartmentFromVitals, printMovedTokenSlip } from "../vitals-department-move";
import type { BillingBaseFixture } from "../../../../test/helpers/billing";
import type { EncounterRow } from "../encounters";
import type { Db } from "../../../kernel/db/client";

/** Spec #1031 — a patient's department (and doctor) changed from the vitals screen, owner 2026-11-03. */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const T0 = new Date("2026-08-08T10:00:00.000Z"); // an earlier consult day
const at = (min: number) => new Date(MON.getTime() + min * 60_000);
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("change a patient's department from vitals (spec #1031)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let ortho: Awaited<ReturnType<typeof mkDoctor>>;
  let medic: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dept2Id: string;
  let patient: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    ({ deptId, dept2Id } = m);
    base = await seedBillingBase(db);
    ortho = await mkDoctor(db, { username: "drortho", departmentId: deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    medic = await mkDoctor(db, { username: "drmed", departmentId: dept2Id, roomId: m.room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    cashier = await mkUser(db, "cd_cashier", ["front_office", "cashier"]);
    vd = await mkUser(db, "cd_vd", ["vitals_desk"]);
    patient = await mkPatient(db, cashier.actor);
    await openSessionFor(db, { id: cashier.id }, 200_000);
  });

  /** A paid walk-in in the first department, opened at `when`. */
  const seat = async (p: { id: string }, departmentId: string, doctorId: string, when: Date) => {
    const r = await openVisit(db, cashier.actor, { patientId: p.id, departmentId, doctorId }, when);
    await issuePaidInvoice(db, cashier, { patientId: p.id, serviceId: base.consultNewServiceId, encounterId: r.encounter.id }, when);
    return r;
  };
  const moveFromVitals = (encounterId: string, now: Date = at(30)) =>
    moveDepartmentFromVitals(db, vd.actor, encounterId, { departmentId: dept2Id, doctorId: medic.doctorId, consented: true, reason: "Patient asked" }, now);
  const liveEntry = async (encounterId: string) =>
    (await db.select().from(opdQueueEntries).where(and(eq(opdQueueEntries.encounterId, encounterId),
      inArray(opdQueueEntries.status, ["waiting_vitals", "waiting", "called"]))))[0];

  it("spec #1031 D1: a vitals-desk user moves a waiting patient to another department and doctor; old visit closed, new visit with the new department's token", async () => {
    const other = await mkPatient(db, cashier.actor, { phone: "9876530001" });
    const already = await seat(other, dept2Id, medic.doctorId, MON); // takes token 1 of the second department's series
    const wrong = await seat(patient, deptId, ortho.doctorId, MON);
    const r = await moveFromVitals(wrong.encounter.id);
    expect((await getEncounter(db, wrong.encounter.id))!.status).toBe("abandoned");
    const moved = (await getEncounter(db, r.encounterId))!;
    expect(moved).toMatchObject({ departmentId: dept2Id, doctorId: medic.doctorId, patientId: patient.id });
    expect(r.tokenNo).toBe(already.tokenNo + 1);
    expect((await liveEntry(r.encounterId))!.tokenNo).toBe(r.tokenNo);
  });

  it("spec #1031 D2: the new department's line places the patient by original arrival time", async () => {
    const wrong = await seat(patient, deptId, ortho.doctorId, MON);
    await recordVitals(db, vd.actor, wrong.encounter.id, adultOk, at(5));
    const later = await mkPatient(db, cashier.actor, { phone: "9876530002" });
    const there = await seat(later, dept2Id, medic.doctorId, at(10));
    await recordVitals(db, vd.actor, there.encounter.id, adultOk, at(15));
    const r = await moveFromVitals(wrong.encounter.id, at(30));
    const mine = (await liveEntry(r.encounterId))!;
    const theirs = (await liveEntry(there.encounter.id))!;
    expect(mine.eligibleAt).toEqual(at(5));
    expect(mine.eligibleAt!.getTime()).toBeLessThan(theirs.eligibleAt!.getTime());
  });

  it("spec #1031 D3: vitals already saved on the old visit appear on the new visit, for the vitals-screen move and the front desk move", async () => {
    const a = await seat(patient, deptId, ortho.doctorId, MON);
    const { vitals: va } = await recordVitals(db, vd.actor, a.encounter.id, adultOk, at(5));
    const ra = await moveFromVitals(a.encounter.id);
    expect((await db.select().from(opdVitals).where(eq(opdVitals.encounterId, ra.encounterId))).map((v) => v.id)).toEqual([va.id]);

    const p2 = await mkPatient(db, cashier.actor, { phone: "9876530003" });
    const b = await seat(p2, deptId, ortho.doctorId, MON);
    const { vitals: vb } = await recordVitals(db, vd.actor, b.encounter.id, adultOk, at(6));
    const rb = await moveVisitDepartment(db, cashier.actor, b.encounter.id, { departmentId: dept2Id, doctorId: medic.doctorId, reason: "wrong desk" }, at(31));
    expect((await db.select().from(opdVitals).where(eq(opdVitals.encounterId, rb.to.encounter.id))).map((v) => v.id)).toEqual([vb.id]);
  });

  it("spec #1031 D4: the move is refused once the consultation has begun", async () => {
    const r = await seat(patient, deptId, ortho.doctorId, MON);
    let enc: EncounterRow = await withTx(db, (tx) => moveEncounter(tx, vd.actor, r.encounter, "waiting", {}, MON));
    enc = await withTx(db, (tx) => moveEncounter(tx, ortho.actor, enc, "in_consultation", {}, MON));
    await db.update(opdQueueEntries).set({ status: "in_consult" }).where(eq(opdQueueEntries.id, r.queueEntry.id));
    await expect(moveFromVitals(enc.id)).rejects.toMatchObject({ code: "encounter_state_conflict" });
    expect((await getEncounter(db, enc.id))!.status).toBe("in_consultation");
    expect(await db.select().from(events).where(eq(events.name, "visit.moved_department"))).toHaveLength(0);
  });

  it("spec #1031 D5: refused from the vitals screen when the fee differs or the bill holds more than the consult fee; no money moves", async () => {
    // A fee difference: a recent consult in the second department makes the visit there a cheaper (or free) one.
    const prior = await openVisit(db, cashier.actor, { patientId: patient.id, departmentId: dept2Id, doctorId: medic.doctorId }, T0);
    let enc: EncounterRow = await withTx(db, (tx) => moveEncounter(tx, vd.actor, prior.encounter, "waiting", {}, T0));
    enc = await withTx(db, (tx) => moveEncounter(tx, medic.actor, enc, "in_consultation", {}, T0));
    await withTx(db, (tx) => moveEncounter(tx, medic.actor, enc, "completed", { consultCompletedAt: T0, followUpDays: 14 }, T0));
    const diff = await seat(patient, deptId, ortho.doctorId, MON);
    await expect(moveFromVitals(diff.encounter.id)).rejects.toMatchObject({ code: "send_to_billing" });
    expect((await getEncounter(db, diff.encounter.id))!.status).not.toBe("abandoned");

    // Anything else on the bill.
    const p2 = await mkPatient(db, cashier.actor, { phone: "9876530004" });
    const mixed = await openVisit(db, cashier.actor, { patientId: p2.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: p2.id, encounterId: mixed.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }, { lineId: "x", serviceId: base.genericServiceId, qty: 1 }],
    }, MON);
    await expect(moveFromVitals(mixed.encounter.id)).rejects.toMatchObject({ code: "send_to_billing" });
    expect((await getEncounter(db, mixed.encounter.id))!.status).not.toBe("abandoned");
    expect(await db.select().from(events).where(eq(events.name, "visit.moved_department"))).toHaveLength(0);
  });

  it("spec #1031 D6: vitals_desk holds opd.vitals.change_department, and not opd.visits.open", () => {
    const held = ROLE_MODEL.find((r) => r.roleKey === "vitals_desk")!.permissions;
    expect(held).toContain("opd.vitals.change_department");
    expect(held).not.toContain("opd.visits.open");
  });

  it("spec #1031 D7: each move is audited with who, from department/doctor, to department/doctor and reason", async () => {
    const r = await seat(patient, deptId, ortho.doctorId, MON);
    await moveFromVitals(r.encounter.id);
    const audit = await db.select().from(events).where(eq(events.name, "visit.moved_department"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: vd.id,
      payload: { fromDepartmentId: deptId, fromDoctorId: ortho.doctorId, toDepartmentId: dept2Id, toDoctorId: medic.doctorId, reason: "Patient asked" },
    });
  });

  it("spec #1031 D9: with the print setting off no print is offered or queued; with it on, the mover can print the new token slip", async () => {
    const r = await seat(patient, deptId, ortho.doctorId, MON);
    const off = await moveFromVitals(r.encounter.id);
    expect(off.printSlip).toBe(false);
    expect(await db.select().from(printJobs).where(eq(printJobs.encounterId, off.encounterId))).toHaveLength(0);
    await expect(printMovedTokenSlip(db, vd.actor, off.encounterId)).rejects.toMatchObject({ code: "print_off" });
    expect(await db.select().from(printJobs).where(eq(printJobs.encounterId, off.encounterId))).toHaveLength(0);

    await db.update(opdConfig).set({ vitalsMovePrintSlip: true }).where(eq(opdConfig.id, "main"));
    const p2 = await mkPatient(db, cashier.actor, { phone: "9876530005" });
    const r2 = await seat(p2, deptId, ortho.doctorId, MON);
    const on = await moveFromVitals(r2.encounter.id);
    expect(on.printSlip).toBe(true);
    await printMovedTokenSlip(db, vd.actor, on.encounterId);
    const jobs = await db.select().from(printJobs).where(eq(printJobs.encounterId, on.encounterId));
    expect(jobs.map((j) => j.document)).toEqual(["opd_token_slip"]);
  });
});
