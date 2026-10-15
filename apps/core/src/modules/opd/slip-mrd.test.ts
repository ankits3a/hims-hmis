import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { captureDocument } from "../patients";
import { completeConsultation, startConsultation } from "./consultation";
import { openVisit } from "./encounters";
import { callNext } from "./queue";
import { recordVitals } from "./vitals";
import { mrdSlips, requestSlipRetake, slipDay } from "./slips";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #659 — THE MRD DAY-END HAND-OFF (owner ruling 28-Sep-2026: "a missing slip shows in the list
 * and clocks and goes to MRD at day end") ═══
 *
 * Nothing is escalated while the day runs. When the day is over, every finished consultation of that
 * day whose slip never landed — still WAITING, or a RETAKE nobody answered — is the records office's
 * to chase. The list is derived, never stored: a page filed later takes the visit off it.
 *
 * (Setup below is slips.test.ts's own.)
 *
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

describe("#659 — a missing slip goes to MRD at day end", () => {
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

  const TUE = new Date("2026-08-18T04:00:00.000Z"); // the next morning, 09:30 IST

  it("MRD1: while the day runs nothing goes to MRD; the next day its waiting and unanswered-retake slips do — filed ones do not", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const ram = await mkPatient(db, clerk.actor, { name: "Ram Prasad", sex: "male", phone: "9811100022", ageYears: 41 });
    const sita = await mkPatient(db, clerk.actor, { name: "Sita Kumari", phone: "9811100033", ageYears: 22 });
    const a = await arrive(asha.id);
    const r = await arrive(ram.id, LATER(1));
    const s = await arrive(sita.id, LATER(2));
    await seeAndFinish(a, LATER(10));
    await seeAndFinish(r, LATER(20));
    await seeAndFinish(s, LATER(30));
    await file(asha.id, a.encounterId, LATER(12)); // filed
    const { documentId } = await file(sita.id, s.encounterId, LATER(32));
    await requestSlipRetake(db, dra.actor, documentId, "line 3 is cut off", LATER(40)); // retake, never answered

    expect(await mrdSlips(db, clerk.actor, LATER(60))).toEqual([]); // the day is still running

    const handed = await mrdSlips(db, clerk.actor, TUE);
    expect(handed.map((i) => [i.serviceDate, i.patient.name, i.state])).toEqual([
      ["2026-08-17", "Ram Prasad", "waiting"],
      ["2026-08-17", "Sita Kumari", "retake"],
    ]);
    expect(handed[0]).toMatchObject({ visitNo: expect.stringMatching(/^V/), doctorCode: "DR-0412", roomName: "Room 12", pages: 0 });
    expect(handed[1]).toMatchObject({ retakeReason: "line 3 is cut off", pages: 1 });
    /* The desk's own list for the new day knows nothing of yesterday. */
    expect((await slipDay(db, clerk.actor, TUE)).items).toEqual([]);
  });

  it("MRD2: a page filed after the hand-off takes the visit off MRD's list — nothing is stored to undo", async () => {
    const ram = await mkPatient(db, clerk.actor, { name: "Ram Prasad", sex: "male", phone: "9811100022", ageYears: 41 });
    const r = await arrive(ram.id);
    await seeAndFinish(r, LATER(20));
    expect((await mrdSlips(db, clerk.actor, TUE)).map((i) => i.encounterId)).toEqual([r.encounterId]);
    await file(ram.id, r.encounterId, TUE);
    expect(await mrdSlips(db, clerk.actor, TUE)).toEqual([]);
  });

  it("MRD3: the hand-off looks back a fixed window — a visit older than it is not listed", async () => {
    const ram = await mkPatient(db, clerk.actor, { name: "Ram Prasad", sex: "male", phone: "9811100022", ageYears: 41 });
    const r = await arrive(ram.id);
    await seeAndFinish(r, LATER(20));
    const farLater = new Date(MON.getTime() + 40 * 86_400_000);
    expect(await mrdSlips(db, clerk.actor, farLater)).toEqual([]);
  });
});
