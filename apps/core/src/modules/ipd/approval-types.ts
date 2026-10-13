import { and, desc, eq, inArray } from "drizzle-orm";
import { approvals } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { defineWorkflow } from "../../kernel/workflow/definition";
import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { IpdError } from "./errors";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor, IpdApprovalKind } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E1.2 (#719) — THE THREE APPROVALS AN ADMISSION CAN NEED, on the kernel approvals engine (each request is a workflow
 * instance with a closure SLA; requester ≠ approver is the engine's SoD rule):
 *
 * - `ipd_icu_admission` — §4.2 "ICU admission needs an intensivist's approval in the system; a clerk alone cannot".
 *   DECIDED: approver = the medical superintendent OR a holder of the `intensivist` role (the ICU consultants the
 *   hospital assigns it to — the roster has no ICU unit to read; `COMBINED_ICU_BEDS` belong to no unit). The
 *   definition allows both roles on the decision; the worklist files it under the MS until an `intensivist` role is
 *   seeded and assigned (owed: no seed mints that role yet).
 * - `ipd_non_covered_line` — §6 "a PM-JAY admission refuses a receipt unless a line is marked non-covered by an
 *   approver". DECIDED: approver = `billing_manager` (or the medical superintendent); the request names the line and
 *   its amount, and a receipt may take at most that amount.
 * - `ipd_deposit_waiver` — the contract's `approved_waiver` exemption. DECIDED: approver = `billing_manager` (or MS).
 *
 * Registration is a go-live step (like the OT's): `registerIpdApprovalTypes(db, activator)` drafts each definition as a
 * system drafter, activates it as a named person (SoD: drafter ≠ activator) and registers the type. Idempotent.
 */
export const IPD_APPROVAL_TYPE_KEYS: Record<IpdApprovalKind, string> = {
  icu: "ipd_icu_admission",
  non_covered: "ipd_non_covered_line",
  deposit_waiver: "ipd_deposit_waiver",
  // E3.2 (#730) — ⚖ leaving with an unpaid balance: approved and recorded as dues, never a detention.
  discharge_dues: "ipd_discharge_dues",
};

type IpdApprovalTypeSpec = ApprovalTypeSpec & { closureSlaMinutes: number; alsoDecides: string[] };

export const IPD_APPROVAL_TYPES: readonly IpdApprovalTypeSpec[] = [
  {
    typeKey: IPD_APPROVAL_TYPE_KEYS.icu, title: "ICU admission — intensivist approval", approverRole: "medical_superintendent",
    urgencyClass: "urgent", actFirstAllowed: false, closureSlaMinutes: 30, alsoDecides: ["intensivist"],
  },
  {
    typeKey: IPD_APPROVAL_TYPE_KEYS.non_covered, title: "Scheme admission — line not covered", approverRole: "billing_manager",
    urgencyClass: "routine", actFirstAllowed: false, closureSlaMinutes: 240, alsoDecides: ["medical_superintendent"],
  },
  {
    typeKey: IPD_APPROVAL_TYPE_KEYS.deposit_waiver, title: "Admission deposit waiver", approverRole: "billing_manager",
    urgencyClass: "routine", actFirstAllowed: false, closureSlaMinutes: 120, alsoDecides: ["medical_superintendent"],
  },
  /**
   * E3.2 (#730) — DECIDED ⚖ (Consumer Protection Act; state clinical-establishment rules; NHRC patients' charter): a patient
   * is never detained for unpaid dues. The unpaid patient-payable balance is approved by the billing manager (or the MS)
   * against a signed undertaking, and the gate pass issues with "dues recorded". Urgent: the patient is waiting to leave.
   */
  {
    typeKey: IPD_APPROVAL_TYPE_KEYS.discharge_dues, title: "Discharge with dues — undertaking", approverRole: "billing_manager",
    urgencyClass: "urgent", actFirstAllowed: false, closureSlaMinutes: 60, alsoDecides: ["medical_superintendent"],
  },
];

const DRAFTER: Actor = { type: "system", id: "ipd-approval-drafter" };

/** The `approval_<typeKey>` definition: the engine's canonical shape, with the second deciding role added. */
export function ipdApprovalDefinition(spec: IpdApprovalTypeSpec) {
  const base = approvalFlowDefinition({
    typeKey: spec.typeKey, title: spec.title, approverRole: spec.approverRole, closureSlaMinutes: spec.closureSlaMinutes,
  });
  return defineWorkflow({
    ...base,
    transitions: base.transitions.map((t) => ({ ...t, roles: [...new Set([...t.roles, ...spec.alsoDecides])] })),
  });
}

export async function registerIpdApprovalTypes(db: Db, activator: Actor): Promise<{ registered: string[] }> {
  const registered: string[] = [];
  for (const spec of IPD_APPROVAL_TYPES) {
    if (await withTx(db, (tx: Tx) => getApprovalType(tx, spec.typeKey))) continue;
    const draft = await createDraft(db, DRAFTER, ipdApprovalDefinition(spec));
    await activateDefinition(db, activator, draft.definitionId);
    await registerApprovalType(db, activator, {
      typeKey: spec.typeKey, title: spec.title, approverRole: spec.approverRole,
      ...(spec.urgencyClass === undefined ? {} : { urgencyClass: spec.urgencyClass }),
      ...(spec.actFirstAllowed === undefined ? {} : { actFirstAllowed: spec.actFirstAllowed }),
    });
    registered.push(spec.typeKey);
  }
  return { registered };
}

/** The subject every IPD approval names: the admission (an emergency ICU admission names the patient). */
export const IPD_APPROVAL_SUBJECT = "ipd_admission";

/** Files one approval request on the admission (or, for an emergency ICU bed, the patient). */
export async function requestIpdApproval(
  tx: Tx, actor: Actor,
  args: { kind: IpdApprovalKind; subjectId: string; patientId: string; note: string; amountPaise?: number },
): Promise<{ approvalId: string }> {
  const typeKey = IPD_APPROVAL_TYPE_KEYS[args.kind];
  if (!(await getApprovalType(tx, typeKey))) {
    throw new IpdError("approval_type_missing", `the approval type ${typeKey} is not registered yet: a go-live step registers it`);
  }
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey,
    subject: { type: IPD_APPROVAL_SUBJECT, id: args.subjectId },
    patientId: args.patientId,
    requestNote: args.note,
    ...(args.amountPaise === undefined ? {} : { amountPaise: args.amountPaise }),
  });
  return { approvalId };
}

