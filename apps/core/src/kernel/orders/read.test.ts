import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import * as permissionsModule from "../auth/permissions";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ALL_MANIFESTS } from "../modules/manifests";
import { ModuleRegistry } from "../modules/loader";
import { patients, registrationConfig, services } from "../db/schema";
import { withTx } from "../db/client";
import { registerEncounterResolver } from "../episodes/encounter-resolvers";
import { advanceOrderItem } from "./advance";
import { ORDERS_PERMISSIONS, ordersManifest } from "./manifest";
import { ORDERS_PLACE, placeOrder } from "./place";
import { findRecentItems, listOrdersForEncounter, listOrdersForPatient } from "./read";
import type { OrderKindDecl } from "./kinds";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 17 PHASE 0 T5 — the cross-kind readers, DD11's restricted rule, and the duplicate window.
 */
const LAB_PLACE = "lab.orders.place";
const IMAGING_PLACE = "radiology.orders.place";
const CONFIDENTIAL_READ = "patients.confidential.read";

const labDecl: OrderKindDecl = {
  kind: "lab", seriesKey: "lab_order", placePermission: LAB_PLACE,
  requiresClinician: true, requiresIndication: false, selfOrderable: false,
};
const imagingDecl: OrderKindDecl = {
  kind: "imaging", seriesKey: "radiology_order", placePermission: IMAGING_PLACE,
  requiresClinician: true, requiresIndication: false, selfOrderable: false,
};
const DECLS = [labDecl, imagingDecl];

