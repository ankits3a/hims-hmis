import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { opdEncounters } from "../../kernel/db/schema";
import { OpdVisitsController } from "./opd-visits.controller";
import { DESK_COMPLAINT_MAX, normaliseDeskComplaint } from "./encounters";
import type { Db } from "../../kernel/db/client";

/**
 * THE PATIENT'S OWN WORDS REACH THE DOCTOR (owner, 2026-09-23; D15 in 01-CONSULT-ENGINE.md).
 *
 * Desk One asks "what brings them in?" to rank departments. Before this, the answer died there and
 * the patient told the doctor again. These pin the whole road through the ROUTE, not the service,
 * because the route's zod body is where an unknown key is stripped silently — a field added to the
 * service and forgotten on the body would pass every service test and never arrive.
 */

describe("desk complaint → the doctor", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let patientId: string;
  let ctl: OpdVisitsController;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
    ctl = new OpdVisitsController(db, {} as never);
  });

  const open = (extra: Record<string, unknown>) =>
    ctl.walkInRoute(clerk.actor, {
      patient: { existingId: patientId }, departmentId: deptId, doctorId: dra.doctorId, ...extra,
    });

  it("stores the desk's words trimmed, with the SERVER's author and time, apart from chief_complaint", async () => {
    const before = Date.now();
    const res = await open({ deskComplaint: "  Sar mein dard aur chakkar, ek hafte se.  " });
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, res.encounter.id));
    expect(row!.deskComplaint).toBe("Sar mein dard aur chakkar, ek hafte se.");
    expect(row!.deskComplaintBy).toBe(clerk.id);
    expect(row!.deskComplaintAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.chiefComplaint).toBeNull(); // the doctor's column is untouched
  });

  it("a client cannot name the author or the time", async () => {
    const res = await open({ deskComplaint: "Fever", deskComplaintBy: "someone-else", deskComplaintAt: "2020-01-01T00:00:00Z" });
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, res.encounter.id));
    expect(row!.deskComplaintBy).toBe(clerk.id);
    expect(row!.deskComplaintAt!.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("a blank complaint stores nothing at all — no author without words", async () => {
    const res = await open({ deskComplaint: "   " });
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, res.encounter.id));
    expect(row!.deskComplaint).toBeNull();
    expect(row!.deskComplaintBy).toBeNull();
    expect(row!.deskComplaintAt).toBeNull();
  });

  it("no complaint sent is the shipped behaviour", async () => {
    const res = await open({});
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, res.encounter.id));
    expect(row!.deskComplaint).toBeNull();
  });

  it("the doctor's visit read carries the words, WHO typed them by name, and when", async () => {
    const res = await open({ deskComplaint: "Bukhar teen din se" });
    const doctor = { type: "user" as const, id: dra.userId };
    const detail = await ctl.visit(doctor, res.encounter.id);
    expect(detail.deskComplaint).toEqual({ text: "Bukhar teen din se", by: "clerk1", at: expect.any(Date) });
  });

  it("the route and the service cap at the same length", async () => {
    expect(DESK_COMPLAINT_MAX).toBe(400); // the controller's literal twin (import cycle, see there)
    await expect(open({ deskComplaint: "x".repeat(DESK_COMPLAINT_MAX + 1) })).rejects.toThrow();
    const ok = await open({ deskComplaint: "y".repeat(DESK_COMPLAINT_MAX) });
    expect(ok.encounter.deskComplaint).toHaveLength(DESK_COMPLAINT_MAX);
    expect(normaliseDeskComplaint("z".repeat(500))).toHaveLength(DESK_COMPLAINT_MAX);
  });

  it("the visit read says null, not an empty object, when the desk typed nothing", async () => {
    const res = await open({});
    const detail = await ctl.visit({ type: "user", id: dra.userId }, res.encounter.id);
    expect(detail.deskComplaint).toBeNull();
  });
});