export type GrantedApproval = { id: string; amountPaise: number | null; decidedBy: string | null };

/** A GRANTED approval of this kind whose subject is one of `subjectIds`, or null. */
export async function grantedApproval(
  db: Db | Tx, approvalId: string | undefined, kind: IpdApprovalKind, subjectIds: readonly string[],
): Promise<GrantedApproval | null> {
  if (approvalId === undefined) return null;
  const row = (await db.select().from(approvals).where(and(
    eq(approvals.id, approvalId), eq(approvals.typeKey, IPD_APPROVAL_TYPE_KEYS[kind]), eq(approvals.status, "granted"),
    inArray(approvals.subjectId, [...subjectIds]),
  )))[0];
  return row === undefined ? null : { id: row.id, amountPaise: row.amountPaise, decidedBy: row.decidedBy };
}

/** The newest approval of a kind on a subject (any status), for the sheet to show "asked · granted · rejected". */
export async function latestApproval(db: Db, kind: IpdApprovalKind, subjectIds: readonly string[]): Promise<{ id: string; status: string } | null> {
  const row = (await db.select({ id: approvals.id, status: approvals.status }).from(approvals)
    .where(and(eq(approvals.typeKey, IPD_APPROVAL_TYPE_KEYS[kind]), inArray(approvals.subjectId, [...subjectIds])))
    .orderBy(desc(approvals.requestedAt)).limit(1))[0];
  return row ?? null;
}
