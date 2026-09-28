import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupRadiologyFixture } from "../../../test/helpers/radiology";
import { events, imagingStudies } from "../../kernel/db/schema";
import { createResource } from "../../kernel/resources/registry";
import { withTx } from "../../kernel/db/client";
import { RADIOLOGY_RESOURCE_KINDS } from "./kinds";
import { placeImagingOrder } from "./place";
import { handleOrderPlaced } from "./consumers";
import { scheduleStudy } from "./schedule";
import { bedsideStudiesFor } from "./bedside";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS2b P4 — **BEDSIDE AT ORDER TIME: the ward door's core half, built ahead of IPD.**
 *
 * An order item may carry `bedsideLocation`. Placement records it (`imaging.bedside_requested`, in
 * the order's transaction) and the `radiology.order_placed` consumer copies it onto the study it
 * creates. From there the 18a-iii rule is unchanged: `resolveBedside` refuses to book the study on a
 * machine that cannot go to a bed, on the EFFECTIVE value — until the desk clears it explicitly.
 */
describe("bedside at order time (18-S RS2b P4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let portableXray: string;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const SLOT = new Date(`${DAY}T09:00:00.000Z`);
  const WARD = "Ward 3 · bed 12";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    ({ resourceId: portableXray } = await withTx(db, (tx) => createResource(
      tx, fx.radiographer, RADIOLOGY_RESOURCE_KINDS,
      { kind: "device", code: "PX-1", name: "Portable X-ray", attributes: { modality: "xray", portable: true } },
    )));
  });
  afterEach(() => { fx.unregister(); });

  /** Places a one-item XR-CHEST order (optionally at a bed) and runs the consumer. */
  const place = async (key: string, item: Record<string, unknown> = {}) => {
    const placed = await placeImagingOrder(db, fx.doctor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.visitNo, serviceDate: fx.serviceDate,
      orderingClinicianId: "dr-consultant", indication: "post-op chest",
      items: [{ serviceId: fx.services["XR-CHEST"]!, ...item }],
      placedAt: NOW,
    } as never, key, NOW);
    const created = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.orderId, orderNo: placed.orderNo, kind: "imaging",
      patientId: fx.patientId, encounterNo: fx.visitNo, groupId: placed.orderId, itemIds: placed.itemIds,
    }));
    return { ...placed, studyId: created[0]!.studyId };
  };
  const study = async (studyId: string) =>
    (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;
  const book = (studyId: string, deviceResourceId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId, deviceResourceId, scheduledAt: SLOT, ...over }));

  it("the order's bedside location lands on the study the consumer creates, trimmed", async () => {
    const { studyId, orderId } = await place("b1", { bedsideLocation: `  ${WARD}  ` });
    expect((await study(studyId)).bedsideLocation).toBe(WARD);
    /** The request is itself on the record: who asked for the trolley to go to that bed. */
    const requested = await db.select().from(events).where(eq(events.name, "imaging.bedside_requested"));
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ correlationId: orderId, actorId: fx.doctor.id });
  });

  it("an order with no bedside location makes a department study and records no request", async () => {
    const { studyId } = await place("b2");
    expect((await study(studyId)).bedsideLocation).toBeNull();
    expect(await db.select().from(events).where(eq(events.name, "imaging.bedside_requested"))).toHaveLength(0);
  });

  it("refuses a blank or over-long bedside location at placement", async () => {
    await expect(place("b3", { bedsideLocation: "   " })).rejects.toMatchObject({ code: "invalid_bedside_location" });
    await expect(place("b4", { bedsideLocation: "x".repeat(121) })).rejects.toMatchObject({ code: "invalid_bedside_location" });
  });

  it("booking it on a fixed machine refuses device_not_portable; on the portable it books", async () => {
    const { studyId } = await place("b5", { bedsideLocation: WARD });
    await expect(book(studyId, fx.devices.xray!)).rejects.toMatchObject({ code: "device_not_portable" });
    await book(studyId, portableXray);
    const row = await study(studyId);
    expect([row.deviceResourceId, row.bedsideLocation]).toEqual([portableXray, WARD]);
  });

  it("clearing it with null brings the patient to the department: the fixed machine then books", async () => {
    const { studyId } = await place("b6", { bedsideLocation: WARD });
    await book(studyId, fx.devices.xray!, { bedsideLocation: null });
    const row = await study(studyId);
    expect([row.deviceResourceId, row.bedsideLocation]).toEqual([fx.devices.xray!, null]);
  });

  it("the IPD seam shows the ward its request before radiology has booked it", async () => {
    const { studyId } = await place("b7", { bedsideLocation: WARD });
    const rows = await bedsideStudiesFor(db, fx.radiographer, "Ward 3");
    expect(rows.map((r) => [r.studyId, r.deviceResourceId, r.status])).toEqual([[studyId, null, "scheduled"]]);
  });
});
