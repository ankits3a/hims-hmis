import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { phiAccessLog, retentionLegalHolds } from "../db/schema";
import { patientTimeline, getVisit } from "../../modules/opd/encounters";
import { listVitals } from "../../modules/opd/vitals";
import { careContextFor } from "../../modules/opd/care-context";
import { registerOpdCareContextProvider } from "../../modules/opd/opd.module";
import { PHI_ACCESS_RETAIN_DAYS, prunePhiAccessLog, recordPhiAccess } from "./audit";
import type { Db } from "../db/client";

/**
 * PLAN 07a T2 — THE PHI ACCESS LOG.
 *
 * Before this, the only record of anyone READING a patient's chart was a click-through from the
 * command palette — one call site in the entire web app. A record reached from the OPD queue, an
 * appointment list, the consult screen or a pasted URL left no trace at all, which made "who looked
 * at this chart" unanswerable for every path a clinician actually uses.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST

describe("phi access log (07a T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let stranger: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let patient: { id: string; uhid: string };
  let encounterId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    unregister = registerOpdCareContextProvider();
  });
  afterAll(async () => { unregister(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    stranger = await mkUser(db, "stranger1", ["front_office_t"]);
    patient = await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540002" });
    ({ encounterId } = await openOpdVisit(
      db, { clerk: clerk.actor, patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, T0,
    ));
  });

  const rows = () => db.select().from(phiAccessLog);

  /**
   * A1 — THE ASSERTION THE WHOLE TASK EXISTS FOR. These reads are reached by calling the read
   * function directly, which is exactly the path the palette-only logging never saw.
   */
  it("A1: a timeline read writes one row naming actor, patient and surface", async () => {
    await patientTimeline(db, clerk.actor, patient.id);
    const written = await rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actorId: clerk.id, actorType: "user", patientId: patient.id, surface: "opd.timeline", sealed: false,
    });
  });

  it("A1b: each read surface writes its own row — it is not one row per session", async () => {
    await patientTimeline(db, clerk.actor, patient.id);
    await listVitals(db, clerk.actor, encounterId);
    await getVisit(db, clerk.actor, encounterId);
    const surfaces = (await rows()).map((r) => r.surface).sort();
    expect(surfaces).toEqual(["opd.timeline", "opd.visit", "opd.vitals"]);
  });

  /** A2 — a broken log must never take the chart away from the person reading it. */
  it("A2: a failing insert does not fail the read", async () => {
    const exploding = {
      insert: () => { throw new Error("disk full"); },
      select: () => { throw new Error("disk full"); },
    } as unknown as Db;
    await expect(recordPhiAccess(exploding, {
      actor: clerk.actor, patientId: patient.id, surface: "patient.detail", context: "none",
    })).resolves.toBeUndefined();
  });

  /**
   * A3 — context is stamped at write time because it is only knowable then. THREE values, not a
   * boolean: a clerk serving a live visit is not "out of context", and marking them so would put
   * hundreds of blameless rows a day on a review worklist.
   */
  it("A3: the encounter's own doctor is `treating`; other staff are `serving` while care is live", async () => {
    expect(await careContextFor(db, dra.actor, patient.id, T0)).toBe("treating");
    expect(await careContextFor(db, clerk.actor, patient.id, T0)).toBe("serving");
    /**
     * THE LIMIT OF WHAT THIS DATA CAN HONESTLY SAY, asserted rather than glossed. `stranger` has no
     * connection to this visit beyond working here, and still reads as `serving`, because the only
     * thing the schema can prove is that the patient HAS live care today — there is no desk or
     * counter assignment to tie a specific staff member to a specific visit (that is Plan 22's
     * `counter_assignments`). So `serving` means "this read is contemporaneous with care", not
     * "this person is on the case", and `none` — no live care at all to justify the read — is the
     * signal the review worklist is built on. Overclaiming here would produce a worklist that
     * looks precise and is not.
     */
    expect(await careContextFor(db, stranger.actor, patient.id, T0)).toBe("serving");
    // Once the visit is not today's, nothing justifies the read and everyone reads as `none`.
    const later = new Date("2026-09-01T04:00:00.000Z");
    expect(await careContextFor(db, dra.actor, patient.id, later)).toBe("none");
    expect(await careContextFor(db, clerk.actor, patient.id, later)).toBe("none");
  });

  it("A3b: the recorded row carries the resolved context, not a default", async () => {
    await recordPhiAccess(db, {
      actor: dra.actor, patientId: patient.id, surface: "opd.visit", encounterId, now: T0,
    });
    expect((await rows())[0]).toMatchObject({ context: "treating" });
  });

  /**
   * A4 — THIS PRUNE IS HOLD-CLAMPED, and that is a deliberate departure from `pruneSearchAudit`,
   * which is not. A search row names no patient; every row here does, and those rows are exactly
   * what the hold was raised to preserve.
   */
  it("A4: an active hold on the patient keeps their access rows; releasing it frees them", async () => {
    const old = new Date(Date.now() - (PHI_ACCESS_RETAIN_DAYS + 10) * 24 * 60 * 60 * 1000);
    await recordPhiAccess(db, {
      actor: clerk.actor, patientId: patient.id, surface: "patient.detail", context: "none", now: old,
    });
    const holdId = newId();
    await db.insert(retentionLegalHolds).values({
      id: holdId, patientId: patient.id, reason: "records enquiry", createdBy: clerk.id,
    });
    expect(await prunePhiAccessLog(db)).toBe(0);
    expect(await rows()).toHaveLength(1);

    await db.update(retentionLegalHolds).set({ releasedAt: new Date() }).where(eq(retentionLegalHolds.id, holdId));
    expect(await prunePhiAccessLog(db)).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  it("A4b: a GLOBAL hold (null patient) suspends the prune entirely", async () => {
    const old = new Date(Date.now() - (PHI_ACCESS_RETAIN_DAYS + 10) * 24 * 60 * 60 * 1000);
    await recordPhiAccess(db, {
      actor: clerk.actor, patientId: patient.id, surface: "patient.detail", context: "none", now: old,
    });
    await db.insert(retentionLegalHolds).values({
      id: newId(), patientId: null, reason: "litigation — preserve everything", createdBy: clerk.id,
    });
    expect(await prunePhiAccessLog(db)).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("A4c: rows inside the retention window are never pruned, hold or no hold", async () => {
    await recordPhiAccess(db, {
      actor: clerk.actor, patientId: patient.id, surface: "patient.detail", context: "none",
    });
    expect(await prunePhiAccessLog(db)).toBe(0);
    expect(await rows()).toHaveLength(1);
  });
});