describe("the order envelope's readers (Plan 17 phase 0 T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let consultant: Actor;   // ordered the restricted item; holds NO restricted-read permission
  let ward: Actor;         // a colleague: no restricted read, no confidential read
  let auditor: Actor;      // holds orders.read.restricted
  let privacy: Actor;      // holds patients.confidential.read

  const PATIENT = "01PATIENT0000000000000001";
  const SEALED = "01PATIENT0000000000000002";
  const VISIT = "V2608290001";
  const SEALED_VISIT = "V2608290002";
  const CBC = "01SERVICE0000000000000001";
  const HIV = "01SERVICE0000000000000002";
  const DAY = "2026-08-29";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values([
      { id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
        administrativeGender: "female", createdBy: "t", updatedBy: "t" },
      /**
       * A5's subject. `isConfidential` with an `alias` is exactly what registration writes for a
       * §14 staff-as-patient or VIP row — registration REFUSES a confidential patient with no
       * alias, so this fixture is the shape the real table holds.
       */
      { id: SEALED, uhid: "HMS-00000002-3", name: "Meera Raghavan", alias: "Patient S-14",
        isConfidential: true, sex: "female", administrativeGender: "female",
        createdBy: "t", updatedBy: "t" },
    ]);
    await db.insert(services).values([
      { id: CBC, code: "CBC", name: "Complete blood count", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: HIV, code: "HIV-ELISA", name: "HIV ELISA", category: "investigation", createdBy: "t", updatedBy: "t" },
    ]);
    unregister = registerEncounterResolver("V", async (_db, no) =>
      no === VISIT ? { patientId: PATIENT, intendedPayer: "self" }
        : no === SEALED_VISIT ? { patientId: SEALED, intendedPayer: "self" } : null);

    const registry = new ModuleRegistry();
    registry.install(ordersManifest);
    registry.install({ key: "lab", title: "Lab", menu: [], permissions: [LAB_PLACE], subscriptions: [] });
    registry.install({ key: "rad", title: "Rad", menu: [], permissions: [IMAGING_PLACE], subscriptions: [] });
    registry.install({ key: "patients", title: "P", menu: [], permissions: [CONFIDENTIAL_READ], subscriptions: [] });
    await syncPermissions(db, registry);
    for (const role of ["consultant", "ward_clerk", "auditor", "privacy_officer"]) await ensureRole(db, role);
    for (const role of ["consultant", "ward_clerk", "auditor", "privacy_officer"]) {
      await grantPermissionToRole(db, registry, role, ORDERS_PLACE);
      await grantPermissionToRole(db, registry, role, LAB_PLACE);
      await grantPermissionToRole(db, registry, role, IMAGING_PLACE);
    }
    await grantPermissionToRole(db, registry, "auditor", ORDERS_PERMISSIONS.readRestricted);
    await grantPermissionToRole(db, registry, "privacy_officer", CONFIDENTIAL_READ);
    ({ actor: consultant } = await mkUser(db, "dr.mehra", ["consultant"]));
    ({ actor: ward } = await mkUser(db, "ward.clerk", ["ward_clerk"]));
    ({ actor: auditor } = await mkUser(db, "audit.rao", ["auditor"]));
    ({ actor: privacy } = await mkUser(db, "privacy.bose", ["privacy_officer"]));
  });

  afterEach(() => { unregister(); });

  /** One lab order for `patientId`, carrying a plain CBC and a RESTRICTED HIV test. */
  async function orderWithRestricted(
    patientId = PATIENT,
    encounterNo = VISIT,
    clinicianId: string | null = null,
  ): Promise<{ orderId: string; itemIds: string[] }> {
    return withTx(db, (tx) => placeOrder(tx, consultant, DECLS, {
      kind: "lab", patientId, encounterNo, serviceDate: DAY,
      orderingClinicianId: clinicianId ?? consultant.id,
      items: [{ serviceId: CBC }, { serviceId: HIV, restricted: true }],
    }));
  }

  // ─────────────────────── A1 / A2 — DD11's restricted rule, both legs ───────────────────────

  /**
   * A1 — the ward clerk is neither the ordering clinician nor a holder of `orders.read.restricted`.
   * The mutant is "drop the filter", and its consequence is an HIV order on every pending list on
   * the ward.
   */
  it("A1 — a restricted item is OMITTED for a caller who is neither clinician nor restricted-reader", async () => {
    await orderWithRestricted();
    const view = await listOrdersForPatient(db, ward, PATIENT);
    expect(view.orders).toHaveLength(1);
    expect(view.orders[0]!.items.map((i) => i.serviceId)).toEqual([CBC]);
    // And the omission is SILENT: there is no field anywhere on the view from which the clerk
    // could infer that a restricted item exists. See F6 — DD11's word is "omits".
    expect(JSON.stringify(view)).not.toContain(HIV);
  });

  /**
   * A2 — the ordering clinician sees their OWN restricted item without holding the permission. The
   * mutant is "require the permission for everyone": the doctor who ordered the test cannot see it,
   * and the clinic then routes around the flag, which loses the protection for every patient.
   */
  it("A2 — the ordering clinician sees their own restricted item with NO extra permission", async () => {
    await orderWithRestricted();
    const view = await listOrdersForPatient(db, consultant, PATIENT);
    expect(view.orders[0]!.items.map((i) => i.serviceId).sort()).toEqual([CBC, HIV].sort());
  });

  it("A2b — a holder of orders.read.restricted sees it though they ordered nothing", async () => {
    await orderWithRestricted();
    const view = await listOrdersForPatient(db, auditor, PATIENT);
    expect(view.orders[0]!.items).toHaveLength(2);
  });

  /**
   * The leg that stops A2 passing for "any user sees any restricted item": a DIFFERENT clinician's
   * order is filtered for this consultant exactly as it is for the clerk. Without it, an
   * implementation that ignored `orderingClinicianId` entirely and returned everything to every
   * user would satisfy A2.
   */
  it("A2c — a consultant does NOT see a restricted item ANOTHER clinician ordered", async () => {
    await orderWithRestricted(PATIENT, VISIT, "some-other-doctor");
    const view = await listOrdersForPatient(db, consultant, PATIENT);
    expect(view.orders[0]!.items.map((i) => i.serviceId)).toEqual([CBC]);
  });

  it("a non-user actor gets the FLOOR clearance and no permission lookup is made on its id", async () => {
    await orderWithRestricted();
    const permissions = jest.spyOn(permissionsModule, "hasPermission");
    try {
      const view = await listOrdersForPatient(db, { type: "patient", id: "patient-credential-1" }, PATIENT);
      expect(view.orders[0]!.items.map((i) => i.serviceId)).toEqual([CBC]);
      // On the ARGUMENTS, never on the spy — see place.test.ts A2 for why (a failing
      // `not.toHaveBeenCalled()` pretty-prints the whole drizzle transaction and OOMs the runner).
      expect(permissions.mock.calls.map((call) => call[1])).toEqual([]);
    } finally {
      permissions.mockRestore();
    }
  });

  // ─────────────────────────── A5 — the sealed patient's name ───────────────────────────

  /**
   * A5 / E17 — the mutant reads `patients.name` directly, and it PRINTS A SEALED PATIENT'S REAL
   * NAME. This is 07c's exact finding, and the rule has one owner: `modules/patients/display-name.ts`.
   */
  it("A5 — a sealed patient's list renders the ALIAS for a caller without patients.confidential.read", async () => {
    await orderWithRestricted(SEALED, SEALED_VISIT);
    const view = await listOrdersForPatient(db, ward, SEALED);
    expect(view.patientDisplayName).toBe("Patient S-14");
    expect(view.patientDisplayName).not.toContain("Meera");
  });

  it("A5b — a holder of patients.confidential.read sees the legal name", async () => {
    await orderWithRestricted(SEALED, SEALED_VISIT);
    const view = await listOrdersForPatient(db, privacy, SEALED);
    expect(view.patientDisplayName).toBe("Meera Raghavan");
  });

  it("A5c — an unsealed patient's name is their name, for everybody", async () => {
    await orderWithRestricted();
    expect((await listOrdersForPatient(db, ward, PATIENT)).patientDisplayName).toBe("Asha Devi");
  });

  // ─────────────────────────── the encounter reader ───────────────────────────

  it("lists by encounter number and applies the same restricted rule", async () => {
    await orderWithRestricted();
    const forWard = await listOrdersForEncounter(db, ward, VISIT);
    expect(forWard[0]!.items.map((i) => i.serviceId)).toEqual([CBC]);
    const forAuditor = await listOrdersForEncounter(db, auditor, VISIT);
    expect(forAuditor[0]!.items).toHaveLength(2);
    expect(await listOrdersForEncounter(db, ward, "V2608290999")).toEqual([]);
  });

  // ─────────────────────── A3 — findRecentItems, the duplicate window ───────────────────────

  it("A3 — findRecentItems finds a prior item across KINDS and inside the window", async () => {
    await withTx(db, (tx) => placeOrder(tx, consultant, DECLS, {
      kind: "lab", patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
      orderingClinicianId: consultant.id, items: [{ serviceId: CBC }],
    }));
    await withTx(db, (tx) => placeOrder(tx, consultant, DECLS, {
      kind: "imaging", patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
      orderingClinicianId: consultant.id, items: [{ serviceId: CBC }],
    }));
    const found = await findRecentItems(db, PATIENT, CBC, 24);
    expect(found).toHaveLength(2);
    // Cross-kind by construction: the lab's duplicate check sees radiology's order.
    expect(found.map((f) => f.kind).sort()).toEqual(["imaging", "lab"]);
  });

  /**
   * A3's mutant is "include cancelled ones", and its consequence is a warning that blocks a
   * clinically-required repeat — which trains clinicians to click through warnings.
   */
  it("A3b — a CANCELLED item is excluded; a completed one is not", async () => {
    const { itemIds } = await withTx(db, (tx) => placeOrder(tx, consultant, DECLS, {
      kind: "lab", patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
      orderingClinicianId: consultant.id, items: [{ serviceId: CBC }, { serviceId: HIV }],
    }));
    await withTx(db, (tx) => advanceOrderItem(tx, consultant, DECLS, itemIds[0]!, "cancelled"));
    expect(await findRecentItems(db, PATIENT, CBC, 24)).toEqual([]);

    await withTx(db, (tx) => advanceOrderItem(tx, consultant, DECLS, itemIds[1]!, "in_progress"));
    await withTx(db, (tx) => advanceOrderItem(tx, consultant, DECLS, itemIds[1]!, "completed"));
    const completed = await findRecentItems(db, PATIENT, HIV, 24);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.status).toBe("completed");
  });

  it("A3c — the window is respected at both ends, and it is another PATIENT's business only", async () => {
    await withTx(db, (tx) => placeOrder(tx, consultant, DECLS, {
      kind: "lab", patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
      orderingClinicianId: consultant.id, items: [{ serviceId: CBC }],
    }));
    // `now` is injected, so the window is measured rather than waited for.
    const inWindow = await findRecentItems(db, PATIENT, CBC, 2, new Date(Date.now() + 3600_000));
    expect(inWindow).toHaveLength(1);
    const outOfWindow = await findRecentItems(db, PATIENT, CBC, 2, new Date(Date.now() + 3 * 3600_000));
    expect(outOfWindow).toEqual([]);
    // A different patient's identical test is not a duplicate.
    expect(await findRecentItems(db, SEALED, CBC, 24)).toEqual([]);
  });

  // ────────────────────────── A4 — the manifest census, by measurement ──────────────────────────

  it("A4 — ALL_MANIFESTS carries `orders` and its four permissions reach registry.allPermissions()", () => {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    expect(ALL_MANIFESTS.map((m) => m.key)).toContain("orders");
    const all = registry.allPermissions();
    for (const permission of Object.values(ORDERS_PERMISSIONS)) expect(all).toContain(permission);
    // `manifests.test.ts` is the census that pins the COUNT and the ORDER; this pins that the four
    // strings a role could be granted actually reach the catalog `syncPermissions` writes.
    expect(ordersManifest.menu).toEqual([]);
    expect(ordersManifest.subscriptions).toEqual([]);
  });
});
