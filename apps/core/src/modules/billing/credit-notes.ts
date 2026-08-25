import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  allocations, creditNoteLines, creditNotes, enteredInErrorMarks, invoiceLines, invoices,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { getApproval } from "../../kernel/approvals/worklist";
import { releaseRedemptions, restoreEntitlements } from "../membership";
import { assertPaise, DISCOUNT_CATEGORIES, loadRuleConfig, percentAmount, roundTotalToRupee } from "../tariff";
import { loadBillingConfig } from "./config";
import { creditShare } from "./credit-share";
import { BillingError } from "./errors";
import { creditNoteIssued } from "./events";
import { invoiceSettlement } from "./invoices";
import { nextDocNo } from "./series";
import type { CreditShare } from "./credit-share";
import type { InvoiceLineRow } from "./invoices";
import type { Settlement } from "./settlement";
import type { ManualCaps } from "../tariff";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D4 — credit notes: the ONLY way an issued invoice's receivable shrinks. Three kinds,
 * one document: `refund` (the paper a refund voucher draws on), `clearance_discount` (the legacy
 * Dues Clear discount, on the ADJUSTMENT side of §7's "the two never mix" seam) and `correction`
 * (entered-in-error grammar for an invoice, which is immutable and can never be edited).
 *
 * THE RULE THIS FILE EXISTS FOR — cumulative pro-ration (D4). Shares are derived from the STORED
 * invoice line and never re-priced: for a line of qty n on which qty p is already credited, a
 * further credit of qty k takes, for each money field F,
 *     share = divHalfUp(F x (p + k), n) - divHalfUp(F x p, n)
 * so the remainder lands on the LAST step and cumulative credits exhaust the line EXACTLY. The
 * naive per-refund `divHalfUp(F x k, n)` leaks paise (100 over three refunds pays 33 + 33 + 33 =
 * 99 — Book B-05, mutant M-C1). `creditShare` (T2, pure) is the single implementation; nothing
 * here re-derives a share.
 *
 * Rounding follows D3 exactly: `roundTotalToRupee` is applied ONCE per document, to THIS credit
 * note's own raw total, and never to the per-line shares. Two consequences, both intended and
 * both asserted in the tests: the SHARES exhaust the line to the paise, and each note carries its
 * own §170 rounding, so the sum of the notes' rounded `net_paise` differs from the line's stored
 * net by exactly the notes' roundings.
 *
 * Every reader this file needs lives in this file: `settlement.ts` is swept by T2's
 * `billing-purity.test.ts` for `from "../../kernel` and `await `, so no SQL reader can live there
 * (the T5/T6 standing resolution — ledger readers live in the writer file that owns their rows).
 * `credit_notes` and `credit_note_lines` are exactly this file's rows.
 */

/** The permission the credit-note lane needs (D4). T11's manifest declares it. */
export const CREDIT_NOTE_ISSUE_PERMISSION = "billing.credit_note.issue";

/** The clearance lane's approval, and the subject it binds to: the ORIGINAL invoice (D4). */
export const CLEARANCE_APPROVAL_TYPE = "billing_clearance_discount";
export const CLEARANCE_APPROVAL_SUBJECT = "billing_clearance";

export type CreditNoteRow = typeof creditNotes.$inferSelect;
export type CreditNoteLineRow = typeof creditNoteLines.$inferSelect;
export type CreditNoteKind = "refund" | "clearance_discount" | "correction";

const creditNoteLineSchema = z.object({ invoiceLineId: z.string().min(1), qty: z.number().int().positive() });

/**
 * The boundary shape. `askPaise` is deliberately typed `z.number()` and NOT `z.number().int()`:
 * the integer belt on an externally supplied amount is `assertPaise` (Global Constraints — the
 * M3 belt at the module boundary), and a schema that quietly refused a fractional ask first would
 * take that belt out of the code path it is there to guard.
 */
const issueCreditNoteSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("refund"),
    invoiceId: z.string().min(1),
    reason: z.string().min(1),
    lines: z.array(creditNoteLineSchema).min(1),
  }),
  z.object({
    kind: z.literal("clearance_discount"),
    invoiceId: z.string().min(1),
    reason: z.string().min(1),
    discountCategory: z.enum(DISCOUNT_CATEGORIES), // D-8 category, MANDATORY on this lane
    askPaise: z.number(),
    approvalId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("correction"),
    invoiceId: z.string().min(1),
    reason: z.string().min(1),
    // Optional: a correction that names no lines covers the whole remainder by construction. When
    // it DOES name them they must add up to that same remainder — a partial "correction" is a
    // refund or a clearance discount by definition (`correction_must_exhaust`).
    lines: z.array(creditNoteLineSchema).min(1).optional(),
  }),
]);

