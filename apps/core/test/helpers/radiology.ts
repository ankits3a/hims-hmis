import { newId } from "@hmis/contracts";
import {
  imagingDefinitions, opdEncounters, patients, registrationConfig, services as servicesTable,
} from "../../src/kernel/db/schema";
import { withTx } from "../../src/kernel/db/client";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { seedSodPairs } from "../../src/kernel/auth/sod";
import { registerEncounterResolver } from "../../src/kernel/episodes/encounter-resolvers";
import { ORDERS_PLACE } from "../../src/kernel/orders/place";
import { activateDefinition, approveDefinition, createDraft } from "../../src/kernel/workflow/definitions";
import { createResource } from "../../src/kernel/resources/registry";
import {
  RADIOLOGY_RESOURCE_KINDS, handleOrderPlaced, imagingStudyDefinition, placeImagingOrder,
} from "../../src/modules/radiology";
import { ensureRole, mkUser } from "./opd";
import type { Db } from "../../src/kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { OrderKindDecl } from "../../src/kernel/orders/kinds";
import type { StudyType } from "../../src/modules/radiology";

/**
 * PLAN 18a T4 — **A VALID STUDY-TYPE ROW, AND THIS HELPER EXISTS BECAUSE T4 CAUGHT T3's FIXTURES.**
 *
 * T3's suites wrote study-type bodies carrying four fields — `code`, `service_id`, `modality`,
 * `pcpndt_applicable` — which was everything the reader needed at the time. T4 gave the body a zod
 * schema, and those bodies stopped parsing: they were missing `name`, `body_part`, `duration_min`,
 * `ionising`, `contrast_option`, `chaperone_required` and `laterality_applicable`.
 *
 * **That is the schema working, not the schema being awkward.** A body of that shape could never
 * have been PUBLISHED through `draftDefinition`, so the fixtures were asserting against a state the
 * system cannot reach — the §2.49 "vacuous fixture" shape, one layer down. Recorded as finding F15.
 *
 * The defaults below are a plain, unremarkable study type: not ionising, no contrast, not covered by
 * the PCPNDT Act, no chaperone, no laterality. Every suite overrides exactly the flags its assertion
 * is about, so a reader can see what the test is varying rather than what it inherited.
 */
export function studyTypeRow(over: Partial<StudyType> & Pick<StudyType, "code" | "service_id">): StudyType {
  return {
    name: `Study ${over.code}`,
    modality: "usg",
    body_part: "abdomen",
    duration_min: 20,
    ionising: false,
    contrast_option: "none",
    pcpndt_applicable: false,
    chaperone_required: false,
    laterality_applicable: false,
    gates: [],
    ...over,
  };
}

/**
 * Inserts an ACTIVE `study_types` definition directly.
 *
 * Direct insert rather than draft-then-approve-then-publish, deliberately: the governance sequence
 * is what `definitions.test.ts` exists to prove, and every OTHER suite needs a published book as a
 * PRECONDITION rather than as a subject. A suite that performed the whole approval dance to test
 * scheduling would be paying for a proof it is not making, and would fail for reasons that have
 * nothing to do with what it asserts.
 */
export async function seedActiveStudyTypes(
  db: Db,
  types: StudyType[],
  at: Date = new Date(),
): Promise<{ definitionId: string }> {
  const definitionId = newId();
  await db.insert(imagingDefinitions).values({
    id: definitionId, kind: "study_types", version: 1, status: "active",
    draftedBy: "fixture", publishedBy: "fixture", publishedAt: at,
    body: { types },
  });
  return { definitionId };
}

/**
 * ═══ THE SHARED RADIOLOGY FIXTURE (18a T4) ═══
 *
 * Three suites need the same precondition — a published study-type book, an active `imaging_study`
 * definition, devices of each modality, a patient on an open visit, and a placed order that has run
 * through the consumer. Building it three times would be three chances to build it slightly
 * differently, and a scheduling test that fails because its fixture drifted teaches nothing.
 *
 * What it deliberately does NOT hide: the Class-A governance sequence for the workflow definition is
 * performed in full (drafter, owner + MS approvals, distinct activator), because a fixture that
 * inserted an `active` row would prove nothing about whether the go-live runbook is performable —
 * `test/helpers/ot.ts` gives the same argument for its own.
 */
export type RadiologyFixture = {
  doctor: Actor;
  radiographer: Actor;
  patientId: string;
  visitNo: string;
  serviceDate: string;
  services: Record<string, string>;
  devices: Record<string, string>;
  decls: OrderKindDecl[];
  unregister: () => void;
};

export const RAD_IMAGING_PLACE = "radiology.orders.place";

export const radiologyDecl: OrderKindDecl = {
  kind: "imaging", seriesKey: "radiology_order", placePermission: RAD_IMAGING_PLACE,
  requiresClinician: true, requiresIndication: true, selfOrderable: false,
};

