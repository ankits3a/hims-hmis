import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  imagingDefinitions, imagingStudies, opdEncounters, patients,
  registrationConfig, services, workflowInstances,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { seedActiveStudyTypes, studyTypeRow } from "../../../test/helpers/radiology";
import { ORDERS_PLACE } from "../../kernel/orders/place";
import { activateDefinition, approveDefinition, createDraft } from "../../kernel/workflow/definitions";
import { handleOrderPlaced } from "./consumers";
import { placeImagingOrder } from "./place";
import { imagingStudyDefinition } from "./workflow-def";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { OrderPlacedPayload } from "./consumers";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T3 — Assertion Book row **A7**: one study per item, in listed order, and a redelivery
 * that creates none.
 *
 * The handler is driven DIRECTLY rather than through the bus. The bus's own delivery guarantees are
 * the worker's tests; what this suite is for is the handler's behaviour when the bus does what a
 * bus does — deliver the same event twice.
 */
const IMAGING_PLACE = "radiology.orders.place";
const imagingDecl: OrderKindDecl = {
  kind: "imaging", seriesKey: "radiology_order", placePermission: IMAGING_PLACE,
  requiresClinician: true, requiresIndication: true, selfOrderable: false,
};
const DECLS = [imagingDecl];

describe("the radiology order.placed consumer (18a T3 A7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let doctor: Actor;
  let activator: Actor;

  const PATIENT = "01PATIENT0000000000000001";
  const SVC_XRAY = "01SERVICE0000000000000001";
  const SVC_USG = "01SERVICE0000000000000002";
  const VISIT = "V2608310001";
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig)
      .values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      administrativeGender: "female", dob: new Date(Date.UTC(2000, 0, 1)),
      createdBy: "t", updatedBy: "t",
    });
    await db.insert(services).values([
      { id: SVC_XRAY, code: "XR-CHEST", name: "X-ray chest", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: SVC_USG, code: "USG-ABDO", name: "USG abdomen", category: "investigation", createdBy: "t", updatedBy: "t" },
    ]);
    await seedActiveStudyTypes(db, [
      studyTypeRow({ code: "XR-CHEST", service_id: SVC_XRAY, modality: "xray", body_part: "chest", ionising: true }),
      studyTypeRow({ code: "USG-ABDO", service_id: SVC_USG, modality: "usg", body_part: "abdomen" }),
    ], NOW);
    await db.insert(opdEncounters).values({
      id: newId(), visitNo: VISIT, patientId: PATIENT, status: "registered",
      workflowInstanceId: newId(), serviceDate: DAY, visitType: "new",
      openedBy: "t", updatedBy: "t",
    });
    unregister = registerEncounterResolver("V", async () => ({ patientId: PATIENT, intendedPayer: "self" }));

    const registry = new ModuleRegistry();
    registry.install({ key: "orders", title: "Orders", menu: [], permissions: [ORDERS_PLACE], subscriptions: [] });
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: [IMAGING_PLACE], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "doctor");
    await ensureRole(db, "owner");
    await grantPermissionToRole(db, registry, "doctor", ORDERS_PLACE);
    await grantPermissionToRole(db, registry, "doctor", IMAGING_PLACE);
    await ensureRole(db, "medical_superintendent");
    ({ actor: doctor } = await mkUser(db, "dr.mehra", ["doctor"]));
    ({ actor: activator } = await mkUser(db, "owner.one", ["owner"]));
    const { actor: ms } = await mkUser(db, "ms.iyer", ["medical_superintendent"]);
    const { actor: drafter } = await mkUser(db, "rad.drafter", ["owner"]);

    /**
     * ═══ THE `imaging_study` DEFINITION IS ACTIVATED THE WAY THE RUNBOOK WILL BE ═══
     *
     * `startInstance` refuses `no_active_definition`, and this definition is **Class A** — so
     * activating it needs an approval from `owner` AND one from `medical_superintendent`, from two
     * DISTINCT people, and then an activator who is not the drafter. Four roles across three humans.
     *
     * The fixture performs that sequence rather than inserting an `active` row, for the reason
     * `test/helpers/ot.ts` gives about its own: a fixture that reached around the governance would
     * prove nothing about whether the go-live runbook is performable. It also means this suite
     * fails if T4's governance is ever loosened, which is the right place to find out.
     */
    /**
     * The SoD pair table is what `assertNotSodPair` consults, and an EMPTY table is an ERROR rather
     * than a pass — `unknown SoD pair key` — which is the safe direction and is why this line is
     * here rather than being assumed. `test/helpers/opd.ts` seeds it the same way.
     */
    await seedSodPairs(db);

    const draft = await createDraft(db, drafter, imagingStudyDefinition);
    await approveDefinition(db, activator, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
    await approveDefinition(db, ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
    await activateDefinition(db, activator, draft.definitionId);
  });

  afterEach(() => { unregister(); });

  const placeTwoItemOrder = async () =>
    await placeImagingOrder(
      db, doctor, DECLS,
      {
        patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
        orderingClinicianId: "dr-consultant", indication: "cough with abdominal pain",
        items: [{ serviceId: SVC_XRAY }, { serviceId: SVC_USG }],
      } as never,
      "k1", NOW,
    );

  const payloadFor = (placed: { orderId: string; orderNo: string; itemIds: string[] }): OrderPlacedPayload => ({
    orderId: placed.orderId, orderNo: placed.orderNo, kind: "imaging",
    patientId: PATIENT, encounterNo: VISIT, groupId: placed.orderId, itemIds: placed.itemIds,
  });

  it("A7: a TWO-item order gets TWO studies, one per item, in the order itemIds lists them", async () => {
    const placed = await placeTwoItemOrder();
    expect(placed.itemIds).toHaveLength(2);

    const created = await withTx(db, (tx) => handleOrderPlaced(tx, payloadFor(placed)));
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.orderItemId)).toEqual(placed.itemIds);

    const rows = await db.select({
      orderItemId: imagingStudies.orderItemId, code: imagingStudies.studyTypeCode,
      accessionNo: imagingStudies.accessionNo, status: imagingStudies.status,
    }).from(imagingStudies);
    expect(rows).toHaveLength(2);
    /** Each study carries the study type of ITS OWN item — A7's mutant collapses these to one. */
    expect(new Map(rows.map((r) => [r.orderItemId, r.code])))
      .toEqual(new Map([[placed.itemIds[0]!, "XR-CHEST"], [placed.itemIds[1]!, "USG-ABDO"]]));
  });

  it("A7: every study has its ACCESSION before it has a slot, and the two are distinct `X` numbers", async () => {
    const placed = await placeTwoItemOrder();
    const created = await withTx(db, (tx) => handleOrderPlaced(tx, payloadFor(placed)));

    const accessions = created.map((c) => c.accessionNo);
    for (const accession of accessions) expect(accession).toMatch(/^X\d+$/);
    expect(new Set(accessions).size).toBe(2);

    /** Not scheduled, no device, no slot — and it still has a number. */
    const [row] = await db.select().from(imagingStudies)
      .where(eq(imagingStudies.id, created[0]!.studyId));
    expect([row!.status, row!.deviceResourceId, row!.scheduledAt]).toEqual(["scheduled", null, null]);
  });

  it("A7: REDELIVERY of the same event creates nothing, and returns the same studies", async () => {
    const placed = await placeTwoItemOrder();
    const first = await withTx(db, (tx) => handleOrderPlaced(tx, payloadFor(placed)));
    const second = await withTx(db, (tx) => handleOrderPlaced(tx, payloadFor(placed)));

    expect(await db.select({ id: imagingStudies.id }).from(imagingStudies)).toHaveLength(2);
    expect(new Set(second.map((s) => s.studyId))).toEqual(new Set(first.map((s) => s.studyId)));

    /** And no second workflow instance either — a duplicate instance would be a study with two machines. */
    const instances = await db.select({ id: workflowInstances.id })
      .from(workflowInstances).where(eq(workflowInstances.subjectType, "imaging_study"));
    expect(instances).toHaveLength(2);
  });

  it("each study gets its OWN workflow instance, started at `scheduled`", async () => {
    const placed = await placeTwoItemOrder();
    const created = await withTx(db, (tx) => handleOrderPlaced(tx, payloadFor(placed)));

    const studies = await db.select({
      id: imagingStudies.id, instanceId: imagingStudies.workflowInstanceId,
    }).from(imagingStudies);
    expect(new Set(studies.map((s) => s.instanceId)).size).toBe(2);

    for (const study of studies) {
      const [instance] = await db.select({ state: workflowInstances.currentState, subjectId: workflowInstances.subjectId })
        .from(workflowInstances).where(eq(workflowInstances.id, study.instanceId));
      expect([instance!.state, instance!.subjectId]).toEqual(["scheduled", study.id]);
    }
    expect(created).toHaveLength(2);
  });

  /**
   * The consumer is subscribed to `order.placed`, which EVERY claiming module's orders raise. A lab
   * order reaching this handler must produce nothing at all — otherwise installing a second module
   * would silently create imaging studies for blood tests.
   */
  it("an order of another KIND is ignored entirely", async () => {
    const placed = await placeTwoItemOrder();
    const created = await withTx(db, (tx) =>
      handleOrderPlaced(tx, { ...payloadFor(placed), kind: "lab" }));
    expect(created).toEqual([]);
    expect(await db.select({ id: imagingStudies.id }).from(imagingStudies)).toHaveLength(0);
  });

  /**
   * DD14's consequence carried across the seam: the item's `restricted` flag, set at PLACEMENT by
   * the applicability rule, becomes the study's `form_f_required`. Read rather than recomputed, so
   * there is one decision and not two that can disagree.
   */
  it("the study inherits form_f_required from the ITEM's restricted flag, never recomputing it", async () => {
    await db.update(imagingDefinitions).set({
      body: {
        types: [
          studyTypeRow({ code: "USG-PELVIS", service_id: SVC_USG, modality: "usg", body_part: "pelvis", pcpndt_applicable: true, chaperone_required: true }),
          studyTypeRow({ code: "XR-CHEST", service_id: SVC_XRAY, modality: "xray", body_part: "chest", ionising: true }),
        ],
      },
    });
    const placed = await placeImagingOrder(
      db, doctor, DECLS,
      {
        patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
        orderingClinicianId: "dr-consultant", indication: "pelvic pain",
        items: [{ serviceId: SVC_USG }, { serviceId: SVC_XRAY }],
      } as never,
      "k-mixed", NOW,
    );
    await withTx(db, (tx) => handleOrderPlaced(tx, payloadFor(placed)));

    const rows = await db.select({
      orderItemId: imagingStudies.orderItemId, formF: imagingStudies.formFRequired,
    }).from(imagingStudies);
    expect(new Map(rows.map((r) => [r.orderItemId, r.formF])))
      .toEqual(new Map([[placed.itemIds[0]!, true], [placed.itemIds[1]!, false]]));
  });
});
