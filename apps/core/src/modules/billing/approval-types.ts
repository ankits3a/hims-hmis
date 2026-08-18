import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * D2/D4/D6/D9 — the five approval types this module gates on. `approverRole` is `billing_manager`
 * on all five (seed-billing.ts creates the role KEY; grants are the owner's policy, the
 * seed-opd.ts precedent). `actFirstAllowed: false` everywhere — every billing approval is
 * check-on-execute, never act-first. `closureSlaMinutes` is this file's own choice (not pinned
 * by the plan text): urgent items get a 4-hour SLA, routine items 24 hours, mirroring the
 * tariff_revision precedent's 1440-minute routine SLA (context.test.ts).
 */
export const BILLING_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: "billing_credit_extension", title: "Billing — credit extension above cap",
    approverRole: "billing_manager", urgencyClass: "urgent", actFirstAllowed: false, closureSlaMinutes: 240,
  },
  {
    typeKey: "billing_discount", title: "Billing — manual discount above cap",
    approverRole: "billing_manager", urgencyClass: "routine", actFirstAllowed: false, closureSlaMinutes: 1440,
  },
  {
    typeKey: "billing_clearance_discount", title: "Billing — clearance discount above cap",
    approverRole: "billing_manager", urgencyClass: "routine", actFirstAllowed: false, closureSlaMinutes: 1440,
  },
  {
    typeKey: "billing_refund", title: "Billing — refund voucher",
    approverRole: "billing_manager", urgencyClass: "urgent", actFirstAllowed: false, closureSlaMinutes: 240,
  },
  {
    typeKey: "billing_variance", title: "Billing — cashier session variance",
    approverRole: "billing_manager", urgencyClass: "routine", actFirstAllowed: false, closureSlaMinutes: 1440,
  },
];

// A fixed system identity for the DRAFTER half of every approval_<typeKey> definition. createDraft
// takes no actor-type check, so "system" is fine here; what matters for
// assertNotSodPair("workflow_drafter_activator", ...) is only that this id differs from the
// caller-supplied `activator`'s id (kernel/auth/sod.ts — the check is same-id, not same-type).
const DRAFTER: Actor = { type: "system", id: "billing-approval-drafter" };

/**
 * Drafts + activates each `approval_<typeKey>` workflow definition (Class C by default —
 * `approvalFlowDefinition`'s changeClass default — so activation needs zero governance
 * approvals, Plan 03's own APIs) then registers the approval type — the two-step flow
 * `registerApprovalType`'s own docstring requires (kernel/approvals/types.ts).
 *
 * Idempotent: a typeKey already registered (checked via `getApprovalType`) is left untouched on
 * a second call, so a re-run neither drafts a redundant definition version nor hits
 * `registerApprovalType`'s `duplicate_type` throw.
 *
 * `activator` must be a "user" actor (`activateDefinition`/`registerApprovalType` both require
 * it) whose id differs from the fixed system drafter above; the caller must have already run
 * `seedSodPairs(db)` (the SoD pair lookup fails loudly otherwise, by design).
 */
export async function registerBillingApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of BILLING_APPROVAL_TYPES) {
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