export type IssueCreditNoteInput = z.infer<typeof issueCreditNoteSchema>;

export type IssueCreditNoteResult = {
  creditNoteId: string;
  creditNoteNo: string;
  invoiceId: string;
  kind: CreditNoteKind;
  grossPaise: number;
  discountPaise: number;
  taxableBasePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  rawTotalPaise: number; // base + the two heads, BEFORE this note's own §170 rounding
  roundingPaise: number;
  netPaise: number;
  settlement: Settlement; // the invoice's settlement AFTER this note
};

// ---------------------------------------------------------------------------------------------
// Readers. Each reads ONE table at a time: drizzle renders a column interpolated into a `sql`
// SELECT FIELD without its table qualifier, so a two-table query written that way can silently
// compare the wrong columns (the caveat T5 and T6 recorded on the same aggregates).
// ---------------------------------------------------------------------------------------------

async function enteredInErrorDocIds(exec: Db | Tx, docType: string, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const rows = await exec
    .select({ docId: enteredInErrorMarks.docId })
    .from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, docType), inArray(enteredInErrorMarks.docId, docIds)));
  return new Set(rows.map((r) => r.docId));
}

/** Sigma non-EIE credit-note nets against one invoice (D1). */
async function creditedPaiseOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({ id: creditNotes.id, netPaise: creditNotes.netPaise })
    .from(creditNotes)
    .where(eq(creditNotes.invoiceId, invoiceId));
  if (rows.length === 0) return 0;
  const dead = await enteredInErrorDocIds(exec, "credit_note", rows.map((r) => r.id));
  let total = 0;
  for (const row of rows) {
    if (!dead.has(row.id)) total += row.netPaise;
  }
  return total;
}

/** Effective allocation against one invoice: Sigma apply - Sigma reverse (D1). */
async function allocatedPaiseOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({
      total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
    })
    .from(allocations)
    .where(eq(allocations.invoiceId, invoiceId));
  return Number(rows[0]!.total); // sum() over bigint arrives as numeric text
}

/**
 * The money a credit note has freed for repayment (D4's last bullet): credited + allocated beyond
 * the net payable. Floored at zero — an invoice that is merely settled owes nobody anything. This
 * is the pot T8's `invoice_refund` vouchers draw on; guard 1 caps them at the money actually
 * RECEIVED, which is why this reader reports the surplus rather than authorising it.
 */
export async function refundableSurplusOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({ netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const row = rows[0];
  if (!row) throw new BillingError("unknown_invoice", `unknown invoice ${invoiceId}`);
  const coveredPaise = (await creditedPaiseOf(exec, invoiceId)) + (await allocatedPaiseOf(exec, invoiceId));
  const surplusPaise = coveredPaise - row.netPayablePaise;
  return surplusPaise > 0 ? surplusPaise : 0;
}

/** Qty already credited per invoice line, across every LIVE credit note on the invoice (D4's `p`). */
async function creditedQtyByLine(exec: Db | Tx, invoiceId: string): Promise<Map<string, number>> {
  const notes = await exec.select({ id: creditNotes.id }).from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId));
  if (notes.length === 0) return new Map();
  const dead = await enteredInErrorDocIds(exec, "credit_note", notes.map((n) => n.id));
  const live = notes.filter((n) => !dead.has(n.id)).map((n) => n.id);
  if (live.length === 0) return new Map();
  const rows = await exec
    .select({ invoiceLineId: creditNoteLines.invoiceLineId, qty: creditNoteLines.qty })
    .from(creditNoteLines)
    .where(inArray(creditNoteLines.creditNoteId, live));
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.invoiceLineId, (out.get(row.invoiceLineId) ?? 0) + row.qty);
  return out;
}

