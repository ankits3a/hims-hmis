import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, seedBillingBase } from "../../../test/helpers/billing";
import { createUser } from "../../kernel/auth/identity";
import { assignRole } from "../../kernel/auth/permissions";
import { approveRequest } from "../../kernel/approvals/decisions";
import { SodViolationError } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { approvals, events, receipts, receiptTenders, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { dayBook } from "./daily-close";
import { markEnteredInError, recordReceipt } from "./receipts";
import { istDay } from "./time";
import { beginClose, confirmClose, openSession, recountSession, requireOpenSession, wasRecounted } from "./sessions";
import type { CashierSessionRow } from "./sessions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16a — the per-test budget for the race legs below. Named rather than inlined so the three
 * suites that need it say the same thing, and so a future reader finds ONE number to reason about.
 */
const RACE_TIMEOUT_MS = 60_000;


/**
 * Plan 08 T4, D9. DISCLOSED SHAPING: `receipts` and `receipt_tenders` rows this file inserts
 * directly against T1's schema exist so `beginClose`'s expected-cash fold has something real to
 * read -- no writer for either table ships until T5 (invoices+receipts) and T6 (allocations). The
 * query under test (`sumCashTendersPaise` in sessions.ts) is written ONCE, against that final
 * schema shape, and T5/T6 need no change to it. The cash-paid-voucher term of the same fold is
 * exercised in T8's suite, not here (no `refund_vouchers` fixture is built in this file).
 */
describe("sessions: openSession / requireOpenSession / beginClose / confirmClose (D9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  // The fixed instant T5-T8 use: 2026-08-19T06:00:00Z + 5:30 = 11:30 IST -> IST day "2026-08-19".
  const NOW = new Date("2026-08-19T06:00:00Z");
  const SERVICE_DAY = "2026-08-19";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    // registerPatient's own dependency -- the mkPatient/seedOpdBase precedent (test/helpers/opd.ts).
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedBillingBase(db); // sod pairs + billing_manager/cashier roles + the five approval types
  });

  async function mkManager(username: string): Promise<{ id: string; actor: Actor }> {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    await assignRole(db, { userId: id, roleKey: "billing_manager", scopeType: "hospital" });
    return { id, actor: { type: "user", id } };
  }

  async function mkTestPatient(actor: Actor): Promise<{ id: string }> {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name: "Test Patient", sex: "female", ageYears: 30 }));
    return { id: patient.id };
  }

  /** Shapes ONE cash receipt (+ its cash tender) under the given session -- disclosed above. */
  async function shapeCashReceipt(cashierId: string, sessionId: string, patientId: string, amountPaise: number): Promise<void> {
    const receiptId = newId();
    await db.insert(receipts).values({
      id: receiptId, receiptNo: newId(), patientId, cashierSessionId: sessionId,
      receivedBy: cashierId, receivedAt: new Date(), serviceDay: istDay(new Date()), totalPaise: amountPaise,
    });
    await db.insert(receiptTenders).values({ id: newId(), receiptId, mode: "cash", amountPaise });
  }

  /** float 100000 + cash tenders 172000 = expected 272000 once the session opens and shapes one receipt. */
  async function openWithShapedReceipt(username: string): Promise<{ cashier: { id: string; actor: Actor }; session: CashierSessionRow }> {
    const cashier = await mkCashier(db, username);
    const patient = await mkTestPatient(cashier.actor);
    const session = await openSession(db, cashier.actor, 100_000);
    await shapeCashReceipt(cashier.id, session.id, patient.id, 172_000);
    return { cashier, session };
  }

  /** Drives a fresh session to `closing` with a hand-derived non-zero variance (-1000 paise). */
  async function driveToClosingVariance(username: string): Promise<{ cashier: { id: string; actor: Actor }; session: CashierSessionRow; result: CashierSessionRow }> {
    const { cashier, session } = await openWithShapedReceipt(username);
    // 250000 + 20000 + 1000 = 271000 counted vs 272000 expected -> variance -1000 (short by Rs 10).
    const result = await beginClose(db, cashier.actor, { denominations: { "50000": 5, "10000": 2, "1000": 1 } });
    return { cashier, session, result };
  }

  test("openSession emits cashier_session.opened and returns the created row", async () => {
    const cashier = await mkCashier(db, "cashier-open");
    const row = await openSession(db, cashier.actor, 100_000);
    expect(row).toMatchObject({ cashierUserId: cashier.id, status: "open", openingFloatPaise: 100_000 });
    expect(row.id).toBeTruthy();
    const evts = await db.select().from(events).where(eq(events.name, "cashier_session.opened"));
    expect(evts).toHaveLength(1);
    expect(evts[0]!.payload).toMatchObject({ sessionId: row.id, cashierUserId: cashier.id, openingFloatPaise: 100_000 });
  });

  test("a second open for the same cashier is refused: session_already_open (the partial index arbiter)", async () => {
    const cashier = await mkCashier(db, "cashier-dup");
    await openSession(db, cashier.actor, 100_000);
    await expect(openSession(db, cashier.actor, 50_000)).rejects.toMatchObject({ code: "session_already_open" });
  });

  /**
   * PLAN 16a — AN EXPLICIT BUDGET, because this leg measures a RACE and not a SPEED.
   *
   * It runs five rounds of concurrent transactions with a full `truncateAll` before each, and the
   * suite's global `testTimeout: 15000` is incidental to everything it asserts (exactly one wins;
   * the invariant holds). On a contended CI runner that budget is what fails, not the property:
   * run 32959218495 timed out HERE at 15 s while the whole job took 1760 s against its
   * neighbours' 649-778 s, and the same commit's code passed on a quieter runner minutes later.
   *
   * 60 s is ~4x the observed local cost of the whole suite, and a genuine DEADLOCK still fails —
   * it just takes a minute to say so, which is the right trade for a lock test.
   */
  test("race: two concurrent opens for the same cashier -> exactly one wins, the loser's raw 23505 maps to session_already_open (measured 5x isolated, cold start every run)", async () => {
    const RUNS = 5;
    let cleanRuns = 0;
    for (let i = 0; i < RUNS; i++) {
      await truncateAll(db);
      await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
      await seedBillingBase(db);
      const cashier = await mkCashier(db, `cashier-race-${String(i)}`);
      const results = await Promise.allSettled([
        openSession(db, cashier.actor, 100_000),
        openSession(db, cashier.actor, 100_000),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "session_already_open" });
      cleanRuns++;
    }
    expect(cleanRuns).toBe(RUNS);
  }, RACE_TIMEOUT_MS);

  test("requireOpenSession: no_open_session for a cashier without one", async () => {
    const cashier = await mkCashier(db, "cashier-none");
    await expect(requireOpenSession(db, cashier.actor)).rejects.toMatchObject({ code: "no_open_session" });
  });

  test("requireOpenSession: returns the live session for its owner", async () => {
    const cashier = await mkCashier(db, "cashier-owns");
    const opened = await openSession(db, cashier.actor, 100_000);
    const found = await requireOpenSession(db, cashier.actor);
    expect(found.id).toBe(opened.id);
    expect(found.status).toBe("open");
  });

  test("beginClose: zero variance closes directly and emits cashier_session.closed (expected-cash fold: float 100000 + cash tenders 172000 - vouchers 0 = 272000)", async () => {
    const { cashier, session } = await openWithShapedReceipt("cashier-zero");
    // 250000 + 20000 + 2000 = 272000, matching the expected fold exactly -> zero variance.
    const closed = await beginClose(db, cashier.actor, { denominations: { "50000": 5, "10000": 2, "2000": 1 } });
    expect(closed.id).toBe(session.id);
    expect(closed.status).toBe("closed");
    expect(closed.countedCashPaise).toBe(272_000);
    expect(closed.expectedCashPaise).toBe(272_000);
    expect(closed.variancePaise).toBe(0);
    expect(closed.varianceApprovalId).toBeNull();
    expect(closed.closedAt).not.toBeNull();
    const evts = await db.select().from(events).where(eq(events.name, "cashier_session.closed"));
    expect(evts).toHaveLength(1);
    expect(evts[0]!.payload).toMatchObject({ sessionId: session.id, cashierUserId: cashier.id, variancePaise: 0 });
    const flagged = await db.select().from(events).where(eq(events.name, "variance.flagged"));
    expect(flagged).toHaveLength(0); // zero variance never flags
  });

  test("beginClose: non-zero variance -> status closing, variance.flagged, a billing_variance approval filed with the CASHIER as requester, varianceApprovalId stored", async () => {
    const { cashier, session, result } = await driveToClosingVariance("cashier-nonzero");
    expect(result.status).toBe("closing");
    expect(result.countedCashPaise).toBe(271_000);
    expect(result.expectedCashPaise).toBe(272_000);
    expect(result.variancePaise).toBe(-1_000); // signed: short by Rs 10
    expect(result.closedAt).toBeNull();
    expect(result.varianceApprovalId).not.toBeNull();

    const flagged = await db.select().from(events).where(eq(events.name, "variance.flagged"));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.payload).toMatchObject({ sessionId: session.id, cashierUserId: cashier.id, variancePaise: -1_000 });

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, result.varianceApprovalId!));
    expect(approvalRow).toBeDefined();
    expect(approvalRow!.typeKey).toBe("billing_variance");
    expect(approvalRow!.requesterId).toBe(cashier.id); // FILED BY THE CASHIER -- the free SoD (D9, K13)
    expect(approvalRow!.status).toBe("pending");
  });

  test("beginClose called again while the session is already closing -> session_state_conflict (single-winner conditional UPDATE)", async () => {
    const { cashier } = await driveToClosingVariance("cashier-again");
    await expect(beginClose(db, cashier.actor, { denominations: {} })).rejects.toMatchObject({ code: "session_state_conflict" });
  });

  test("confirmClose before the variance approval is granted -> approval_not_granted", async () => {
    const { cashier, session } = await driveToClosingVariance("cashier-pending");
    await expect(confirmClose(db, cashier.actor, session.id)).rejects.toMatchObject({ code: "approval_not_granted" });
  });

  test("confirmClose after approveRequest by a billing_manager -> closed", async () => {
    const { cashier, session, result } = await driveToClosingVariance("cashier-granted");
    const manager = await mkManager("manager-granted");
    await approveRequest(db, manager.actor, { approvalId: result.varianceApprovalId!, note: "verified against the drawer count" });
    const closed = await confirmClose(db, cashier.actor, session.id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
    const evts = await db.select().from(events).where(eq(events.name, "cashier_session.closed"));
    expect(evts).toHaveLength(1);
  });

  test("the cashier approving their OWN variance is refused by the kernel's requester_approver SoD pair -- the real decision path, not a local check (D9, K13)", async () => {
    const { cashier, result } = await driveToClosingVariance("cashier-self-approve");
    // The cashier ALSO holds billing_manager here -- proves SoD, not a missing permission, is the
    // gate (the decisions.test.ts precedent: "permission is not the gate, SoD is").
    await assignRole(db, { userId: cashier.id, roleKey: "billing_manager", scopeType: "hospital" });

    await expect(
      approveRequest(db, cashier.actor, { approvalId: result.varianceApprovalId!, note: "approving my own drawer variance" }),
    ).rejects.toBeInstanceOf(SodViolationError);

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, result.varianceApprovalId!));
    expect(approvalRow!.status).toBe("pending"); // nothing moved

    const sodEvents = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(sodEvents).toHaveLength(1); // appended in its OWN tx -- survives the refused decision
    expect(sodEvents[0]!.payload).toMatchObject({
      pairKey: "requester_approver", actorAId: cashier.id, actorBId: cashier.id,
    });
  });

  // ===========================================================================================
  // The expected-cash fold and the day book read the SAME "cash taken" and must agree about it
  // ===========================================================================================

  test("a voided cash receipt creates NO drawer variance: expected cash matches the day book, the session closes, and no billing_variance is filed", async () => {
    const cashier = await mkCashier(db, "cashier-void-cash");
    const patient = await mkTestPatient(cashier.actor);
    const session = await openSession(db, cashier.actor, 100_000);

    // A mis-keyed 50000p cash receipt, taken and then voided through the shipped write paths --
    // no shaping here: `markEnteredInError` is what puts the mark in `entered_in_error_marks`.
    const mistake = await recordReceipt(
      db, cashier.actor, { patientId: patient.id, tenders: [{ mode: "cash", amountPaise: 50_000 }] }, NOW,
    );
    await markEnteredInError(db, cashier.actor, { receiptId: mistake.receiptId, reason: "keyed against the wrong patient" }, NOW);

    // Voiding a receipt is not a lockout: the cashier's session is untouched and still `open`.
    expect(await requireOpenSession(db, cashier.actor)).toMatchObject({ id: session.id, status: "open" });

    // The day book already excludes it: money never really received cannot appear in the cash the
    // drawer is reconciled against (daily-close.ts's own docstring).
    const book = await dayBook(db, SERVICE_DAY);
    expect(book.receipts).toMatchObject({ count: 0, totalPaise: 0 });
    expect(book.receipts.byMode.cash).toBe(0);

    // The drawer physically holds exactly the opening float. Against shipped code the fold still
    // counted the voided 50000, so this reported expected 150000, variance -50000, status
    // `closing` and a filed `billing_variance` -- locking the cashier out of all counter work
    // (`requireOpenSession` accepts only `open`) until a billing_manager granted it.
    const closed = await beginClose(db, cashier.actor, { denominations: { "50000": 2 } }, NOW);
    expect(closed.status).toBe("closed");
    expect(closed.countedCashPaise).toBe(100_000);
    expect(closed.expectedCashPaise).toBe(100_000);
    expect(closed.variancePaise).toBe(0);
    expect(closed.varianceApprovalId).toBeNull();
    expect(closed.closedAt).not.toBeNull();

    // THE TWO READERS AGREE, over the same voided receipt: expected cash net of the opening float
    // IS the day book's cash total.
    expect(closed.expectedCashPaise! - session.openingFloatPaise).toBe(book.receipts.byMode.cash);

    expect(await db.select().from(approvals).where(eq(approvals.typeKey, "billing_variance"))).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.name, "variance.flagged"))).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * FD-11 — THE AUDITED RE-COUNT, AND THE HOLE IT WOULD HAVE OPENED IF IT WERE JUST AN UNDO
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Owner, on the preview: *"I wrongly typed the closing amount. Now I can't undo it and so I can't
   * close the drawer properly and hence can't proceed on to the dashboard."*
   *
   * The trap was real — every exit from a mistyped count needed a second human, in a hospital with
   * one supervisor. The fix must not become the bigger problem, so most of what follows asserts the
   * ATTACK is still refused rather than that the happy path works.
   */
  describe("FD-11: re-counting a mistyped close", () => {
    test("withdraws the count, writes the retracted figure to the log first, and reopens the drawer", async () => {
      const { cashier, session, result } = await driveToClosingVariance("cashier-recount-1");
      expect(result.status).toBe("closing");
      expect(result.variancePaise).toBe(-1000);
      const filedApprovalId = result.varianceApprovalId;
      expect(filedApprovalId).not.toBeNull();

      const reopened = await recountSession(db, cashier.actor, session.id, { reason: "typed 2,710 instead of 2,720" });

      expect(reopened.status).toBe("open");
      // the retracted numbers are OFF the row — the row is a live drawer again, not a half-closed one
      expect(reopened.countedCashPaise).toBeNull();
      expect(reopened.variancePaise).toBeNull();
      expect(reopened.varianceApprovalId).toBeNull();
      expect(reopened.closedAt).toBeNull();

      /*
        …and ON the log, which is the whole point. A correction is a thing that HAPPENED. The count a
        cashier first wrote down is the one piece of evidence an undo would destroy and the one piece
        an audit wants.
      */
      const logged = await db.select().from(events).where(eq(events.name, "cashier_session.recounted"));
      expect(logged).toHaveLength(1);
      const payload = logged[0]!.payload as Record<string, unknown>;
      expect(payload["sessionId"]).toBe(session.id);
      expect(payload["retractedCountedPaise"]).toBe(271_000);
      expect(payload["retractedExpectedPaise"]).toBe(272_000);
      expect(payload["retractedVariancePaise"]).toBe(-1000);
      expect(payload["retractedApprovalId"]).toBe(filedApprovalId);
      expect(payload["reason"]).toBe("typed 2,710 instead of 2,720");
    });

    /**
     * THE ATTACK, AND THE LINE THAT STOPS IT.
     *
     * Count short. Read the expected figure off the variance the screen just showed you. Retract.
     * Type that figure exactly. Without the rule this test pins, the session closes CLEAN — no
     * variance, no approval, no supervisor — and the difference stays in the cashier's pocket.
     *
     * So a drawer that has been retracted once files an approval on its next close whatever the
     * arithmetic says. The typo still costs one supervisor tap; what changes is that the number
     * reaching the ledger is the right one.
     */
    test("a re-counted drawer NEVER closes silently, even when the second count matches exactly", async () => {
      const { cashier, session } = await driveToClosingVariance("cashier-recount-attack");
      await recountSession(db, cashier.actor, session.id, { reason: "miscounted the 500s" });

      // 272000 exactly — the expected figure, which the cashier can read off their own screen
      const second = await beginClose(db, cashier.actor, { denominations: { "50000": 5, "20000": 1, "2000": 1 } });

      expect(second.countedCashPaise).toBe(272_000);
      expect(second.variancePaise).toBe(0);
      // a zero variance that would have auto-closed on a virgin drawer
      expect(second.status).toBe("closing");
      expect(second.closedAt).toBeNull();
      expect(second.varianceApprovalId).not.toBeNull();

      const filed = await db.select().from(approvals).where(eq(approvals.id, second.varianceApprovalId!));
      expect(filed[0]!.requestNote).toContain("retracted and re-entered");
    });

    test("a drawer that was never re-counted still closes clean on an exact count", async () => {
      const { cashier } = await openWithShapedReceipt("cashier-recount-clean");
      const closed = await beginClose(db, cashier.actor, { denominations: { "50000": 5, "20000": 1, "2000": 1 } });
      expect(closed.variancePaise).toBe(0);
      expect(closed.status).toBe("closed");
      expect(closed.varianceApprovalId).toBeNull();
    });

    test("only the cashier whose drawer it is may re-count it", async () => {
      const { session } = await driveToClosingVariance("cashier-recount-owner");
      const other = await mkCashier(db, "cashier-recount-stranger");
      await expect(recountSession(db, other.actor, session.id, { reason: "helping out" }))
        .rejects.toMatchObject({ code: "not_your_session" });
    });

    test("refuses a drawer that is not awaiting a close, and one that does not exist", async () => {
      const { cashier, session } = await openWithShapedReceipt("cashier-recount-open");
      // still `open` — there is no count to withdraw
      await expect(recountSession(db, cashier.actor, session.id, { reason: "nothing to undo" }))
        .rejects.toMatchObject({ code: "session_state_conflict" });
      await expect(recountSession(db, cashier.actor, "no-such-session", { reason: "x" }))
        .rejects.toMatchObject({ code: "unknown_session" });
    });

    /* A log entry with no reason is a log entry nobody can act on six months later. */
    test("a re-count must say why", async () => {
      const { cashier, session } = await driveToClosingVariance("cashier-recount-noreason");
      await expect(recountSession(db, cashier.actor, session.id, { reason: "   " }))
        .rejects.toMatchObject({ code: "recount_reason_required" });
      // and the drawer is untouched by the refusal
      expect(await wasRecounted(db, session.id)).toBe(false);
    });
  });
});
