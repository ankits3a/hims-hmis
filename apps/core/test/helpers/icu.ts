import { randomUUID } from "node:crypto";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { createAgent } from "../../src/kernel/auth/agents";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../src/kernel/resources";
import { withTx } from "../../src/kernel/db/client";
import { patientsManifest } from "../../src/modules/patients";
import { backfillDowntime, ipdManifest, printBand } from "../../src/modules/ipd";
import { RADIOLOGY_RESOURCE_KINDS } from "../../src/modules/radiology";
import { decideIcuRequest, icuManifest, mapCode, mapSlot, registerGateway, requestIcu } from "../../src/modules/icu";
import { ensureRole, mkUser } from "./opd";
import { mkDischargeWorld } from "./ipd";
import type { Actor, IcuDeviceType, IcuParam } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { DischargeWorld } from "./ipd";

/**
 * ICU IC-1 (#984) — a hospital with one ICU hall (MICU) behind one gateway, on top of the IPD discharge world (the admit
 * desk, the cashier, the approval types, the rate card with an `icu` class). Every instant is the caller's.
 *
 * People: `intensivist` and `intensivist2` (role `intensivist`: view, request, decide, care), `incharge` (`icu_incharge`:
 * view, care, manage), `icuNurse` (`ward_nurse` + view, care), `doctor` (the IPD world's consultant: view, request).
 */
export type IcuWorld = DischargeWorld & {
  intensivist: Actor; intensivist2: Actor; incharge: Actor; icuNurse: Actor;
  hallId: string; gatewayId: string; agent: Actor; interfaceId: string;
  /** A new ICU bed in the hall, its slot `slot` on the gateway (default its code). */
  icuBed(code: string, slot?: string): Promise<string>;
  /** A registered ICU device; `serial` is what the central station reports (default the code). */
  device(type: IcuDeviceType, code: string, serial?: string): Promise<string>;
  /** A patient admitted onto a new ICU bed at `at` through an approved ICU request; the band printed. */
  admitIcu(at: Date, opts?: { name?: string; slot?: string }): Promise<{ admissionId: string; patientId: string; bedId: string; band: string; slot: string }>;
};

/** Standard Philips-like OBX codes the fixture's gateway maps (synthetic). */
export const FIXTURE_CODES: Record<string, IcuParam> = {
  "150456^MDC_PULS_OXIM_SAT_O2": "spo2", "147842^MDC_ECG_HEART_RATE": "hr", "151562^MDC_RESP_RATE": "rr",
  "150301^MDC_PRESS_CUFF_SYS": "nibp_sys", "150302^MDC_PRESS_CUFF_DIA": "nibp_dia", "150344^MDC_TEMP": "temp",
  "151980^MDC_VENT_PRESS_AWAY_END_EXP_POS": "peep",
};
export const codeOf = (p: IcuParam): string => Object.entries(FIXTURE_CODES).find(([, v]) => v === p)![0];

const ICU_BED = {
  class: "icu", genderRule: "any", isolation: "none", negativePressure: false, icu: true, equipment: [], daycare: false, overflow: false,
};

