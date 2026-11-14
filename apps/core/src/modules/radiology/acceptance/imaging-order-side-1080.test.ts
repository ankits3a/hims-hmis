import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { setupRadiologyFixture, studyTypeRow } from "../../../../test/helpers/radiology";
import { withTx } from "../../../kernel/db/client";
import {
  imagingDefinitions, imagingSafetyScreenings, imagingStudies, orderItems, orders,
} from "../../../kernel/db/schema";
import { checkIn } from "../checkin";
import { handleOrderPlaced } from "../consumers";
import { gateState, requireStudyGate, satisfyGate } from "../gates";
import { placeImagingOrder } from "../place";
import { scheduleStudy } from "../schedule";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { Db } from "../../../kernel/db/client";
import type { PlaceImagingOrderInput } from "../place";

/**
 * ACCEPTANCE — issue #1080, spec docs/specs/1080-imaging-order-side-and-console.md (owner APPROVED
 * 2026-11-14). The side (left/right) is an ORDER field, written onto the study when it is created; the
 * console's side check is then reachable; identity is one act that attests the patient said their name.
 * D5–D7 (the screens) are `apps/web/src/screens/acceptance/imaging-order-side-1080.test.tsx`.
 */
describe("imaging: the side as an order field, and identity in one act (spec #1080)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    /** A knee X-ray is a side-applicable study (the seeded book's `XR-KNEE`); the rest of the book is plain. */
    await db.update(imagingDefinitions).set({ body: { types: [
      studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({
        code: "XR-KNEE", name: "X-ray knee", service_id: fx.services["XR-CHEST"]!, modality: "xray",
        body_part: "knee", ionising: true, laterality_applicable: true,
      }),
      studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true }),
      studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
    ] } }).where(eq(imagingDefinitions.kind, "study_types"));
  });
  afterEach(() => { fx.unregister(); });

  const KNEE = () => fx.services["XR-CHEST"]!;

  const order = (item: PlaceImagingOrderInput["items"][number]): PlaceImagingOrderInput => ({
    patientId: fx.patientId, encounterNo: fx.visitNo, serviceDate: fx.serviceDate,
    orderingClinicianId: fx.doctor.id, indication: "pain after a fall, ?fracture", placedAt: NOW,
    items: [item],
  });

  /** Places the order and runs the `order.placed` consumer, exactly as the worker does. */
  const placeAndCreate = async (item: PlaceImagingOrderInput["items"][number]) => {
    seq += 1;
    const placed = await placeImagingOrder(db, fx.doctor, fx.decls, order(item), `k${String(seq)}`, NOW);
    const [study] = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.orderId, orderNo: placed.orderNo, kind: "imaging", patientId: fx.patientId,
      encounterNo: fx.visitNo, groupId: placed.orderId, itemIds: placed.itemIds,
    }));
    return { ...placed, studyId: study!.studyId };
  };

  /** Books a slot and checks the patient in — the step that opens the gates. */
  const arrive = async (studyId: string, deviceKey: string) => {
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId, deviceResourceId: fx.devices[deviceKey]!, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    return await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId, now: NOW }));
  };

  const satisfy = async (studyId: string, kind: string, evidence: unknown) => {
    const gate = await requireStudyGate(db, studyId, kind);
    return { gateId: gate.id, run: () => withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence, NOW)) };
  };

  it("spec #1080 D1: an order for a side-applicable study placed with laterality left yields a study whose side is left before any gate is touched", async () => {
    const placed = await placeAndCreate({ serviceId: KNEE(), laterality: "left" });

    const [study] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, placed.studyId));
    expect(study!.laterality).toBe("left");
    /** No gate exists yet: nobody at a console has said anything about the side. */
    expect(await db.select().from(imagingSafetyScreenings)
      .where(eq(imagingSafetyScreenings.studyId, placed.studyId))).toEqual([]);
    /** The order item carries it — the order is where the side is decided. */
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, placed.itemIds[0]!));
    expect(item!.laterality).toBe("left");
  });

  it("spec #1080 D2: the same order with no side is refused", async () => {
    await expect(placeImagingOrder(db, fx.doctor, fx.decls, order({ serviceId: KNEE() }), "k-none", NOW))
      .rejects.toMatchObject({ code: "laterality_required" });
    expect(await db.select().from(orders)).toEqual([]);
  });

  it("spec #1080 D3: confirming right at the console for that study is refused with the mismatch code; left satisfies", async () => {
    const placed = await placeAndCreate({ serviceId: KNEE(), laterality: "left" });
    const checked = await arrive(placed.studyId, "xray");
    expect(checked.gates).toContain("laterality_confirm");

    const right = await satisfy(placed.studyId, "laterality_confirm", { patientStated: "right" });
    await expect(right.run()).rejects.toMatchObject({ code: "laterality_mismatch" });
    expect(await gateState(db, right.gateId)).toBe("open");

    const left = await satisfy(placed.studyId, "laterality_confirm", { patientStated: "left" });
    expect((await left.run()).state).toBe("satisfied");
    const [study] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, placed.studyId));
    expect(study!.laterality).toBe("left");
  });

  it("spec #1080 D4: the identity gate refuses a correct band without nameStated, and accepts it with", async () => {
    const placed = await placeAndCreate({ serviceId: fx.services["USG-ABDO"]! });
    const checked = await arrive(placed.studyId, "usg");
    expect(checked.gates).toContain("identity_two_factor");

    const band = await satisfy(placed.studyId, "identity_two_factor", { secondIdentifier: "wristband", value: "HMS-00000001-5" });
    await expect(band.run()).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(await gateState(db, band.gateId)).toBe("open");

    const said = await satisfy(placed.studyId, "identity_two_factor", {
      secondIdentifier: "wristband", value: "HMS-00000001-5", nameStated: true,
    });
    expect((await said.run()).state).toBe("satisfied");
    const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, said.gateId));
    expect(row!.evidence).toMatchObject({ kind: "identity_two_factor", secondIdentifier: "wristband", nameStated: true });
  });
});
