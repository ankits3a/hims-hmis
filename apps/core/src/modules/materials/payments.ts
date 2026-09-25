import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { assertNotSodPair } from "../../kernel/auth/sod";
import { hasPermission } from "../../kernel/auth/permissions";
import { requestApproval } from "../../kernel/approvals/requests";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { getApproval } from "../../kernel/approvals/worklist";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import { approvals, supplierBills, supplierPaymentRunLines, supplierPaymentRuns, supplierPayments, users, vendors } from "../../kernel/db/schema";
import { PAYMENT_RUN_APPROVAL_TYPE } from "./approval-types";
import { CASH_PAYMENT_DAILY_LIMIT_PAISE, PAYMENT_RUN_HORIZON_DAYS } from "./config";
import { MaterialsError } from "./errors";
import {
  paymentRunAuthorised, paymentRunCancelled, paymentRunCompleted, paymentRunDrafted, paymentRunRejected, paymentRunSubmitted,
  paymentRunUpdated, supplierPaymentRecorded,
} from "./events";
import { istDay } from "./grn";
import { addDays, billsDueBy, daysBetween, requirePayablesReader, reservedByBill, vendorCredits } from "./supplier-bills";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P3 — THE PAYMENT RUN AND THE PAYMENT ═══
 *
 * The Healthray "Pay Bill" grid, our way: a RUN of bills proposed for payment, authorised by the
 * owner through `kernel/approvals`, then paid vendor by vendor.
 *
 *   draft ─submit→ pending_authorisation ─owner authorises→ authorised ─each vendor recorded→ completed
 *                        └─owner refuses→ draft (with the reason)
 *
 * - **The agent drafts.** `planPaymentRun` proposes every accepted bill due within
 *   `PAYMENT_RUN_HORIZON_DAYS` (overdue included), MSME vendors first, then the oldest due date, at
 *   what the bill still owes less what other open runs already hold. A vendor in its bank-change
 *   cooling-off is listed apart and left out. `draftPaymentRun` writes that as a DRAFT only.
 * - **Three people.** `materials.payments.prepare` prepares and submits (only the preparer submits,
 *   so the kernel's requester ≠ approver is the preparer ≠ authoriser rule, and
 *   `payout_preparer_payout_approver` refuses the sheet's decision too). The owner authorises
 *   (`materials_payment_run_approval`). `materials.payments.record` records each vendor paid — never
 *   the authoriser (`payment_authoriser_recorder`, SoD engine + in-act guard).
 * - **At the moment money moves** (`recordVendorPayment`): the run must be authorised; the vendor's
 *   `first_payment_allowed_at` must have passed (bank-change cooling-off, O-6); cash to one vendor in
 *   one day may not pass the s.40A(3) limit; no bill may be paid past its total.
 * - **Part payments.** A run line may pay less than the bill owes; the bill becomes `part_paid`.
 * - **Credit to offset** (parity P4): a vendor's accepted credit notes (`vendorCredits`) are set
 *   against its bills on the run, oldest due first — `credit_paise` on the line, `Payable = Total −
 *   Credit`. A bill the credit covers whole rides on the run with nothing to pay; a vendor whose credit
 *   covers everything due is left off (listed apart) — no voucher is written for ₹0. What a run holds
 *   is reserved; recording the vendor's payment applies it; cancelling the run releases it.
 */

const PREPARE = "materials.payments.prepare";
const RECORD = "materials.payments.record";

export type RunStatus = "draft" | "pending_authorisation" | "authorised" | "completed" | "cancelled";
const OPEN_RUN: readonly RunStatus[] = ["draft", "pending_authorisation", "authorised"];
export type PaymentMode = "neft" | "rtgs" | "upi" | "cheque" | "cash";
export const PAYMENT_MODES: readonly PaymentMode[] = ["neft", "rtgs", "upi", "cheque", "cash"];

/** One bill on a run: what is paid now and (parity P4) the vendor credit set against it. */
export type RunLineInput = { billId: string; payPaise: number; creditPaise?: number };

export type RunLineView = {
  id: string; billId: string; billNo: string; vendorBillNo: string; billDate: string; dueDate: string | null; msme: boolean;
  totalPaise: number;
  /** Paid on the bill before this line (other runs, or this line before it was recorded). */
  prevPaidPaise: number;
  creditPaise: number;
  payPaise: number;
  /** What the bill will still owe once this line is paid: `total − prev paid − credit − pay`. */
  remainingPaise: number;
  overdueDays: number;
  paid: boolean;
};

export type RunVendorView = {
  vendorId: string; vendorCode: string; vendorName: string; msme: boolean;
  /** The bank-change cooling-off, when it has not ended: nobody pays this vendor before it. */
  coolingOffUntil: string | null;
  payPaise: number;
  lines: RunLineView[];
  /** PARITY P4 — the vendor credit set against this vendor's bills on the run. */
  creditPaise: number;
  payment: { paymentId: string; paymentNo: string; mode: PaymentMode; reference: string | null; paidOn: string; amountPaise: number; recordedBy: string } | null;
};

export type RunSummary = {
  id: string; runNo: string; status: RunStatus; source: "manual" | "agent"; totalPaise: number; vendorCount: number; billCount: number;
  approvalId: string | null; rejectionNote: string | null; createdBy: string; createdAt: string; submittedAt: string | null;
  authorisedBy: string | null; authorisedAt: string | null; completedAt: string | null;
};

export type RunView = RunSummary & {
  note: string | null; cancelReason: string | null; names: Record<string, string>; vendors: RunVendorView[];
  approval: { status: string; approverRole: string; requesterId: string; decidedBy: string | null; decisionNote: string | null } | null;
};

// ═══════════════════════════════════ who may ═══════════════════════════════════

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${perm}`);
  }
}

// ═══════════════════════════════════ the agent's plan ═══════════════════════════════════

export type PlanBill = {
  billId: string; billNo: string; vendorBillNo: string; billDate: string; dueDate: string; totalPaise: number; paidPaise: number;
  reservedPaise: number;
  /** What the bill still owes, less what open runs already hold. */
  owedPaise: number;
  /** PARITY P4 — the vendor's available credit set against this bill (oldest due first). */
  creditPaise: number;
  /** What the run pays on it now: `owed − credit`. */
  payablePaise: number;
  overdueDays: number;
};
export type PlanGroup = {
  vendorId: string; vendorCode: string; vendorName: string; msme: boolean;
  /** Σ payable — the money this vendor is paid. */
  totalPaise: number;
  /** Σ credit set off. */
  creditPaise: number;
  bills: PlanBill[];
};
export type PaymentPlan = {
  asOf: string; until: string;
  groups: PlanGroup[];
  /** Vendors with bills due whose bank-change cooling-off has not ended — left out of the draft. */
  blocked: (PlanGroup & { coolingOffUntil: string })[];
  /** PARITY P4 — vendors whose available credit covers everything due: nothing to pay, left out. */
  coveredByCredit: PlanGroup[];
  totalPaise: number;
  /** PARITY P4 — the credit the draft sets off, all vendors. */
  creditPaise: number;
};

/**
 * What the agent would put on a run now (writes nothing): each accepted bill due by today +
 * `PAYMENT_RUN_HORIZON_DAYS`, at what it still owes less what open runs hold, grouped by vendor —
 * MSME vendors first, then by each vendor's oldest due date.
 */
export async function planPaymentRun(db: Db, now: Date = new Date()): Promise<PaymentPlan> {
  const today = istDay(now);
  const until = addDays(today, PAYMENT_RUN_HORIZON_DAYS);
  const due = await billsDueBy(db, until);
  const reserved = await reservedByBill(db, due.map((b) => b.id));
  const vendorIds = [...new Set(due.map((b) => b.vendorId))];
  const vs = vendorIds.length === 0 ? [] : await db.select().from(vendors).where(inArray(vendors.id, vendorIds));
  const credit = await vendorCredits(db, vendorIds);
  const groups = new Map<string, PlanGroup & { coolingOffUntil: string | null; creditLeft: number }>();
  for (const b of due) {
    const owed = b.totalPaise - b.paidPaise - (reserved.get(b.id) ?? 0);
    if (owed <= 0) continue;
    const v = vs.find((x) => x.id === b.vendorId)!;
    const coolingOffUntil = v.firstPaymentAllowedAt !== null && v.firstPaymentAllowedAt > now ? v.firstPaymentAllowedAt.toISOString() : null;
    const g = groups.get(b.vendorId) ?? {
      vendorId: v.id, vendorCode: v.code, vendorName: v.tradeName ?? v.legalName, msme: b.msme, totalPaise: 0, creditPaise: 0, bills: [],
      coolingOffUntil,
      // A vendor in cooling-off is not paid now, so none of its credit is spent on it either.
      creditLeft: coolingOffUntil === null ? Math.max(0, credit.get(v.id)?.availablePaise ?? 0) : 0,
    };
    g.msme = g.msme || b.msme;
    // `billsDueBy` orders by due date: the oldest bill takes the credit first.
    const setOff = Math.min(g.creditLeft, owed);
    g.creditLeft -= setOff;
    g.bills.push({
      billId: b.id, billNo: b.billNo, vendorBillNo: b.vendorBillNo, billDate: b.billDate, dueDate: b.dueDate!, totalPaise: b.totalPaise,
      paidPaise: b.paidPaise, reservedPaise: reserved.get(b.id) ?? 0, owedPaise: owed, creditPaise: setOff, payablePaise: owed - setOff,
      overdueDays: Math.max(0, daysBetween(b.dueDate!, today)),
    });
    g.totalPaise += owed - setOff;
    g.creditPaise += setOff;
    groups.set(b.vendorId, g);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    Number(b.msme) - Number(a.msme) || a.bills[0]!.dueDate.localeCompare(b.bills[0]!.dueDate) || a.vendorName.localeCompare(b.vendorName));
  const plain = (g: PlanGroup): PlanGroup => ({
    vendorId: g.vendorId, vendorCode: g.vendorCode, vendorName: g.vendorName, msme: g.msme, totalPaise: g.totalPaise, creditPaise: g.creditPaise, bills: g.bills,
  });
  const ready: PlanGroup[] = ordered.filter((g) => g.coolingOffUntil === null && g.totalPaise > 0).map(plain);
  const coveredByCredit: PlanGroup[] = ordered.filter((g) => g.coolingOffUntil === null && g.totalPaise === 0).map(plain);
  const blocked = ordered.filter((g) => g.coolingOffUntil !== null).map((g) => ({ ...plain(g), coolingOffUntil: g.coolingOffUntil! }));
  return {
    asOf: today, until, groups: ready, blocked, coveredByCredit,
    totalPaise: ready.reduce((s, g) => s + g.totalPaise, 0), creditPaise: ready.reduce((s, g) => s + g.creditPaise, 0),
  };
}

// ═══════════════════════════════════ lines ═══════════════════════════════════

type RunRow = typeof supplierPaymentRuns.$inferSelect;

type ResolvedRunLine = { billId: string; vendorId: string; payPaise: number; creditPaise: number };

async function resolveLines(tx: Tx, runId: string | null, lines: readonly RunLineInput[]): Promise<ResolvedRunLine[]> {
  if (lines.length === 0) throw new MaterialsError("run_invalid", "a run carries at least one bill");
  if (lines.length > 500) throw new MaterialsError("run_invalid", "a run carries at most 500 bills");
  const ids = [...new Set(lines.map((l) => l.billId))];
  if (ids.length !== lines.length) throw new MaterialsError("run_invalid", "a bill appears twice on the run");
  // PARITY P4 — the vendors' rows are locked BEFORE the bills', the order `recordVendorPayment` takes
  // them in (run → vendor → bills), so a run being drafted and a payment being recorded cannot
  // deadlock; the lock is what stops two runs spending one vendor credit.
  const owners = await tx.select({ vendorId: supplierBills.vendorId }).from(supplierBills).where(inArray(supplierBills.id, ids));
  const vendorIds = [...new Set(owners.map((o) => o.vendorId))].sort();
  if (vendorIds.length > 0) await tx.select({ id: vendors.id }).from(vendors).where(inArray(vendors.id, vendorIds)).orderBy(asc(vendors.id)).for("update");
  const bills = await tx.select().from(supplierBills).where(inArray(supplierBills.id, ids)).for("update");
  const reserved = await reservedByBill(tx, ids, runId ?? undefined);
  const resolved = lines.map((l) => {
    const b = bills.find((x) => x.id === l.billId);
    if (b === undefined) throw new MaterialsError("unknown_supplier_bill", `supplier bill ${l.billId} not found`);
    if (b.status !== "accepted" && b.status !== "part_paid") {
      throw new MaterialsError("run_invalid", `bill ${b.billNo} is ${b.status}; only an accepted bill is paid`, { billNo: b.billNo, status: b.status });
    }
    const available = b.totalPaise - b.paidPaise - (reserved.get(b.id) ?? 0);
    const credit = l.creditPaise ?? 0;
    if (!Number.isSafeInteger(l.payPaise) || !Number.isSafeInteger(credit) || l.payPaise < 0 || credit < 0 || l.payPaise + credit <= 0 || l.payPaise + credit > available) {
      throw new MaterialsError("run_invalid", `bill ${b.billNo}: pay plus credit between ₹0.01 and ₹${(available / 100).toFixed(2)} (what it still owes, less other open runs)`, {
        billNo: b.billNo, availablePaise: available, payPaise: l.payPaise, creditPaise: credit,
      });
    }
    return { billId: b.id, vendorId: b.vendorId, payPaise: l.payPaise, creditPaise: credit };
  });
  // PARITY P4 — per vendor: the credit set off is the vendor's to spend (under the lock taken above),
  // and money still moves.
  const credits = await vendorCredits(tx, vendorIds, runId ?? undefined);
  for (const vendorId of vendorIds) {
    const mine = resolved.filter((l) => l.vendorId === vendorId);
    const creditOn = mine.reduce((s, l) => s + l.creditPaise, 0);
    const availableCredit = Math.max(0, credits.get(vendorId)?.availablePaise ?? 0);
    if (creditOn > availableCredit) {
      throw new MaterialsError("run_invalid", `credit ₹${(creditOn / 100).toFixed(2)} is more than the vendor's available credit ₹${(availableCredit / 100).toFixed(2)}`, {
        vendorId, creditPaise: creditOn, availableCreditPaise: availableCredit,
      });
    }
    if (mine.reduce((s, l) => s + l.payPaise, 0) === 0) {
      throw new MaterialsError("run_invalid", "every vendor on a run is paid something; a vendor whose credit covers everything due is left off the run", { vendorId });
    }
  }
  return resolved;
}

