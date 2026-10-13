import { randomUUID } from "node:crypto";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { ensureRole, mkPatient, mkUser, seedOpdBase } from "./opd";
import { admissionWorkflowDefinition, ipdManifest, ipdNonPayableDepositCode, registerIpdApprovalTypes } from "../../src/modules/ipd";
import { ipdRateServiceCode, newId } from "@hmis/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { ipdAdmissions, ipdBedStays, opdDepartments, opdDoctors } from "../../src/kernel/db/schema";
import { backfillDowntime, emergencyAdmit } from "../../src/modules/ipd";
import { listServices, resolveActiveTariffVersion } from "../../src/modules/tariff";
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
  /** The billing base's tariff drafter and activator (E2.1's fixture drafts a second rate card with them). */
  tariffDrafter: Actor; tariffActivator: Actor;
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
  return { ...w, admitDesk, doctor, ms, billingManager, owner: base.owner, tariffDrafter: base.drafter, tariffActivator: base.activator };
}

// ═══ E2.1 — the running bill: a second rate card (private, RMO, a class with no nursing rate) and the people ═══

/**
 * Per-day rates (paise) the charges fixture adds on top of `ADMIT_RATES`, in a tariff version activated 2026-01-03 (so
 * every admission the charges suites make, at explicit instants after it, locks THIS version). `semi_private` has a
 * room rate and NO nursing rate (the missing-rate leg); `general` has an RMO rate, `private` none (RMO is optional).
 */
export const CHARGE_RATES = {
  general: { room: 150_000, nursing: 50_000, visit: 80_000, rmo: 20_000, cross_visit: 100_000 },
  private: { room: 400_000, nursing: 90_000, visit: 120_000 },
  semi_private: { room: 250_000 },
  icu: { room: 600_000, nursing: 200_000, visit: 150_000 },
} as const;

export type ChargesWorld = AdmitWorld & {
  billDesk: Actor; resident: Actor; consultantUserId: string; crossUserId: string; versionId: string;
  /** Admits a patient onto a fresh bed of `cls` at the instant `at` (the emergency lane: no deposit, explicit time). */
  admitAt(cls: string, at: Date, code?: string): Promise<{ admissionId: string; patientId: string }>;
  /** Moves the admission to a fresh bed of `cls` at `at` (the transfer lane's act, written directly until it lands). */
  move(admissionId: string, cls: string, at: Date, billedClass?: string): Promise<void>;
  /** Ends the stay as discharged at `at` (the discharge lane's act, written directly until it lands). */
  discharge(admissionId: string, at: Date): Promise<void>;
};

