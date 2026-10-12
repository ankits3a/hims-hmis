import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { ensureRole, mkPatient, mkUser, seedOpdBase } from "./opd";
import { admissionWorkflowDefinition, ipdManifest, ipdNonPayableDepositCode, registerIpdApprovalTypes } from "../../src/modules/ipd";
import { ipdRateServiceCode } from "@hmis/contracts";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { activateDefinition, approveDefinition, createDraft } from "../../src/kernel/workflow/definitions";
import { createDraftVersion, createService, setTariffItem, submitVersion, activateVersion } from "../../src/modules/tariff";
import { openSession } from "../../src/modules/billing/sessions";
import { seedBillingBase } from "./billing";
import { patientsManifest } from "../../src/modules/patients";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../src/kernel/resources";
import { withTx } from "../../src/kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";

/** A person who may apply a bed layout: holds `auth.users.manage` (see `modules/ipd` `BED_LAYOUT_PERMISSION`). */
export async function mkBedLoader(db: Db, username = "bed.loader"): Promise<Actor> {
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  await syncPermissions(db, registry);
  await ensureRole(db, "bed_layout_loader");
  await grantPermissionToRole(db, registry, "bed_layout_loader", "auth.users.manage");
  return (await mkUser(db, username, ["bed_layout_loader"])).actor;
}

// ═══ E1.1 — a small hospital for the bed intents: one floor, one ward, a twin room and flagged beds ═══

const IPD_BED_DEFAULTS = {
  class: "general", genderRule: "any", isolation: "none", negativePressure: false, icu: false,
  equipment: [], daycare: false, overflow: false,
} as const;

export type BedWorld = {
  desk: Actor; dutyManager: Actor; cleaner: Actor; viewer: Actor; nobody: Actor;
  floorId: string; wardId: string; roomId: string;
  bed(code: string, attrs?: Partial<Record<keyof typeof IPD_BED_DEFAULTS, unknown>>, parent?: "ward" | "room"): Promise<string>;
  patient(sex: "male" | "female" | "other", ageYears?: number, name?: string): Promise<string>;
};

/**
 * Users: `desk` holds view+manage (front office), `dutyManager` all four, `cleaner` view+clean, `viewer` view only,
 * `nobody` none. Places: F-T floor → F-T-W ward → F-T-R twin room; beds made on demand.
 */
export async function mkBedWorld(db: Db): Promise<BedWorld> {
  await seedOpdBase(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    t_bed_desk: ["ipd.beds.view", "ipd.beds.manage"],
    t_bed_duty: ["ipd.beds.view", "ipd.beds.manage", "ipd.beds.clean", "ipd.beds.overflow"],
    t_bed_clean: ["ipd.beds.view", "ipd.beds.clean"],
    t_bed_view: ["ipd.beds.view"],
    t_bed_none: [],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const user = async (name: string, role: string): Promise<Actor> => (await mkUser(db, name, [role])).actor;
  const desk = await user("bed.desk", "t_bed_desk");
  const dutyManager = await user("bed.duty", "t_bed_duty");
  const cleaner = await user("bed.clean", "t_bed_clean");
  const viewer = await user("bed.view", "t_bed_view");
  const nobody = await user("bed.none", "t_bed_none");
  const SETUP: Actor = { type: "system", id: "test-bed-world" };
  const place = (kind: string, code: string, parentId: string | null, attributes?: Record<string, unknown>) =>
    withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, { kind, code, name: code, parentId, ...(attributes ? { attributes } : {}) }))
      .then((r) => r.resourceId);
  const floorId = await place("floor", "F-T", null);
  const wardId = await place("ward", "F-T-W", floorId, { department: "MED", unitType: "WARD", wardType: "ward" });
  const roomId = await place("room", "F-T-R", wardId);
  let n = 0;
  return {
    desk, dutyManager, cleaner, viewer, nobody, floorId, wardId, roomId,
    bed: (code, attrs = {}, parent = "ward") => place("bed", code, parent === "room" ? roomId : wardId, { ...IPD_BED_DEFAULTS, ...attrs }),
    patient: async (sex, ageYears = 40, name) => {
      n += 1;
      const phone = `98765${String(43210 + n).padStart(5, "0")}`;
      const guardian = ageYears < 18 ? { guardian: { name: "Test Guardian", relationship: "mother" as const, phone } } : {};
      return (await mkPatient(db, desk, { name: name ?? `Test Patient ${String(n)}`, sex, ageYears, phone, ...guardian })).id;
    },
  };
}

