import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { patientDocuments } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { captureDocument } from "../patients";
import { completeConsultation, startConsultation } from "./consultation";
import { getEncounter, openVisit } from "./encounters";
import { callNext } from "./queue";
import { recordVitals } from "./vitals";
import { findTodaysVisits, requestSlipRetake, slipDay, slipReadback } from "./slips";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE SLIP DESK'S DAY ═══
 *
 * The approved board draws four things the server did not return: the Doctor ID, department and
 * room on the read-back; today's slips as waiting / retake / filed; today's visit found by name or
 * UHID when the QR is torn (owner ruling 28-Sep-2026); and the doctor's retake request. These rows
 * drive each through the real OPD lifecycle — open, vitals, call, consult, complete — rather than
 * writing queue rows by hand, so "finished" means what the doctor's Complete button makes it mean.
 */
class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.files.set(key, bytes); }
  async get(key: string): Promise<Buffer> { return this.files.get(key)!; }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}

const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const LATER = (min: number): Date => new Date(MON.getTime() + min * 60_000);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("opd — the slip desk's day", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let store: FakeStore;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId, displayName: "Dr Anand Rao", code: "DR-0412" });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    store = new FakeStore();
  });

  async function arrive(patientId: string, at: Date = MON): Promise<{ encounterId: string; sessionId: string }> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, at);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, at);
    return { encounterId: opened.encounter.id, sessionId: opened.sessionId };
  }
  async function seeAndFinish(v: { encounterId: string; sessionId: string }, at: Date): Promise<void> {
    await callNext(db, dra.actor, v.sessionId, at);
    await startConsultation(db, dra.actor, v.encounterId, at);
    await completeConsultation(db, dra.actor, v.encounterId, { testsOrderedReturnToday: false }, at);
  }
  const file = (patientId: string, encounterId: string | null, at: Date) => withTx(db, (tx) => captureDocument(
    tx, store, clerk.actor, patientId, { encounterId, kind: "consult_prescription", mimeType: "image/jpeg", bytes: JPEG }, at,
  ));

  it("SL1: the read-back names the Doctor ID, department and room — and never the doctor's name", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const v = await arrive(asha.id);
    const back = await slipReadback(db, clerk.actor, (await getEncounter(db, v.encounterId))!);

    expect(back).toMatchObject({
      encounterId: v.encounterId, doctorCode: "DR-0412", departmentName: "General Medicine", roomName: "Room 12", filed: [],
    });
    expect(back!.patient.uhid).toBe(asha.uhid);
    /* Owner, 2026-09-06: a desk sees the Doctor ID only. */
    expect(JSON.stringify(back)).not.toContain("Anand Rao");
  });

  it("SL2: today's slips are the FINISHED consultations — waiting first, filed after, the unfinished absent", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const ram = await mkPatient(db, clerk.actor, { name: "Ram Prasad", sex: "male", phone: "9811100022", ageYears: 41 });
    const sita = await mkPatient(db, clerk.actor, { name: "Sita Kumari", phone: "9811100033", ageYears: 22 });
    const a = await arrive(asha.id);
    const r = await arrive(ram.id, LATER(1));
    await arrive(sita.id, LATER(2)); // still waiting for the doctor: no slip exists yet
    await seeAndFinish(a, LATER(10));
    await seeAndFinish(r, LATER(20));
    await file(asha.id, a.encounterId, LATER(12));

    const day = await slipDay(db, clerk.actor, LATER(30));
    expect(day.serviceDate).toBe("2026-08-17");
    expect(day.items.map((i) => [i.patient.name, i.state])).toEqual([["Ram Prasad", "waiting"], ["Asha Devi", "filed"]]);
    expect(day.counts).toEqual({ waiting: 1, retake: 0, filed: 1 });
    const ramRow = day.items[0]!;
    /* The waiting clock starts when the doctor finished, and the row carries the room and Doctor ID. */
    expect(ramRow.consultDoneAt?.toISOString()).toBe(LATER(20).toISOString());
    expect(ramRow).toMatchObject({ roomName: "Room 12", doctorCode: "DR-0412", pages: 0 });
    /* Owner 2026-10-06 — what the paper says: the token as the slip prints it (`<dept>-<n>`), so the desk can find a visit by it. */
    expect(typeof ramRow.tokenNo).toBe("number");
    expect(ramRow.tokenNo).toBeGreaterThan(0);
    expect(typeof ramRow.departmentCode).toBe("string");
    expect(ramRow.departmentCode).not.toBe("");
    expect(day.items[1]).toMatchObject({ pages: 1, kinds: ["consult_prescription"] });
  });

  it("SL3: the doctor's retake puts a filed slip back on the list until a NEWER page lands", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const a = await arrive(asha.id);
    await seeAndFinish(a, LATER(10));
    const { documentId } = await file(asha.id, a.encounterId, LATER(12));

    const asked = await requestSlipRetake(db, dra.actor, documentId, "line 3 is cut off", LATER(15));
    expect(asked).toEqual({ documentId, encounterId: a.encounterId, alreadyRequested: false });
    let day = await slipDay(db, clerk.actor, LATER(16));
    expect(day.items[0]).toMatchObject({ state: "retake", retakeReason: "line 3 is cut off" });
    expect(day.counts).toEqual({ waiting: 0, retake: 1, filed: 0 });

    /* First writer wins: a second ask changes nothing and says so. */
    expect((await requestSlipRetake(db, dra.actor, documentId, "again", LATER(17))).alreadyRequested).toBe(true);
    const [row] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));
    expect(row!.retakeReason).toBe("line 3 is cut off");
    /* The page is NOT hidden: it is still what was filed. */
    expect(row!.status).toBe("active");

    await file(asha.id, a.encounterId, LATER(20));
    day = await slipDay(db, clerk.actor, LATER(21));
    expect(day.items[0]).toMatchObject({ state: "filed", pages: 2, retakeRequestedAt: null });
  });

  it("SL4: a page with no visit cannot be retaken, and the refusal writes nothing", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const { documentId } = await file(asha.id, null, LATER(1));
    await expect(requestSlipRetake(db, dra.actor, documentId, null, LATER(2))).rejects.toMatchObject({ code: "unknown_encounter" });
    const [row] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));
    expect(row!.retakeRequestedAt).toBeNull();
  });

  it("SL5: a torn QR finds TODAY's visit by name or UHID — never another day's", async () => {
    const asha = await mkPatient(db, clerk.actor, { name: "Sunita Verma", phone: "9811100044" });
    await arrive(asha.id, new Date(MON.getTime() - 24 * 3_600_000 * 7)); // last Monday's visit
    const today = await arrive(asha.id);

    const byName = await findTodaysVisits(db, clerk.actor, "Sunita", LATER(5));
    expect(byName.map((v) => v.encounterId)).toEqual([today.encounterId]);
    expect(byName[0]).toMatchObject({ doctorCode: "DR-0412", departmentName: "General Medicine" });

    const byUhid = await findTodaysVisits(db, clerk.actor, asha.uhid, LATER(5));
    expect(byUhid.map((v) => v.encounterId)).toEqual([today.encounterId]);

    expect(await findTodaysVisits(db, clerk.actor, "Nobody Here", LATER(5))).toEqual([]);
  });
});