export async function mkIcuWorld(db: Db, setupAt: Date): Promise<IcuWorld> {
  const w = await mkDischargeWorld(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  registry.install(icuManifest);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    intensivist: ["icu.view", "icu.request", "icu.decide", "icu.care", "ipd.nursing.view", "ipd.vitals.record"],
    icu_incharge: ["icu.view", "icu.care", "icu.manage", "ipd.nursing.view", "ipd.vitals.record"],
    ward_nurse: ["icu.view", "icu.care", "ipd.nursing.view", "ipd.vitals.record"],
    doctor: ["icu.view", "icu.request", "ipd.nursing.view", "ipd.vitals.record"],
    front_office: ["ipd.family.issue", "ipd.discharge.view", "ipd.band.print"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const intensivist = (await mkUser(db, "icu.intensivist", ["intensivist"])).actor;
  const intensivist2 = (await mkUser(db, "icu.intensivist2", ["intensivist"])).actor;
  const incharge = (await mkUser(db, "icu.incharge", ["icu_incharge"])).actor;
  const icuNurse = (await mkUser(db, "icu.nurse", ["ward_nurse"])).actor;

  const SETUP: Actor = { type: "system", id: "test-icu-world" };
  const floorId = (await withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F-ICU", name: "ICU floor", parentId: null }))).resourceId;
  const hallId = (await withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, {
    kind: "ward", code: "MICU-H1", name: "MICU Hall 1", parentId: floorId, attributes: { department: "MED", unitType: "MICU", wardType: "hall" },
  }))).resourceId;
  const agentRow = await createAgent(db, "icu-gateway-h1");
  const agent: Actor = { type: "agent", id: agentRow.id };
  const gw = await registerGateway(db, incharge, { hallId, name: "MICU Hall 1 gateway", agentId: agentRow.id }, setupAt);
  for (const [code, param] of Object.entries(FIXTURE_CODES)) await mapCode(db, incharge, { gatewayId: gw.gatewayId, code, param }, setupAt);

  const icuBed = async (code: string, slot = code): Promise<string> => {
    const bedId = (await withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, {
      kind: "bed", code, name: code, parentId: hallId, attributes: ICU_BED,
    }))).resourceId;
    await mapSlot(db, incharge, { gatewayId: gw.gatewayId, slot, bedId }, setupAt);
    return bedId;
  };
  const device = async (type: IcuDeviceType, code: string, serial = code): Promise<string> =>
    (await withTx(db, (tx) => createResource(tx, SETUP, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code, name: `${type} ${code}`, attributes: { icuType: type, serial },
    }))).resourceId;

  let n = 0;
  const admitIcu: IcuWorld["admitIcu"] = async (at, opts = {}) => {
    n += 1;
    const slot = opts.slot ?? `BED${String(n).padStart(2, "0")}`;
    const patientId = await w.patient("male", 58, opts.name ?? `Icu Patient ${String(n)}`);
    const bedId = await icuBed(`MICU-B${String(n).padStart(2, "0")}`, slot);
    const req = await requestIcu(db, w.doctor, {
      patientId, source: "er", priorityClass: 1, reason: "Septic shock on two pressors", triage: { sofa: 9 },
    }, new Date(at.getTime() - 20 * 60_000));
    const approved = await decideIcuRequest(db, intensivist, { requestId: req.id, decision: "approve", reason: "Needs ICU" }, new Date(at.getTime() - 10 * 60_000));
    const done = await backfillDowntime(db, w.admitDesk, {
      idempotencyKey: randomUUID(), paperSerial: `ICU-${String(n)}`, patientId, bedId, consultantId: w.doctor.id, requestedClass: "icu",
      isolation: "none", provisionalDiagnosis: "Septic shock", mlc: false, payerKind: "cash", intensivistApprovalId: approved.approvalId!,
      requestedAt: at.toISOString(), admittedAt: at.toISOString(), consent: { signedBy: "patient", method: "paper", witnessName: "Desk Witness" },
    }, { now: at });
    const band = (await printBand(db, w.admitDesk, { idempotencyKey: randomUUID(), admissionId: done.admissionId, size: "adult", site: "wrist" }, { now: at })).bandSerial;
    return { admissionId: done.admissionId, patientId, bedId, band, slot };
  };
  return { ...w, intensivist, intensivist2, incharge, icuNurse, hallId, gatewayId: gw.gatewayId, agent, interfaceId: gw.interfaceId, icuBed, device, admitIcu };
}

/** An hour mark three days back from the real clock (UTC hours are IST half-hours; only the hour mark matters). */
export function icuBase(): Date {
  return new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3 * 86_400_000);
}
export const plus = (t: Date, ms: number): Date => new Date(t.getTime() + ms);
export const SEC = 1000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
