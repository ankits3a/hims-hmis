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
  RADIOLOGY_RESOURCE_KINDS, RADIOLOGY_WORKFLOW_DEFINITIONS, handleOrderPlaced, placeImagingOrder,
} from "../../src/modules/radiology";
import { ensureRole, mkUser } from "./opd";
import { AERB_LICENSABLE_MODALITIES, aerbManifest, fileLicence } from "../../src/modules/aerb";
import { imagingStudies } from "../../src/kernel/db/schema";
import { eq } from "drizzle-orm";
import { checkIn } from "../../src/modules/radiology/checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "../../src/modules/radiology/gates";
import { scheduleStudy } from "../../src/modules/radiology/schedule";
import { recordAcquired, startAcquisition } from "../../src/modules/radiology/acquisition";
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
  /** 18a T5 — the override lane's only holder, and `prior_contrast_reaction`'s named decider. */
  radiologist: Actor;
  /** PLAN 18c T1 — files the AERB licences; holds `aerb.registers.manage` and no clinical string. */
  rso: Actor;
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
  opts: { serviceDate: string; now: Date; types?: StudyType[]; unlicensedModalities?: string[] },
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
  for (const role of ["doctor", "radiographer", "radiologist", "owner", "medical_superintendent"]) {
    await ensureRole(db, role);
  }
  await grantPermissionToRole(db, registry, "doctor", ORDERS_PLACE);
  await grantPermissionToRole(db, registry, "doctor", RAD_IMAGING_PLACE);
  const { actor: doctor } = await mkUser(db, "dr.mehra", ["doctor"]);
  const { actor: radiographer } = await mkUser(db, "rt.singh", ["radiographer"]);
  const { actor: radiologist } = await mkUser(db, "dr.rao", ["radiologist"]);
  const { actor: owner } = await mkUser(db, "owner.one", ["owner"]);
  const { actor: ms } = await mkUser(db, "ms.iyer", ["medical_superintendent"]);
  const { actor: drafter } = await mkUser(db, "rad.drafter", ["owner"]);
  /**
   * PLAN 18c T1 — the RSO, who files the equipment licences below. The AERB manifest is installed
   * here rather than in each suite for the reason the pcpndt helper gives: building it four times
   * is four chances to build it differently.
   */
  registry.install(aerbManifest);
  await syncPermissions(db, registry);
  await ensureRole(db, "radiation_safety_officer");
  for (const p of aerbManifest.permissions) {
    await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
  }
  const { actor: rso } = await mkUser(db, "rso.bhat", ["radiation_safety_officer"]);

  await seedSodPairs(db);
  /**
   * 18a T5 — BOTH definitions, not just the study's. `openStudyGate` starts an `imaging_gate`
   * instance per opened gate, and `startInstance` refuses `no_active_definition` — so a fixture
   * that activated only `imaging_study` made every check-in fail for a reason that had nothing to
   * do with the assertion. The governance sequence is still performed in full for each, for the
   * reason the header gives: a fixture that inserted an `active` row would prove nothing about
   * whether the go-live runbook is performable.
   */
  for (const definition of RADIOLOGY_WORKFLOW_DEFINITIONS) {
    const draft = await createDraft(db, drafter, definition);
    await approveDefinition(db, owner, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
    await approveDefinition(db, ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
    await activateDefinition(db, owner, draft.definitionId);
  }

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

  /**
   * ═══ PLAN 18c T1 — THE AERB LICENCE, AND WHY THE FIXTURE HAS TO FILE ONE ═══
   *
   * 18c's D3 refuses to start an ionising acquisition on a machine with no active AERB licence.
   * That is a real change to what a working hospital looks like, and this fixture models a working
   * hospital: the X-ray and CT units carry a licence covering the fixture's own service date, and
   * the ultrasound and MRI units carry none because AERB licences neither.
   *
   * `opts.unlicensedModalities` is the negative. A suite proving the refusal passes the modality it
   * wants dark rather than deleting rows afterwards — the licence is then MISSING rather than
   * revoked, which is the state a hospital that never filed is actually in.
   */
  const dark = new Set(opts.unlicensedModalities ?? []);
  const licenceWindow = { from: "2020-01-01", to: "2099-12-31" };
  for (const [, , modality] of serviceSpecs) {
    if (!AERB_LICENSABLE_MODALITIES.includes(modality)) continue;
    if (dark.has(modality)) continue;
    const deviceResourceId = devices[modality];
    if (deviceResourceId === undefined) continue;
    await withTx(db, (tx) => fileLicence(tx, rso, {
      deviceResourceId,
      licenceType: modality === "ct" ? "licence" : "registration",
      licenceNo: `AERB/${modality.toUpperCase()}/FIXTURE/1`,
      validFrom: licenceWindow.from, validTo: licenceWindow.to,
      rsoUserId: rso.id,
    }));
  }

  return {
    doctor, radiographer, radiologist, rso, patientId, visitNo: "V2608310001",
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
      /**
       * ═══ FINDING F28 — WITHOUT THIS, EVERY SUITE USING THIS HELPER IS A TIME BOMB ═══
       *
       * T3's duplicate window is `orders.placed_at >= now - 24h`, and `placeOrder` stamps
       * `placed_at = input.placedAt ?? new Date()`. This helper spaces its placements 25 fictional
       * hours apart (T4's `newStudy`, T5's `arrive`) but did NOT pass `placedAt` — so every order
       * was stamped with the REAL wall clock while the window was measured from the FICTIONAL one.
       *
       * The two agree only while real time sits behind `NOW + seq*25h - 24h`. **It passed all day
       * on 2026-08-31 and began failing on 2026-09-01** — five radiology suites at once,
       * `duplicate_recent` against `R2608310001`, with no code change between the green and the red.
       * A test whose correctness depends on what day it is run is a test that will fail for
       * somebody who did not write it, on a morning when nothing is wrong.
       *
       * Passing the fictional instant makes the stamp and the window read the same clock, which is
       * what the 25-hour spacing always assumed.
       */
      placedAt: now,
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

/**
 * ═══ A STUDY ON `acquired`, WHICH IS WHERE A REPORT BECOMES POSSIBLE (18a T8) ═══
 *
 * Three T8 suites need the same seven-step precondition — placed, scheduled, checked in, every
 * opened gate cleared, ready, started, acquired. Building it three times would be three chances to
 * build it differently, and a reporting test that fails because its fixture drifted teaches nothing
 * (the same argument `setupRadiologyFixture` makes for itself).
 *
 * `stat` priority is set before the start so DD12a authorises without an invoice line: this helper's
 * subject is the REPORT, and a test that had to raise a bill first would be paying for a proof it is
 * not making. `money.test.ts` is where the authorisation matrix is asserted.
 */
/**
 * ═══ A STUDY ON THE MACHINE — `in_acquisition`, AND NOTHING FURTHER (18a CLOSE REVIEW, F53) ═══
 *
 * The step `acquireStudy` used to hide inside itself. It is extracted because F53 needed a test to
 * reach `in_acquisition` HONESTLY: the old `schedule.test.ts` fixture hand-wrote
 * `{status:'in_acquisition', acquiredAt: NOW}` — a pair the product cannot produce, which is
 * precisely why the guard reading it was unreachable and nobody noticed for nine tasks. A shared
 * helper that walks the real path is the cheapest defence against the next fixture doing it again.
 */
export async function startStudyOnMachine(
  db: Db,
  fx: RadiologyFixture,
  opts: { serviceCode?: string; deviceKey?: string; idemKey: string; now: Date; slot: Date },
): Promise<{ studyId: string; accessionNo: string; orderId: string; itemId: string }> {
  const serviceCode = opts.serviceCode ?? "USG-ABDO";
  const deviceKey = opts.deviceKey ?? "usg";
  const study = await placeAndCreateStudy(db, fx, serviceCode, opts.idemKey, opts.now);
  await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
    studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!, scheduledAt: opts.slot,
  }));
  const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: opts.now }));
  const evidence: Record<string, unknown> = {
    identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
    pregnancy_screen: { declared: true, lmpDate: new Date(opts.now.getTime() - 10 * 86_400_000).toISOString() },
    laterality_confirm: { patientStated: "na" },
  };
  for (const kind of checked.gates) {
    const gate = await requireStudyGate(db, study.studyId, kind);
    await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, opts.now));
  }
  await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
  await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
  await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, {
    studyId: study.studyId, now: opts.now,
  }));
  return study;
}

