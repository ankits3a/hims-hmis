import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdEncounters, opdPrescriptions } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { OpdQueueController } from "./opd-queue.controller";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT WALK 2026-09-28, DEFECT A — the lines the doctor has written and not yet issued were held
 * only in the browser, so a reload, a second tab or a lease takeover lost them. They now ride the
 * consult note's own route as `rxDraft`: the same treating-doctor, in_consultation and lease guards,
 * and NOTHING that makes them a prescription. Asserted through the ROUTE, whose zod body is where a
 * field added to the service and forgotten on the body would be stripped silently.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

const FULL = {
  drug: "Crocin 500", dose: "500 mg", route: "oral", frequency: "TDS", durationDays: "3",
  instructions: "After food", noSubstitution: false, medicineId: "M-CROCIN",
};
/** Half-written: a draft is whatever the doctor left, not a line the issue path would accept. */
const HALF = { drug: "Azee", dose: "", route: "oral", frequency: "", durationDays: "", instructions: "", noSubstitution: false, medicineId: null };

describe("consult rx draft — the unissued lines survive a reload, through the note's own guards", () => {
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

  it("RD1: the note route stores the unissued lines — half-written ones included — and a later read returns them", async () => {
    const id = await inConsult();
    const { encounter } = await ctl.note(dra.actor, id, { rxDraft: [FULL, HALF] });
    expect(encounter.rxDraft).toEqual([FULL, HALF]);
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, id));
    expect(row!.rxDraft).toEqual([FULL, HALF]);
  });

  it("RD2: a save that does not mention the draft leaves it alone; null clears it", async () => {
    const id = await inConsult();
    await ctl.note(dra.actor, id, { rxDraft: [FULL] });
    const kept = await ctl.note(dra.actor, id, { doctorNote: "unrelated" });
    expect(kept.encounter.rxDraft).toEqual([FULL]);
    const cleared = await ctl.note(dra.actor, id, { rxDraft: null });
    expect(cleared.encounter.rxDraft).toBeNull();
  });

  it("RD3: a draft is not a prescription — nothing is issued by saving one", async () => {
    const id = await inConsult();
    await ctl.note(dra.actor, id, { rxDraft: [FULL] });
    expect(await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, id))).toHaveLength(0);
  });

  it("RD4: only the treating doctor writes it, and the body is bounded", async () => {
    const drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    const id = await inConsult();
    await expect(ctl.note(drb.actor, id, { rxDraft: [FULL] })).rejects.toThrow();
    await expect(ctl.note(dra.actor, id, { rxDraft: Array.from({ length: 31 }, () => FULL) })).rejects.toThrow();
    await expect(ctl.note(dra.actor, id, { rxDraft: [{ ...FULL, drug: "x".repeat(301) }] })).rejects.toThrow();
  });
});
