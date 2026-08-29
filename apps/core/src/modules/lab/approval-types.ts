import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17 T2 / DD6 — **THE ONE APPROVAL TYPE THIS MODULE GATES ON: releasing an unpaid report.**
 *
 * ═══ AN APPROVAL TYPE REACHES A DEPLOYMENT ONLY THROUGH A SEED SCRIPT ═══
 *
 * `requestApproval` throws `unknown_type` for a key no `approval_types` row carries. That is how
 * `patient_merge` went unregistered from Plan 05 until 2026-08-26 — every merge request on the live
 * box threw the whole time — and how `tariff_revision` made a tariff undraftable in production.
 * Both were caught by a human looking, not by a test. So this file exists at T2, the lab seed calls
 * it, and `deploy.sh` runs that seed. This is `modules/ot/approval-types.ts` in the same shape
 * rather than a variation of it.
 *
 * ═══ THE SPEC, AND WHY THE APPROVER IS `billing_manager` ═══
 *
 * `lab.release_unpaid` — approver **`billing_manager`**, urgency `urgent`, no act-first,
 * **60-minute SLA**.
 *
 * The approver is the money office and not the pathologist on purpose. DD6's interlock exists to
 * collect a self-pay balance; the decision to hand over the document anyway is a decision to carry
 * a receivable, which is billing's to make. A pathologist approving it would be the person under
 * pressure from the patient at the counter deciding the hospital's credit policy — the same
 * separation the OT's deposit exception makes for the same reason.
 *
 * **`actFirstAllowed: false`, and this is the field worth arguing about.** Act-first exists for
 * clinical urgency: do the thing, justify it after. The clinical case for it — a doctor needs the
 * result NOW — is already answered and better answered elsewhere, because **the interlock never
 * touches a clinician's read** (DD6, T7 A3): `listResultsForEncounter` returns verified results for
 * an unpaid order, and the critical-value CALL never consults the interlock at all. What this
 * approval releases is a PRINTED or MESSAGED copy for the patient, and there is no version of that
 * which cannot wait sixty minutes for a reply. An act-first release would be indistinguishable from
 * no interlock.
 *
 * ═══ AND WHAT THE APPROVAL DOES **NOT** DO (T7 A4) ═══
 *
 * It does not write a credit note, does not touch the invoice, and does not move the dues row. The
 * money was already a receivable before the release and is the same receivable after — the only
 * thing that changed is that a document left the building. A release that quietly wrote off the
 * balance would make the interlock a discount mechanism, which is 02 O-1's opposite.
 */
export const LAB_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: "lab_release_unpaid",
    title: "Release an unpaid lab report (self-pay balance outstanding)",
    approverRole: "billing_manager",
    urgencyClass: "urgent",
    actFirstAllowed: false,
    closureSlaMinutes: 60,
  },
];

/** The type key, for callers that must not retype a string the engine matches exactly. */
export const RELEASE_UNPAID_APPROVAL_TYPE = "lab_release_unpaid";

/** The DRAFTER half of the `approval_<typeKey>` definition — a system identity, distinct from any
 *  caller-supplied activator, which is all `assertNotSodPair` compares. */
const DRAFTER: Actor = { type: "system", id: "lab-approval-drafter" };

/**
 * Drafts + activates the `approval_<typeKey>` workflow definition, then registers the approval type.
 *
 * IDEMPOTENT, proved by execution in `approval-types.test.ts`: a typeKey already registered is left
 * untouched, so a second call neither drafts a redundant definition VERSION nor hits
 * `duplicate_type`. The redundant-version half is the one that would go unnoticed — a second
 * `workflow_definitions` row for the same key is not an error, just a lie about how many times the
 * flow changed.
 *
 * `activator` must be a `user` actor whose id differs from the drafter, and the caller must already
 * have run `seedSodPairs(db)`.
 */
export async function registerLabApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of LAB_APPROVAL_TYPES) {
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
