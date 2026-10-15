import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { activateDefinition, approveDefinition, createDraft } from "../../src/kernel/workflow/definitions";
import { emergencyManifest, erEpisodeWorkflowDefinition } from "../../src/modules/emergency";
import { ipdManifest } from "../../src/modules/ipd";
import { patientsManifest } from "../../src/modules/patients";
import { registerPatientApprovalTypes } from "../../src/modules/patients/approval-types";
import { mkAdmitWorld } from "./ipd";
import { ensureRole, mkUser } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { AdmitWorld } from "./ipd";

export type ErWorld = AdmitWorld & {
  /** front_office with the two ER strings (and the IPD admission desk's, from `mkAdmitWorld`). */
  erDesk: Actor;
  /** The casualty nurse: the two ER strings only. */
  erNurse: Actor;
  /** The MRD officer: `patients.merge` (files and executes merges), nothing of the ER. */
  mrd: Actor;
  /** A doctor with the board only. */
  erDoctor: Actor;
};

/**
 * ER lane 1 (#808) — `mkAdmitWorld` (the bed registry, the IPD admission workflow, billing's base, the MS) plus: the
 * `er_episode` workflow ACTIVATED the governance way (owner + MS approve, a third person activates), the patients
 * approval types (`patient_merge` decided by the MS), and the people: the ER desk (front office), the casualty nurse,
 * the MRD officer and a doctor who only reads the board.
 */
export async function mkErWorld(db: Db): Promise<ErWorld> {
  const w = await mkAdmitWorld(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  registry.install(emergencyManifest);
  await syncPermissions(db, registry);
  // ER review (2026-10-15): the board readers also hold the wall screen's own string, as seed:roles grants it.
  for (const p of ["er.board.view", "er.board.wall", "er.arrival.register"]) await grantPermissionToRole(db, registry, "front_office", p);
  await ensureRole(db, "er_nurse");
  for (const p of ["er.board.view", "er.board.wall", "er.arrival.register"]) await grantPermissionToRole(db, registry, "er_nurse", p);
  await ensureRole(db, "mrd_officer");
  for (const p of ["patients.read", "patients.merge"]) await grantPermissionToRole(db, registry, "mrd_officer", p);
  await grantPermissionToRole(db, registry, "doctor", "er.board.view");
  await grantPermissionToRole(db, registry, "doctor", "er.board.wall");
  const erNurse = (await mkUser(db, "er.nurse", ["er_nurse"])).actor;
  const mrd = (await mkUser(db, "er.mrd", ["mrd_officer"])).actor;
  const erDoctor = (await mkUser(db, "er.doctor", ["doctor"])).actor;

  const draft = await createDraft(db, w.tariffDrafter, erEpisodeWorkflowDefinition);
  await approveDefinition(db, w.owner, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
  await approveDefinition(db, w.ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
  await activateDefinition(db, w.tariffActivator, draft.definitionId);
  await registerPatientApprovalTypes(db, w.tariffActivator);
  return { ...w, erDesk: w.admitDesk, erNurse, mrd, erDoctor };
}