async function writeLines(tx: Tx, runId: string, lines: readonly ResolvedRunLine[]): Promise<number> {
  await tx.insert(supplierPaymentRunLines).values(lines.map((l) => ({
    id: newId(), runId, billId: l.billId, vendorId: l.vendorId, payPaise: l.payPaise, creditPaise: l.creditPaise,
  })));
  return lines.reduce((s, l) => s + l.payPaise, 0);
}

async function lockRun(tx: Tx, runId: string): Promise<RunRow> {
  const [row] = await tx.select().from(supplierPaymentRuns).where(eq(supplierPaymentRuns.id, runId)).for("update");
  if (row === undefined) throw new MaterialsError("unknown_payment_run", `payment run ${runId} not found`);
  return row;
}

function wrongStatus(r: RunRow, act: string, need: readonly string[]): MaterialsError {
  return new MaterialsError("run_wrong_status", `payment run ${r.runNo} is ${r.status}; ${act} needs it ${need.join(" or ")}`, { status: r.status, runNo: r.runNo });
}

const header = (r: Pick<RunRow, "id" | "runNo" | "totalPaise">): { runId: string; runNo: string; totalPaise: number } =>
  ({ runId: r.id, runNo: r.runNo, totalPaise: r.totalPaise });

// ═══════════════════════════════════ draft, edit ═══════════════════════════════════

