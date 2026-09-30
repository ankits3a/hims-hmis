import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { approvals, receipts, receiptTenders, reconResolutions } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { BillingError } from "./errors";
import { tenderResolved } from "./events";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — DECIDING A SETTLEMENT MISMATCH ═══
 *
 * Until the board, a `mismatched` tender could only be looked at. The billing back office board's
 * mismatch flow (step 2, "What happened") gives it three outcomes, each written as a
 * `recon_resolutions` row and a `tender.resolved` event in ONE transaction with the tender's move:
 *
 *   · `dispute`     — the bank short-paid; the office raises it with the bank. The tender STAYS
 *                     `mismatched` (it is still money the hospital is owed) and leaves the office's
 *                     "needs you" list for its clocks until a later decision closes it.
 *   · `bank_charge` — the shortfall is accepted as the bank's charge; the tender reconciles and the
 *                     resolution row carries the amount written off.
 *   · `reupload`    — the statement row was wrong; the tender goes back to `captured`, so the
 *                     corrected statement matches it on upload (recon.ts only ever settles a
 *                     `captured` tender — K32 is untouched: nothing here re-settles anything).
 *
 * OWNER RULING 2026-09-28 (money) — "the billing manager may accept a bank short-settlement as a bank
 * charge only up to ₹50.00 per receipt; above that the decision goes to the OWNER". The line is a
 * constant, not configuration, for the reason `refunds.ts` gives for its own: the person bound by a
 * line must not be the person who can move it. Above it, the first call FILES a
 * `billing_recon_charge_owner` approval (approver: owner) for the exact shortfall and changes nothing;
 * the call that carries the granted approval id applies it — check-on-execute, the credit-request
 * shape of GAP A3 (`credit-requests.ts`).
 *
 * Every write is conditional on the tender's state (`WHERE state = 'mismatched'`), the single-winner
 * shape recon.ts and refunds.ts use, so two people deciding the same tender cannot both win.
 */

export const RECON_CHARGE_OWNER_APPROVAL_TYPE = "billing_recon_charge_owner";
export const RECON_CHARGE_APPROVAL_SUBJECT = "receipt_tender";
/** OWNER RULING 2026-09-28 — ₹50.00, per receipt, is the most the billing manager may write off. */
export const RECON_CHARGE_MANAGER_MAX_PAISE = 5_000;

export type ReconOutcome = "dispute" | "bank_charge" | "reupload";
type StoredOutcome = "disputed" | "bank_charge" | "reupload";

const resolveSchema = z.object({
  tenderId: z.string().min(1),
  outcome: z.enum(["dispute", "bank_charge", "reupload"]),
  reason: z.string().trim().min(1).max(500),
  approvalId: z.string().min(1).optional(),
});
export type ResolveMismatchInput = z.infer<typeof resolveSchema>;

export type ResolveMismatchResult =
  | { status: "resolved"; tenderId: string; outcome: ReconOutcome; shortPaise: number; state: "mismatched" | "reconciled" | "captured"; resolutionId: string }
  | { status: "awaiting_owner"; tenderId: string; outcome: "bank_charge"; shortPaise: number; approvalId: string };

type TenderFacts = {
  id: string; receiptId: string; patientId: string; state: string;
  expectedNetPaise: number; settledPaise: number;
};

async function tenderFacts(db: Db, tenderId: string): Promise<TenderFacts> {
  const rows = await db
    .select({
      id: receiptTenders.id, receiptId: receiptTenders.receiptId, state: receiptTenders.state,
      expectedNetPaise: receiptTenders.expectedNetPaise, settledPaise: receiptTenders.settledPaise,
      patientId: receipts.patientId,
    })
    .from(receiptTenders)
    .innerJoin(receipts, eq(receiptTenders.receiptId, receipts.id))
    .where(eq(receiptTenders.id, tenderId));
  const row = rows[0];
  if (!row) throw new BillingError("unknown_tender", `no tender ${tenderId}`, { tenderId });
  return {
    id: row.id, receiptId: row.receiptId, patientId: row.patientId, state: row.state,
    expectedNetPaise: row.expectedNetPaise ?? 0, settledPaise: row.settledPaise ?? 0,
  };
}

/** The latest decision on a tender, or null — a dispute is "open" while it is the latest. */
export async function latestResolution(db: Db, tenderId: string): Promise<{ outcome: StoredOutcome; at: Date } | null> {
  const rows = await db
    .select({ outcome: reconResolutions.outcome, at: reconResolutions.at })
    .from(reconResolutions)
    .where(eq(reconResolutions.tenderId, tenderId))
    .orderBy(desc(reconResolutions.at))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { outcome: row.outcome as StoredOutcome, at: row.at };
}

/**
 * The owner's question about this shortfall, if one was asked: a pending one, and a GRANTED one no
 * decision has used yet (a grant writes off one shortfall once — a tender sent back and mismatched
 * again for the same amount needs a fresh yes).
 */
export async function ownerQuestionFor(
  db: Db, tenderId: string, shortPaise: number,
): Promise<{ pending: string | null; granted: string | null }> {
  const asked = await db
    .select({ id: approvals.id, status: approvals.status })
    .from(approvals)
    .where(and(
      eq(approvals.typeKey, RECON_CHARGE_OWNER_APPROVAL_TYPE), eq(approvals.subjectId, tenderId), eq(approvals.amountPaise, shortPaise),
    ))
    .orderBy(desc(approvals.requestedAt));
  const used = new Set((await db
    .select({ approvalId: reconResolutions.approvalId })
    .from(reconResolutions)
    .where(eq(reconResolutions.tenderId, tenderId))).map((r) => r.approvalId));
  return {
    pending: asked.find((a) => a.status === "pending")?.id ?? null,
    granted: asked.find((a) => a.status === "granted" && !used.has(a.id))?.id ?? null,
  };
}

