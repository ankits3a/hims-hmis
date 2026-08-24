import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import { TARIFF_REVISION_APPROVAL_TYPE } from "./versions";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 11g / DD2 — THE APPROVAL TYPE THE TARIFF MODULE GATES ON, WHICH NOTHING REGISTERED.
 *
 * `submitVersion` (versions.ts:129) calls `requestApproval` with `tariff_revision`, and
 * `requestApproval` throws `unknown_type` for a key no `approval_types` row carries
 * (kernel/approvals/requests.ts:39). Four test fixtures registered the type inline — the shipped
 * `test/helpers/billing.ts` block is byte-for-byte the spec below — and **no seed script did**, so
 * on a real deployment a tariff could be drafted and never submitted. Measured in production on
 * 2026-08-24: `approval_types` held the five `billing_*` rows and nothing else, and the synthetic
 * smoke test had to register this type BY HAND to activate a tariff at all (report D7, gap 2).
 *
 * This is the shipped `modules/billing/approval-types.ts` for the tariff module's one type,
 * deliberately in the same shape rather than a variation of it: same two-step draft → activate →
 * register flow, same skip-if-registered idempotency, same fixed system drafter.
 *
 * The `owner` approver role and the 1440-minute routine SLA are NOT this file's choices — they are
 * Plan 06's, recorded at `versions.ts:14-20` (one approver role in v1; the §10.4 two-key upgrade is
 * definition DATA at go-live, not code) and used verbatim by every existing fixture.
 *
 * WHO MAY OPERATE the tariff is a different question and is still open: no role holds any
 * `tariff.*` permission (`seed-roles.ts`'s `NOT_YET_MODELLED`, awaiting an owner ruling — report
 * D7, gap 1). Registering the type does not grant anything to anybody; it removes the half of the
 * blockage that was an oversight rather than a pending decision.
 */
export const TARIFF_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: TARIFF_REVISION_APPROVAL_TYPE,
    title: "Tariff Revision",
    approverRole: "owner",
    urgencyClass: "routine",
    actFirstAllowed: false,
    closureSlaMinutes: 1440,
  },
];

// The DRAFTER half of the `approval_tariff_revision` definition. `createDraft` runs no actor-type
// check, so a "system" identity is right here; what matters to
// `assertNotSodPair("workflow_drafter_activator", …)` is only that this id differs from the
// caller-supplied activator's — the check is same-ID, never same-type (kernel/auth/sod.ts).
const DRAFTER: Actor = { type: "system", id: "tariff-approval-drafter" };

/**
 * Drafts + activates each `approval_<typeKey>` workflow definition then registers the approval
 * type — the two-step flow `registerApprovalType`'s own docstring requires.
 *
 * Idempotent: a typeKey already registered (checked through `getApprovalType`) is left untouched,
 * so a second call neither drafts a redundant definition version nor hits `duplicate_type`. That
 * is what lets it sit in the re-deploy path for ever.
 *
 * `activator` must be a "user" actor whose id differs from the drafter above, and the caller must
 * already have run `seedSodPairs(db)` — the SoD pair lookup fails loudly otherwise, by design.
 */
export async function registerTariffApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of TARIFF_APPROVAL_TYPES) {
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
