import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { events, ipdAdmissions, ipdBedStays, ipdUnitTransfers, rosterDutyWindows, rosterTeams } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkRoundsWorld } from "../../../../test/helpers/ipd";
import { orgDepartmentByCode } from "../../roster";
import { admit, emergencyAdmit, planAdmission, requestAdmission, transferUnit, unitCensus } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { RoundsWorld } from "../../../../test/helpers/ipd";

/**
 * ACCEPTANCE — issue #962, spec docs/specs/962-doctor-desk-ward.md (owner APPROVED 2026-10-26), the IPD half:
 *
 *   D1  every new admission has a unit; an ER admission that ARRIVED at 07:55 and was ENTERED at 08:10 belongs to the
 *       unit that was on take at 07:55 (last night's), not the consultant's own unit and not the 08:00 unit.
 *   D2  the unit census for a take day (08:00 → 08:00 IST) equals a hand-counted fixture.
 *
 * Every act runs at an explicit IST instant; nothing reads the real clock.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();

describe("spec #962 — the unit stamp and the unit census (IPD)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: RoundsWorld;
  let medU1: string;
  let medU2: string;
  let surU1: string;
  let n = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkRoundsWorld(db);
    n = 0;
    const team = async (code: string) => (await db.select({ id: rosterTeams.id }).from(rosterTeams).where(eq(rosterTeams.code, code)))[0]!.id;
    medU1 = await team("T-MED-U1");
    surU1 = await team("T-SUR-U1");
    const med = (await orgDepartmentByCode(db, "MED"))!.id;
    medU2 = newId();
    const by = { createdBy: w.doctor.id, updatedBy: w.doctor.id };
    await db.insert(rosterTeams).values({
      id: medU2, kind: "clinical_unit", departmentId: med, code: "T-MED-U2", name: "General Medicine Unit II", active: true,
      validFrom: new Date("2026-01-01T00:00:00Z"), ...by,
    } as never);
    // The take: Unit II from Mon 08:00 to Tue 08:00, Unit I from Tue 08:00 to Wed 08:00 (half-open, roster V12).
    await db.insert(rosterDutyWindows).values([
      { id: newId(), departmentId: med, teamId: medU2, activity: "take", startsAt: ist("2026-03-09T08:00:00"), endsAt: ist("2026-03-10T08:00:00"), source: "cycle", ...by },
      { id: newId(), departmentId: med, teamId: medU1, activity: "take", startsAt: ist("2026-03-10T08:00:00"), endsAt: ist("2026-03-11T08:00:00"), source: "cycle", ...by },
    ] as never);
  });

  /** An emergency-lane admission under `consultantId` onto a fresh MED-ward bed at `at`. */
  const erAdmit = async (consultantId: string, at: Date, erArrivedAt?: Date) => {
    n += 1;
    const patientId = await w.patient("male", 50);
    const bedId = await w.bed(`U-${String(n)}`, { class: "general" });
    const done = await emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: key(), patientId, bedId, consultantId, isolation: "none", mlc: false,
    }, { now: at, ...(erArrivedAt === undefined ? {} : { erArrivedAt }) });
    return { admissionId: done.admissionId, patientId };
  };
  const row = async (admissionId: string) => (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!;
  /** Ends a stay in `state` at `at` (the exits' own acts are covered by the discharge suite; the census reads the rows). */
  const end = async (admissionId: string, state: "discharged" | "lama" | "absconded" | "deceased", at: Date) => {
    await db.update(ipdBedStays).set({ endedAt: at, endedBy: w.admitDesk.id }).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt)));
    await db.update(ipdAdmissions).set({ state, endedAt: at, endedBy: w.admitDesk.id, updatedAt: at }).where(eq(ipdAdmissions.id, admissionId));
  };

  it("spec #962 D1: every new admission has a unit; an ER arrival at 07:55 entered at 08:10 belongs to the night's unit on take", async () => {
    // The ER case: the consultant is Unit I faculty, and Unit I takes over at 08:00 — but the patient came through the door at 07:55.
    const er = await erAdmit(w.doctor.id, ist("2026-03-10T08:10:00"), ist("2026-03-10T07:55:00"));
    expect((await row(er.admissionId)).admittedUnderTeamId).toBe(medU2);

    // An ER admission arriving after 08:00 belongs to the day's take unit.
    const late = await erAdmit(w.head.id, ist("2026-03-10T09:30:00"), ist("2026-03-10T09:05:00"));
    expect((await row(late.admissionId)).admittedUnderTeamId).toBe(medU1);

    // A planned admission (OPD advice / direct) belongs to the consultant's own unit, whoever is on take.
    const p = await w.patient("female", 40);
    const at = ist("2026-03-10T03:00:00");
    const { admissionId } = await requestAdmission(db, w.doctor, {
      idempotencyKey: key(), patientId: p, source: "direct", consultantId: w.cross.id, requestedClass: "general",
      isolation: "none", provisionalDiagnosis: "Synthetic hernia", mlc: false,
    }, { now: at });
    await planAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId, payerKind: "pmjay", requestedClass: "general", plan: { kind: "medical" } }, { now: at });
    const bed = await w.bed("U-PLAN", { class: "general" });
    await admit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, bedId: bed, consent: { signedBy: "patient", method: "paper", witnessName: "Synthetic Witness" },
      deposit: { exempt: "scheme" },
    }, { now: at });
    expect((await row(admissionId)).admittedUnderTeamId).toBe(surU1);

    // Every admission made here carries a unit.
    const all = await db.select({ id: ipdAdmissions.id, team: ipdAdmissions.admittedUnderTeamId }).from(ipdAdmissions);
    expect(all.length).toBe(3);
    expect(all.filter((a) => a.team === null)).toEqual([]);

    // A change of unit is a row and an event; the stamp itself is never edited.
    const moved = await transferUnit(db, w.consultant, { admissionId: er.admissionId, toTeamId: medU1, reason: "Synthetic: belongs to Unit I's speciality" }, { now: ist("2026-03-10T11:00:00") });
    expect(moved).toMatchObject({ fromTeamId: medU2, toTeamId: medU1 });
    expect((await row(er.admissionId)).admittedUnderTeamId).toBe(medU2);
    const rows = await db.select().from(ipdUnitTransfers).where(eq(ipdUnitTransfers.admissionId, er.admissionId));
    expect(rows).toHaveLength(1);
    const ev = await db.select().from(events).where(eq(events.name, "ipd.admission.unit_transferred"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ admissionId: er.admissionId, fromTeamId: medU2, toTeamId: medU1 });
  });

  it("spec #962 D2: the take-day census equals the hand-counted fixture", async () => {
    // The take day Tue 10 March: 08:00 IST Tue → 08:00 IST Wed. Unit I (`w.doctor`'s unit). No take windows matter here:
    // these are emergency-lane admissions with no ER arrival, so the unit is the consultant's (D1's fallback).
    await db.delete(rosterDutyWindows);
    const a1 = await erAdmit(w.doctor.id, ist("2026-03-10T09:00:00")); // admitted, still in → admitted, occupied, midnight
    const a2 = await erAdmit(w.doctor.id, ist("2026-03-10T10:00:00")); // admitted, discharged the same evening
    const a3 = await erAdmit(w.doctor.id, ist("2026-03-09T12:00:00")); // yesterday's, left against advice today
    const a4 = await erAdmit(w.doctor.id, ist("2026-03-09T13:00:00")); // yesterday's, absconded today
    const a5 = await erAdmit(w.doctor.id, ist("2026-03-10T11:00:00")); // admitted, died at 02:00 (in bed at midnight)
    const a6 = await erAdmit(w.doctor.id, ist("2026-03-09T14:00:00")); // ours, moved to Surgery Unit I today → out
    const a7 = await erAdmit(w.cross.id, ist("2026-03-09T15:00:00")); //  Surgery's, moved to us today → in, occupied, midnight
    await erAdmit(w.doctor.id, ist("2026-03-10T07:30:00")); //             the previous take day's; still in → occupied, midnight
    await erAdmit(w.doctor.id, ist("2026-03-11T08:30:00")); //             the next take day's → not counted at all
    await erAdmit(w.cross.id, ist("2026-03-10T09:30:00")); //              another unit's → not counted

    await end(a2.admissionId, "discharged", ist("2026-03-10T20:00:00"));
    await end(a3.admissionId, "lama", ist("2026-03-10T15:00:00"));
    await end(a4.admissionId, "absconded", ist("2026-03-10T16:00:00"));
    await end(a5.admissionId, "deceased", ist("2026-03-11T02:00:00"));
    await transferUnit(db, w.consultant, { admissionId: a6.admissionId, toTeamId: surU1, reason: "Synthetic: surgical abdomen" }, { now: ist("2026-03-10T12:00:00") });
    await transferUnit(db, w.consultant, { admissionId: a7.admissionId, toTeamId: medU1, reason: "Synthetic: medical problem" }, { now: ist("2026-03-10T13:00:00") });
    void a1;

    const c = await unitCensus(db, medU1, "2026-03-10", ist("2026-03-11T09:00:00"));
    expect(c).toMatchObject({
      teamId: medU1, takeDay: "2026-03-10",
      admitted: 3, discharged: 1, lama: 1, absconded: 1, deaths: 1, transfersIn: 1, transfersOut: 1,
      occupied: 3, bedsAtMidnight: 4,
    });
    expect(c.from.toISOString()).toBe(ist("2026-03-10T08:00:00").toISOString());
    expect(c.to.toISOString()).toBe(ist("2026-03-11T08:00:00").toISOString());

    // Asked during the take day, the midnight census has not happened yet: absent, never a zero.
    const during = await unitCensus(db, medU1, "2026-03-10", ist("2026-03-10T21:00:00"));
    expect(during.bedsAtMidnight).toBeNull();
  });
});
