import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deskAndLabel, seedLabDeskBase, serviceIdForLabCode, uhidOf } from "../../../test/helpers/lab";
import { openOpdVisit } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, opdQueueEntries } from "../../kernel/db/schema";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { getEncounter, openLabWalkin } from "../opd";
import { reject } from "./accession";
import { awaitingLabels, collectionQueue } from "./collection";
import { deskOrder } from "./desk";
import { printLabels } from "./specimens";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 17c T2 — THE CHAIR'S QUEUE, BEFORE AND AFTER THE LABEL ═══
 *
 * 17a's `collectionQueue` lists TUBES, and a tube exists only after `printLabels`: a patient who
 * had just left reception was on nobody's list. `awaitingLabels` is the other half, and both halves
 * now carry the OPD token the phlebotomist calls out.
 */
describe("the collection seat's queue (17c T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  const AT = new Date("2026-08-29T05:00:00Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
  });
  afterEach(() => { fx.unregister(); });

  it("A1: a fresh desk order is AWAITING a label with its token; after printing it is a TUBE with the same token; a lab walk-in carries its own", async () => {
    /** The real reader on the real row — the visits below are real and the fake resolver cannot see them. */
    fx.unregister();
    fx.unregister = registerEncounterResolver("V", async (exec, no) => {
      const e = await getEncounter(exec, no);
      return e ? { patientId: e.patientId, intendedPayer: e.intendedPayer } : null;
    });
    const visit = await openOpdVisit(db, {
      clerk: fx.desk.actor, patientId: fx.patientId, departmentId: fx.labDepartmentId, doctorId: fx.pathologist.doctorId,
    }, AT);
    const [enc] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, visit.encounterId));
    const [entry] = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, visit.encounterId));
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: enc!.visitNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, priority: "stat",
      items: [{ serviceId: serviceIdForLabCode("CBC") }, { serviceId: serviceIdForLabCode("LFT") }],
      credit: { reason: "counter order" },
    }));
    const walkin = await openLabWalkin(db, fx.desk.actor, { patientId: fx.otherPatientId });
    const placedWalkin = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.otherPatientId, encounterNo: walkin.encounter.visitNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: [{ serviceId: serviceIdForLabCode("TSH") }],
      credit: { reason: "counter order" },
    }));

    /**
     * CORRECTED BY EXECUTION: the phase document said a walk-in has no token. It has one — a lab
     * walk-in is an OPD visit in the LAB department and `openVisitInTx` joins the pathologist's
     * doctor-day queue, so the chair can call it out like any other. `null` is reserved for a
     * visit that never joined a queue (RC-1's deferred `bill_first` join).
     */
    const [walkinEntry] = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, walkin.encounter.id));
    const awaiting = await awaitingLabels(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    /** STAT first, then arrival; the token rides the visit. */
    expect(awaiting.map((r) => [r.orderGroupId, r.tokenNo, r.priority, r.orderableCodes])).toEqual([
      [placed.orderGroupId, entry!.tokenNo, "stat", ["CBC", "LFT"]],
      [placedWalkin.orderGroupId, walkinEntry!.tokenNo, "routine", ["TSH"]],
    ]);
    expect(walkinEntry!.tokenNo).toBeGreaterThan(0);
    expect(awaiting[0]!.itemIds.sort()).toEqual([...placed.itemIds].sort());
    expect(awaiting[0]!.patientDisplay).toBe("Ram Kumar");
    expect(await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate })).toEqual([]);

    await printLabels(db, fx.bench.actor, { orderGroupId: placed.orderGroupId, scannedUhid: await uhidOf(db, fx.patientId) });
    const after = await awaitingLabels(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    expect(after.map((r) => r.orderGroupId)).toEqual([placedWalkin.orderGroupId]);
    const tubes = await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    expect(tubes).toHaveLength(2);
    for (const tube of tubes) {
      expect([tube.orderGroupId, tube.tokenNo, tube.patientDisplay]).toEqual([placed.orderGroupId, entry!.tokenNo, "Ram Kumar"]);
      expect(tube.waitingMinutes).toBeGreaterThanOrEqual(0);
      expect(typeof tube.labelledAt).toBe("string");
    }
  });

  it("A2: a rejected tube's free recollection is back on the TUBE queue by itself, not on the awaiting list", async () => {
    const { specimens } = await deskAndLabel(db, fx, ["CBC"]);
    expect(await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate })).toEqual([]);
    await withTx(db, (tx) => reject(tx, fx.bench.actor, {
      specimenNo: specimens[0]!.specimenNo, reason: "haemolysed", attributableTo: "collection",
    }));
    const tubes = await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    expect(tubes).toHaveLength(1);
    expect(tubes[0]!.specimenNo).not.toBe(specimens[0]!.specimenNo);
    expect(await awaitingLabels(db, fx.bench.actor, { serviceDate: fx.serviceDate })).toEqual([]);
  });
});
