import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  counterparties, labOrderables, opdEncounters, orderItems, orders, patients, phiAccessLog,
  registrationConfig, services,
} from "../../kernel/db/schema";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { seedActiveStudyTypes, studyTypeRow } from "../../../test/helpers/radiology";
import { ORDERS_PLACE } from "../../kernel/orders/place";
import { RadiologyError } from "./errors";
import { imagingDoorFor } from "./advised";
import { placeImagingOrder } from "./place";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS2 (18a-iv T1) — THE ORDERING DOOR'S READ, against a real database.
 *
 * The test that matters is the negative (18a-iv T1): a LAB line advised in the same consult does
 * NOT appear at the imaging door. The others pin D3 (already ordered, cancelled does not count),
 * D6 (an investigation the book does not name is shown greyed with a reason, never hidden), the
 * 30-day look-back that never names a restricted item, and the PHI line.
 */
const IMAGING_PLACE = "radiology.orders.place";
const DECLS: OrderKindDecl[] = [{
  kind: "imaging", seriesKey: "radiology_order", placePermission: IMAGING_PLACE,
  requiresClinician: true, requiresIndication: true, selfOrderable: false,
}];

describe("imagingDoorFor — the advised imaging lines (18-S RS2 / 18a-iv T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let doctor: Actor;

  const PATIENT = "01PATIENT0000000000000001";
  const SVC_CT_HEAD = "01SERVICE0000000000000001";
  const SVC_XR_KNEE = "01SERVICE0000000000000002";
  const SVC_CBC = "01SERVICE0000000000000003";
  /** An investigation on the price list that no study type names — D6's greyed line. */
  const SVC_PET = "01SERVICE0000000000000004";
  /** A consultation advised as a "test" — belongs to nobody's door. */
  const SVC_CONSULT = "01SERVICE0000000000000005";
  const SVC_USG_OBS = "01SERVICE0000000000000006";

  const VISIT = "V2609280001";
  const OTHER_VISIT = "V2609270001";
  const DAY = "2026-09-28";
  const NOW = new Date("2026-09-28T06:00:00.000Z");

  const advised = [
    { serviceId: SVC_CT_HEAD, code: "RAD-CT-HEAD", name: "CT head, plain", pricePaise: 250000 },
    { serviceId: SVC_CBC, code: "LAB-CBC", name: "Complete blood count", pricePaise: 35000 },
    { serviceId: SVC_XR_KNEE, code: "RAD-XR-KNEE", name: "X-ray knee", pricePaise: 45000 },
    { serviceId: SVC_PET, code: "RAD-PET", name: "PET-CT whole body", pricePaise: 2500000 },
    { serviceId: SVC_CONSULT, code: "CONS-ORTHO", name: "Orthopaedics consult", pricePaise: 60000 },
  ];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      administrativeGender: "female", dob: new Date(Date.UTC(1990, 0, 1)), createdBy: "t", updatedBy: "t",
    });
    const svc = (id: string, code: string, name: string, category = "investigation") =>
      ({ id, code, name, category, createdBy: "t", updatedBy: "t" });
    await db.insert(services).values([
      svc(SVC_CT_HEAD, "RAD-CT-HEAD", "CT head, plain"),
      svc(SVC_XR_KNEE, "RAD-XR-KNEE", "X-ray knee"),
      svc(SVC_CBC, "LAB-CBC", "Complete blood count"),
      svc(SVC_PET, "RAD-PET", "PET-CT whole body"),
      svc(SVC_CONSULT, "CONS-ORTHO", "Orthopaedics consult", "consultation"),
      svc(SVC_USG_OBS, "RAD-USG-OBS", "USG obstetric"),
    ]);
    await db.insert(labOrderables).values({
      serviceId: SVC_CBC, code: "CBC", nameEn: "Complete blood count", discipline: "haematology",
      specimenType: "whole_blood", container: "edta", tatMinutesRoutine: 120, createdBy: "t", updatedBy: "t",
    } as never);
    await seedActiveStudyTypes(db, [
      studyTypeRow({ code: "CT-HEAD-PLAIN", name: "CT head, plain", service_id: SVC_CT_HEAD, modality: "ct", ionising: true }),
      studyTypeRow({ code: "XR-KNEE", name: "X-ray knee", service_id: SVC_XR_KNEE, modality: "xray", ionising: true, laterality_applicable: true }),
      studyTypeRow({ code: "USG-OBS", name: "USG obstetric", service_id: SVC_USG_OBS, modality: "usg", pcpndt_applicable: true }),
    ], NOW);
    const visit = (visitNo: string, serviceDate: string, advisedTests: unknown[]) => ({
      id: newId(), visitNo, patientId: PATIENT, status: "in_consultation", workflowInstanceId: newId(),
      serviceDate, visitType: "new", openedBy: "t", updatedBy: "t", advisedTests,
    });
    await db.insert(opdEncounters).values([
      visit(VISIT, DAY, advised) as never,
      visit(OTHER_VISIT, "2026-09-27", []) as never,
    ]);
    unregister = registerEncounterResolver("V", async (_db, encounterNo) => {
      const rows = await db.select({ patientId: opdEncounters.patientId }).from(opdEncounters).where(eq(opdEncounters.visitNo, encounterNo));
      return rows[0] ? { patientId: rows[0].patientId, intendedPayer: "self" } : null;
    });
    const registry = new ModuleRegistry();
    registry.install({ key: "orders", title: "Orders", menu: [], permissions: [ORDERS_PLACE], subscriptions: [] });
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: [IMAGING_PLACE], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "doctor");
    await grantPermissionToRole(db, registry, "doctor", ORDERS_PLACE);
    await grantPermissionToRole(db, registry, "doctor", IMAGING_PLACE);
    ({ actor: doctor } = await mkUser(db, "dr.mehra", ["doctor"]));
  });

  afterEach(() => { unregister(); });

  const place = (encounterNo: string, serviceId: string, over: Record<string, unknown> = {}) =>
    placeImagingOrder(db, doctor, DECLS, {
      patientId: PATIENT, encounterNo, serviceDate: encounterNo === VISIT ? DAY : "2026-09-27",
      orderingClinicianId: doctor.id, indication: "headache for three weeks", items: [{ serviceId }], ...over,
    } as never, undefined, NOW);

  it("NEGATIVE: a lab line advised in the same consult does NOT appear, nor a consultation", async () => {
    const view = await imagingDoorFor(db, doctor, VISIT, NOW);
    const ids = view.lines.map((l) => l.serviceId);
    expect(ids).not.toContain(SVC_CBC);
    expect(ids).not.toContain(SVC_CONSULT);
    expect(ids).toEqual([SVC_CT_HEAD, SVC_XR_KNEE, SVC_PET]);
  });

  it("D6: an investigation the book does not name is shown greyed with a reason, never hidden", async () => {
    const view = await imagingDoorFor(db, doctor, VISIT, NOW);
    const pet = view.lines.find((l) => l.serviceId === SVC_PET)!;
    expect(pet.orderable).toBeNull();
    expect(pet.reason).toMatch(/not in the imaging study-type book/i);
    const knee = view.lines.find((l) => l.serviceId === SVC_XR_KNEE)!;
    expect(knee.orderable).toMatchObject({ studyTypeCode: "XR-KNEE", lateralityApplicable: true, ionising: true });
    expect(knee.reason).toBeNull();
    expect(view.bookActive).toBe(true);
    expect(view.book.map((b) => b.serviceId).sort()).toEqual([SVC_CT_HEAD, SVC_XR_KNEE, SVC_USG_OBS].sort());
  });

  it("D3: an imaging line already ordered on this visit is marked; a cancelled item does not count", async () => {
    const ct = await place(VISIT, SVC_CT_HEAD);
    const knee = await place(VISIT, SVC_XR_KNEE, { indication: "right knee pain after a fall" });
    await db.update(orderItems).set({ status: "cancelled", cancelledFrom: "placed", cancelReason: "patient declined", cancelledAt: NOW }).where(eq(orderItems.id, knee.itemIds[0]!));

    const view = await imagingDoorFor(db, doctor, VISIT, NOW);
    const ctLine = view.lines.find((l) => l.serviceId === SVC_CT_HEAD)!;
    expect(ctLine.alreadyOrderedItemId).toBe(ct.itemIds[0]);
    expect(ctLine.alreadyOrderedOrderNo).toBe(ct.orderNo);
    expect(view.lines.find((l) => l.serviceId === SVC_XR_KNEE)!.alreadyOrderedItemId).toBeNull();

    /** The visit's standing imaging orders come back for the "what happened to it" state. */
    expect(view.orders.map((o) => o.orderNo).sort()).toEqual([ct.orderNo, knee.orderNo].sort());
    expect(view.orders.find((o) => o.orderNo === ct.orderNo)!.items[0]).toMatchObject({
      serviceId: SVC_CT_HEAD, serviceName: "CT head, plain", study: null,
    });
  });

  it("a lab order on the same visit never marks an imaging line", async () => {
    await db.insert(orders).values({
      id: "01ORDERLAB000000000000001", orderNo: "L2609280001", orderGroupId: "g1", kind: "lab",
      patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY, priority: "routine", authority: "clinician",
      orderedByType: "user", orderedById: doctor.id, placedAt: NOW,
    } as never);
    await db.insert(orderItems).values({ id: "01ITEMLAB0000000000000001", orderId: "01ORDERLAB000000000000001", serviceId: SVC_CT_HEAD } as never);
    const view = await imagingDoorFor(db, doctor, VISIT, NOW);
    expect(view.lines.find((l) => l.serviceId === SVC_CT_HEAD)!.alreadyOrderedItemId).toBeNull();
  });

  it("the 30-day look-back names another visit's scan, and never a restricted one", async () => {
    const yesterday = await place(OTHER_VISIT, SVC_CT_HEAD);
    await place(OTHER_VISIT, SVC_USG_OBS, { indication: "dating scan" });
    const view = await imagingDoorFor(db, doctor, VISIT, NOW);
    expect(view.recent[SVC_CT_HEAD]).toEqual([expect.objectContaining({ itemId: yesterday.itemIds[0], encounterNo: OTHER_VISIT })]);
    /** The obstetric USG was placed restricted (PCPNDT, woman aged 36) — it is not named here. */
    expect(view.recent[SVC_USG_OBS]).toBeUndefined();
  });

  it("the read is PHI-logged once, as opd.visit, against the encounter", async () => {
    const view = await imagingDoorFor(db, doctor, VISIT, NOW);
    const rows = await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, PATIENT));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "opd.visit", actorId: doctor.id, encounterId: view.visit.encounterId });
  });

  it("an unknown visit number is refused, not answered empty", async () => {
    await expect(imagingDoorFor(db, doctor, "V2609289999", NOW)).rejects.toMatchObject({ code: "unknown_study" });
    await expect(imagingDoorFor(db, doctor, "V2609289999", NOW)).rejects.toBeInstanceOf(RadiologyError);
  });

  it("the walk-in leg: an outside slip's referrer is found-or-made from the registration number", async () => {
    const first = await place(VISIT, SVC_CT_HEAD, {
      authority: "external_prescription", referrer: { name: "Dr R. Sharma", registrationNo: "dmc/12345" },
    });
    const second = await place(VISIT, SVC_XR_KNEE, {
      authority: "external_prescription", referrer: { name: "Dr Rakesh Sharma", registrationNo: "DMC 12345" },
    });
    const cps = await db.select().from(counterparties);
    expect(cps).toHaveLength(1);
    expect(cps[0]).toMatchObject({ code: "RMP-DMC12345", payeeClass: "external_rmp", name: "Dr R. Sharma" });
    const placed = await db.select({ ref: orders.externalReferrerId, authority: orders.authority }).from(orders);
    expect(placed).toEqual([
      { ref: cps[0]!.id, authority: "external_prescription" },
      { ref: cps[0]!.id, authority: "external_prescription" },
    ]);
    expect(first.orderNo).not.toBe(second.orderNo);
  });

  it("the walk-in leg: an outside slip with no referrer is refused by name", async () => {
    await expect(place(VISIT, SVC_CT_HEAD, { authority: "external_prescription", referrer: { name: " ", registrationNo: "" } }))
      .rejects.toMatchObject({ code: "referrer_required" });
  });

  it("a 24-hour duplicate refusal carries the item ids the override pair needs", async () => {
    const first = await place(OTHER_VISIT, SVC_CT_HEAD);
    await expect(place(VISIT, SVC_CT_HEAD)).rejects.toMatchObject({
      code: "duplicate_recent", detail: expect.objectContaining({ recentItemIds: [first.itemIds[0]] }),
    });
  });
});