export async function setupRadiologyFixture(
  db: Db,
  opts: { serviceDate: string; now: Date; types?: StudyType[] },
): Promise<RadiologyFixture> {
  await db.insert(registrationConfig)
    .values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();

  const patientId = "01PATIENT0000000000000001";
  await db.insert(patients).values({
    id: patientId, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
    administrativeGender: "female", dob: new Date(Date.UTC(1996, 0, 1)),
    createdBy: "t", updatedBy: "t",
  });

  /** One service per modality, so a modality-mismatch test has something honest to mismatch. */
  const serviceSpecs = [
    ["USG-ABDO", "RAD-USG-ABDO", "usg", "abdomen"],
    ["XR-CHEST", "RAD-XR-CHEST", "xray", "chest"],
    ["CT-HEAD", "RAD-CT-HEAD", "ct", "head"],
    ["MRI-BRAIN", "RAD-MRI-BRAIN", "mri", "head"],
  ] as const;
  const services: Record<string, string> = {};
  for (const [code, serviceCode] of serviceSpecs) {
    const id = newId();
    services[code] = id;
    await db.insert(servicesTable).values({
      id, code: serviceCode, name: `Imaging ${code}`, category: "investigation",
      createdBy: "t", updatedBy: "t",
    });
  }

  await seedActiveStudyTypes(db, opts.types ?? serviceSpecs.map(([code, , modality, bodyPart]) =>
    studyTypeRow({
      code, service_id: services[code]!, modality, body_part: bodyPart,
      ionising: modality === "xray" || modality === "ct",
    })), opts.now);

  await db.insert(opdEncounters).values({
    id: newId(), visitNo: "V2608310001", patientId, status: "registered",
    workflowInstanceId: newId(), serviceDate: opts.serviceDate, visitType: "new",
    openedBy: "t", updatedBy: "t",
  });
  const unregister = registerEncounterResolver("V", async () => ({ patientId, intendedPayer: "self" }));

  const registry = new ModuleRegistry();
  registry.install({ key: "orders", title: "Orders", menu: [], permissions: [ORDERS_PLACE], subscriptions: [] });
  registry.install({ key: "radiology", title: "Rad", menu: [], permissions: [RAD_IMAGING_PLACE], subscriptions: [] });
  await syncPermissions(db, registry);
  for (const role of ["doctor", "radiographer", "owner", "medical_superintendent"]) await ensureRole(db, role);
  await grantPermissionToRole(db, registry, "doctor", ORDERS_PLACE);
  await grantPermissionToRole(db, registry, "doctor", RAD_IMAGING_PLACE);
  const { actor: doctor } = await mkUser(db, "dr.mehra", ["doctor"]);
  const { actor: radiographer } = await mkUser(db, "rt.singh", ["radiographer"]);
  const { actor: owner } = await mkUser(db, "owner.one", ["owner"]);
  const { actor: ms } = await mkUser(db, "ms.iyer", ["medical_superintendent"]);
  const { actor: drafter } = await mkUser(db, "rad.drafter", ["owner"]);

  await seedSodPairs(db);
  const draft = await createDraft(db, drafter, imagingStudyDefinition);
  await approveDefinition(db, owner, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
  await approveDefinition(db, ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
  await activateDefinition(db, owner, draft.definitionId);

  /** One machine per modality, each `available`, each carrying its `modality` attribute. */
  const devices: Record<string, string> = {};
  for (const [, , modality] of serviceSpecs) {
    if (devices[modality]) continue;
    const { resourceId } = await withTx(db, (tx) => createResource(tx, owner, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code: `DEV-${modality.toUpperCase()}`, name: `${modality} machine`,
      attributes: { modality },
    }));
    devices[modality] = resourceId;
  }

  return {
    doctor, radiographer, patientId, visitNo: "V2608310001",
    serviceDate: opts.serviceDate, services, devices, decls: [radiologyDecl], unregister,
  };
}

/** Places a one-item imaging order and runs the consumer, returning the study it created. */
export async function placeAndCreateStudy(
  db: Db,
  fx: RadiologyFixture,
  serviceCode: string,
  idemKey: string,
  now: Date,
): Promise<{ studyId: string; accessionNo: string; orderId: string; itemId: string }> {
  const placed = await placeImagingOrder(
    db, fx.doctor, fx.decls,
    {
      patientId: fx.patientId, encounterNo: fx.visitNo, serviceDate: fx.serviceDate,
      orderingClinicianId: "dr-consultant", indication: "clinical suspicion",
      items: [{ serviceId: fx.services[serviceCode]! }],
    } as never,
    idemKey, now,
  );
  const created = await withTx(db, (tx) => handleOrderPlaced(tx, {
    orderId: placed.orderId, orderNo: placed.orderNo, kind: "imaging",
    patientId: fx.patientId, encounterNo: fx.visitNo, groupId: placed.orderId,
    itemIds: placed.itemIds,
  }));
  return {
    studyId: created[0]!.studyId, accessionNo: created[0]!.accessionNo,
    orderId: placed.orderId, itemId: placed.itemIds[0]!,
  };
}
