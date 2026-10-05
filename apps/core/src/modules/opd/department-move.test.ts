import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, invoiceLines, opdAppointments, opdQueueEntries } from "../../kernel/db/schema";
import { issueCreditNote, issueInvoice } from "../billing";
import { bookAppointment, checkInAppointment, rescheduleAppointment } from "./appointments";
import { moveVisitDepartment, previewDepartmentMove } from "./department-move";
import { getEncounter, moveEncounter, openVisit } from "./encounters";
import { loadOpdReport, rangeFor } from "./report";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/**
 * Owner 2026-10-05 — "Wrong department — move patient": the desk seated a patient in the wrong
 * department; one act moves them, and the OPD report follows without anyone touching it.
 */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const T0 = new Date("2026-08-08T10:00:00.000Z"); // an earlier consult day

describe("OPD — move a visit to the right department", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let ortho: Awaited<ReturnType<typeof mkDoctor>>; // "the wrong department" (dept)
  let medic: Awaited<ReturnType<typeof mkDoctor>>; // "the right one" (dept2)
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
    clerk = await mkUser(db, "dm_clerk", ["front_office", "cashier"]);
    vd = await mkUser(db, "dm_vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor);
  });

  const seatInOrtho = () => openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
  const move = (encounterId: string, reason = "patient asked for medicine; booked in ortho by mistake") =>
    moveVisitDepartment(db, clerk.actor, encounterId, { departmentId: dept2Id, doctorId: medic.doctorId, reason }, MON);

  it("in one act: the wrong visit is abandoned and its token cancelled; the right one opens with the new department's token", async () => {
    const wrong = await seatInOrtho();
    const r = await move(wrong.encounter.id);

    expect(r.from.encounter.status).toBe("abandoned");
    expect(r.from.encounter.abandonReason).toMatch(/^wrong department — /);
    expect(r.from.tokenNo).toBe(1);
    const oldEntry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, wrong.queueEntry.id)))[0]!;
    expect(oldEntry.status).toBe("cancelled");

    expect(r.to.encounter.departmentId).toBe(dept2Id);
    expect(r.to.encounter.doctorId).toBe(medic.doctorId);
    expect(r.to.encounter.status).toBe("registered");
    expect(r.to.encounter.visitNo).not.toBe(wrong.encounter.visitNo);
    expect(r.to.tokenNo).toBe(1); // the first in General Medicine's own series
    const live = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, r.to.encounter.id));
    expect(live.map((e) => e.status)).toEqual(["waiting_vitals"]);
  });

  it("writes visit.moved_department with who, from, to and why — plus the old visit's own visit.abandoned", async () => {
    const wrong = await seatInOrtho();
    const r = await move(wrong.encounter.id, "wrong department");
    const moved = await db.select().from(events).where(eq(events.name, "visit.moved_department"));
    expect(moved).toHaveLength(1);
    expect(moved[0]!.actorId).toBe(clerk.id);
    expect(moved[0]!.payload).toMatchObject({
      fromEncounterId: wrong.encounter.id, toEncounterId: r.to.encounter.id,
      fromDepartmentId: deptId, toDepartmentId: dept2Id, fromDoctorId: ortho.doctorId, toDoctorId: medic.doctorId,
      fromVisitType: "new", toVisitType: "new", fromTokenNo: 1, toTokenNo: 1, appointmentId: null, reason: "wrong department",
    });
    const abandoned = await db.select().from(events).where(and(eq(events.name, "visit.abandoned"), eq(events.encounterId, wrong.encounter.id)));
    expect(abandoned).toHaveLength(1);
  });

  it("re-classifies in the NEW department: a revisit there is a revisit, whatever the wrong one said", async () => {
    // A completed General Medicine consult 9 days back with a 14-day window: medicine sees a revisit.
    const prior = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: dept2Id, doctorId: medic.doctorId }, T0);
    let enc: EncounterRow = await withTx(db, (tx) => moveEncounter(tx, vd.actor, prior.encounter, "waiting", {}, T0));
    enc = await withTx(db, (tx) => moveEncounter(tx, medic.actor, enc, "in_consultation", {}, T0));
    await withTx(db, (tx) => moveEncounter(tx, medic.actor, enc, "completed", { consultCompletedAt: T0, followUpDays: 14 }, T0));

    const wrong = await seatInOrtho();
    expect(wrong.visitType).toBe("new"); // new to orthopaedics
    const preview = await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON);
    expect(preview).toMatchObject({ from: { visitType: "new" }, to: { departmentId: dept2Id, visitType: "revisit" }, standingInvoiceNo: null });
    const r = await move(wrong.encounter.id);
    expect(r.to.visitType).toBe("revisit");
    expect(r.to.encounter.visitType).toBe("revisit");
  });

  it("the OPD report follows by itself: the patient counts in General Medicine, not Orthopaedics", async () => {
    const wrong = await seatInOrtho();
    const range = rangeFor("day", "2026-08-17");
    const before = await loadOpdReport(db, range, MON);
    expect(before.departments.find((d) => d.departmentId === deptId)?.stillOpen).toBe(1);

    await move(wrong.encounter.id);
    const after = await loadOpdReport(db, range, MON);
    expect(after.departments.find((d) => d.departmentId === deptId)?.stillOpen ?? 0).toBe(0);
    expect(after.departments.find((d) => d.departmentId === dept2Id)?.stillOpen).toBe(1);
  });

  it("a checked-in APPOINTMENT moves with the patient, so the report's booked count follows too", async () => {
    const slot = new Date("2026-08-17T05:00:00.000Z"); // 10:30 IST
    const { appointment: appt } = await bookAppointment(db, clerk.actor, { patientId: patient.id, doctorId: ortho.doctorId, slotStart: slot }, new Date("2026-08-16T04:00:00.000Z"));
    const wrong = await checkInAppointment(db, clerk.actor, appt.id, MON);
    const range = rangeFor("day", "2026-08-17");
    expect((await loadOpdReport(db, range, MON)).departments.find((d) => d.departmentId === deptId)?.booked).toBe(1);

    const r = await move(wrong.encounter.id);
    const row = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appt.id)))[0]!;
    expect(row).toMatchObject({ departmentId: dept2Id, doctorId: medic.doctorId, encounterId: r.to.encounter.id, status: "checked_in" });
    expect(r.to.encounter.appointmentId).toBe(appt.id);
    const report = await loadOpdReport(db, range, MON);
    expect(report.departments.find((d) => d.departmentId === deptId)?.booked ?? 0).toBe(0);
    expect(report.departments.find((d) => d.departmentId === dept2Id)?.booked).toBe(1);
  });

  it("REFUSES while a bill stands against the visit — a credit note first; after a full credit note it moves", async () => {
    await openSessionFor(db, { id: clerk.id }, 200_000);
    const wrong = await seatInOrtho();
    const issued = await issueInvoice(db, clerk.actor, {
      draftId: "dm-1", patientId: patient.id, encounterId: wrong.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    });
    await expect(move(wrong.encounter.id)).rejects.toMatchObject({ code: "visit_billed_state_conflict" });
    expect((await getEncounter(db, wrong.encounter.id))!.status).toBe("registered"); // nothing moved
    expect((await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON)).standingInvoiceNo).toBe(issued.invoiceNo);

    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, issued.invoiceId));
    await issueCreditNote(db, clerk.actor, { invoiceId: issued.invoiceId, kind: "refund", reason: "wrong department", lines: [{ invoiceLineId: lines[0]!.id, qty: 1 }] });
    const r = await move(wrong.encounter.id);
    expect(r.to.encounter.departmentId).toBe(dept2Id);
  });

  it("refuses once the consult has begun, a blank reason, and the department the visit is already in", async () => {
    const wrong = await seatInOrtho();
    await expect(move(wrong.encounter.id, "  ")).rejects.toMatchObject({ code: "reason_required" });
    await expect(moveVisitDepartment(db, clerk.actor, wrong.encounter.id, { departmentId: deptId, doctorId: ortho.doctorId, reason: "x" }, MON))
      .rejects.toMatchObject({ code: "move_same_department" });

    let enc: EncounterRow = await withTx(db, (tx) => moveEncounter(tx, vd.actor, wrong.encounter, "waiting", {}, MON));
    enc = await withTx(db, (tx) => moveEncounter(tx, ortho.actor, enc, "in_consultation", {}, MON));
    await expect(move(enc.id)).rejects.toMatchObject({ code: "encounter_state_conflict" });
    expect(await db.select().from(events).where(eq(events.name, "visit.moved_department"))).toHaveLength(0);
  });

  it("a booking NOT yet checked in moves by reschedule to the new department's doctor, and says why", async () => {
    const slot = new Date("2026-08-17T05:00:00.000Z");
    const booked = new Date("2026-08-16T04:00:00.000Z");
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: patient.id, doctorId: ortho.doctorId, slotStart: slot }, booked);
    const { from, to } = await rescheduleAppointment(db, clerk.actor, appointment.id, { slotStart: slot, doctorId: medic.doctorId, reason: "booked in ortho by mistake" }, booked);
    expect(from.status).toBe("rescheduled");
    expect(to).toMatchObject({ departmentId: dept2Id, doctorId: medic.doctorId, status: "booked" });
    const ev = (await db.select().from(events).where(eq(events.name, "appointment.rescheduled")))[0]!;
    expect(ev.payload).toMatchObject({ previousDepartmentId: deptId, departmentId: dept2Id, reason: "booked in ortho by mistake" });
    const report = await loadOpdReport(db, rangeFor("day", "2026-08-17"), MON);
    expect(report.departments.find((d) => d.departmentId === deptId)?.booked ?? 0).toBe(0);
    expect(report.departments.find((d) => d.departmentId === dept2Id)?.booked).toBe(1);
  });

  it("a bill-first visit (no token yet) stays bill-first in the new department", async () => {
    const wrong = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId, join: "defer" }, MON);
    const r = await move(wrong.encounter.id);
    expect(r.from.tokenNo).toBeNull();
    expect(r.to.tokenNo).toBeNull();
    expect(await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, r.to.encounter.id))).toHaveLength(0);
  });
});