// ═══ E1.2 — the admission desk: an active admission workflow, the IPD approval types and a priced rate card ═══

/** Per-day rates (paise) on the fixture tariff. `private` is deliberately NOT priced (the `rate_missing` leg). */
export const ADMIT_RATES = {
  general: { room: 150_000, nursing: 50_000, visit: 80_000 },
  icu: { room: 600_000, nursing: 200_000, visit: 150_000 },
} as const;
export const ADMIT_NONPAY_GENERAL = 500_000;

export type AdmitWorld = BedWorld & {
  admitDesk: Actor; doctor: Actor; ms: Actor; billingManager: Actor; owner: Actor;
};

/**
 * `mkBedWorld` plus: billing's base (an activated tariff, cashier roles, SoD pairs), the admission workflow ACTIVATED
 * the governance way (owner + MS approve, a third person activates), the three IPD approval types registered, the
 * IPD rate card priced for general and ICU, and the people: `admitDesk` (front_office, the four admission strings and
 * the bed strings, an open cashier drawer), `doctor` (raises requests only), `ms` (decides ICU approvals), and
 * `billingManager` (decides non-covered lines).
 */
export async function mkAdmitWorld(db: Db): Promise<AdmitWorld> {
  const w = await mkBedWorld(db);
  const base = await seedBillingBase(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  await ensureRole(db, "front_office");
  for (const p of ["ipd.beds.view", "ipd.beds.manage", "ipd.admit.request", "ipd.admit", "ipd.payer.manage", "ipd.band.print"]) {
    await grantPermissionToRole(db, registry, "front_office", p);
  }
  await ensureRole(db, "doctor");
  await grantPermissionToRole(db, registry, "doctor", "ipd.admit.request");
  const admitDesk = (await mkUser(db, "adm.desk", ["front_office"])).actor;
  const doctor = (await mkUser(db, "adm.doctor", ["doctor"])).actor;
  const ms = (await mkUser(db, "adm.ms", ["medical_superintendent"])).actor;
  const billingManager = (await mkUser(db, "adm.bm", ["billing_manager"])).actor;

  const draft = await createDraft(db, base.drafter, admissionWorkflowDefinition);
  await approveDefinition(db, base.owner, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
  await approveDefinition(db, ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
  await activateDefinition(db, base.activator, draft.definitionId);
  await registerIpdApprovalTypes(db, base.activator);

  const services: Record<string, string> = {};
  const codes: [string, number][] = [];
  for (const [cls, r] of Object.entries(ADMIT_RATES)) {
    for (const [component, price] of Object.entries(r)) codes.push([ipdRateServiceCode(cls as "general", component as "room"), price]);
  }
  codes.push([ipdNonPayableDepositCode("general"), ADMIT_NONPAY_GENERAL]);
  for (const [code] of codes) {
    services[code] = (await withTx(db, (tx) => createService(tx, base.drafter, { code, name: code, category: "consultation" }))).serviceId;
  }
  const version = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, base.drafter, { copyFromVersionId: base.tariffVersionId });
    for (const [code, price] of codes) await setTariffItem(tx, base.drafter, d.versionId, services[code]!, price);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, base.drafter, version.versionId));
  await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "ipd fixture tariff" });
  await activateVersion(db, base.activator, version.versionId, new Date("2026-01-02T00:00:00Z"));

  await openSession(db, admitDesk, 0);
  return { ...w, admitDesk, doctor, ms, billingManager, owner: base.owner };
}