export async function createPaymentRun(
  db: Db, actor: Actor, input: { lines: RunLineInput[]; note?: string | null }, opts: { source?: "manual" | "agent"; now?: Date } = {},
): Promise<RunView> {
  await requirePerm(db, actor, PREPARE, "preparing a payment run");
  const now = opts.now ?? new Date();
  const runId = await withTx(db, async (tx) => {
    const lines = await resolveLines(tx, null, input.lines);
    const id = newId();
    const runNo = await nextEpisodeNo(tx, "payment_run", istDay(now));
    const note = input.note?.trim().slice(0, 500) || null;
    await tx.insert(supplierPaymentRuns).values({
      id, runNo, status: "draft", source: opts.source ?? "manual", totalPaise: 0, note, createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
    });
    const totalPaise = await writeLines(tx, id, lines);
    await tx.update(supplierPaymentRuns).set({ totalPaise }).where(eq(supplierPaymentRuns.id, id));
    await appendEvent(tx, paymentRunDrafted.make({
      occurredAt: now, actor, correlationId: id,
      payload: { runId: id, runNo, totalPaise, source: opts.source ?? "manual", bills: lines.length, vendors: new Set(lines.map((l) => l.vendorId)).size },
    }));
    return id;
  });
  return (await readPaymentRun(db, runId))!;
}