export async function mkChargesWorld(db: Db): Promise<ChargesWorld> {
  const w = await mkAdmitWorld(db);
  const billing = { drafter: w.tariffDrafter, activator: w.tariffActivator, owner: w.owner };
  const current = await resolveActiveTariffVersion(db, new Date("2026-01-02T12:00:00Z"));
  const known = new Map((await listServices(db)).map((s) => [s.code, s.id] as const));
  const codes: [string, number][] = [];
  for (const [cls, r] of Object.entries(CHARGE_RATES)) {
    for (const [component, price] of Object.entries(r)) codes.push([ipdRateServiceCode(cls as "general", component as "room"), price]);
  }
  for (const [code] of codes) {
    if (!known.has(code)) {
      known.set(code, (await withTx(db, (tx) => createService(tx, billing.drafter, { code, name: code, category: "consultation" }))).serviceId);
    }
  }
  const version = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, billing.drafter, { copyFromVersionId: current!.versionId });
    for (const [code, price] of codes) await setTariffItem(tx, billing.drafter, d.versionId, known.get(code)!, price);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, billing.drafter, version.versionId));
  await approveRequest(db, billing.owner, { approvalId: submitted.approvalId, note: "ipd charges fixture tariff" });
  await activateVersion(db, billing.activator, version.versionId, new Date("2026-01-03T00:00:00Z"));

  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  await ensureRole(db, "t_bill_desk");
  for (const p of ["ipd.bill.view", "ipd.charges.reverse"]) await grantPermissionToRole(db, registry, "t_bill_desk", p);
  const billDesk = (await mkUser(db, "chg.billdesk", ["t_bill_desk"])).actor;
  const resident = (await mkUser(db, "chg.resident", ["doctor"])).actor;
  const cross = (await mkUser(db, "chg.cross", ["doctor"])).actor;

  // The doctor master: the admitting consultant (`w.doctor`) and a cross-consultant are on it; the resident is not.
  const deptId = newId();
  await db.insert(opdDepartments).values({ id: deptId, code: "IPDT", name: "IPD test", createdBy: "t", updatedBy: "t" });
  for (const [userId, code] of [[w.doctor.id, "DR-9001"], [cross.id, "DR-9002"]] as const) {
    await db.insert(opdDoctors).values({
      id: newId(), userId, displayName: `Dr ${code}`, code, registrationNo: "BMC/1", departmentId: deptId, createdBy: "t", updatedBy: "t",
    });
  }

  let n = 0;
  const freshBed = async (cls: string): Promise<string> => {
    n += 1;
    return w.bed(`C-${cls.toUpperCase()}-${String(n)}`, { class: cls, ...(cls === "icu" ? { icu: true } : {}) });
  };
  return {
    ...w, billDesk, resident, consultantUserId: w.doctor.id, crossUserId: cross.id, versionId: version.versionId,
    admitAt: async (cls, at) => {
      const patientId = await w.patient("male", 45);
      const bedId = await freshBed(cls);
      const done = await emergencyAdmit(db, w.admitDesk, {
        idempotencyKey: randomUUID(), patientId, bedId, consultantId: w.doctor.id, isolation: "none", mlc: false,
      }, { now: at });
      return { admissionId: done.admissionId, patientId };
    },
    move: async (admissionId, cls, at, billedClass) => {
      const bedId = await freshBed(cls);
      const open = (await db.select().from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt))))[0]!;
      await db.update(ipdBedStays).set({ endedAt: at, endedBy: w.admitDesk.id }).where(eq(ipdBedStays.id, open.id));
      await db.insert(ipdBedStays).values({
        id: newId(), bedId, admissionId, patientId: open.patientId, placedAs: open.placedAs, bedClass: cls, billedClass: billedClass ?? cls,
        startedBy: w.admitDesk.id, startedAt: at,
      });
    },
    discharge: async (admissionId, at) => {
      await db.update(ipdBedStays).set({ endedAt: at, endedBy: w.admitDesk.id })
        .where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt)));
      await db.update(ipdAdmissions).set({ state: "discharged", endedAt: at, endedBy: w.admitDesk.id, updatedAt: at })
        .where(eq(ipdAdmissions.id, admissionId));
    },
  };
}

// ═══ E3.1 — transfers: a second ward, a sending and a receiving nurse (duty-manager role until nursing roles land) ═══

export type TransferWorld = ChargesWorld & {
  /** Starts transfers and swaps (ipd.transfer.start + the bed strings); workflow role duty_manager. */
  sender: Actor;
  /** Accepts handovers (ipd.transfer.accept + the bed strings); workflow role duty_manager. */
  receiver: Actor;
  /** A second ward on the same floor (the receiving ward). */
  ward2Id: string;
  /** A bed in the second ward. */
  bed2(code: string, attrs?: Partial<Record<keyof typeof IPD_BED_DEFAULTS, unknown>>): Promise<string>;
  /** The admission's open stay (bed and billed class). */
  openStay(admissionId: string): Promise<typeof ipdBedStays.$inferSelect | undefined>;
};

export async function mkTransferWorld(db: Db): Promise<TransferWorld> {
  const w = await mkChargesWorld(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  await ensureRole(db, "duty_manager");
  for (const p of ["ipd.beds.view", "ipd.beds.manage", "ipd.admit", "ipd.transfer.start", "ipd.transfer.accept"]) {
    await grantPermissionToRole(db, registry, "duty_manager", p);
  }
  const sender = (await mkUser(db, "trf.sender", ["duty_manager"])).actor;
  const receiver = (await mkUser(db, "trf.receiver", ["duty_manager"])).actor;
  const SETUP: Actor = { type: "system", id: "test-transfer-world" };
  const place = (kind: string, code: string, parentId: string, attributes?: Record<string, unknown>) =>
    withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, { kind, code, name: code, parentId, ...(attributes ? { attributes } : {}) }))
      .then((r) => r.resourceId);
  const ward2Id = await place("ward", "F-T-W2", w.floorId, { department: "SUR", unitType: "WARD", wardType: "ward" });
  return {
    ...w, sender, receiver, ward2Id,
    bed2: (code, attrs = {}) => place("bed", code, ward2Id, { ...IPD_BED_DEFAULTS, ...attrs }),
    openStay: async (admissionId) =>
      (await db.select().from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt))))[0],
  };
}

