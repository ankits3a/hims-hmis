import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 18a T2 / DD13 — THE ONE APPROVAL TYPE THIS MODULE GATES ON.
 *
 * ═══ AN APPROVAL TYPE REACHES A DEPLOYMENT ONLY THROUGH A SEED SCRIPT ═══
 *
 * `requestApproval` throws `unknown_type` for a key no `approval_types` row carries. That is how
 * `patient_merge` went unregistered from Plan 05 until 2026-08-26 — every merge request on the live
 * box threw the whole time — and how `tariff_revision` made a tariff undraftable in production.
 * Both were caught by a human looking, not by a test. So this file exists at T2, `seed-radiology.ts`
 * calls it, and `deploy.sh` runs that seed.
 *
 * This is `modules/ot/approval-types.ts` in the same shape rather than a variation of it: same
 * draft → activate → register flow, same skip-if-registered idempotency, same fixed system drafter.
 *
 * ═══ THE SPEC, AND THE TWO CHOICES IN IT ═══
 *
 * **`imaging_definition_publish`** — approver `medical_superintendent`, routine, no act-first,
 * 1,440-minute SLA.
 *
 *   · **The MS, not the radiologist.** The `study_types` body says which gates open for which
 *     study — whether a CT abdomen on a woman of childbearing age opens a pregnancy screen, whether
 *     an obstetric ultrasound opens `form_f`. That is what the department is ALLOWED to do, and the
 *     office that says so is the medical superintendent's. The engine's own `requester_approver`
 *     SoD then forces two distinct humans, and production HAS two (`admin` as `owner`,
 *     `anand.rao` as `medical_superintendent`), so this is posture with somebody behind it.
 *   · **`actFirstAllowed: false`.** Act-first exists for clinical urgency — do the thing, justify
 *     it after. Publishing the definition that decides which safety gates exist is not that: an
 *     act-first gate-set change is indistinguishable from having no gate rule at all, and the one
 *     it could switch off is the one N2 says has no bypass. A day to decide costs nothing, because
 *     the ACTIVE definition keeps working the whole time.
 */
export const RADIOLOGY_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: "imaging_definition_publish",
    title: "Imaging Definition Publish (study types, gate sets, pregnancy policy, critical categories)",
    approverRole: "medical_superintendent",
    urgencyClass: "routine",
    actFirstAllowed: false,
    closureSlaMinutes: 1440,
  },
];

/** The type key, for callers that must not retype a string the engine matches exactly. */
export const IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE = "imaging_definition_publish";

/** The DRAFTER half of the `approval_<typeKey>` definition — a system identity, distinct from any
 *  caller-supplied activator, which is all `assertNotSodPair` compares. */
const DRAFTER: Actor = { type: "system", id: "radiology-approval-drafter" };

/**
 * Drafts + activates each `approval_<typeKey>` workflow definition then registers the approval type.
 *
 * IDEMPOTENT, proved by execution: a typeKey already registered is left untouched, so a second call
 * neither drafts a redundant definition VERSION nor hits `duplicate_type`. The redundant-version
 * half is the one that would go unnoticed — a second `workflow_definitions` row for the same key is
 * not an error, just a lie about how many times the flow changed.
 *
 * `activator` must be a "user" actor whose id differs from the drafter, and the caller must already
 * have run `seedSodPairs(db)`.
 */
export async function registerRadiologyApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of RADIOLOGY_APPROVAL_TYPES) {
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
