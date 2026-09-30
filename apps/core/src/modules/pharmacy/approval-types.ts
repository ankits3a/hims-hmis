import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { getApprovalType, registerApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import type { ApprovalTypeSpec } from "../../kernel/approvals/types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY STAGE D5 — THE APPROVAL TYPE THE RESTRICTED-ANTIMICROBIAL GATE CHECKS ON EXECUTE ═══
 *
 * An approval type reaches a deployment ONLY through a seed script (`requestApproval` throws `unknown_type`
 * otherwise — the `patient_merge` and `tariff_revision` lessons in `materials/approval-types.ts`). So
 * `seed:pharmacy` calls `registerPharmacyApprovalTypes`, which is that file's function in the same shape:
 * draft → activate → register, skip a type already registered.
 *
 *   · `pharmacy_restricted_antimicrobial` — approver `antimicrobial_steward` (DECIDED 2026-09-28, stage D doc:
 *     ICMR AMSP 2018, the ID physician, else the clinical microbiologist, else the MS's named AMSP lead, held in
 *     addition to a clinical role). `urgent`: a patient is standing at the OPD window. 240 minutes, the SLA every
 *     other `urgent` type carries (billing, membership); the office's LAW row turns amber at the same four hours.
 *     No act-first: an OPD patient can wait for a steward, and a restricted antimicrobial handed over "to be
 *     reviewed later" is the case the gate exists to prevent.
 */
export const PHARMACY_APPROVAL_TYPES: (ApprovalTypeSpec & { closureSlaMinutes: number })[] = [
  {
    typeKey: "pharmacy_restricted_antimicrobial",
    title: "Restricted Antimicrobial (Steward Approval)",
    approverRole: "antimicrobial_steward",
    urgencyClass: "urgent",
    actFirstAllowed: false,
    closureSlaMinutes: 240,
  },
  /**
   * OWNER RULINGS 2026-09-30 (money) — the sale-side discount (`discount.ts`). Up to 10% the pharmacist gives
   * it; above 10% and up to 25% the pharmacy in-charge approves THIS type; above 25%, or worth more than
   * ₹25,000 on one bill, only the owner approves the second. Two types, because an approval type's approver
   * is fixed at registration: an in-charge's grant can never stand in for the owner's. `urgent` and 240
   * minutes — a patient is waiting at the counter, the owner-credit ask's SLA. No act-first: the bill waits.
   */
  {
    typeKey: "pharmacy_discount_incharge",
    title: "Pharmacy discount above 10% (Pharmacy In-charge Approval)",
    approverRole: "pharmacy_incharge",
    urgencyClass: "urgent",
    actFirstAllowed: false,
    closureSlaMinutes: 240,
  },
  {
    typeKey: "pharmacy_discount_owner",
    title: "Pharmacy discount above 25% or over ₹25,000 (Owner Approval)",
    approverRole: "owner",
    urgencyClass: "urgent",
    actFirstAllowed: false,
    closureSlaMinutes: 240,
  },
];

export const RESTRICTED_ANTIMICROBIAL_APPROVAL_TYPE = "pharmacy_restricted_antimicrobial";
export const ANTIMICROBIAL_STEWARD_ROLE = "antimicrobial_steward";

const DRAFTER: Actor = { type: "system", id: "pharmacy-approval-drafter" };

/** Idempotent; `activator` is a user actor distinct from the drafter, and the SoD pairs are seeded (`seed:pharmacy` does both). */
export async function registerPharmacyApprovalTypes(db: Db, activator: Actor): Promise<{ registered: string[]; already: string[] }> {
  const out = { registered: [] as string[], already: [] as string[] };
  for (const spec of PHARMACY_APPROVAL_TYPES) {
    const { closureSlaMinutes, ...typeSpec } = spec;
    const existing = await withTx(db, (tx: Tx) => getApprovalType(tx, typeSpec.typeKey));
    if (existing) { out.already.push(typeSpec.typeKey); continue; }
    const def = approvalFlowDefinition({ typeKey: typeSpec.typeKey, title: typeSpec.title, approverRole: typeSpec.approverRole, closureSlaMinutes });
    const draft = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, draft.definitionId);
    await registerApprovalType(db, activator, typeSpec);
    out.registered.push(typeSpec.typeKey);
  }
  return out;
}
