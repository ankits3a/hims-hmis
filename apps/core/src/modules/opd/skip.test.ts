import { desc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { callNext, listQueue, skipCalled, undoSkip } from "./queue";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE SKIP: A REASON, AND A WAY BACK (owner report, 2026-09-13) ═══
 *
 * *"When as a doctor, I clicked 'Skip' by mistake and that patient is no where to be seen in my
 * dashboard to undo my mistake … doctors do not have any input box or pre-identified reason to
 * select … it should be auditable. right?"*
 *
 * Measured in the owner's own data that afternoon, and it is the fixture these tests are built to
 * reproduce: one patient at the three-skip cap with entry `left` and encounter `waiting` — a
 * patient the hospital believed was waiting, on no queue and no screen, callable by nobody.
 */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const AT = (min: number) => new Date(MON.getTime() + min * 60_000);
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("opd — why a token was skipped, and taking the skip back", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
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
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    asha = await mkPatient(db, clerk.actor);
    ram = await mkPatient(db, clerk.actor, { name: "Ram Prasad", sex: "male", phone: "9811100022", ageYears: 41 });
  });

  async function arrive(patientId: string, at: Date): Promise<{ encounterId: string; sessionId: string; entryId: string }> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, at);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, at);
    return { encounterId: opened.encounter.id, sessionId: opened.sessionId, entryId: opened.queueEntry.id };
  }

  const entryOf = async (id: string) => (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, id)))[0]!;
  const named = (name: string) => db.select().from(events).where(eq(events.name, name)).orderBy(desc(events.seq));

  it("S1: a skip records WHY, who and when — on the row and on the event", async () => {
    const a = await arrive(asha.id, AT(0));
    await callNext(db, dra.actor, a.sessionId, AT(5));

    await skipCalled(db, dra.actor, a.entryId, { reason: "at_billing", note: "sent to counter 2" }, AT(6));

    const row = await entryOf(a.entryId);
    expect({ reason: row.skipReason, note: row.skipNote, by: row.skippedBy, at: row.skippedAt?.toISOString() })
      .toEqual({ reason: "at_billing", note: "sent to counter 2", by: dra.userId, at: AT(6).toISOString() });
    const [e] = await named("queue.skipped");
    expect(e!.actorId).toBe(dra.userId);
    expect(e!.payload).toMatchObject({ entryId: a.entryId, skips: 1, left: false, reason: "at_billing", note: "sent to counter 2" });
  });

  /** `other` is the only one that cannot stand alone — an unexplained "other" is the state this ends. */
  it("S2: 'other' without the text is refused; the five named reasons stand on their own", async () => {
    const a = await arrive(asha.id, AT(0));
    await callNext(db, dra.actor, a.sessionId, AT(5));

    await expect(skipCalled(db, dra.actor, a.entryId, { reason: "other", note: "  " }, AT(6)))
      .rejects.toMatchObject({ code: "reason_required" });
    // nothing was written by the refusal
    expect((await entryOf(a.entryId)).status).toBe("called");
    expect(await named("queue.skipped")).toHaveLength(0);

    await skipCalled(db, dra.actor, a.entryId, { reason: "absent" }, AT(7));
    expect((await entryOf(a.entryId)).skipNote).toBeNull();
  });

  /**
   * THE MIS-CLICK. The patient's turn is the thing a skip takes, so it is the thing an undo gives
   * back: `eligible_at` restored to the value it had, which is what puts them in FRONT of the
   * walk-in who arrived while the doctor was clicking.
   */
  it("S3: an undo gives back the turn, not just the place in the list", async () => {
    const a = await arrive(asha.id, AT(0));
    const r = await arrive(ram.id, AT(1));
    await db.update(opdQueueEntries).set({ eligibleAt: AT(0) }).where(eq(opdQueueEntries.id, a.entryId));
    await db.update(opdQueueEntries).set({ eligibleAt: AT(1) }).where(eq(opdQueueEntries.id, r.entryId));
    await callNext(db, dra.actor, a.sessionId, AT(5)); // → Asha, the earlier arrival

    await skipCalled(db, dra.actor, a.entryId, { reason: "absent" }, AT(6));
    const behind = (await listQueue(db, dra.actor, dra.doctorId, "2026-08-17", AT(7)))!;
    expect(behind.ordered.map((x) => x.id)).toEqual([r.entryId, a.entryId]); // she is behind him now

    await undoSkip(db, dra.actor, a.entryId, AT(8));

    const back = (await listQueue(db, dra.actor, dra.doctorId, "2026-08-17", AT(9)))!;
    expect(back.ordered.map((x) => x.id)).toEqual([a.entryId, r.entryId]); // and in front of him again
    const row = await entryOf(a.entryId);
    expect({ status: row.status, skips: row.skips, eligibleAt: row.eligibleAt?.toISOString(), reason: row.skipReason })
      .toEqual({ status: "waiting", skips: 0, eligibleAt: AT(0).toISOString(), reason: null });
  });

  /**
   * THE MEASURED FIXTURE: three skips, `left`, and a visit still open. Before the undo there was no
   * act in the system that could put her back, and before `QueueView.left` there was no screen that
   * could name her.
   */
  it("S4: a patient who fell out of the queue after three skips is named on the view, and can be brought back", async () => {
    const a = await arrive(asha.id, AT(0));
    for (const [i, min] of [5, 10, 15].entries()) {
      await callNext(db, dra.actor, a.sessionId, AT(min));
      await skipCalled(db, dra.actor, a.entryId, { reason: i === 2 ? "absent" : "stepped_out" }, AT(min + 1));
    }
    const gone = await entryOf(a.entryId);
    expect({ status: gone.status, skips: gone.skips }).toEqual({ status: "left", skips: 3 });

    const view = (await listQueue(db, dra.actor, dra.doctorId, "2026-08-17", AT(20)))!;
    expect(view.counts.left).toBe(1);
    expect(view.left.map((x) => x.id)).toEqual([a.entryId]);          // the count could never say WHO
    expect(view.left[0]!.patient!.uhid).toBe(asha.uhid);
    expect(view.left[0]!.skipReason).toBe("absent");
    expect(view.ordered).toHaveLength(0);

    await undoSkip(db, dra.actor, a.entryId, AT(21));

    const after = (await listQueue(db, dra.actor, dra.doctorId, "2026-08-17", AT(22)))!;
    expect(after.left).toHaveLength(0);
    expect(after.ordered.map((x) => x.id)).toEqual([a.entryId]);       // callable again
    const [e] = await named("queue.skip_undone");
    expect(e!.payload).toMatchObject({ entryId: a.entryId, skips: 2, reason: "absent", wasLeft: true });
    // the skip it corrects is still in the log, with its reason: an undo adds a fact, it deletes none
    expect(await named("queue.skipped")).toHaveLength(3);
  });

  it("S5: only the most recent skip comes back, and only while the token is still waiting or left", async () => {
    const a = await arrive(asha.id, AT(0));
    await callNext(db, dra.actor, a.sessionId, AT(5));
    await skipCalled(db, dra.actor, a.entryId, { reason: "absent" }, AT(6));
    await undoSkip(db, dra.actor, a.entryId, AT(7));

    // nothing left to undo: the mark is gone and a second undo must not decrement the counter again
    await expect(undoSkip(db, dra.actor, a.entryId, AT(8))).rejects.toMatchObject({ code: "queue_entry_state_conflict" });
    expect((await entryOf(a.entryId)).skips).toBe(0);

    // and once the patient is called again, that call — not the undo — is the state that stands
    await callNext(db, dra.actor, a.sessionId, AT(9));
    await skipCalled(db, dra.actor, a.entryId, { reason: "absent" }, AT(10));
    await callNext(db, dra.actor, a.sessionId, AT(11));
    await expect(undoSkip(db, dra.actor, a.entryId, AT(12))).rejects.toMatchObject({ code: "queue_entry_state_conflict" });
    expect((await entryOf(a.entryId)).status).toBe("called");
  });

  it("S6: an entry that was never skipped has no skip to take back", async () => {
    const a = await arrive(asha.id, AT(0));
    await expect(undoSkip(db, dra.actor, a.entryId, AT(5))).rejects.toMatchObject({ code: "queue_entry_state_conflict" });
    expect(await named("queue.skip_undone")).toHaveLength(0);
  });
});