/** The person's press of "make the draft": the agent's plan, as a DRAFT run. Nothing is submitted. */
export async function draftPaymentRun(db: Db, actor: Actor, now: Date = new Date()): Promise<RunView> {
  await requirePerm(db, actor, PREPARE, "preparing a payment run");
  const plan = await planPaymentRun(db, now);
  const lines = plan.groups.flatMap((g) => g.bills.map((b) => ({ billId: b.billId, payPaise: b.payablePaise, creditPaise: b.creditPaise })));
  if (lines.length === 0) throw new MaterialsError("run_invalid", "nothing is due to pay: no accepted bill falls due in the next week that another run does not already hold");
  return createPaymentRun(db, actor, { lines, note: `Drafted by the agent: bills due by ${plan.until}` }, { source: "agent", now });
}

/** A draft's lines (all of them) and note. */
export async function updatePaymentRun(
  db: Db, actor: Actor, runId: string, patch: { lines?: RunLineInput[]; note?: string | null }, now: Date = new Date(),
): Promise<RunView> {
  await requirePerm(db, actor, PREPARE, "editing a payment run");
  await withTx(db, async (tx) => {
    const r = await lockRun(tx, runId);
    if (r.status !== "draft") throw wrongStatus(r, "editing", ["draft"]);
    const set: Partial<typeof supplierPaymentRuns.$inferInsert> = { updatedBy: actor.id, updatedAt: now };
    if (patch.note !== undefined) set.note = patch.note?.trim().slice(0, 500) || null;
    let bills = (await tx.select({ id: supplierPaymentRunLines.id }).from(supplierPaymentRunLines).where(eq(supplierPaymentRunLines.runId, runId))).length;
    if (patch.lines !== undefined) {
      const lines = await resolveLines(tx, runId, patch.lines);
      await tx.delete(supplierPaymentRunLines).where(eq(supplierPaymentRunLines.runId, runId));
      set.totalPaise = await writeLines(tx, runId, lines);
      bills = lines.length;
    }
    const [after] = await tx.update(supplierPaymentRuns).set(set).where(eq(supplierPaymentRuns.id, runId)).returning();
    await appendEvent(tx, paymentRunUpdated.make({ occurredAt: now, actor, correlationId: runId, payload: { ...header(after!), bills } }));
  });
  return (await readPaymentRun(db, runId))!;
}

// ═══════════════════════════════════ authorisation ═══════════════════════════════════

/**
 * Draft → pending_authorisation. Only the PREPARER submits (so the approvals kernel's requester ≠
 * approver refuses the preparer authorising, whichever screen they decide from). The lines are
 * re-asked: a bill paid or cancelled since the draft refuses here, not at the bank.
 */
