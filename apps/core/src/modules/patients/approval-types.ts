import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 05's TWO APPROVAL TYPES, REGISTERED AT LAST — Group A follow-up, owner ruling 2026-08-26.
 *
 * ═══ WHAT THIS FILE ENDS, AND IT IS NOT A ROLE PROBLEM ═══
 *
 * `merge.ts` has named `patient_merge` and `patient_unmerge` since Plan 05 and NOTHING HAS EVER
 * REGISTERED THEM. `createMergeRequest` calls `requestApproval`, which reads `getApprovalType` and
 * throws `unknown_type` when it finds nothing (`kernel/approvals/requests.ts`). Measured against
 * production on 2026-08-26: seven approval types exist, all of them billing, tariff and membership.
 * So `POST /patients/merge-requests` failed for EVERY account on the deployment, holder of
 * `patients.merge` or not — and the merge-review screen, the unmerge path and the whole §11.5
 * correction flow were unreachable behind it.
 *
 * That is why Group A refused to grant `patients.merge` on its own: the permission was the last
 * mile of something unwired, and granting it would have handed the MRD officer a button that
 * throws. The role (`mrd_officer`) and this registration land together, deliberately, so the lane
 * goes from dead to working in one reviewable change.
 *
 * ═══ THE APPROVER IS `medical_superintendent` — OWNER RULING 2026-08-26 ═══
 *
 * Merging two patient records is a medical-record governance act: role card #39 gives the Medical
 * Superintendent exactly that brief, and workforce mechanism 27 routes clinical-class reviews to
 * them. The alternative considered and rejected was `front_office_supervisor` — closest to the
 * duplicate and fastest in practice, but it keeps the correction inside the team that created it,
 * which is the one thing a merge approval exists to prevent.
 *
 * THE SoD PAIR ALREADY COVERS THE REST. `requester_approver` is asserted at DECISION time
 * (`approvals/decisions.ts`), so one person holding both `mrd_officer` and
 * `medical_superintendent` — entirely plausible in a small hospital — still cannot approve their
 * own merge. The role split is not what protects this; the act-time check is.
 *
 * ═══ WHY BOTH TYPES, WHEN ONLY ONE IS URGENT ═══
 *
 * `patient_unmerge` is registered in the same pass even though `requestUnmerge` is the rarer path,
 * for the reason `merge.ts` states in its own header: an unmerge is the repair for a merge that
 * should not have happened, and a repair path that is itself unregistered is how a wrong merge
 * becomes permanent. Registering one without the other would leave that trap set.
 *
 * ═══ THE SLAs, AND THEY ARE THIS FILE'S CHOICE ═══
 *
 * `urgent` / 240 minutes for the merge: a duplicate UHID splits a patient's history in half, and
 * every hour it stands is another encounter filed against the wrong record. `routine` / 1440 for
 * the unmerge: the damage is already done and the correction wants care rather than speed. Both
 * mirror the billing precedent's two bands rather than inventing a third.
 *
 * `actFirstAllowed` is FALSE on both, which differs from the merge SCREEN's "act first
 * (patient-safety)" affordance — that flag governs the approvals engine's own act-first lane, and
 * `executeMerge` refuses anything but a `granted` approval regardless. Check-on-execute, always.
 */
export const PATIENT_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: "patient_merge", title: "Patients — merge two records",
    approverRole: "medical_superintendent", urgencyClass: "urgent", actFirstAllowed: false,
    closureSlaMinutes: 240,
  },
  {
    typeKey: "patient_unmerge", title: "Patients — unmerge a merged record",
    approverRole: "medical_superintendent", urgencyClass: "routine", actFirstAllowed: false,
    closureSlaMinutes: 1440,
  },
];

/**
 * The DRAFTER half of every `approval_<typeKey>` definition — a fixed system identity, exactly as
 * `billing/approval-types.ts` uses. `assertNotSodPair("workflow_drafter_activator", …)` compares
 * IDs, not types, so all this must do is differ from the caller's `activator`.
 */
const DRAFTER: Actor = { type: "system", id: "patients-approval-drafter" };

/**
 * Drafts and activates each `approval_<typeKey>` workflow definition, then registers the type —
 * the two-step order `registerApprovalType`'s docstring requires.
 *
 * IDEMPOTENT BY THE SAME GUARD THE BILLING SEED USES: a typeKey `getApprovalType` already finds is
 * skipped whole, so a re-run drafts no redundant definition version and never reaches
 * `registerApprovalType`'s `duplicate_type` throw. That is what lets this sit in the deploy path
 * forever rather than being an operator command somebody has to remember — the shape that left
 * `auth.elevation.review` ungranted on a live box for half of 2026-08-26.
 *
 * `activator` must be a "user" actor and the caller must have run `seedSodPairs(db)` first.
 */
export async function registerPatientApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of PATIENT_APPROVAL_TYPES) {
    const { closureSlaMinutes, ...typeSpec } = spec;
    const already = await withTx(db, (tx: Tx) => getApprovalType(tx, typeSpec.typeKey));
    if (already) continue;

    const def = approvalFlowDefinition({
      typeKey: typeSpec.typeKey,
      title: typeSpec.title,
      approverRole: typeSpec.approverRole,
      closureSlaMinutes,
    });
    const draft = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, draft.definitionId);
    await registerApprovalType(db, activator, typeSpec);
  }
}
