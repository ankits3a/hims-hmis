import { newId } from "@hmis/contracts";
import { episodeSeries, opdDepartments, opdDoctors, patients } from "../../src/kernel/db/schema";
import { withTx } from "../../src/kernel/db/client";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { ORDERS_PLACE } from "../../src/kernel/orders/place";
import { registerOpdEncounterResolver } from "../../src/modules/opd/opd.module";
import { billingManifest } from "../../src/modules/billing";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion, upsertGstCategory } from "../../src/modules/tariff";
import { openSessionFor, seedBillingBase } from "./billing";
import { activateOpdVisitDefinition, ensureRole, mkUser, seedOpdBase } from "./opd";
import type { BillingBaseFixture } from "./billing";
import type { RadiologyFixture } from "./radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";

/**
 * #1079 (IM2b) — **THE WORLD AN IMAGING WALK-IN OPENS INTO**, on top of `setupRadiologyFixture`.
 *
 * The radiology fixture is enough to place an order on a hand-made visit. A walk-in opens a REAL visit
 * through OPD's own opener, so it needs what the lab walk-in needs (`seedLabDeskBase`): the OPD config,
 * the OPD visit definition activated as the runbook does it, a `RAD` department row and the radiologist
 * of record as an `opd_doctors` row IN it (the go-live runbook's stand-up step), and OPD's real `V`
 * resolver in place of the fixture's stub — the stub answers "the fixture patient" for every number,
 * which would let a visit minted for another patient pass `placeOrder`'s patient check by accident.
 *
 * The patient here has NO visit at all (the fixture's own patient has `V2608310001` that day). That
 * hand-written visit number is also why the day's `visit` series starts at 2: the fixture inserted the
 * row without allocating it, and the first minted number would otherwise collide with it.
 *
 * The desk user holds what `radiology_receptionist` holds in production for these acts — the kernel's
 * `orders.place`, `radiology.orders.place`, `radiology.schedule`, `radiology.checkin`,
 * `radiology.bill_decisions.manage` — plus the counter's billing strings and an open cash drawer, so the
 * desk's own collect can be asked what the visit's bill carries. The imaging services are priced on a
 * real tariff version.
 */
export type ImagingWalkInFixture = {
  desk: Actor;
  /** A male patient with no visit on any day. Male, so no pregnancy gate and no PCPNDT rule is the subject. */
  patientId: string;
  radDepartmentId: string;
  radiologistDoctorId: string;
  radiologistUserId: string;
  billing: BillingBaseFixture;
  restore: () => void;
};

export const WALK_IN_PRICES: Record<string, number> = { "USG-ABDO": 120_000, "XR-CHEST": 30_000, "CT-HEAD": 250_000, "MRI-BRAIN": 600_000 };

const DESK_PERMISSIONS = [
  ORDERS_PLACE, "radiology.orders.place", "radiology.schedule", "radiology.checkin", "radiology.bill_decisions.manage",
  "billing.invoice.issue", "billing.receipt.record", "billing.session.own",
];

export async function setupImagingWalkIn(db: Db, fx: RadiologyFixture, opts: { serviceDate: string }): Promise<ImagingWalkInFixture> {
  await seedOpdBase(db);
  await activateOpdVisitDefinition(db);

  const radDepartmentId = newId();
  await db.insert(opdDepartments).values({
    id: radDepartmentId, code: "RAD", name: "Radiology", active: true, createdBy: "t", updatedBy: "t",
  });
  const radiologistDoctorId = newId();
  await db.insert(opdDoctors).values({
    id: radiologistDoctorId, userId: fx.radiologist.id, departmentId: radDepartmentId,
    displayName: "Dr Rao", code: "DR-RAD-01", registrationNo: "JMC/RAD/2014", active: true, createdBy: "t", updatedBy: "t",
  });

  const patientId = newId();
  await db.insert(patients).values({
    id: patientId, uhid: "HMS-00000207-3", name: "Mohan Lal", sex: "male",
    administrativeGender: "male", dob: new Date(Date.UTC(1968, 4, 10)), createdBy: "t", updatedBy: "t",
  });

  await db.insert(episodeSeries).values({ seriesKey: "visit", serviceDate: opts.serviceDate, nextNo: 2 })
    .onConflictDoNothing();

  fx.unregister();
  const unregisterResolver = registerOpdEncounterResolver();

  const billing = await seedBillingBase(db);
  await withTx(db, (tx) => upsertGstCategory(tx, billing.drafter, {
    category: "investigation", sacCode: "999316", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null,
  }));
  const draft = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, billing.drafter, { copyFromVersionId: billing.tariffVersionId });
    for (const [code, paise] of Object.entries(WALK_IN_PRICES)) await setTariffItem(tx, billing.drafter, d.versionId, fx.services[code]!, paise);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, billing.drafter, draft.versionId));
  await approveRequest(db, billing.owner, { approvalId: submitted.approvalId, note: "imaging walk-in fixture" });
  await activateVersion(db, billing.activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));

  const registry = new ModuleRegistry();
  registry.install(billingManifest);
  registry.install({ key: "orders", title: "Orders", menu: [], permissions: [ORDERS_PLACE], subscriptions: [] });
  registry.install({
    key: "radiology", title: "Rad", menu: [],
    permissions: DESK_PERMISSIONS.filter((p) => p.startsWith("radiology.")), subscriptions: [],
  });
  await syncPermissions(db, registry);
  await ensureRole(db, "radiology_receptionist");
  for (const p of DESK_PERMISSIONS) await grantPermissionToRole(db, registry, "radiology_receptionist", p);
  const desk = (await mkUser(db, "desk.walkin", ["radiology_receptionist"])).actor;
  await openSessionFor(db, { id: desk.id }, 0);

  return {
    desk, patientId, radDepartmentId, radiologistDoctorId, radiologistUserId: fx.radiologist.id, billing,
    restore: unregisterResolver,
  };
}