export async function submitPaymentRun(db: Db, actor: Actor, runId: string, now: Date = new Date()): Promise<RunView> {
  await requirePerm(db, actor, PREPARE, "submitting a payment run");
  await withTx(db, async (tx) => {
    const r = await lockRun(tx, runId);
    if (r.status !== "draft") throw wrongStatus(r, "submitting", ["draft"]);
    if (r.createdBy !== actor.id) throw new MaterialsError("run_not_preparer", `payment run ${r.runNo} is submitted by the person who prepared it`, { runNo: r.runNo });
    const lines = await tx.select().from(supplierPaymentRunLines).where(eq(supplierPaymentRunLines.runId, runId));
    await resolveLines(tx, runId, lines.map((l) => ({ billId: l.billId, payPaise: l.payPaise, creditPaise: l.creditPaise })));
    const vendorsOn = new Set(lines.map((l) => l.vendorId)).size;
    const { approvalId } = await requestApproval(tx, actor, {
      typeKey: PAYMENT_RUN_APPROVAL_TYPE,
      subject: { type: "supplier_payment_run", id: runId },
      // The run is the payee for the kernel's daily aggregation: one run, one sum, whatever its vendors.
      payeeId: runId,
      amountPaise: r.totalPaise,
      requestNote: `${r.runNo} · ${String(vendorsOn)} vendor(s) · ${String(lines.length)} bill(s) · ₹${(r.totalPaise / 100).toFixed(2)}`,
    });
    await tx.update(supplierPaymentRuns).set({ status: "pending_authorisation", approvalId, submittedAt: now, rejectionNote: null, updatedBy: actor.id, updatedAt: now })
      .where(eq(supplierPaymentRuns.id, runId));
    await appendEvent(tx, paymentRunSubmitted.make({ occurredAt: now, actor, correlationId: runId, payload: { ...header(r), approvalId } }));
  });
  return (await readPaymentRun(db, runId))!;
}

/**
 * Authorise or refuse from the run's own sheet. The kernel decides (the owner's role, requester ≠
 * approver, a note); the SoD engine first refuses the preparer (`payout_preparer_payout_approver`)
 * with an audit event, then the run is settled in the kernel's wake.
 */
export async function decidePaymentRun(
  db: Db, actor: Actor, runId: string, verdict: "approve" | "reject", note: string, now: Date = new Date(),
): Promise<RunView> {
  const [r] = await db.select().from(supplierPaymentRuns).where(eq(supplierPaymentRuns.id, runId));
  if (r === undefined) throw new MaterialsError("unknown_payment_run", `payment run ${runId} not found`);
  if (r.status !== "pending_authorisation" || r.approvalId === null) throw wrongStatus(r, "a decision", ["pending_authorisation"]);
  await assertNotSodPair(db, "payout_preparer_payout_approver", { type: "user", id: r.createdBy }, actor);
  if (verdict === "approve") await approveRequest(db, actor, { approvalId: r.approvalId, note });
  else await rejectRequest(db, actor, { approvalId: r.approvalId, note });
  await settlePaymentRuns(db, now, [runId]);
  return (await readPaymentRun(db, runId))!;
}

/** Pending runs brought level with their approvals (idempotent; conditional updates, the PO's pattern). */
export async function settlePaymentRuns(db: Db, now: Date = new Date(), runIds?: readonly string[]): Promise<number> {
  const decided = await db.select({ r: supplierPaymentRuns, ap: approvals }).from(supplierPaymentRuns)
    .innerJoin(approvals, eq(approvals.id, supplierPaymentRuns.approvalId))
    .where(and(
      eq(supplierPaymentRuns.status, "pending_authorisation"), ne(approvals.status, "pending"),
      ...(runIds === undefined ? [] : [inArray(supplierPaymentRuns.id, [...runIds])]),
    ));
  let moved = 0;
  for (const { r, ap } of decided) {
    const decider: Actor = { type: "user", id: ap.decidedBy ?? "unknown" };
    await withTx(db, async (tx) => {
      const guard = and(eq(supplierPaymentRuns.id, r.id), eq(supplierPaymentRuns.status, "pending_authorisation"), eq(supplierPaymentRuns.approvalId, ap.id));
      if (ap.status === "granted") {
        const won = await tx.update(supplierPaymentRuns).set({
          status: "authorised", authorisedBy: ap.decidedBy, authorisedAt: ap.decidedAt ?? now, updatedBy: ap.decidedBy ?? r.updatedBy, updatedAt: now,
        }).where(guard).returning({ id: supplierPaymentRuns.id });
        if (won.length === 0) return;
        await appendEvent(tx, paymentRunAuthorised.make({
          occurredAt: now, actor: decider, correlationId: r.id, payload: { ...header(r), approvalId: ap.id, authorisedBy: ap.decidedBy ?? "unknown" },
        }));
      } else {
        const won = await tx.update(supplierPaymentRuns).set({
          status: "draft", approvalId: null, rejectionNote: ap.decisionNote ?? "refused", updatedBy: ap.decidedBy ?? r.updatedBy, updatedAt: now,
        }).where(guard).returning({ id: supplierPaymentRuns.id });
        if (won.length === 0) return;
        await appendEvent(tx, paymentRunRejected.make({
          occurredAt: now, actor: decider, correlationId: r.id,
          payload: { ...header(r), approvalId: ap.id, rejectedBy: ap.decidedBy ?? "unknown", note: ap.decisionNote ?? "" },
        }));
      }
      moved += 1;
    });
  }
  return moved;
}

