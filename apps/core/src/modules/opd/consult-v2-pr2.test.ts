import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { events, opdEncounters, opdQueueEntries, opdVitals } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { amendVitals, recordVitals } from "./vitals";
import { patientVitalsHistory } from "./history";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { OpdQueueController } from "./opd-queue.controller";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT V2, SECOND PART (owner, 2026-09-23; 01-CONSULT-ENGINE.md §1.1 item 9) — recall a called token,
 * the doctor's own reading in the room, one tab editing at a time (D17), and the internal referral.
 * Asserted through the ROUTE, where a zod body would silently strip a field the service expects.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("consult v2 — recall, vitals in the room, the edit lease, the referral", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drp: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dept2Id: string;
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
    dept2Id = m.dept2Id;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: m.roomId });
    drp = await mkDoctor(db, { username: "drp", departmentId: dept2Id, roomId: m.room2Id });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
    ctl = new OpdQueueController(db, testCfg as never);
  });

  async function called(): Promise<{ encounterId: string; entryId: string }> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    const r = await callNext(db, dra.actor, opened.sessionId, MON);
    return { encounterId: opened.encounter.id, entryId: r.entry!.id };
  }
  async function inConsult(): Promise<string> {
    const c = await called();
    await startConsultation(db, dra.actor, c.encounterId, MON);
    return c.encounterId;
  }

  it("RECALL says the called token again: callCount rises, the token stays called, and a queue.called event is appended", async () => {
    const c = await called();
    const before = await db.select().from(events).where(and(eq(events.name, "queue.called"), eq(events.encounterId, c.encounterId)));
    const { entry } = await ctl.recall(dra.actor, c.entryId);
    expect(entry.status).toBe("called");
    expect(entry.callCount).toBe(2);
    const after = await db.select().from(events).where(and(eq(events.name, "queue.called"), eq(events.encounterId, c.encounterId)));
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)!.actorId).toBe(dra.actor.id);
  });

  it("RECALL refuses a token that is not called", async () => {
    const c = await called();
    await startConsultation(db, dra.actor, c.encounterId, MON);
    const [row] = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, c.entryId));
    expect(row!.status).not.toBe("called");
    await expect(ctl.recall(dra.actor, c.entryId)).rejects.toThrow();
  });

  it("VITALS: the treating doctor adds a reading in the room; the bay and another doctor cannot", async () => {
    const id = await inConsult();
    const r = await recordVitals(db, dra.actor, id, { ...adultOk, sbp: 150, dbp: 96 }, new Date(MON.getTime() + 600_000));
    expect(r.vitals.recordedBy).toBe(dra.actor.id);
    expect(r.vitals.sbp).toBe(150);
    const rows = await db.select().from(opdVitals).where(eq(opdVitals.encounterId, id));
    expect(rows).toHaveLength(2); // the bay's reading is still there, untouched
    await expect(recordVitals(db, vd.actor, id, adultOk, MON)).rejects.toThrow();
    await expect(recordVitals(db, drp.actor, id, adultOk, MON)).rejects.toThrow();
  });

  it("VITALS: a correction keeps the original, struck (superseded) with its reason, and the history names who took each reading", async () => {
    const id = await inConsult();
    const [bay] = await db.select().from(opdVitals).where(eq(opdVitals.encounterId, id));
    await amendVitals(db, dra.actor, bay!.id, { ...adultOk, sbp: 128 }, "cuff too small on first reading", new Date(MON.getTime() + 300_000));
    const hist = await patientVitalsHistory(db, dra.actor, patientId);
    const orig = hist.find((h) => h.vitalsId === bay!.id)!;
    expect(orig.status).toBe("superseded");
    expect(orig.sbp).toBe(118);
    expect(orig.recordedByName).not.toBe("");
    const fixed = hist.find((h) => h.vitalsId !== bay!.id)!;
    expect(fixed).toMatchObject({ status: "active", sbp: 128, amendmentReason: "cuff too small on first reading" });
  });

  it("D17: one tab holds the lease; the other is refused, cannot write, and may take over — which is recorded", async () => {
    const id = await inConsult();
    const A = "tab-aaaa-1111"; const B = "tab-bbbb-2222";
    expect((await ctl.lease(dra.actor, id, { token: A })).held).toBe(true);
    expect((await ctl.lease(dra.actor, id, { token: A })).held).toBe(true); // the heartbeat
    const refused = await ctl.lease(dra.actor, id, { token: B });
    expect(refused.held).toBe(false);
    await expect(ctl.note(dra.actor, id, { doctorNote: "from B", leaseToken: B })).rejects.toThrow(/another tab/);
    await ctl.note(dra.actor, id, { doctorNote: "from A", leaseToken: A });

    const took = await ctl.lease(dra.actor, id, { token: B, takeover: true });
    expect(took).toMatchObject({ held: true, tookOver: true });
    await expect(ctl.note(dra.actor, id, { doctorNote: "from A again", leaseToken: A })).rejects.toThrow(/another tab/);
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, id));
    expect(row!.editTakeovers).toEqual([expect.objectContaining({ by: dra.actor.id, fromToken: A })]);
    // A note that names no token is the shipped client, untouched by the lease.
    await ctl.note(dra.actor, id, { advice: "rest" });
  });

  it("D17: another doctor can never hold the lease", async () => {
    const id = await inConsult();
    await expect(ctl.lease(drp.actor, id, { token: "tab-zzzz-9999" })).rejects.toThrow();
  });

  it("REFER opens a visit in the other doctor's line for the SAME patient, and the receiving doctor reads who sent them and why", async () => {
    const id = await inConsult();
    const res = await ctl.refer(dra.actor, id, { departmentId: dept2Id, doctorId: drp.doctorId, reason: "Wheeze in a child sibling? — assess asthma", note: "BP fine" });
    const [neu] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, res.encounterId));
    expect(neu!.patientId).toBe(patientId);
    expect(neu!.doctorId).toBe(drp.doctorId);
    expect(neu!.departmentId).toBe(dept2Id);
    expect(neu!.referralSource).toBe("internal_doctor");
    expect(neu!.deskComplaint).toMatch(/^Referred by .+: Wheeze in a child sibling\? — assess asthma — BP fine$/);
    expect(neu!.deskComplaintBy).toBe(dra.actor.id);
    const [old] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, id));
    expect(old!.referralTo).toMatch(/Paediatrics/);
    const q = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, res.encounterId));
    expect(q).toHaveLength(1);
  });

  it("REFER is the treating doctor's act, and to a doctor who is really in that department", async () => {
    const id = await inConsult();
    await expect(ctl.refer(drp.actor, id, { departmentId: dept2Id, doctorId: drp.doctorId, reason: "x-ray review" })).rejects.toThrow();
    await expect(ctl.refer(dra.actor, id, { departmentId: deptId, doctorId: drp.doctorId, reason: "x-ray review" })).rejects.toThrow();
    await expect(ctl.refer(dra.actor, id, { departmentId: dept2Id, doctorId: drp.doctorId, reason: "" })).rejects.toThrow();
  });
});
