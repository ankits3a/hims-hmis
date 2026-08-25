import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import { GRACE_HONOR_APPROVAL_TYPE } from "./recognition";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 09 T3 / O-1 — THE ONE APPROVAL TYPE THIS MODULE GATES ON.
 *
 * `approverRole` is `billing_manager`: the role that already approves every other exception at
 * this counter (discount above cap, refund, clearance, session variance). Honouring a card the
 * holder book has never heard of is the same kind of decision and it belongs to the same person —
 * inventing a second approver role for one path would be authority nobody asked for on a trust
 * hospital, which is DD18's own reasoning.
 *
 * `actFirstAllowed: false` — O-1 says so in as many words, and the reason is the ruling's own: the
 * whole value of the approval is that it makes grace-honouring RARE, attributable and reversible.
 * An act-first path would make it the default answer at a busy counter and the review a formality.
 *
 * `closureSlaMinutes` is 240 — the `urgent` SLA the billing types already use. A member is standing
 * at the counter while this is pending, so a 24-hour routine SLA would be a wrong number to put in
 * front of a duty manager.
 *
 * ═══ WHY THIS FILE EXISTS SEPARATELY FROM THE SEED SCRIPT (§6.0 S3) ═══
 *
 * An approval type reaches a real deployment ONLY through a `seed:*` script — `seed-roles.ts:278`
 * says so in as many words. Registering it in a test and nowhere else would ship a hospital a
 * grace-honor path that nobody can ever approve. So the registration lives here, beside the code
 * that checks it, and `scripts/seed-membership.ts` is the caller that carries it into a deployment.
 */
export const MEMBERSHIP_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: GRACE_HONOR_APPROVAL_TYPE,
    title: "Membership — honour a card the holder book does not know",
    approverRole: "billing_manager",
    urgencyClass: "urgent",
    actFirstAllowed: false, // O-1
    closureSlaMinutes: 240,
  },
];

/**
 * A fixed system identity for the DRAFTER half of the `approval_<typeKey>` definition, the
 * `modules/billing/approval-types.ts` convention. `createDraft` takes no actor-type check, and what
 * `assertNotSodPair("workflow_drafter_activator", …)` cares about is only that this id differs from
 * the caller-supplied activator's — the check is same-id, not same-type.
 */
const DRAFTER: Actor = { type: "system", id: "membership-approval-drafter" };

/**
 * Drafts + activates the `approval_<typeKey>` workflow definition, then registers the approval
 * type — the two-step flow `kernel/approvals/types.ts` requires.
 *
 * IDEMPOTENT BY MEASUREMENT, NOT BY HOPE: a typeKey already registered (checked through
 * `getApprovalType`) is skipped entirely, so a second call drafts no redundant definition version
 * and never reaches `registerApprovalType`'s `duplicate_type` throw. That property is what lets
 * `seed:membership` sit in the re-deploy path for ever (§6.0 S14) rather than in a one-time
 * bootstrap, and `approval-types.test.ts` quotes both runs.
 *
 * `activator` must be a "user" actor whose id differs from the fixed drafter above, and the caller
 * must have run `seedSodPairs(db)` first — the SoD pair lookup fails loudly otherwise, by design.
 */
export async function registerMembershipApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of MEMBERSHIP_APPROVAL_TYPES) {
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