/** A run with nothing paid may be cancelled, with a reason; its bills are free for another run. */
export async function cancelPaymentRun(db: Db, actor: Actor, runId: string, reason: string, now: Date = new Date()): Promise<RunView> {
  await requirePerm(db, actor, PREPARE, "cancelling a payment run");
  const why = reason.trim();
  if (why === "") throw new MaterialsError("reason_required", "say why the run is cancelled");
  await withTx(db, async (tx) => {
    const r = await lockRun(tx, runId);
    if (!OPEN_RUN.includes(r.status as RunStatus)) throw wrongStatus(r, "cancelling", OPEN_RUN);
    const paid = await tx.select({ id: supplierPayments.id }).from(supplierPayments).where(eq(supplierPayments.runId, runId)).limit(1);
    if (paid.length > 0) throw new MaterialsError("run_wrong_status", `payment run ${r.runNo} has a payment recorded and cannot be cancelled`, { runNo: r.runNo });
    await tx.update(supplierPaymentRuns).set({
      status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: why.slice(0, 500), updatedBy: actor.id, updatedAt: now,
    }).where(eq(supplierPaymentRuns.id, runId));
    await appendEvent(tx, paymentRunCancelled.make({ occurredAt: now, actor, correlationId: runId, payload: { ...header(r), reason: why.slice(0, 500), fromStatus: r.status } }));
  });
  return (await readPaymentRun(db, runId))!;
}

// ═══════════════════════════════════ the payment ═══════════════════════════════════

/**
 * The SoD engine's half of `payment_authoriser_recorder`, run on `db` BEFORE the payment's
 * transaction so the `sod.violation_blocked` event survives the refusal. `recordVendorPayment`
 * refuses the same person in the act whatever the caller did.
 */
export async function assertNotRunAuthoriser(db: Db, actor: Actor, runId: string): Promise<void> {
  const [r] = await db.select({ authorisedBy: supplierPaymentRuns.authorisedBy }).from(supplierPaymentRuns).where(eq(supplierPaymentRuns.id, runId));
  if (r?.authorisedBy === null || r?.authorisedBy === undefined) return;
  await assertNotSodPair(db, "payment_authoriser_recorder", { type: "user", id: r.authorisedBy }, actor);
}

export type PaymentInput = { mode: PaymentMode; reference?: string | null; paidOn?: string | null };

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * One vendor on an authorised run paid: every unpaid line of that vendor, in one voucher (`MPV…`) of
 * one mode and reference. Refuses, in this order: a run not authorised; the run's authoriser as the
 * recorder; a bank mode without its reference; a vendor still in its bank-change cooling-off; cash
 * past the day's s.40A(3) limit for this vendor; a bill that would be paid past its total.
 */