async function assertOwnerGrant(db: Db, approvalId: string, tender: TenderFacts, shortPaise: number): Promise<void> {
  const approval = await getApproval(db, approvalId);
  if (!approval || approval.status !== "granted") {
    throw new BillingError("approval_not_granted", `approval ${approvalId} is not granted`);
  }
  const bound =
    approval.typeKey === RECON_CHARGE_OWNER_APPROVAL_TYPE &&
    approval.subjectType === RECON_CHARGE_APPROVAL_SUBJECT &&
    approval.subjectId === tender.id &&
    approval.amountPaise === shortPaise;
  if (!bound) {
    throw new BillingError("approval_subject_mismatch", `approval ${approvalId} does not bind to this write-off`, {
      expected: { typeKey: RECON_CHARGE_OWNER_APPROVAL_TYPE, subjectId: tender.id, amountPaise: shortPaise },
      got: { typeKey: approval.typeKey, subjectId: approval.subjectId, amountPaise: approval.amountPaise },
    });
  }
}

export async function resolveMismatch(
  db: Db,
  actor: Actor,
  rawInput: ResolveMismatchInput,
  now: Date = new Date(),
): Promise<ResolveMismatchResult> {
  const input = resolveSchema.parse(rawInput);
  const tender = await tenderFacts(db, input.tenderId);
  if (tender.state !== "mismatched") {
    throw new BillingError("tender_not_mismatched", `tender ${tender.id} is ${tender.state}, not mismatched`, {
      tenderId: tender.id, state: tender.state,
    });
  }
  // Positive when the bank paid LESS than it should have after its fee.
  const shortPaise = tender.expectedNetPaise - tender.settledPaise;
  let ownerApprovalId: string | null = null;

  if (input.outcome === "dispute") {
    const last = await latestResolution(db, tender.id);
    if (last?.outcome === "disputed") {
      throw new BillingError("recon_already_disputed", `tender ${tender.id} is already disputed`, { tenderId: tender.id });
    }
  }

  if (input.outcome === "bank_charge") {
    if (shortPaise <= 0) {
      // Over-settlement is not a charge the bank took; it is money to return or re-check.
      throw new BillingError("not_short_settled", "only a short settlement can be accepted as a bank charge", {
        tenderId: tender.id, shortPaise,
      });
    }
    if (shortPaise > RECON_CHARGE_MANAGER_MAX_PAISE) {
      if (input.approvalId === undefined) {
        const question = await ownerQuestionFor(db, tender.id, shortPaise);
        if (question.granted !== null) {
          // The owner said yes to exactly this: pressing the act again applies it (still checked below).
          ownerApprovalId = question.granted;
        } else if (question.pending !== null) {
          // Asking twice files once: a question already with the owner is returned as it is.
          return { status: "awaiting_owner", tenderId: tender.id, outcome: "bank_charge", shortPaise, approvalId: question.pending };
        } else {
          const filed = await withTx(db, (tx) => requestApproval(tx, actor, {
            typeKey: RECON_CHARGE_OWNER_APPROVAL_TYPE,
            subject: { type: RECON_CHARGE_APPROVAL_SUBJECT, id: tender.id },
            patientId: tender.patientId,
            amountPaise: shortPaise,
            requestNote: input.reason,
          }));
          return { status: "awaiting_owner", tenderId: tender.id, outcome: "bank_charge", shortPaise, approvalId: filed.approvalId };
        }
      } else {
        ownerApprovalId = input.approvalId;
      }
      await assertOwnerGrant(db, ownerApprovalId, tender, shortPaise);
    }
  }

  const stored: StoredOutcome = input.outcome === "dispute" ? "disputed" : input.outcome;
  const nextState = input.outcome === "dispute" ? "mismatched" : input.outcome === "bank_charge" ? "reconciled" : "captured";
  const approvalId = ownerApprovalId;

  return withTx(db, async (tx) => {
    if (input.outcome !== "dispute") {
      const set = input.outcome === "bank_charge"
        ? { state: "reconciled" }
        // A wrong statement row: undo what that row wrote, so the corrected statement settles it afresh.
        : { state: "captured", settledPaise: null, reconciledAt: null, mismatchNote: null };
      const moved = await tx
        .update(receiptTenders)
        .set(set)
        .where(and(eq(receiptTenders.id, tender.id), eq(receiptTenders.state, "mismatched")))
        .returning({ id: receiptTenders.id });
      if (moved.length === 0) {
        throw new BillingError("tender_not_mismatched", `tender ${tender.id} was decided by someone else first`, { tenderId: tender.id });
      }
    }
    const resolutionId = newId();
    await tx.insert(reconResolutions).values({
      id: resolutionId, tenderId: tender.id, outcome: stored, shortPaise, settledPaise: tender.settledPaise,
      reason: input.reason, approvalId, actorId: actor.id, at: now,
    });
    await appendEvent(tx, tenderResolved.make({
      actor,
      payload: { tenderId: tender.id, receiptId: tender.receiptId, outcome: stored, shortPaise, approvalId },
      patientId: tender.patientId,
    }));
    return { status: "resolved", tenderId: tender.id, outcome: input.outcome, shortPaise, state: nextState, resolutionId };
  });
}
