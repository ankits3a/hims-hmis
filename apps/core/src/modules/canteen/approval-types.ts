import { withTx } from "../../kernel/db/client";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * CN-1 (#977, decision 0088 §5) — A FAMILY MEAL THAT IS FREE OR SUBSIDISED NEEDS FINANCE'S APPROVAL FIRST (D5). One type
 * on the kernel approvals engine, `canteen_charity_meal`: approver `billing_manager` (finance acts sit with this role and
 * it holds `canteen.finance`); requester ≠ approver is the engine's rule; never act-first. The request names the grant
 * and its amount (meals × the most one meal may cost). The owner owes the limits (per meal or per admission per day) and
 * any higher approver: until then one approver, any amount, as finance decides.
 *
 * Registration is a go-live step (the IPD shape): drafted by a system drafter, activated by a named person, registered.
 */
export const CANTEEN_CHARITY_APPROVAL = "canteen_charity_meal";
export const CANTEEN_CHARITY_SUBJECT = "canteen_charity_grant";

const SPEC = {
  typeKey: CANTEEN_CHARITY_APPROVAL, title: "Free or subsidised family meal", approverRole: "billing_manager", closureSlaMinutes: 240,
} as const;

const DRAFTER: Actor = { type: "system", id: "canteen-approval-drafter" };

export async function registerCanteenApprovalTypes(db: Db, activator: Actor): Promise<{ registered: string[] }> {
  if (await withTx(db, (tx: Tx) => getApprovalType(tx, SPEC.typeKey))) return { registered: [] };
  const draft = await createDraft(db, DRAFTER, approvalFlowDefinition(SPEC));
  await activateDefinition(db, activator, draft.definitionId);
  await registerApprovalType(db, activator, { typeKey: SPEC.typeKey, title: SPEC.title, approverRole: SPEC.approverRole, urgencyClass: "routine", actFirstAllowed: false });
  return { registered: [SPEC.typeKey] };
}