export async function recordVendorPayment(
  db: Db, actor: Actor, runId: string, vendorId: string, input: PaymentInput, now: Date = new Date(),
): Promise<RunView> {
  await requirePerm(db, actor, RECORD, "recording a supplier payment");
  await settlePaymentRuns(db, now, [runId]);
  const mode = input.mode;
  if (!PAYMENT_MODES.includes(mode)) throw new MaterialsError("run_invalid", `"${String(mode)}" is not a payment mode`);
  const reference = input.reference?.trim() || null;
  if (mode !== "cash" && reference === null) {
    throw new MaterialsError("payment_reference_required", `a ${mode.toUpperCase()} payment carries its reference (${mode === "cheque" ? "the cheque number" : "the UTR"})`, { mode });
  }
  if (reference !== null && reference.length > 64) throw new MaterialsError("run_invalid", "the reference is longer than 64 characters");
  const today = istDay(now);
  const paidOn = input.paidOn ?? today;
  if (!isIsoDate(paidOn) || paidOn > today) throw new MaterialsError("run_invalid", `paid on "${paidOn}" is not a date on or before today`);
  await withTx(db, async (tx) => {
    const r = await lockRun(tx, runId);
    if (r.status !== "authorised") throw wrongStatus(r, "recording a payment", ["authorised"]);
    if (r.authorisedBy === actor.id) {
      throw new MaterialsError("authoriser_recording", `you authorised payment run ${r.runNo}; somebody else records it paid`, { runNo: r.runNo });
    }
    // The vendor's row lock serialises two payments to one vendor, so the day's cash is summed once.
    const [v] = await tx.select().from(vendors).where(eq(vendors.id, vendorId)).for("update");
    if (v === undefined) throw new MaterialsError("unknown_vendor", `vendor ${vendorId} not found`);
    if (v.firstPaymentAllowedAt !== null && v.firstPaymentAllowedAt > now) {
      throw new MaterialsError("vendor_cooling_off", `${v.tradeName ?? v.legalName}'s bank details changed; the first payment is allowed from ${v.firstPaymentAllowedAt.toISOString()}`, {
        firstPaymentAllowedAt: v.firstPaymentAllowedAt.toISOString(),
      });
    }
    const lines = await tx.select().from(supplierPaymentRunLines)
      .where(and(eq(supplierPaymentRunLines.runId, runId), eq(supplierPaymentRunLines.vendorId, vendorId), isNull(supplierPaymentRunLines.paymentId)));
    if (lines.length === 0) throw new MaterialsError("run_invalid", `payment run ${r.runNo} owes this vendor nothing unpaid`, { runNo: r.runNo });
    const amount = lines.reduce((s, l) => s + l.payPaise, 0);
    if (mode === "cash") {
      const [row] = await tx.select({ paise: sql<string>`coalesce(sum(${supplierPayments.amountPaise}), 0)` }).from(supplierPayments)
        .where(and(eq(supplierPayments.vendorId, vendorId), eq(supplierPayments.mode, "cash"), eq(supplierPayments.paidOn, paidOn)));
      const already = Number(row?.paise ?? 0);
      if (already + amount > CASH_PAYMENT_DAILY_LIMIT_PAISE) {
        throw new MaterialsError(
          "cash_limit_exceeded",
          `cash to one vendor in one day may not pass ₹${(CASH_PAYMENT_DAILY_LIMIT_PAISE / 100).toFixed(0)} (Income-tax Act s.40A(3)); `
            + `₹${(already / 100).toFixed(2)} already paid in cash on ${paidOn}, this is ₹${(amount / 100).toFixed(2)} — pay by bank`,
          { limitPaise: CASH_PAYMENT_DAILY_LIMIT_PAISE, alreadyPaise: already, amountPaise: amount, paidOn },
        );
      }
    }
    const bills = await tx.select().from(supplierBills).where(inArray(supplierBills.id, lines.map((l) => l.billId))).for("update");
    const paymentId = newId();
    const paymentNo = await nextEpisodeNo(tx, "supplier_payment", istDay(now));
    await tx.insert(supplierPayments).values({ id: paymentId, paymentNo, runId, vendorId, mode, reference, paidOn, amountPaise: amount, recordedBy: actor.id, recordedAt: now });
    const settled: { billId: string; billNo: string; paidPaise: number; creditPaise: number; status: "part_paid" | "paid" }[] = [];
    for (const l of lines) {
      const b = bills.find((x) => x.id === l.billId)!;
      if (b.status !== "accepted" && b.status !== "part_paid") {
        throw new MaterialsError("run_invalid", `bill ${b.billNo} is ${b.status}; it cannot be paid`, { billNo: b.billNo });
      }
      const paid = b.paidPaise + l.payPaise + l.creditPaise;
      if (paid > b.totalPaise) {
        throw new MaterialsError("run_invalid", `bill ${b.billNo} would be paid ₹${(paid / 100).toFixed(2)} against ₹${(b.totalPaise / 100).toFixed(2)}`, { billNo: b.billNo });
      }
      const status = paid === b.totalPaise ? "paid" : "part_paid";
      await tx.update(supplierBills).set({ paidPaise: paid, status, updatedBy: actor.id, updatedAt: now }).where(eq(supplierBills.id, b.id));
      await tx.update(supplierPaymentRunLines).set({ paymentId }).where(eq(supplierPaymentRunLines.id, l.id));
      b.paidPaise = paid;
      settled.push({ billId: b.id, billNo: b.billNo, paidPaise: l.payPaise, creditPaise: l.creditPaise, status });
    }
    await appendEvent(tx, supplierPaymentRecorded.make({
      occurredAt: now, actor, correlationId: paymentId,
      payload: { paymentId, paymentNo, runId, vendorId, mode, reference, paidOn, amountPaise: amount, bills: settled },
    }));
    const left = await tx.select({ id: supplierPaymentRunLines.id }).from(supplierPaymentRunLines)
      .where(and(eq(supplierPaymentRunLines.runId, runId), isNull(supplierPaymentRunLines.paymentId))).limit(1);
    if (left.length === 0) {
      await tx.update(supplierPaymentRuns).set({ status: "completed", completedAt: now, updatedBy: actor.id, updatedAt: now }).where(eq(supplierPaymentRuns.id, runId));
      const [n] = await tx.select({ n: sql<string>`count(*)` }).from(supplierPayments).where(eq(supplierPayments.runId, runId));
      await appendEvent(tx, paymentRunCompleted.make({ occurredAt: now, actor, correlationId: runId, payload: { ...header(r), payments: Number(n?.n ?? 1) } }));
    }
  });
  return (await readPaymentRun(db, runId))!;
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.fullName]));
}

function summaryOf(r: RunRow, vendorCount: number, billCount: number): RunSummary {
  return {
    id: r.id, runNo: r.runNo, status: r.status as RunStatus, source: r.source as "manual" | "agent", totalPaise: r.totalPaise,
    vendorCount, billCount, approvalId: r.approvalId, rejectionNote: r.rejectionNote, createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(), submittedAt: r.submittedAt?.toISOString() ?? null, authorisedBy: r.authorisedBy,
    authorisedAt: r.authorisedAt?.toISOString() ?? null, completedAt: r.completedAt?.toISOString() ?? null,
  };
}

