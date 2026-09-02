import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { phiAccessLog } from "../../kernel/db/schema";
import { moveEncounter, openVisit } from "./encounters";
import { CONTINUITY_WINDOW_MONTHS, continuityDoctorFor } from "./continuity";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ FD-7 T2 — RULE 1 OF THE WALK-IN ═══
 *
 * The owner's routing ruling puts CONTINUITY first: a patient who has been seen in this department
 * goes back to that doctor even when his line is longer. Nothing in the codebase could answer the
 * question — `visitsQuery` has no `patientId` at all, so the desk had no way to ask what a patient's
 * history was. This is that rail, and its whole design is how NARROW it is: the clerk names the
 * department, and the server answers about that department only.
 */
const NOW = new Date("2026-09-03T04:00:00.000Z"); // Thursday 09:30 IST

describe("walk-in continuity (FD-7 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let drp: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dept2Id: string;
  let patient: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    let roomId: string, room2Id: string;
    ({ deptId, dept2Id, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    drp = await mkDoctor(db, { username: "drp", departmentId: dept2Id, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor);
  });

  /** One encounter carried all the way to a COMPLETED consultation — which is what "seen" means. */
  async function seen(
    doc: Awaited<ReturnType<typeof mkDoctor>>, departmentId: string, at: Date,
  ): Promise<void> {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId, doctorId: doc.doctorId }, at);
    let enc = await withTx(db, (tx) => moveEncounter(tx, vd.actor, opened.encounter, "waiting", {}, at));
    enc = await withTx(db, (tx) => moveEncounter(tx, doc.actor, enc, "in_consultation", {}, at));
    await withTx(db, (tx) => moveEncounter(tx, doc.actor, enc, "completed", { consultCompletedAt: at, followUpDays: 7 }, at));
  }

  const monthsAgo = (n: number): Date => {
    const d = new Date(NOW);
    d.setMonth(d.getMonth() - n);
    return d;
  };

  it("names the doctor this patient was last seen by in THIS department", async () => {
    await seen(dra, deptId, monthsAgo(2));
    const anchor = await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW);
    expect(anchor).not.toBeNull();
    expect(anchor!.doctorId).toBe(dra.doctorId);
    expect(anchor!.doctorName).toBe("Dr dra");
    expect(anchor!.seenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /** The MOST RECENT one wins — a patient who changed doctors within the department follows the change. */
  it("the most recent consultation is the anchor, not the first", async () => {
    await seen(dra, deptId, monthsAgo(4));
    await seen(drb, deptId, monthsAgo(1));
    const anchor = await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW);
    expect(anchor!.doctorId).toBe(drb.doctorId);
  });

  /**
   * THE WINDOW, and the reason it is a server constant: past six months the episode is a new
   * complaint and rule 2 (the shortest line) serves the patient better than the familiar face.
   */
  it(`a consultation older than ${String(CONTINUITY_WINDOW_MONTHS)} months does not route the patient`, async () => {
    await seen(dra, deptId, monthsAgo(CONTINUITY_WINDOW_MONTHS + 1));
    expect(await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW)).toBeNull();
  });

  it("one month inside the window still routes", async () => {
    await seen(dra, deptId, monthsAgo(CONTINUITY_WINDOW_MONTHS - 1));
    expect((await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW))!.doctorId)
      .toBe(dra.doctorId);
  });

  /**
   * THE PRIVACY SHAPE, asserted as behaviour: the answer is about the department the clerk NAMED.
   * A route that reported "seen in Psychiatry" to a desk asking about General Medicine would be the
   * diagnosis leak 07a/07b were spent closing on four other routes.
   */
  it("a consultation in ANOTHER department is invisible to this department's question", async () => {
    await seen(drp, dept2Id, monthsAgo(1));
    expect(await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW)).toBeNull();
  });

  /** An OPEN visit is not a consultation. "Seen" means a doctor finished with them. */
  it("a visit that never reached a completed consultation is not an anchor", async () => {
    await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, monthsAgo(1));
    expect(await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW)).toBeNull();
  });

  it("a patient with no history at all answers null, not an error", async () => {
    expect(await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW)).toBeNull();
  });

  it("an unknown patient is refused", async () => {
    await expect(continuityDoctorFor(db, clerk.actor, { patientId: "nope", departmentId: deptId }, NOW))
      .rejects.toBeInstanceOf(OpdError);
  });

  /** 07a's ruling: a PHI read is logged. This one gets its own surface so the desk's reads count apart. */
  it("the read is recorded in the PHI access log under its own surface", async () => {
    await seen(dra, deptId, monthsAgo(1));
    await continuityDoctorFor(db, clerk.actor, { patientId: patient.id, departmentId: deptId }, NOW);
    const rows = (await db.select().from(phiAccessLog)).filter((r) => r.surface === "opd.continuity");
    expect(rows.length).toBe(1);
    expect(rows[0]!.patientId).toBe(patient.id);
    expect(rows[0]!.actorId).toBe(clerk.id);
  });

  /** A refusal writes NOTHING — otherwise the log itself becomes a way to probe for patient ids. */
  it("a refused read logs nothing", async () => {
    await continuityDoctorFor(db, clerk.actor, { patientId: "nope", departmentId: deptId }, NOW).catch(() => null);
    expect((await db.select().from(phiAccessLog)).filter((r) => r.surface === "opd.continuity").length).toBe(0);
  });
});
