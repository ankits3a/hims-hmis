import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 14 T2 / DD10 — THE TWO APPROVAL TYPES THIS MODULE GATES ON.
 *
 * ═══ AN APPROVAL TYPE REACHES A DEPLOYMENT ONLY THROUGH A SEED SCRIPT ═══
 *
 * `requestApproval` throws `unknown_type` for a key no `approval_types` row carries
 * (kernel/approvals/requests.ts). That is how `patient_merge` went unregistered from Plan 05 until
 * 2026-08-26 — every merge request on the live box threw the whole time — and how `tariff_revision`
 * made a tariff undraftable in production (11g report D7, gap 2). Both were caught by a human
 * looking, not by a test. **So this file exists at T2, `seed-materials.ts` calls it, and
 * `deploy.sh` runs that seed** — the seed census moving 11 → 12 is the visible half of the fix.
 *
 * This is the shipped `modules/tariff/approval-types.ts`, deliberately in the same shape rather
 * than a variation of it: same two-step draft → activate → register flow, same skip-if-registered
 * idempotency, same fixed system drafter.
 *
 * ═══ THE TWO SPECS, AND WHERE THEIR VALUES COME FROM ═══
 *
 * Neither approver role nor SLA is this file's choice. Both are DD10's, and DD10's bank-change
 * approver is **O-6 RULED 2026-08-27: owner approval always.**
 *
 *   · `materials_near_expiry_acceptance` — approver `materials_head`, routine, no act-first,
 *     240-minute pending SLA. The GRN gate's rule 5 marks a line `near_expiry` and `postGrn`
 *     refuses `near_expiry_unapproved` until this is GRANTED (A17). Four hours because a lorry is
 *     waiting and the alternative to a decision is a truck in the bay; it is the fast-mover
 *     exception O-2 declined to make a constant.
 *   · `materials_vendor_bank_change` — approver **`owner`**, routine, no act-first, 1,440 minutes.
 *     Not `materials_head`: a supplier bank account is the single highest-value target in a
 *     procurement system, the fraud is a forged letterhead and a plausible email, and the person
 *     who can approve it must not be the person who talks to the vendor daily. A day to decide,
 *     because unlike a near-expiry line nothing is waiting in a bay.
 *
 * ═══ `actFirstAllowed: false` ON BOTH, AND IT IS A DECISION ═══
 *
 * Act-first exists for clinical urgency — do the thing, justify it after. Neither of these is
 * urgent in that sense: accepting short-dated stock and changing where money goes are both
 * reversible-only-on-paper. A GRN posted act-first would have put expiring stock on a shelf with
 * the approval still pending, which is the case the rule exists to prevent.
 */
export const MATERIALS_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: "materials_near_expiry_acceptance",
    title: "Near-Expiry Stock Acceptance",
    approverRole: "materials_head",
    urgencyClass: "routine",
    actFirstAllowed: false,
    closureSlaMinutes: 240,
  },
  {
    typeKey: "materials_vendor_bank_change",
    title: "Vendor Bank Account Change",
    /** O-6 RULED 2026-08-27 — owner approval ALWAYS. See the header for why not `materials_head`. */
    approverRole: "owner",
    urgencyClass: "routine",
    actFirstAllowed: false,
    closureSlaMinutes: 1440,
  },
];

/** The two type keys, for callers that must not retype a string the engine matches exactly. */
export const NEAR_EXPIRY_APPROVAL_TYPE = "materials_near_expiry_acceptance";
export const VENDOR_BANK_CHANGE_APPROVAL_TYPE = "materials_vendor_bank_change";

/**
 * The DRAFTER half of each `approval_<typeKey>` definition. `createDraft` runs no actor-type check,
 * so a "system" identity is right here; what matters to
 * `assertNotSodPair("workflow_drafter_activator", …)` is only that this id differs from the
 * caller-supplied activator's — the check is same-ID, never same-type (kernel/auth/sod.ts).
 */
const DRAFTER: Actor = { type: "system", id: "materials-approval-drafter" };

/**
 * Drafts + activates each `approval_<typeKey>` workflow definition then registers the approval
 * type — the two-step flow `registerApprovalType`'s own docstring requires.
 *
 * IDEMPOTENT, and `approval-types.test.ts` proves it by execution: a typeKey already registered
 * (checked through `getApprovalType`) is left untouched, so a second call neither drafts a
 * redundant definition VERSION nor hits `duplicate_type`. That is what lets it sit in the
 * re-deploy path for ever — and the redundant-version half is the one that would go unnoticed,
 * because a second `workflow_definitions` row for the same key is not an error, just a lie about
 * how many times the flow changed.
 *
 * `activator` must be a "user" actor whose id differs from the drafter above, and the caller must
 * already have run `seedSodPairs(db)` — the SoD pair lookup fails loudly otherwise, by design.
 */
export async function registerMaterialsApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of MATERIALS_APPROVAL_TYPES) {
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