async function readPaymentRun(db: Db, runId: string, now: Date = new Date()): Promise<RunView | undefined> {
  const [r] = await db.select().from(supplierPaymentRuns).where(eq(supplierPaymentRuns.id, runId));
  if (r === undefined) return undefined;
  const rows = await db.select({ l: supplierPaymentRunLines, b: supplierBills, v: vendors, p: supplierPayments }).from(supplierPaymentRunLines)
    .innerJoin(supplierBills, eq(supplierBills.id, supplierPaymentRunLines.billId))
    .innerJoin(vendors, eq(vendors.id, supplierPaymentRunLines.vendorId))
    .leftJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentRunLines.paymentId))
    .where(eq(supplierPaymentRunLines.runId, runId))
    .orderBy(asc(supplierBills.dueDate), asc(supplierBills.billNo));
  const today = istDay(now);
  const byVendor = new Map<string, RunVendorView>();
  for (const { l, b, v, p } of rows) {
    const g = byVendor.get(v.id) ?? {
      vendorId: v.id, vendorCode: v.code, vendorName: v.tradeName ?? v.legalName, msme: false,
      coolingOffUntil: v.firstPaymentAllowedAt !== null && v.firstPaymentAllowedAt > now ? v.firstPaymentAllowedAt.toISOString() : null,
      payPaise: 0, creditPaise: 0, lines: [],
      payment: p === null ? null : {
        paymentId: p.id, paymentNo: p.paymentNo, mode: p.mode as PaymentMode, reference: p.reference, paidOn: p.paidOn, amountPaise: p.amountPaise, recordedBy: p.recordedBy,
      },
    };
    g.msme = g.msme || b.msme;
    const paid = l.paymentId !== null;
    const prevPaid = b.paidPaise - (paid ? l.payPaise + l.creditPaise : 0);
    g.lines.push({
      id: l.id, billId: b.id, billNo: b.billNo, vendorBillNo: b.vendorBillNo, billDate: b.billDate, dueDate: b.dueDate, msme: b.msme,
      totalPaise: b.totalPaise, prevPaidPaise: prevPaid, creditPaise: l.creditPaise, payPaise: l.payPaise,
      remainingPaise: b.totalPaise - prevPaid - l.creditPaise - l.payPaise,
      overdueDays: b.dueDate === null ? 0 : Math.max(0, daysBetween(b.dueDate, today)), paid,
    });
    g.payPaise += l.payPaise;
    g.creditPaise += l.creditPaise;
    byVendor.set(v.id, g);
  }
  const vendorsOut = [...byVendor.values()].sort((a, b) => Number(b.msme) - Number(a.msme) || a.vendorName.localeCompare(b.vendorName));
  const ap = r.approvalId === null ? null : await getApproval(db, r.approvalId);
  const names = await namesOf(db, [r.createdBy, r.authorisedBy, r.cancelledBy, ap?.decidedBy ?? null, ...vendorsOut.map((v) => v.payment?.recordedBy ?? null)]);
  return {
    ...summaryOf(r, vendorsOut.length, rows.length), note: r.note, cancelReason: r.cancelReason, names, vendors: vendorsOut,
    approval: ap === null ? null : { status: ap.status, approverRole: ap.approverRole, requesterId: ap.requesterId, decidedBy: ap.decidedBy, decisionNote: ap.decisionNote },
  };
}

export async function getPaymentRun(db: Db, actor: Actor, runId: string, now: Date = new Date()): Promise<RunView> {
  await requirePayablesReader(db, actor);
  await settlePaymentRuns(db, now, [runId]);
  const r = await readPaymentRun(db, runId, now);
  if (r === undefined) throw new MaterialsError("unknown_payment_run", `payment run ${runId} not found`);
  return r;
}

export async function listPaymentRuns(db: Db, actor: Actor, filter: { statuses?: readonly RunStatus[]; limit?: number } = {}): Promise<RunSummary[]> {
  await requirePayablesReader(db, actor);
  await settlePaymentRuns(db);
  const rows = await db.select({
    r: supplierPaymentRuns,
    vendors: sql<string>`(select count(distinct ${supplierPaymentRunLines.vendorId}) from ${supplierPaymentRunLines} where ${supplierPaymentRunLines.runId} = ${supplierPaymentRuns.id})`,
    bills: sql<string>`(select count(*) from ${supplierPaymentRunLines} where ${supplierPaymentRunLines.runId} = ${supplierPaymentRuns.id})`,
  }).from(supplierPaymentRuns)
    .where(filter.statuses === undefined || filter.statuses.length === 0 ? undefined : inArray(supplierPaymentRuns.status, [...filter.statuses]))
    .orderBy(desc(supplierPaymentRuns.createdAt), desc(supplierPaymentRuns.id)).limit(Math.min(filter.limit ?? 100, 500));
  return rows.map((x) => summaryOf(x.r, Number(x.vendors), Number(x.bills)));
}
