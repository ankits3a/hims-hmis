import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T2 / DD6 + DD12 — THE TWO APPROVAL TYPES THIS MODULE GATES ON.
 *
 * ═══ AN APPROVAL TYPE REACHES A DEPLOYMENT ONLY THROUGH A SEED SCRIPT ═══
 *
 * `requestApproval` throws `unknown_type` for a key no `approval_types` row carries. That is how
 * `patient_merge` went unregistered from Plan 05 until 2026-08-26 — every merge request on the live
 * box threw the whole time — and how `tariff_revision` made a tariff undraftable in production.
 * Both were caught by a human looking, not by a test. So this file exists at T2, `seed-ot.ts` calls
 * it, and `deploy.sh` runs that seed.
 *
 * This is the shipped `modules/materials/approval-types.ts`, in the same shape rather than a
 * variation of it: same draft → activate → register flow, same skip-if-registered idempotency, same
 * fixed system drafter.
 *
 * ═══ THE TWO SPECS ═══
 *
 *   · **`ot_definition_publish`** — approver `medical_superintendent`, routine, no act-first,
 *     1,440-minute SLA. DD6's ruling: the criteria whitelist, the privilege list, the deposit policy
 *     and the PACU thresholds are what the unit is ALLOWED to do, and the MS is the office that says
 *     so. The engine's own `requester_approver` SoD then forces two distinct humans — and Spike Q3
 *     measured that production HAS two (`admin` as `owner`, `anand.rao` as `medical_superintendent`),
 *     so this is honest posture rather than theatre. A day to decide: nothing is waiting in a bay.
 *
 *   · **`ot_deposit_exception`** — approver **`owner`**, routine, no act-first, 120-minute SLA.
 *     N12's poor patient, and the SLA is short because a list is running and the alternative to a
 *     decision is a postponed operation. The approver is the OWNER rather than the MS on purpose:
 *     this is the money rule, not the clinical one, and the person who waives a deposit must not be
 *     the person under pressure to fill the list. **It is the ONLY path by which `paid < required`
 *     reaches a satisfied `deposit` gate** (DD12), which is why it is an approval and not a flag.
 *
 * ═══ `actFirstAllowed: false` ON BOTH ═══
 *
 * Act-first exists for clinical urgency — do the thing, justify it after. Publishing the definition
 * that says which operations the unit may perform is not that. Neither is waiving a deposit: the
 * gate it satisfies is evaluated BEFORE wheel-in, so there is always time to ask, and an act-first
 * deposit waiver is indistinguishable from no deposit rule at all.
 */
export const OT_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: "ot_definition_publish",
    title: "OT Definition Publish (criteria, privileges, deposit policy, PACU thresholds)",
    approverRole: "medical_superintendent",
    urgencyClass: "routine",
    actFirstAllowed: false,
    closureSlaMinutes: 1440,
  },
  {
    typeKey: "ot_deposit_exception",
    title: "Day-care Deposit Shortfall Exception",
    approverRole: "owner",
    urgencyClass: "routine",
    actFirstAllowed: false,
    closureSlaMinutes: 120,
  },
];

/** The two type keys, for callers that must not retype a string the engine matches exactly. */
export const DEFINITION_PUBLISH_APPROVAL_TYPE = "ot_definition_publish";
export const DEPOSIT_EXCEPTION_APPROVAL_TYPE = "ot_deposit_exception";

/** The DRAFTER half of each `approval_<typeKey>` definition — a system identity, distinct from any
 *  caller-supplied activator, which is all `assertNotSodPair` compares. */
const DRAFTER: Actor = { type: "system", id: "ot-approval-drafter" };

/**
 * Drafts + activates each `approval_<typeKey>` workflow definition then registers the approval type.
 *
 * IDEMPOTENT, proved by execution in `approval-types.test.ts`: a typeKey already registered is left
 * untouched, so a second call neither drafts a redundant definition VERSION nor hits
 * `duplicate_type`. The redundant-version half is the one that would go unnoticed — a second
 * `workflow_definitions` row for the same key is not an error, just a lie about how many times the
 * flow changed.
 *
 * `activator` must be a "user" actor whose id differs from the drafter, and the caller must already
 * have run `seedSodPairs(db)`.
 */
export async function registerOtApprovalTypes(db: Db, activator: Actor): Promise<void> {
  for (const spec of OT_APPROVAL_TYPES) {
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
