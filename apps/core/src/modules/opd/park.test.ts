import { desc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries } from "../../kernel/db/schema";
import { completeConsultation, parkConsultation, resumeConsultation, saveConsultNote, startConsultation } from "./consultation";
import { getEncounter, openVisit } from "./encounters";
import { boardSnapshot, callNext, listQueue, summaryByDoctor } from "./queue";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE PARKED CONSULTATION (owner report, 2026-09-13) ═══
 *
 * *"in between the patient decide to stop and he gets outside for 15 minutes … Since I don't have
 * hold/park patient option/button, I simply clicked on call next button. Now the issue is that old
 * patient gets invisible in the dashboard. There's no any mechanism to choose the parked patient
 * and restart consultation."*
 *
 * The first patient was never deleted and never moved: `call-next` does not refuse a doctor with
 * somebody in the chair, so the row stayed `in_consult` — correct, the visit is not over — and no
 * screen rendered `in_consult` rows at all. These tests pin the two halves of the fix from the
 * server's side: the hold exists and is a fact anybody can read (P1, P2), and it is reversible with
 * everything the doctor had already written still in place (P3).
 */
const MON = new Date("2026-08-17T04:00:00.000Z");           // Monday 09:30 IST
const LATER = (min: number) => new Date(MON.getTime() + min * 60_000);
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("opd — parking a consultation and resuming it", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let asha: { id: string; uhid: string };
  let ram: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    roomId = masters.roomId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: masters.room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    asha = await mkPatient(db, clerk.actor);
    ram = await mkPatient(db, clerk.actor, { name: "Ram Prasad", sex: "male", phone: "9811100022", ageYears: 41 });
  });

  /** open → vitals (registered→waiting): a token that is callable, the production path. */
  async function arrive(patientId: string, at: Date = MON): Promise<{ encounterId: string; sessionId: string; entryId: string }> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, at);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, at);
    return { encounterId: opened.encounter.id, sessionId: opened.sessionId, entryId: opened.queueEntry.id };
  }

  async function seat(encounterId: string, sessionId: string, at: Date = MON): Promise<void> {
    await callNext(db, dra.actor, sessionId, at);
    await startConsultation(db, dra.actor, encounterId, at);
  }

  const entryOf = async (encounterId: string) => (await db
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0]!;
  const named = (name: string) => db.select().from(events).where(eq(events.name, name));

  it("P1: a park holds the consultation open — the encounter and the token do not move, and it is neither a completion nor a second start", async () => {
    const a = await arrive(asha.id);
    await seat(a.encounterId, a.sessionId);

    const parked = await parkConsultation(db, dra.actor, a.encounterId, LATER(6));

    expect(parked.queueEntry.status).toBe("in_consult");
    expect(parked.queueEntry.parkedAt).toEqual(LATER(6));
    expect(parked.queueEntry.parkedBy).toBe(dra.userId);
    expect((await getEncounter(db, a.encounterId))!.status).toBe("in_consultation");
    expect(await named("consultation.started")).toHaveLength(1);
    expect(await named("consultation.completed")).toHaveLength(0);

    const [e] = await named("consultation.parked");
    expect(e!.actorId).toBe(dra.userId);
    expect(e!.encounterId).toBe(a.encounterId);
    expect(e!.payload).toMatchObject({
      encounterId: a.encounterId, patientId: asha.id, entryId: a.entryId, doctorId: dra.doctorId,
      serviceDate: "2026-08-17", sessionId: a.sessionId, roomId, tokenNo: 1,
      parkedAt: LATER(6).toISOString(),
    });
  });

  /**
   * THE REPORTED DEFECT, from the server's side. The doctor parks, calls the next token, and the
   * first patient must still be on the queue view the screen reads — with the mark that says which
   * of the two is in the chair. Before the park existed this test could still be written and would
   * still pass on the first two assertions: what it could NOT answer is which patient is held, and
   * that is the question the rail needs to render an answer to.
   */
  it("P2: after parking, the next token is called and BOTH patients are on the queue view — one held, one in the chair", async () => {
    const a = await arrive(asha.id);
    const r = await arrive(ram.id, LATER(1));
    await seat(a.encounterId, a.sessionId);
    await parkConsultation(db, dra.actor, a.encounterId, LATER(6));

    await callNext(db, dra.actor, a.sessionId, LATER(7));
    await startConsultation(db, dra.actor, r.encounterId, LATER(8));

    const view = (await listQueue(db, dra.actor, dra.doctorId, "2026-08-17", LATER(9)))!;
    expect(view.counts.inConsult).toBe(2);
    const byEncounter = new Map(view.inConsult.map((x) => [x.encounterId, x] as const));
    expect(byEncounter.get(a.encounterId)!.parkedAt).toEqual(LATER(6));
    expect(byEncounter.get(a.encounterId)!.patient!.uhid).toBe(asha.uhid);
    expect(byEncounter.get(r.encounterId)!.parkedAt).toBeNull();
    // The held patient never re-joins the callable queue — their turn was held, not given back.
    expect(view.ordered).toHaveLength(0);
    expect(view.current).toBeNull();
  });

  it("P3: resume clears the hold, reports how long it lasted, and the note written before the park is still there", async () => {
    const a = await arrive(asha.id);
    await seat(a.encounterId, a.sessionId);
    await saveConsultNote(db, dra.actor, a.encounterId, { chiefComplaint: "fever 3d", diagnosis: "Acute pharyngitis" }, LATER(4));
    await parkConsultation(db, dra.actor, a.encounterId, LATER(6));

    const resumed = await resumeConsultation(db, dra.actor, a.encounterId, LATER(21));

    expect({ parkedAt: resumed.queueEntry.parkedAt, parkedBy: resumed.queueEntry.parkedBy, status: resumed.queueEntry.status })
      .toEqual({ parkedAt: null, parkedBy: null, status: "in_consult" });
    const enc = (await getEncounter(db, a.encounterId))!;
    expect({ status: enc.status, chiefComplaint: enc.chiefComplaint, diagnosis: enc.diagnosis })
      .toEqual({ status: "in_consultation", chiefComplaint: "fever 3d", diagnosis: "Acute pharyngitis" });

    const [e] = await named("consultation.resumed");
    expect(e!.payload).toMatchObject({ encounterId: a.encounterId, parkedAt: LATER(6).toISOString(), parkedMs: 15 * 60_000 });
    // A resume is not a new consultation: the day still counts one start for this patient.
    expect(await named("consultation.started")).toHaveLength(1);
  });

  it("P4: only the treating doctor parks, only a consultation parks, and a held patient cannot be held twice or resumed twice", async () => {
    const a = await arrive(asha.id);

    // not in consultation yet — there is nothing to hold
    await expect(parkConsultation(db, dra.actor, a.encounterId, LATER(2))).rejects.toMatchObject({ code: "encounter_state_conflict" });
    await seat(a.encounterId, a.sessionId);
    await expect(parkConsultation(db, drb.actor, a.encounterId, LATER(6))).rejects.toMatchObject({ code: "not_your_patient" });
    await expect(parkConsultation(db, clerk.actor, a.encounterId, LATER(6))).rejects.toMatchObject({ code: "not_a_doctor" });
    await expect(resumeConsultation(db, dra.actor, a.encounterId, LATER(6))).rejects.toMatchObject({ code: "queue_entry_state_conflict" });

    await parkConsultation(db, dra.actor, a.encounterId, LATER(6));
    await expect(parkConsultation(db, dra.actor, a.encounterId, LATER(7))).rejects.toMatchObject({ code: "queue_entry_state_conflict" });
    // the first park stands: a refused second one must not restamp the clock
    expect((await entryOf(a.encounterId)).parkedAt).toEqual(LATER(6));

    await resumeConsultation(db, dra.actor, a.encounterId, LATER(9));
    await expect(resumeConsultation(db, dra.actor, a.encounterId, LATER(10))).rejects.toMatchObject({ code: "queue_entry_state_conflict" });
    expect(await named("consultation.resumed")).toHaveLength(1);
  });

  /**
   * ═══ THE CORRIDOR BOARD MUST NOT CALL A PARKED TOKEN ═══
   *
   * `summarise` answers "now serving" with the called row, or failing that the first `in_consult`
   * row it finds — and with a park that is the patient who is NOT in the room. The hall would read
   * "now serving 1" over an empty chair while the doctor saw token 2, and the parked patient's
   * family would send them back in. A hold is invisible to the public board by design: it says who
   * is actually with the doctor, and when that is nobody it says nothing.
   */
  it("P6: the board and the desk announce the patient in the chair, never the one being held", async () => {
    const a = await arrive(asha.id);
    const r = await arrive(ram.id, LATER(1));
    await seat(a.encounterId, a.sessionId);
    await parkConsultation(db, dra.actor, a.encounterId, LATER(6));

    // held, and nobody else called yet: the doctor is serving NOBODY, and the board says so
    const alone = await boardSnapshot(db, "2026-08-17", undefined, LATER(7));
    expect(alone.find((b) => b.doctorId === dra.doctorId)!.nowServing).toBeNull();

    await callNext(db, dra.actor, a.sessionId, LATER(7));
    await startConsultation(db, dra.actor, r.encounterId, LATER(8));

    const board = await boardSnapshot(db, "2026-08-17", undefined, LATER(9));
    expect(board.find((b) => b.doctorId === dra.doctorId)!.nowServing).toBe(2);
    const desk = await summaryByDoctor(db, deptId, "2026-08-17", LATER(9));
    expect(desk.find((d) => d.doctor.id === dra.doctorId)!.nowServing).toBe(2);
  });

  it("P5: completing a patient who was parked finishes the visit and leaves no hold behind — done and held are never both true", async () => {
    const a = await arrive(asha.id);
    await seat(a.encounterId, a.sessionId);
    await parkConsultation(db, dra.actor, a.encounterId, LATER(6));

    const done = await completeConsultation(db, dra.actor, a.encounterId, { testsOrderedReturnToday: false }, LATER(30));

    expect(done.encounter.status).toBe("completed");
    const entry = await entryOf(a.encounterId);
    expect({ status: entry.status, parkedAt: entry.parkedAt, parkedBy: entry.parkedBy })
      .toEqual({ status: "done", parkedAt: null, parkedBy: null });
  });
});
