import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdEncounters, opdPatientReminders } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { OpdQueueController } from "./opd-queue.controller";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT V2 (owner, 2026-09-23; 01-CONSULT-ENGINE.md §1.1, D14) — the sections the doctor's screen was
 * missing, written through the SAME note route as the complaint and the diagnosis, so its guards hold,
 * and the patient reminder that outlives the visit. Asserted through the ROUTE: its zod body is where a
 * field added to the service and forgotten on the body would be stripped silently.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("consult v2 — examination, treatment, notes, diagnosis kind, stock choices, the reminder", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let room2Id: string;
  let patientId: string;
  let ctl: OpdQueueController;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    room2Id = m.room2Id;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: m.roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
    ctl = new OpdQueueController(db, testCfg as never);
  });

  async function inConsult(): Promise<string> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    await startConsultation(db, dra.actor, opened.encounter.id, MON);
    return opened.encounter.id;
  }

  it("the note route writes and returns examination, treatment, both notes and the diagnosis kind", async () => {
    const id = await inConsult();
    const body = {
      examination: [
        { group: "general", text: "Pallor absent" },
        { group: "systemic", text: "CVS: S1 S2 normal, no murmur" },
        { group: "local", text: "Fundus: AV nicking" },
      ],
      treatment: ["BP recheck after 10 min rest"],
      doctorNote: "Likely white-coat component; home BP log.",
      internalComment: "Call if BP log above 150.",
      diagnosisKind: "final",
    };
    const { encounter } = await ctl.note(dra.actor, id, body);
    expect(encounter.examination).toEqual(body.examination);
    expect(encounter.treatment).toEqual(body.treatment);
    expect(encounter.doctorNote).toBe(body.doctorNote);
    expect(encounter.internalComment).toBe(body.internalComment);
    expect(encounter.diagnosisKind).toBe("final");
  });

  it("a list is REPLACED whole — what the doctor removed is gone", async () => {
    const id = await inConsult();
    await ctl.note(dra.actor, id, { examination: [{ group: "general", text: "A" }, { group: "general", text: "B" }] });
    const { encounter } = await ctl.note(dra.actor, id, { examination: [{ group: "general", text: "B" }] });
    expect(encounter.examination).toEqual([{ group: "general", text: "B" }]);
  });

  it("refuses an unknown examination group and an unknown diagnosis kind", async () => {
    const id = await inConsult();
    await expect(ctl.note(dra.actor, id, { examination: [{ group: "other", text: "x" }] })).rejects.toThrow();
    await expect(ctl.note(dra.actor, id, { diagnosisKind: "maybe" })).rejects.toThrow();
  });

  it("another doctor cannot write these sections (the note's own guard)", async () => {
    const drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    const id = await inConsult();
    await expect(ctl.note(drb.actor, id, { doctorNote: "x" })).rejects.toThrow();
  });

  it("D14: the SERVER stamps who and when on a stock choice, and a re-save keeps the first stamp", async () => {
    const id = await inConsult();
    const choice = { offeredMedicineId: "M-STAMLO", keptMedicineId: "M-AMLONG", chosen: "keep", by: "someone-else", at: "2020-01-01T00:00:00.000Z" };
    const first = await ctl.note(dra.actor, id, { rxStockChoices: [choice] });
    const stamped = (first.encounter.rxStockChoices as { by: string; at: string }[])[0]!;
    expect(stamped.by).toBe(dra.actor.id);
    expect(stamped.at).not.toBe("2020-01-01T00:00:00.000Z");
    const again = await ctl.note(dra.actor, id, { rxStockChoices: [choice], doctorNote: "later edit" });
    expect((again.encounter.rxStockChoices as { at: string }[])[0]!.at).toBe(stamped.at);
  });

  it("the reminder: set, read, replaced (the old one cleared, never deleted), cleared", async () => {
    expect((await ctl.reminder(dra.actor, patientId)).reminder).toBeNull();
    const a = await ctl.putReminder(dra.actor, patientId, { text: "  Prefers generic medicines  " });
    expect(a.reminder.text).toBe("Prefers generic medicines");
    expect(a.reminder.setBy).toBe(dra.actor.id);
    await ctl.putReminder(dra.actor, patientId, { text: "Hard of hearing" });
    expect((await ctl.reminder(dra.actor, patientId)).reminder!.text).toBe("Hard of hearing");
    const rows = await db.select().from(opdPatientReminders).where(eq(opdPatientReminders.patientId, patientId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.clearedAt === null)).toHaveLength(1);
    expect(await ctl.clearReminderRoute(dra.actor, patientId)).toEqual({ cleared: true });
    expect((await ctl.reminder(dra.actor, patientId)).reminder).toBeNull();
    await expect(ctl.putReminder(dra.actor, patientId, { text: "   " })).rejects.toThrow();
  });

  it("the reminder refuses an unknown patient the way an absent one is refused", async () => {
    await expect(ctl.reminder(dra.actor, "NO-SUCH-PATIENT")).rejects.toThrow();
  });

  it("nothing here touches the encounter until the doctor writes it", async () => {
    const id = await inConsult();
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, id));
    expect([row!.examination, row!.treatment, row!.doctorNote, row!.internalComment, row!.diagnosisKind, row!.rxStockChoices])
      .toEqual([null, null, null, null, null, null]);
  });
});
