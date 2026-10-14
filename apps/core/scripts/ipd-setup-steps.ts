import { withTx } from "../src/kernel/db/client";
import { getApprovalType } from "../src/kernel/approvals/types";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { createDraft, listDefinitions } from "../src/kernel/workflow/definitions";
import { ADMISSION_WORKFLOW_DEF_KEY, IPD_APPROVAL_TYPE_KEYS, admissionWorkflowDefinition, registerIpdApprovalTypes } from "../src/modules/ipd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * The two IPD setup steps shared by `stage-ipd-setup` (staging, steps a and b) and `ipd-golive-setup` (go-live day,
 * #798). Each step has a read-only PLAN and a WRITE; both are idempotent. Neither approves or activates the admission
 * workflow: that stays with the medical superintendent and the owner.
 */

export type ApprovalTypesReport = { registered: string[]; alreadyPresent: string[]; billVoid: string };
export type AdmissionWorkflowReport = { action: "drafted" | "already"; definitionId: string; version: number; status: string };

const ALL_TYPES = (): string[] => Object.values(IPD_APPROVAL_TYPE_KEYS);

/** Read only: which IPD approval types exist and which are missing. */
export async function planIpdApprovalTypes(db: Db): Promise<{ missing: string[]; present: string[] }> {
  const missing: string[] = [];
  const present: string[] = [];
  for (const k of ALL_TYPES()) ((await withTx(db, (tx) => getApprovalType(tx, k))) ? present : missing).push(k);
  return { missing, present };
}

/** Step a: the SoD pairs first, then every missing IPD approval type (drafted by a system drafter, activated by `activator`). */
export async function registerIpdApprovalTypesStep(db: Db, activator: Actor): Promise<ApprovalTypesReport> {
  await seedSodPairs(db);
  const { registered } = await registerIpdApprovalTypes(db, activator);
  const all = ALL_TYPES();
  const billVoid = all.includes("ipd_bill_void") ? "included" : "not in this tree (IPD_APPROVAL_TYPE_KEYS has no ipd_bill_void)";
  return { registered, alreadyPresent: all.filter((k) => !registered.includes(k)), billVoid };
}

/** Read only: the live (active, else draft) `ipd_admission` definition, or null when there is none. */
export async function findAdmissionWorkflow(db: Db): Promise<{ definitionId: string; version: number; status: string } | null> {
  const defs = await listDefinitions(db, ADMISSION_WORKFLOW_DEF_KEY);
  const live = defs.find((d) => d.status === "active") ?? defs.find((d) => d.status === "draft");
  return live === undefined ? null : { definitionId: live.id, version: live.version, status: live.status };
}

/** Step b: a DRAFT of `ipd_admission` when no active or draft version exists — and nothing more. */
export async function draftAdmissionWorkflowStep(db: Db, drafter: Actor): Promise<AdmissionWorkflowReport> {
  const live = await findAdmissionWorkflow(db);
  if (live !== null) return { action: "already", ...live };
  const d = await createDraft(db, drafter, admissionWorkflowDefinition);
  return { action: "drafted", definitionId: d.definitionId, version: d.version, status: "draft" };
}