/**
 * Serializes credit notes against one invoice. Locking an immutable row is legal — 0012's trigger
 * forbids UPDATE and DELETE, not locks — and it is what makes the cumulative qty check and the
 * outstanding check plain in-transaction reads: a second writer cannot read this invoice's
 * credited totals until the first COMMITS. Same lock, same row, same order as the allocation
 * writers in `receipts.ts` (INVOICE first), so the two never deadlock against each other.
 */
async function lockInvoice(
  tx: Tx,
  invoiceId: string,
): Promise<{ id: string; patientId: string; encounterId: string | null; rawTotalPaise: number }> {
  const rows = await tx
    .select({
      id: invoices.id, patientId: invoices.patientId,
      encounterId: invoices.encounterId, rawTotalPaise: invoices.rawTotalPaise,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");
  const row = rows[0];
  if (!row) throw new BillingError("unknown_invoice", `unknown invoice ${invoiceId}`);
  return row;
}

/** Check-on-execute: granted, and bound to THIS invoice, patient and amount (the T5 shape). */
async function assertGrantedApproval(
  db: Db,
  approvalId: string,
  expected: { typeKey: string; subjectType: string; subjectId: string; patientId: string; amountPaise: number },
): Promise<void> {
  const approval = await getApproval(db, approvalId);
  if (!approval || approval.status !== "granted") {
    throw new BillingError("approval_not_granted", `approval ${approvalId} is not granted`);
  }
  const bound =
    approval.typeKey === expected.typeKey &&
    approval.subjectType === expected.subjectType &&
    approval.subjectId === expected.subjectId &&
    approval.patientId === expected.patientId &&
    approval.amountPaise === expected.amountPaise;
  if (!bound) {
    throw new BillingError(
      "approval_subject_mismatch",
      `approval ${approvalId} does not bind to this ${expected.typeKey} request`,
      {
        expected,
        got: {
          typeKey: approval.typeKey, subjectType: approval.subjectType, subjectId: approval.subjectId,
          patientId: approval.patientId, amountPaise: approval.amountPaise,
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

type CreditStep = { line: InvoiceLineRow; addQty: number; share: CreditShare };

/** The qty-bearing lanes fold `creditShare` over the STORED lines — nothing is re-priced (D4). */
function foldSteps(steps: CreditStep[]): {
  grossPaise: number; discountPaise: number; taxableBasePaise: number; cgstPaise: number; sgstPaise: number;
} {
  const totals = { grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0 };
  for (const step of steps) {
    totals.grossPaise += step.share.grossPaise;
    totals.discountPaise += step.share.discountPaise;
    totals.taxableBasePaise += step.share.taxableBasePaise;
    totals.cgstPaise += step.share.cgstPaise;
    totals.sgstPaise += step.share.sgstPaise;
  }
  return totals;
}

/** Line asks folded by invoice line, so two entries for one line cannot each read a stale `p`. */
function askedQtyByLine(lines: { invoiceLineId: string; qty: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) out.set(line.invoiceLineId, (out.get(line.invoiceLineId) ?? 0) + line.qty);
  return out;
}

/**
 * D4. One transaction: lock the invoice, derive the shares from its STORED lines, check the lane's
 * governance, persist the note with its lines and append `credit_note.issued` — once, inside the
 * same transaction as the inserts, so the event can never describe a note that did not land.
 *
 * Credit notes never touch allocations (D4): money already received stays received, and the
 * surplus a credit note creates is repaid through T8's voucher path, never by rewriting the
 * ledger.
 */
export async function issueCreditNote(
  db: Db,
  actor: Actor,
  rawInput: IssueCreditNoteInput,
  now: Date = new Date(),
): Promise<IssueCreditNoteResult> {
  const input = issueCreditNoteSchema.parse(rawInput);
  const cfg = await loadBillingConfig(db);

  // The M1 lesson, clearance side (K25/M-C2): the caps come from the ENGINE'S OWN loader, which
  // honours `active` and the validity window — never from `listAdjustmentRules`, which returns
  // every row including the retired ones. One discount governance table in the hospital, read the
  // one way the engine reads it. `loadRuleConfig` takes `Db` and runs OUTSIDE the transaction,
  // exactly like `loadPricingContext` in `issueInvoice`.
  let manualCaps: ManualCaps = {};
  if (input.kind === "clearance_discount") {
    assertPaise(input.askPaise, "clearance ask"); // the M3 belt at OUR boundary
    if (input.askPaise === 0) {
      throw new BillingError("invalid_paise", "a clearance discount must credit a positive amount");
    }
    manualCaps = (await loadRuleConfig(db, now)).manualCaps;
  }

  return withTx(db, async (tx) => {
    const invoice = await lockInvoice(tx, input.invoiceId);
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))
      .orderBy(asc(invoiceLines.lineNo));
    const creditedQty = await creditedQtyByLine(tx, invoice.id);
    const byId = new Map(lines.map((line) => [line.id, line] as const));

    const steps: CreditStep[] = [];
    let discountCategory: string | null = null;
    let approvalId: string | null = null;
    let totals = { grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0 };

    if (input.kind === "clearance_discount") {
      // A clearance discount shrinks the RECEIVABLE — on an invoice with nothing outstanding it
      // would be a refund wearing a discount's clothes, and refunds are guarded elsewhere (D6).
      const before = await invoiceSettlement(tx, invoice.id);
      if (before.outstandingPaise <= 0) {
        throw new BillingError(
          "clearance_requires_outstanding",
          `invoice ${invoice.id} has nothing outstanding — a clearance discount here would be a refund`,
          { askedPaise: input.askPaise, outstandingPaise: before.outstandingPaise },
        );
      }
      if (input.askPaise > before.outstandingPaise) {
        throw new BillingError(
          "clearance_requires_outstanding",
          `${String(input.askPaise)}p exceeds the ${String(before.outstandingPaise)}p outstanding on this invoice`,
          { askedPaise: input.askPaise, outstandingPaise: before.outstandingPaise },
        );
      }

      // Caps are a percentage of the ORIGINAL invoice's raw total (D4). A category with no ACTIVE
      // cap row carries no authority at all, so its cap is zero and every ask is over it.
      const cap = manualCaps[input.discountCategory];
      const capPaise = cap === undefined ? 0 : percentAmount(invoice.rawTotalPaise, cap.maxBps);
      if (input.askPaise > capPaise) {
        throw new BillingError(
          "over_cap",
          `${String(input.askPaise)}p exceeds the ${String(capPaise)}p clearance cap for "${input.discountCategory}"`,
          {
            askedPaise: input.askPaise, capPaise, discountCategory: input.discountCategory,
            maxBps: cap?.maxBps ?? null, rawTotalPaise: invoice.rawTotalPaise,
          },
        );
      }
      const approvalAboveBps = cap?.approvalAboveBps ?? null;
      if (approvalAboveBps !== null && input.askPaise > percentAmount(invoice.rawTotalPaise, approvalAboveBps)) {
        if (input.approvalId === undefined) {
          throw new BillingError(
            "clearance_approval_required",
            `${String(input.askPaise)}p is above the approval threshold for "${input.discountCategory}"`,
            {
              askedPaise: input.askPaise, discountCategory: input.discountCategory,
              approvalAboveBps, thresholdPaise: percentAmount(invoice.rawTotalPaise, approvalAboveBps),
            },
          );
        }
        await assertGrantedApproval(db, input.approvalId, {
          typeKey: CLEARANCE_APPROVAL_TYPE,
          subjectType: CLEARANCE_APPROVAL_SUBJECT,
          subjectId: invoice.id,
          patientId: invoice.patientId,
          amountPaise: input.askPaise,
        });
      }
      discountCategory = input.discountCategory;
      approvalId = input.approvalId ?? null;
      // The clearance lane credits VALUE, not a line's tax: it is an adjustment agreed at the dues
      // counter, priced by nothing and pro-rated over no line (D4 — the adjustment side of the
      // seam). Its raw total is therefore its own ask, and its own §170 rounding applies below.
      totals = {
        grossPaise: input.askPaise, discountPaise: 0, taxableBasePaise: input.askPaise,
        cgstPaise: 0, sgstPaise: 0,
      };
    } else {
      const remaining = lines
        .map((line) => ({ line, remainingQty: line.qty - (creditedQty.get(line.id) ?? 0) }))
        .filter((r) => r.remainingQty > 0);

      let asked: Map<string, number>;
      if (input.kind === "correction") {
        // A correction is entered-in-error grammar for an immutable invoice: it must cover the
        // FULL remaining value of EVERY line still carrying one. Anything less is a refund or a
        // clearance discount, and those lanes have their own guards.
        if (remaining.length === 0) {
          throw new BillingError("correction_must_exhaust", `invoice ${invoice.id} has nothing left to correct`, {
            remainingLines: 0,
          });
        }
        const full = new Map(remaining.map((r) => [r.line.id, r.remainingQty] as const));
        if (input.lines !== undefined) {
          const claimed = askedQtyByLine(input.lines);
          for (const lineId of claimed.keys()) {
            if (!byId.has(lineId)) {
              throw new BillingError("unknown_line", `line ${lineId} is not on invoice ${invoice.id}`, { lineId });
            }
          }
          const exhausts =
            claimed.size === full.size && [...full].every(([lineId, qty]) => claimed.get(lineId) === qty);
          if (!exhausts) {
            throw new BillingError(
              "correction_must_exhaust",
              `a correction must cover the full remaining value of invoice ${invoice.id}`,
              { asked: [...claimed], remaining: [...full] },
            );
          }
        }
        asked = full;
      } else {
        asked = askedQtyByLine(input.lines);
      }

      for (const [lineId, addQty] of asked) {
        const line = byId.get(lineId);
        if (!line) {
          throw new BillingError("unknown_line", `line ${lineId} is not on invoice ${invoice.id}`, { lineId });
        }
        // `creditShare` owns the cumulative rule AND the `credit_exceeds_line` refusal (T2, pure).
        steps.push({ line, addQty, share: creditShare(line, creditedQty.get(lineId) ?? 0, addQty) });
      }
      totals = foldSteps(steps);
    }

    // §170, applied ONCE to THIS document's own raw total — never to the shares (D3/D4).
    const rawTotalPaise = totals.taxableBasePaise + totals.cgstPaise + totals.sgstPaise;
    const { roundedPaise, roundingPaise } = roundTotalToRupee(rawTotalPaise);

    const creditNoteId = newId();
    const creditNoteNo = await nextDocNo(tx, cfg, "credit_note", now);
    await tx.insert(creditNotes).values({
      id: creditNoteId,
      creditNoteNo,
      invoiceId: invoice.id,
      kind: input.kind,
      discountCategory,
      reason: input.reason,
      approvalId,
      issuedBy: actor.id,
      issuedAt: now,
      grossPaise: totals.grossPaise,
      discountPaise: totals.discountPaise,
      taxableBasePaise: totals.taxableBasePaise,
      cgstPaise: totals.cgstPaise,
      sgstPaise: totals.sgstPaise,
      roundingPaise,
      netPaise: roundedPaise,
    });
    for (const step of steps) {
      await tx.insert(creditNoteLines).values({
        id: newId(),
        creditNoteId,
        invoiceLineId: step.line.id,
        qty: step.addQty,
        grossPaise: step.share.grossPaise,
        discountPaise: step.share.discountPaise,
        taxableBasePaise: step.share.taxableBasePaise,
        cgstPaise: step.share.cgstPaise,
        sgstPaise: step.share.sgstPaise,
      });
    }

    await appendEvent(
      tx,
      creditNoteIssued.make({
        actor,
        payload: { creditNoteId, creditNoteNo, invoiceId: invoice.id, kind: input.kind, netPaise: roundedPaise },
        patientId: invoice.patientId,
        encounterId: invoice.encounterId ?? undefined,
        correlationId: invoice.id, // invoice-scoped emission (Global Constraints)
      }),
    );

    // ═══ PLAN 09 / DD9 — THE SYMMETRIC HALF, IN THE SAME TRANSACTION AS THE DOCUMENT ═══
    //
    // O-4 and C1/C2 hook onto the two append-shaped mechanisms this module already has, and this
    // is one of them. Two DIFFERENT rules, and the difference is the whole ruling:
    //
    //  · AN ENTITLEMENT COUNTER is restored for the LINES THIS NOTE CREDITS and for no others
    //    (C2 — "proportional to the reversed line, never to the invoice"). A partial credit note
    //    therefore hands back one line's free consult and leaves the other line's consumed. Every
    //    qty-bearing lane does it; a `clearance_discount` names no lines and restores nothing,
    //    which is right — it discounts VALUE at the dues counter and reverses no service.
    //
    //  · A COUPON REDEMPTION is released ONLY on a `correction` (O-4's narrowing). A partial
    //    refund releases nothing, "because the sale the coupon was consumed against really did
    //    happen". `correction_must_exhaust` above is what makes "a correction" and "the invoice's
    //    full value" the same sentence in this codebase: a correction covers the full remaining
    //    value of every line still carrying one, so after it every line is credited in full.
    //
    // NEITHER IS BEHIND `MEMBER_BENEFITS_ENABLED`, deliberately. That flag governs whether new
    // benefits are CONSUMED; a row already written must reverse whichever way the flag has since
    // been moved, or an operator turning the lane off would strand every member's counter at the
    // value it happened to hold that morning. With the lane never armed both calls are two
    // queries that find nothing.
    await restoreEntitlements(tx, actor, {
      invoiceId: invoice.id,
      invoiceLineIds: steps.map((step) => step.line.id),
      at: now,
      reason: `credit note ${creditNoteNo}`,
    });
    if (input.kind === "correction") {
      await releaseRedemptions(tx, actor, {
        invoiceId: invoice.id,
        trigger: "correction_credit_note",
        at: now,
        reason: `credit note ${creditNoteNo}`,
      });
    }

    return {
      creditNoteId,
      creditNoteNo,
      invoiceId: invoice.id,
      kind: input.kind,
      ...totals,
      rawTotalPaise,
      roundingPaise,
      netPaise: roundedPaise,
      settlement: await invoiceSettlement(tx, invoice.id),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function getCreditNote(
  exec: Db | Tx,
  creditNoteId: string,
): Promise<{ creditNote: CreditNoteRow; lines: CreditNoteLineRow[] } | null> {
  const rows = await exec.select().from(creditNotes).where(eq(creditNotes.id, creditNoteId));
  const creditNote = rows[0];
  if (!creditNote) return null;
  const lines = await exec.select().from(creditNoteLines).where(eq(creditNoteLines.creditNoteId, creditNoteId));
  return { creditNote, lines };
}

/**
 * Issue order. `credit_notes` carries no `seq` column (T1's schema — frozen), so the order key is
 * `issued_at` with the document number as the tie-break: the series counter is per-FY and strictly
 * increasing, so two notes stamped at one instant still read back in the order they were numbered.
 */
export async function listCreditNotes(
  exec: Db | Tx,
  filters: { invoiceId?: string } = {},
): Promise<CreditNoteRow[]> {
  return exec
    .select()
    .from(creditNotes)
    .where(filters.invoiceId === undefined ? undefined : eq(creditNotes.invoiceId, filters.invoiceId))
    .orderBy(asc(creditNotes.issuedAt), asc(creditNotes.creditNoteNo));
}