// ═══ E3.2 — discharge: the cascade's people (doctor, cashier, duty manager, desk) holding the discharge strings ═══

export type DischargeWorld = TransferWorld & {
  /** Cashier: confirms billing, composes and settles the final bill, issues the gate pass; an open drawer. */
  cashier: Actor;
  /** Duty manager (= `sender`): confirms the ward, issues and scans gate passes, records LAMA / abscond, the mortuary. */
  duty: Actor;
  /** A second person for the mortuary's two-person identity check. */
  witness: Actor;
};

export async function mkDischargeWorld(db: Db): Promise<DischargeWorld> {
  const w = await mkTransferWorld(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    doctor: ["ipd.discharge.view", "ipd.discharge.declare", "ipd.discharge.exit"],
    cashier: ["ipd.discharge.view", "ipd.discharge.confirm", "ipd.discharge.bill", "ipd.gate.pass", "ipd.bill.view"],
    duty_manager: [
      "ipd.discharge.view", "ipd.discharge.confirm", "ipd.gate.pass", "ipd.gate.scan", "ipd.discharge.exit", "ipd.mortuary.manage",
    ],
    front_office: ["ipd.discharge.view", "ipd.gate.pass", "ipd.gate.scan"],
    billing_manager: ["ipd.discharge.view", "ipd.discharge.confirm", "ipd.discharge.bill", "ipd.gate.pass", "ipd.bill.view"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const cashier = (await mkUser(db, "dis.cashier", ["cashier"])).actor;
  const witness = (await mkUser(db, "dis.witness", ["duty_manager"])).actor;
  await openSession(db, cashier, 0);
  return { ...w, cashier, duty: w.sender, witness };
}

// ═══ E4.1 — nursing: the ward nursing roles (as `seed:roles` grants them) and a patient admitted on a bed ═══

export type NursingWorld = AdmitWorld & {
  /** ward_nurse: the station, vitals, assessment, shift handover. */
  nurse: Actor; nurse2: Actor;
  /** nursing_supervisor: the nurse's strings plus `ipd.ews.respond`; told of overdue assessments and unacknowledged alerts. */
  supervisor: Actor;
  /** Admits one patient onto a new bed by the downtime back-fill at an explicit instant; the consultant is `doctor`. */
  admitPatient(at: Date, opts?: { sex?: "male" | "female"; ageYears?: number; name?: string }): Promise<{ admissionId: string; patientId: string; bedId: string }>;
};

export async function mkNursingWorld(db: Db): Promise<NursingWorld> {
  const w = await mkAdmitWorld(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  const nurseStrings = ["ipd.nursing.view", "ipd.vitals.record", "ipd.assessment.record", "ipd.handover.shift", "ipd.beds.view"];
  const grants: Record<string, string[]> = {
    ward_nurse: nurseStrings,
    nursing_supervisor: [...nurseStrings, "ipd.ews.respond"],
    doctor: ["ipd.nursing.view", "ipd.vitals.record", "ipd.ews.respond"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const nurse = (await mkUser(db, "nrs.nurse", ["ward_nurse"])).actor;
  const nurse2 = (await mkUser(db, "nrs.nurse2", ["ward_nurse"])).actor;
  const supervisor = (await mkUser(db, "nrs.supervisor", ["nursing_supervisor"])).actor;
  let n = 0;
  return {
    ...w, nurse, nurse2, supervisor,
    admitPatient: async (at, opts = {}) => {
      n += 1;
      const patientId = await w.patient(opts.sex ?? "male", opts.ageYears ?? 50, opts.name);
      const bedId = await w.bed(`NRS-B${String(n).padStart(2, "0")}`, { class: "general", genderRule: "any" });
      const done = await backfillDowntime(db, w.admitDesk, {
        idempotencyKey: randomUUID(), paperSerial: `NRS-${String(n)}`, patientId, bedId, consultantId: w.doctor.id, requestedClass: "general",
        isolation: "none", provisionalDiagnosis: "Community-acquired pneumonia", mlc: false, payerKind: "cash",
        requestedAt: at.toISOString(), admittedAt: at.toISOString(), consent: { signedBy: "patient", method: "paper", witnessName: "Desk Witness" },
      }, { now: at });
      return { admissionId: done.admissionId, patientId, bedId };
    },
  };
}
