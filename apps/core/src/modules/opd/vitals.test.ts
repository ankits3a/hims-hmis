import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries, opdVitals, phiAccessLog, workflowInstances, workflowTimers } from "../../kernel/db/schema";
import { abandonVisit, getEncounter, openVisit } from "./encounters";
import { amendVitals, getVitalsForAmend, recordVitals } from "./vitals";
import { setBenchState } from "./bench";
import type { Db } from "../../kernel/db/client";

/** Monday 2026-08-17, 09:30 IST — the encounters.test.ts anchor. */
const MON = new Date("2026-08-17T04:00:00.000Z");
/**
 * Fixed DOBs, never `ageYears` (prescriptions.test.ts precedent): registration derives an estimated dob from the
 * REAL wall clock, so an age asserted against the pinned MON drops by one the day the anniversary passes.
 * At MON these are exactly 30 (adult band) and 3 (child_1_5 band) whatever day the suite runs.
 */
const DOB_ADULT = new Date(Date.UTC(1996, 0, 15));
const DOB_CHILD = new Date(Date.UTC(2023, 0, 15));
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("opd vitals (recording, danger flags, the registered→waiting move)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let patient: { id: string; uhid: string };
  let childPatient: { id: string; uhid: string };

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
    patient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ADULT });
    childPatient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_CHILD, guardian: { name: "G", relationship: "mother" } });
  });

  it("normal recording moves registered → waiting", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);

    expect(r.flags).toEqual([]);
    expect(r.vitals.band).toBe("adult");
    expect(r.vitals.ageYearsAtRecord).toBe(30);
    expect(r.vitals.dangerFlags).toEqual([]);
    expect(r.vitals.recordedBy).toBe(vd.id);
    expect(r.encounter.status).toBe("waiting");
    expect(r.encounter.dangerFlagged).toBe(false);

    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry.status).toBe("waiting");
    expect(entry.eligibleAt).toEqual(MON);
    expect(entry.danger).toBe(false);

    const recorded = await db.select().from(events).where(eq(events.name, "vitals.recorded"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      encounterId: opened.encounter.id, vitalsId: r.vitals.id, band: "adult", dangerCount: 0, tokenNo: 1, serviceDate: "2026-08-17",
    });
    const flagged = await db.select().from(events).where(eq(events.name, "vitals.danger_flagged"));
    expect(flagged).toHaveLength(0);

    const inst = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, r.encounter.workflowInstanceId)))[0]!;
    expect(inst.currentState).toBe("waiting");
    const timers = await db.select().from(workflowTimers).where(and(
      eq(workflowTimers.instanceId, r.encounter.workflowInstanceId), eq(workflowTimers.state, "waiting"),
      isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt),
    ));
    expect(timers).toHaveLength(1);
  });

  it("danger flags and never auto-clears", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r1 = await recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, sbp: 190 }, MON);
    expect(r1.flags).toEqual([{ vital: "sbp", value: 190, bound: "max", limit: 180, severity: "danger" }]);
    expect(r1.encounter.dangerFlagged).toBe(true);

    const entry1 = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry1.danger).toBe(true);

    const flaggedEvents = await db.select().from(events).where(eq(events.name, "vitals.danger_flagged"));
    expect(flaggedEvents).toHaveLength(1);
    expect(flaggedEvents[0]!.payload).toMatchObject({
      flags: [{ vital: "sbp", value: 190, bound: "max", limit: 180, severity: "danger" }], tokenNo: 1,
    });

    const MON5 = new Date(MON.getTime() + 5 * 60_000);
    const r2 = await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON5);
    expect(r2.vitals.dangerFlags).toEqual([]);
    expect(r2.encounter.dangerFlagged).toBe(true); // never auto-clears

    const entry2 = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry2.danger).toBe(true);

    const inst = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, r2.encounter.workflowInstanceId)))[0]!;
    expect(inst.currentState).toBe("waiting");
    const timers = await db.select().from(workflowTimers).where(and(
      eq(workflowTimers.instanceId, r2.encounter.workflowInstanceId), eq(workflowTimers.state, "waiting"),
      isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt),
    ));
    expect(timers).toHaveLength(1); // no second transition

    const recordedEvents = await db.select().from(events).where(eq(events.name, "vitals.recorded"));
    expect(recordedEvents).toHaveLength(2);
  });

  it("incomplete writes nothing", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await expect(recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, weightKg: undefined }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["weightKg"] } });

    const vitalsRows = await db.select().from(opdVitals).where(eq(opdVitals.encounterId, opened.encounter.id));
    expect(vitalsRows).toHaveLength(0);
    const opdEvents = await db.select().from(events).where(eq(events.module, "opd"));
    expect(opdEvents).toHaveLength(2); // visit.opened + patient.checked_in only
    expect((await getEncounter(db, opened.encounter.id))!.status).toBe("registered");
  });

  it("pediatric band + weight context", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: childPatient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    // VD-1 T1 / D5 — `muacCm` joined this band's required list, so the fixture gained it. 13.4 is
    // deliberately in the GREEN zone: the pulse flag below is then the only one, which is what
    // makes the assertion about pulse still an assertion about pulse.
    const kid = { heightCm: 92, weightKg: 14, tempC: 37.2, spo2: 98, muacCm: 13.4 };
    const r = await recordVitals(db, vd.actor, opened.encounter.id, { ...kid, pulse: 155 }, MON);
    expect(r.vitals.band).toBe("child_1_5");
    expect(r.vitals.ageYearsAtRecord).toBe(3);
    expect(r.vitals.muacCm).toBe(13.4);
    expect(r.flags).toEqual([{ vital: "pulse", value: 155, bound: "max", limit: 150, severity: "danger" }]);

    await expect(recordVitals(db, vd.actor, opened.encounter.id, { heightCm: 92, tempC: 37.2, spo2: 98, pulse: 100, muacCm: 13.4 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["weightKg"] } });
    await expect(recordVitals(db, vd.actor, opened.encounter.id, { ...kid, pulse: 100, muacCm: undefined }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["muacCm"] } });
  });

  /**
   * ═══ VD-1 T1 — THE READING, THROUGH THE SERVICE AND INTO THE ROW ═══
   *
   * The pure rules are proved in `vitals-rules.test.ts`; what is proved here is that the storage
   * carries them — that a pair reaches the table as a pair, that the scalar the four shipped
   * readers select is the OPERATIVE take, and that a held value is nowhere near the chart column.
   */
  it("a rest-and-recheck pair is ONE row: both takes stored, the scalars carry the LAST", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, { heightCm: 164, tempC: 36.6 }, MON, {
      readings: {
        bp: { takes: [[172, 104], [146, 88]], source: "device" },
        pulse: { takes: [86, 80], source: "device" },
        spo2: { takes: [96], source: "device", held: [45] },
        heightCm: { takes: [164], source: "typed" },
        weightKg: { takes: [61], source: "typed" },
        tempC: { takes: [36.6], source: "device" },
      },
      contextChips: [{ key: "bpmed", question: "BP dawa aaj li?", answer: "yes" }],
    });
    // The operative take — and 172/104 would have flagged, while 146/88 does not. The pair is on
    // the chart and the DOCTOR sees both; the flag follows the number they should act on.
    expect([r.vitals.sbp, r.vitals.dbp, r.vitals.pulse, r.vitals.spo2]).toEqual([146, 88, 80, 96]);
    expect(r.flags).toEqual([]);
    const stored = r.vitals.readings as { bp: { takes: number[][] }; spo2: { held: number[] } };
    expect(stored.bp.takes).toEqual([[172, 104], [146, 88]]);
    expect(stored.spo2.held).toEqual([45]); // seen, logged, and never a chart fact
    expect(r.vitals.contextChips).toEqual([{ key: "bpmed", question: "BP dawa aaj li?", answer: "yes" }]);
  });

  it("a flat body still records, and gets one typed take per vital — no row has two shapes", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    const stored = r.vitals.readings as Record<string, { takes: unknown; source: string }>;
    expect(stored.bp).toEqual({ takes: [[adultOk.sbp, adultOk.dbp]], source: "typed" });
    expect(stored.weightKg).toEqual({ takes: [adultOk.weightKg], source: "typed" });
    expect(r.vitals.emergency).toBe(false);
    expect(r.vitals.carriedForward).toEqual([]);
    expect(r.vitals.status).toBe("active");
    expect(r.vitals.supersedesVitalsId).toBeNull();
  });

  it("a declared emergency saves on BP + pulse + SpO2 alone; an undeclared one does not", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const crashing = { sbp: 208, dbp: 126, pulse: 104, spo2: 91 };
    await expect(recordVitals(db, vd.actor, opened.encounter.id, crashing, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete" });
    const r = await recordVitals(db, vd.actor, opened.encounter.id, crashing, MON, { emergency: true });
    expect(r.vitals.emergency).toBe(true);
    expect(r.vitals.heightCm).toBeNull();
    expect(r.flags.map((f) => f.vital).sort()).toEqual(["dbp", "sbp"]);
  });

  /**
   * ═══ THIS TEST GAINED A FIRST VISIT WHEN T2's CARRIED LOCK LANDED, AND THE REASON IS THE POINT ═══
   *
   * As first written it carried a height forward for a patient with NO previous reading, and T2
   * refused it — correctly. `carriedForward: ["heightCm"]` is a PROVENANCE CLAIM that a doctor is
   * shown: it says "this number was measured at an earlier visit, not today". A claim of that
   * shape against an empty history is either a mistake or a fiction, and the lock is what makes it
   * one that cannot be recorded. So the fixture gained the visit it was always implying (method
   * §9.8 rule 3: ask which invariant carries the property, do not reach for a test-only seam).
   */
  it("a carried-forward key is not missing — provenance is stored, not inferred", async () => {
    const first = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, first.encounter.id, { ...adultOk, heightCm: 151 }, MON); // 151 on record

    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const noHeight = { ...adultOk, heightCm: undefined };
    await expect(recordVitals(db, vd.actor, opened.encounter.id, noHeight, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["heightCm"] } });
    const r = await recordVitals(db, vd.actor, opened.encounter.id, { ...noHeight, heightCm: 151 }, MON, {
      carriedForward: ["heightCm"],
    });
    expect(r.vitals.carriedForward).toEqual(["heightCm"]);
    expect(r.vitals.heightCm).toBe(151);

    // And the claim cannot be made where there is nothing to carry FROM — a different patient,
    // first visit, same body. This is the leg the original fixture was accidentally exercising.
    const stranger = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ADULT });
    const strangerVisit = await openVisit(db, clerk.actor, { patientId: stranger.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await expect(recordVitals(db, vd.actor, strangerVisit.encounter.id, { ...noHeight, heightCm: 151 }, MON, { carriedForward: ["heightCm"] }))
      .rejects.toMatchObject({ code: "carried_value_locked", detail: { locked: [{ key: "heightCm", carried: null, supplied: 151 }] } });
  });

  it("gates: invalid ranges, role_denied writes nothing, and a non-recordable state", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);

    await expect(recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, spo2: 101 }, MON))
      .rejects.toMatchObject({ code: "invalid_vitals" });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, opened.encounter.id))).toHaveLength(0);

    await expect(recordVitals(db, clerk.actor, opened.encounter.id, adultOk, MON))
      .rejects.toMatchObject({ name: "WorkflowError", code: "role_denied" });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, opened.encounter.id))).toHaveLength(0);
    expect((await getEncounter(db, opened.encounter.id))!.status).toBe("registered");

    await abandonVisit(db, clerk.actor, opened.encounter.id, "left before vitals", MON);
    await expect(recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  /**
   * ═══ VD-1 CLOSE / F1 — THE FEVER REACHES THE DOCTOR AND THE QUEUE DOES NOT MOVE ═══
   *
   * The pure rule is proved in `vitals-rules.test.ts`. What is proved HERE is the half that
   * actually decides a child's afternoon: the notice is STORED where the doctor reads it, and
   * `opd_queue_entries.danger` — queue class 0 — is untouched. Getting this wrong in the generous
   * direction would seat a febrile toddler ahead of a stroke.
   */
  it("F1: a paediatric fever is flagged to the doctor and does NOT move the board", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: childPatient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, {
      heightCm: 92, weightKg: 14, tempC: 38.9, spo2: 98, pulse: 110, muacCm: 13.4,
    }, MON);

    // The doctor sees it — it is on the chart the consultation screen reads.
    expect(r.flags).toEqual([{ vital: "tempC", value: 38.9, bound: "max", limit: 37.9, severity: "notice" }]);
    expect(r.vitals.dangerFlags).toEqual([{ vital: "tempC", value: 38.9, bound: "max", limit: 37.9, severity: "notice" }]);

    // …and the board does not move. Neither the clinical danger flag nor queue class 0.
    expect(r.encounter.dangerFlagged).toBe(false);
    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry.danger).toBe(false);

    // No `vitals.danger_flagged` — a notice is not a danger, and an event that said otherwise
    // would reach every queue screen watching that doctor-day.
    expect(await db.select().from(events).where(eq(events.name, "vitals.danger_flagged"))).toHaveLength(0);
    const recorded = (await db.select().from(events).where(eq(events.name, "vitals.recorded")))[0]!;
    expect(recorded.payload).toMatchObject({ dangerCount: 0, noticeCount: 1 });
  });

  it("F1: a genuine paediatric danger still moves the board — the notice did not soften anything", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: childPatient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, {
      heightCm: 92, weightKg: 14, tempC: 40.2, spo2: 98, pulse: 110, muacCm: 13.4,
    }, MON);
    expect(r.flags).toEqual([{ vital: "tempC", value: 40.2, bound: "max", limit: 39.5, severity: "danger" }]);
    expect(r.encounter.dangerFlagged).toBe(true);
    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry.danger).toBe(true);
  });

  // ═══ VD-2 T0 — the independent review VD-1 owed, findings F1 F2 F3 F6 and two MINORs ═══

  it("T0/F1: amend holds the carried lock — a carried key changed without a reason is refused, and a same-visit correction is gated against the PREDECESSOR", async () => {
    const first = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, first.encounter.id, { ...adultOk, heightCm: 151 }, MON);
    const second = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, second.encounter.id, { ...adultOk, heightCm: 151 }, MON, { carriedForward: ["heightCm"] });
    // 149 under carried provenance with no reason: refused, ZERO new rows.
    await expect(amendVitals(db, vd.actor, r.vitals.id, { ...adultOk, heightCm: 149 }, "typo", MON, { carriedForward: ["heightCm"] }))
      .rejects.toMatchObject({ code: "carried_value_locked", detail: { locked: [{ key: "heightCm", carried: 151, supplied: 149 }] } });
    const rows = await db.select().from(opdVitals).where(eq(opdVitals.encounterId, second.encounter.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("active");
    // With a preset reason the amendment lands and names the old value.
    const a = await amendVitals(db, vd.actor, r.vitals.id, { ...adultOk, heightCm: 149 }, "re-measured", MON, {
      carriedForward: ["heightCm"], unlockReasons: { heightCm: "patient_disputes_old_value" },
    });
    expect(a.vitals.heightCm).toBe(149);
    expect((a.vitals.readings as { heightCm?: { note?: string } }).heightCm?.note).toContain("was 151");
  });

  it("T0/F1: a same-visit correction is gated against the PREDECESSOR, not the row being replaced", async () => {
    const first = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, first.encounter.id, { ...adultOk, heightCm: 151 }, MON);
    const second = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, second.encounter.id, { ...adultOk, heightCm: 153 }, MON); // 2 cm: passes
    // 153 → 150 is 3 cm from the row being replaced (the gate's threshold) and 1 cm from the
    // predecessor. Compared against `prior` this fired `shrinking_adult` at the value being corrected.
    const fixed = await amendVitals(db, vd.actor, r.vitals.id, { ...adultOk, heightCm: 150 }, "mistyped", MON);
    expect(fixed.vitals.heightCm).toBe(150);
    // The gate still runs, against the predecessor: 5 cm from 151 is held.
    await expect(amendVitals(db, vd.actor, fixed.vitals.id, { ...adultOk, heightCm: 156 }, "again", MON))
      .rejects.toMatchObject({ code: "vitals_gate" });
  });

  it("T0/F2: an amendment that REVEALS a danger moves the board and fires vitals.danger_flagged; a notice-only amendment sets nothing", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, spo2: 95 }, MON);
    expect((await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!.danger).toBe(false);
    const a = await amendVitals(db, vd.actor, r.vitals.id, { ...adultOk, spo2: 85 }, "probe was on the wrong finger", MON);
    expect(a.flags.map((f) => f.vital)).toEqual(["spo2"]);
    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry.danger).toBe(true);
    expect((await getEncounter(db, opened.encounter.id))!.dangerFlagged).toBe(true);
    const flagged = await db.select().from(events).where(eq(events.name, "vitals.danger_flagged"));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.payload).toMatchObject({ vitalsId: a.vitals.id, tokenNo: 1 });

    // The child: 37.4 corrected to 38.5 is a NOTICE (F1) — the doctor sees it, the board does not move.
    const kid = await openVisit(db, clerk.actor, { patientId: childPatient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const childOk = { heightCm: 95, weightKg: 14, pulse: 100, rr: 24, spo2: 98, tempC: 37.4, muacCm: 15 };
    const k = await recordVitals(db, vd.actor, kid.encounter.id, childOk, MON);
    const ka = await amendVitals(db, vd.actor, k.vitals.id, { ...childOk, tempC: 38.5 }, "re-read the strip", MON);
    expect(ka.flags.map((f) => f.severity)).toEqual(["notice"]);
    expect((await getEncounter(db, kid.encounter.id))!.dangerFlagged).toBe(false);
    expect((await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, kid.encounter.id)))[0]!.danger).toBe(false);
    expect(await db.select().from(events).where(eq(events.name, "vitals.danger_flagged"))).toHaveLength(1); // still the adult's
  });

  it("T0/F6: the nurse who charted a CONFIDENTIAL patient can amend that chart — one rule for record and correct", async () => {
    const vip = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ADULT, isConfidential: true, alias: "Patient 4F2" });
    const opened = await openVisit(db, clerk.actor, { patientId: vip.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, pulse: 27 }, MON); // transposed 72
    const a = await amendVitals(db, vd.actor, r.vitals.id, { ...adultOk, pulse: 72 }, "transposed digits", MON, {
      overrides: {},
    });
    expect(a.vitals.pulse).toBe(72);
    expect(a.superseded).toBe(r.vitals.id);
  });

  it("T0 (MINOR): emergency on the amend body is honoured, and a chart save clears the bench state", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await setBenchState(db, vd.actor, opened.encounter.id, { state: "resting", restMinutes: 5 }, MON);
    expect((await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!.benchState).toBe("resting");
    const r = await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry.benchState).toBeNull();
    expect(entry.recallAt).toBeNull();
    // An amendment declared an emergency saves on BP + pulse + SpO₂ alone.
    const a = await amendVitals(db, vd.actor, r.vitals.id, { sbp: 118, dbp: 78, pulse: 70, spo2: 97 }, "collapsed at the bench", MON, { emergency: true });
    expect(a.vitals.emergency).toBe(true);
    expect(a.vitals.heightCm).toBeNull();
  });

  it("CLOSE/pass1: the chart a nurse may amend, she may READ — a confidential patient's row under vitals_desk, logged", async () => {
    const vip = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ADULT, isConfidential: true, alias: "Patient 4F2" });
    const opened = await openVisit(db, clerk.actor, { patientId: vip.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    const row = await getVitalsForAmend(db, vd.actor, r.vitals.id);
    expect(row?.id).toBe(r.vitals.id);
    expect(await getVitalsForAmend(db, vd.actor, "no-such-row")).toBeNull();
    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, vip.id));
    expect(logged.some((l) => l.surface === "opd.vitals" && l.encounterId === opened.encounter.id)).toBe(true);
  });

  it("CLOSE/pass2 F2: a chart whose SpO₂ was CONFIRMED at 68 can have its WEIGHT amended — the prior row's own values are not gated again", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, spo2: 68, weightKg: 22 }, MON, {
      readings: { spo2: { takes: [68], source: "typed", held: [68] }, weightKg: { takes: [22], source: "typed" } },
      overrides: { spo2: "confirmed_reclip", weightKg: "confirmed_real" },
    });
    expect(r.vitals.spo2).toBe(68);
    const a = await amendVitals(db, vd.actor, r.vitals.id, { ...adultOk, spo2: 68, weightKg: 22, pulse: 96 }, "pulse re-read", MON, {
      readings: { spo2: { takes: [68], source: "typed", held: [68] }, weightKg: { takes: [22], source: "typed" }, pulse: { takes: [96], source: "typed" } },
    });
    expect(a.vitals.pulse).toBe(96);
    expect(a.vitals.spo2).toBe(68);
    // a NEW low value on the amendment is still held: the gate judges what changed
    await expect(amendVitals(db, vd.actor, a.vitals.id, { ...adultOk, spo2: 40, weightKg: 22 }, "slipped", MON))
      .rejects.toMatchObject({ code: "vitals_incomplete" });
  });
});