export async function acquireStudy(
  db: Db,
  fx: RadiologyFixture,
  opts: { serviceCode?: string; deviceKey?: string; idemKey: string; now: Date; slot: Date; dose?: boolean },
): Promise<{ studyId: string; accessionNo: string; orderId: string; itemId: string }> {
  const serviceCode = opts.serviceCode ?? "USG-ABDO";
  const deviceKey = opts.deviceKey ?? "usg";
  const study = await placeAndCreateStudy(db, fx, serviceCode, opts.idemKey, opts.now);
  await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
    studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!, scheduledAt: opts.slot,
  }));
  const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: opts.now }));
  const evidence: Record<string, unknown> = {
    identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
    pregnancy_screen: { declared: true, lmpDate: new Date(opts.now.getTime() - 10 * 86_400_000).toISOString() },
    laterality_confirm: { patientStated: "na" },
  };
  for (const kind of checked.gates) {
    const gate = await requireStudyGate(db, study.studyId, kind);
    await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, opts.now));
  }
  await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
  await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
  await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, {
    studyId: study.studyId, now: opts.now,
  }));
  await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
    studyId: study.studyId, imageSource: "no_pacs_images", now: opts.now,
    ...(opts.dose === true ? { doseDap: 1.2 } : {}),
  }));
  return study;
}
