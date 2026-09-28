import { hasPermission } from "../../kernel/auth/permissions";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { withTx } from "../../kernel/db/client";
import { BillingError } from "./errors";
import { CREDIT_APPROVAL_SUBJECT, CREDIT_APPROVAL_TYPE, CREDIT_EXTEND_PERMISSION } from "./invoices";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ GAP CLOSURE A3 — ASKING THE OWNER FOR CREDIT ═══
 *
 * Owner ruling 2026-09-28: "nobody can issue credit except owner", for the whole hospital. Every
 * counter that would let something go out unpaid — the OPD cashier, the lab desk, the pharmacy desk —
 * files ONE kind of request here, about the draft it is about to issue, for the exact amount it wants to
 * leave unpaid. The owner decides it in /approvals. The counter then issues the invoice with
 * `credit.approvalId`, and `issueInvoice` checks the grant against the same draft, patient and amount.
 *
 * Gated on `billing.credit.extend`, which since this ruling means "may ASK for credit and use a granted
 * one", no longer "may extend credit". A route of its own rather than the generic `POST /approvals`,
 * because that one needs `approvals.requests.create`, which the counters do not hold and should not:
 * they may ask for this one thing, not for anything.
 */

export type CreditRequestInput = { draftId: string; patientId: string; amountPaise: number; reason: string };

export async function requestCredit(db: Db, actor: Actor, input: CreditRequestInput): Promise<{ approvalId: string }> {
  if (!(await hasPermission(db, actor.id, CREDIT_EXTEND_PERMISSION, "hospital"))) {
    throw new BillingError("credit_permission_required", `asking for credit needs ${CREDIT_EXTEND_PERMISSION}`);
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new BillingError("invalid_paise", "credit must be a positive whole number of paise");
  }
  if (input.reason.trim() === "") {
    throw new BillingError("unsettled_issue_refused", "credit needs a reason the owner can read");
  }
  const filed = await withTx(db, (tx) => requestApproval(tx, actor, {
    typeKey: CREDIT_APPROVAL_TYPE,
    subject: { type: CREDIT_APPROVAL_SUBJECT, id: input.draftId },
    patientId: input.patientId,
    amountPaise: input.amountPaise,
    requestNote: input.reason.trim(),
  }));
  return { approvalId: filed.approvalId };
}

/** Where the request stands — the counter polls this and issues the moment it reads `granted`. */
export async function creditRequestStatus(
  db: Db, approvalId: string,
): Promise<{ approvalId: string; status: string; amountPaise: number | null; draftId: string; decisionNote: string | null }> {
  const a = await getApproval(db, approvalId);
  if (a === null || a.typeKey !== CREDIT_APPROVAL_TYPE) {
    throw new BillingError("unknown_credit_request", `no credit request ${approvalId}`);
  }
  return { approvalId, status: a.status, amountPaise: a.amountPaise, draftId: a.subjectId, decisionNote: a.decisionNote ?? null };
}
