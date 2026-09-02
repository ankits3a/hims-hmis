import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { cashierSessions, receipts, receiptTenders, refundVouchers } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { assertPaise } from "../tariff";
import { BillingError } from "./errors";
import { expectedCash, sumDenominations } from "./cash-math";
import { cashierSessionClosed, cashierSessionOpened, varianceFlagged } from "./events";
import type { Db, Tx } from "../../kernel/db/client";

export type CashierSessionRow = typeof cashierSessions.$inferSelect;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

/**
 * D9 -- one open session per cashier, arbitrated at the database layer by
 * `cashier_sessions_live_ux` (a partial unique index on `cashier_user_id` WHERE status IN
 * ('open', 'closing'), T1). No pre-check SELECT: the INSERT itself is the single-winner move,
 * and a raw 23505 escaping it is EXPECTED under concurrent opens (the tariff services.ts
 * precedent) -- caught here and mapped to `session_already_open` so callers never see the raw
 * driver error.
 */
export async function openSession(db: Db, actor: Actor, floatPaise: number): Promise<CashierSessionRow> {
  assertPaise(floatPaise, "opening float paise");
  const id = newId();
  const openedAt = new Date();
  try {
    return await withTx(db, async (tx) => {
      await tx.insert(cashierSessions).values({
        id, cashierUserId: actor.id, status: "open", openedAt, openingFloatPaise: floatPaise,
      });
      await appendEvent(
        tx,
        cashierSessionOpened.make({ actor, payload: { sessionId: id, cashierUserId: actor.id, openingFloatPaise: floatPaise } }),
      );
      const rows = await tx.select().from(cashierSessions).where(eq(cashierSessions.id, id));
      return rows[0]!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new BillingError("session_already_open", `cashier ${actor.id} already has a live session`);
    }
    throw e;
  }
}

/** D9 -- receipts and cash voucher payments require the ACTING cashier's OPEN (not closing) session. */
export async function requireOpenSession(db: Db | Tx, actor: Actor): Promise<CashierSessionRow> {
  const rows = await db
    .select()
    .from(cashierSessions)
    .where(and(eq(cashierSessions.cashierUserId, actor.id), eq(cashierSessions.status, "open")));
  const row = rows[0];
  if (!row) throw new BillingError("no_open_session", `cashier ${actor.id} has no open session`);
  return row;
}

/**
 * The session's cash tenders, session-scoped: Sigma `receipt_tenders.amount_paise` where
 * `mode = 'cash'` over the session's LIVE receipts. No writer creates these rows yet (T5
 * issues invoices with receipts, T6 ships allocations) -- sessions.test.ts SHAPES them by direct
 * insert against T1's schema (disclosed there and in this task's report). Written once, against
 * the FINAL shape, so T5/T6 need no change here.
 *
 * ENTERED-IN-ERROR RECEIPTS ARE EXCLUDED, and that is the same law `dayBook` states one file over
 * (daily-close.ts): money never really received cannot appear in the cash the drawer is reconciled
 * against. Without it, voiding a mis-keyed cash receipt left this fold counting money that is not
 * in the drawer -- a phantom shortfall that moved the session to `closing` and locked the cashier
 * out of all counter work (`requireOpenSession` accepts only `open`) behind a `billing_variance`
 * approval nobody could honestly grant.
 *
 * INLINE, deliberately. `enteredInErrorDocIds` exists as four private copies across this module
 * and the nearest one lives in `receipts.ts`, which imports `requireOpenSession` FROM THIS FILE --
 * so importing it would be a cycle, and copying it a fifth time would be worse. A correlated
 * NOT EXISTS in the query the fold already runs needs neither.
 */
async function sumCashTendersPaise(tx: Db | Tx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${receiptTenders.amountPaise}), 0)` })
    .from(receiptTenders)
    .innerJoin(receipts, eq(receiptTenders.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.cashierSessionId, sessionId),
        eq(receiptTenders.mode, "cash"),
        sql`not exists (
          select 1 from entered_in_error_marks
          where entered_in_error_marks.doc_type = 'receipt' and entered_in_error_marks.doc_id = receipts.id
        )`,
      ),
    );
  return Number(rows[0]!.total);
}

/**
 * The session's cash-paid voucher outflow, session-scoped. The term is zero until T8 ships
 * `payRefundVoucher` (no row ever carries this session's id as a cash-paid voucher until then) --
 * the query is still written now, against T1's schema, per this task's Step 2 (T8's suite covers
 * the non-zero case; not owed here).
 */
/**
 * PLAN 07b T5 — change handed back on this session's receipts. It mirrors `sumCashTendersPaise`
 * exactly, INCLUDING the entered-in-error exclusion: a receipt struck from the ledger takes its
 * change with it, or reversing a mistaken receipt would leave the drawer permanently short.
 */
async function sumChangeGivenPaise(tx: Db | Tx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${receipts.changeGivenPaise}), 0)` })
    .from(receipts)
    .where(
      and(
        eq(receipts.cashierSessionId, sessionId),
        sql`not exists (
          select 1 from entered_in_error_marks
          where entered_in_error_marks.doc_type = 'receipt' and entered_in_error_marks.doc_id = receipts.id
        )`,
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

async function sumCashVouchersPaidPaise(tx: Db | Tx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${refundVouchers.amountPaise}), 0)` })
    .from(refundVouchers)
    .where(
      and(
        eq(refundVouchers.cashierSessionId, sessionId),
        eq(refundVouchers.status, "paid"),
        eq(refundVouchers.method, "cash"),
      ),
    );
  return Number(rows[0]!.total);
}

/**
 * D9 -- `beginClose`: `countedCashPaise` from the denomination JSONB (cash-math.ts's pure fold);
 * `expectedCashPaise = openingFloat + Sigma cash tenders - Sigma cash vouchers paid` in-session;
 * `variancePaise = counted - expected`. Zero variance closes directly. Non-zero files a
 * `billing_variance` approval with the ACTING CASHIER as requester, in the SAME transaction --
 * the kernel's seeded `requester_approver` SoD pair then makes variance-approver != cashier
 * structural, for free (D9, K13). The final UPDATE is conditioned on `status = 'open'`
 * (single-winner), so a session already moved -- by this call's own initial read losing a race,
 * or a second `beginClose` while `closing` -- reports `session_state_conflict` rather than
 * silently double-filing an approval or double-closing.
 */
/**
 * FD-1 T3 / D5 — ONE MONEY FORMULA. The cash the drawer should hold RIGHT NOW is the same sum the
 * close counts against — float + cash tenders − cash vouchers paid − change given, over the live
 * receipts of this session (entered-in-error excluded). The desk card reads THIS function and the
 * close reads THIS function; a second arithmetic on the tile would be a figure the cashier could
 * defend to nobody.
 */
export async function liveExpectedCashPaise(exec: Db | Tx, session: Pick<CashierSessionRow, "id" | "openingFloatPaise">): Promise<number> {
  const cashTenders = await sumCashTendersPaise(exec, session.id);
  const cashVouchers = await sumCashVouchersPaidPaise(exec, session.id);
  const changeGiven = await sumChangeGivenPaise(exec, session.id);
  return expectedCash(session.openingFloatPaise, cashTenders, cashVouchers, changeGiven);
}

export async function beginClose(
  db: Db,
  actor: Actor,
  input: { denominations: Record<string, number>; note?: string },
  now: Date = new Date(),
): Promise<CashierSessionRow> {
  return withTx(db, async (tx) => {
    const rows = await tx
      .select()
      .from(cashierSessions)
      .where(and(eq(cashierSessions.cashierUserId, actor.id), inArray(cashierSessions.status, ["open", "closing"])));
    const session = rows[0];
    if (!session) throw new BillingError("no_open_session", `cashier ${actor.id} has no open session to close`);
    if (session.status !== "open") {
      throw new BillingError("session_state_conflict", `session ${session.id} is already ${session.status}`);
    }

    const counted = sumDenominations(input.denominations);
    const expected = await liveExpectedCashPaise(tx, session);
    const variancePaise = counted - expected;
    const closed = variancePaise === 0;

    let varianceApprovalId: string | null = null;
    if (!closed) {
      await appendEvent(
        tx,
        varianceFlagged.make({ actor, payload: { sessionId: session.id, cashierUserId: actor.id, variancePaise } }),
      );
      // FILED BY THE CASHIER (`actor`, the caller of beginClose) -- this is the free SoD (D9, K13):
      // the kernel's seeded requester_approver pair then refuses this SAME actor's later
      // approveRequest on this approval. Never file with a different/system identity here.
      const filed = await requestApproval(tx, actor, {
        typeKey: "billing_variance",
        subject: { type: "cashier_session", id: session.id },
        requestNote: `session ${session.id}: counted ${String(counted)} vs expected ${String(expected)} (variance ${String(variancePaise)} paise)`,
      });
      varianceApprovalId = filed.approvalId;
    }

    const updated = await tx
      .update(cashierSessions)
      .set({
        denominations: input.denominations,
        countedCashPaise: counted,
        expectedCashPaise: expected,
        variancePaise,
        closeNote: input.note ?? null,
        varianceApprovalId,
        status: closed ? "closed" : "closing",
        closedAt: closed ? now : null,
      })
      .where(and(eq(cashierSessions.id, session.id), eq(cashierSessions.status, "open")))
      .returning();
    if (updated.length === 0) {
      throw new BillingError("session_state_conflict", `session ${session.id} moved concurrently`);
    }

    if (closed) {
      await appendEvent(
        tx,
        cashierSessionClosed.make({ actor, payload: { sessionId: session.id, cashierUserId: actor.id, variancePaise } }),
      );
    }
    return updated[0]!;
  });
}

/**
 * D9 -- check-on-execute against the GRANTED variance approval (the patients/merge.ts
 * `executeMerge` precedent: the approval is read on `db`, outside any transaction, before the
 * state-changing transaction opens). Single-winner `closing -> closed` conditional UPDATE.
 */
export async function confirmClose(db: Db, actor: Actor, sessionId: string, now: Date = new Date()): Promise<CashierSessionRow> {
  const rows = await db.select().from(cashierSessions).where(eq(cashierSessions.id, sessionId));
  const session = rows[0];
  if (!session || session.status !== "closing") {
    throw new BillingError("session_state_conflict", `session ${sessionId} is not awaiting confirm-close`);
  }
  if (session.varianceApprovalId === null) {
    throw new BillingError("approval_not_granted", `session ${sessionId} carries no variance approval to confirm against`);
  }
  const approval = await getApproval(db, session.varianceApprovalId);
  if (!approval || approval.status !== "granted") {
    throw new BillingError("approval_not_granted", `variance approval for session ${sessionId} is not granted`);
  }

  return withTx(db, async (tx) => {
    const updated = await tx
      .update(cashierSessions)
      .set({ status: "closed", closedAt: now })
      .where(and(eq(cashierSessions.id, sessionId), eq(cashierSessions.status, "closing")))
      .returning();
    if (updated.length === 0) {
      throw new BillingError("session_state_conflict", `session ${sessionId} was already finalized concurrently`);
    }
    await appendEvent(
      tx,
      cashierSessionClosed.make({
        actor, payload: { sessionId, cashierUserId: session.cashierUserId, variancePaise: session.variancePaise ?? 0 },
      }),
    );
    return updated[0]!;
  });
}

/** A back-office worklist read -- filterable by cashier and/or lifecycle status, newest first. */
export async function listSessions(
  db: Db,
  filters: { cashierUserId?: string; status?: "open" | "closing" | "closed" } = {},
): Promise<CashierSessionRow[]> {
  const conditions = [];
  if (filters.cashierUserId !== undefined) conditions.push(eq(cashierSessions.cashierUserId, filters.cashierUserId));
  if (filters.status !== undefined) conditions.push(eq(cashierSessions.status, filters.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(cashierSessions).where(where).orderBy(desc(cashierSessions.openedAt));
}
