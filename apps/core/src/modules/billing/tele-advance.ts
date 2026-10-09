import { feeServiceFor, FEE_LINE_ID } from "./charge-rules";
import { chargeRulesAt, loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { issueInvoice, previewInvoice } from "./invoices";
import type { EncounterRow } from "../opd";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ WHAT A CONSULTATION WOULD COST THIS PATIENT ON A DATE, BEFORE ANY VISIT EXISTS ═══
 *
 * Owner 2026-10-09: *"Fee: tele-call costs same as in-person visit."* A tele-call is paid before
 * its slot, when there is no encounter to quote against — and every other pricer here
 * (`feeQuote`, `newConsultFeePaise`) starts from one. This is the same two steps without it: the
 * charge rule picks the service for the visit type (null is the free branch — a revisit inside its
 * window, or the consultation fee switched off), and the counter's own pricer prices that one line
 * for that patient, member benefits included. A new function; no existing signature changed.
 */
export async function consultFeeAt(
  db: Db, input: { patientId: string; visitType: string; at: Date },
): Promise<{ feeServiceId: string | null; paise: number }> {
  const cfg = await loadBillingConfig(db);
  const rules = await chargeRulesAt(db, cfg.chargeRules, input.at);
  const feeServiceId = feeServiceFor({ visitType: input.visitType, openedAt: input.at } as EncounterRow, rules);
  if (feeServiceId === null) return { feeServiceId: null, paise: 0 };
  const priced = await previewInvoice(db, {
    patientId: input.patientId, lines: [{ lineId: FEE_LINE_ID, serviceId: feeServiceId, qty: 1 }],
  }, input.at);
  return { feeServiceId, paise: priced.totals.netPayablePaise };
}

/**
 * ═══ THE CONSULTATION INVOICE FOR A FEE THE PATIENT HAS ALREADY PAID (owner 2026-10-09) ═══
 *
 * *"Bill at slot time: automatic; receipt already names the cashier."* and — the brief's slice 2d —
 * the amount paid is honoured whatever the price list says by then. One fee line, priced AT THE
 * QUOTE the appointment was stamped with (`prepaidUnitPaise`), settled from the advance receipt
 * that met it. The invoice names the actor it is handed (the system); the receipt keeps its cashier.
 *
 * ON THE CALLER'S TRANSACTION. `issueInvoice` is called with the transaction standing in for the
 * database — the arrangement `visit-move.ts` uses for a department move — so the invoice, its
 * allocation and whatever the caller wrote beside them commit together or not at all. A refusal is
 * THROWN; nothing here swallows one.
 *
 * Returns null — and raises nothing — when no consultation fee applies now (a free follow-up, the
 * consultation fee switched off) or the priced line comes to nothing. A NEW function: no existing
 * billing signature changed.
 */
export async function issuePrepaidConsultInvoice(
  tx: Tx, actor: Actor,
  input: { draftId: string; patientId: string; encounterId: string; visitType: string; receiptId: string; quotePaise: number },
  now: Date = new Date(),
): Promise<{ invoiceId: string; invoiceNo: string; netPayablePaise: number } | null> {
  const db = tx as unknown as Db;
  const cfg = await loadBillingConfig(db);
  const rules = await chargeRulesAt(db, cfg.chargeRules, now);
  const feeServiceId = feeServiceFor({ visitType: input.visitType, openedAt: now } as EncounterRow, rules);
  if (feeServiceId === null || input.quotePaise <= 0) return null;
  const lines = [{ lineId: FEE_LINE_ID, serviceId: feeServiceId, qty: 1, prepaidUnitPaise: input.quotePaise }];
  const priced = await previewInvoice(db, { encounterId: input.encounterId, patientId: input.patientId, lines }, now);
  const net = priced.totals.netPayablePaise;
  if (net <= 0) return null;
  if (net > input.quotePaise) {
    // Never reached while a consultation is exempt of tax; refused loudly rather than left part-paid.
    throw new BillingError("unsettled_issue_refused", `the prepaid consultation line comes to ${String(net)}p against ${String(input.quotePaise)}p paid`, { remainderPaise: net - input.quotePaise });
  }
  const issued = await issueInvoice(db, actor, {
    draftId: input.draftId, patientId: input.patientId, encounterId: input.encounterId, lines,
    settleFromReceipts: [{ receiptId: input.receiptId, amountPaise: net }],
  }, now);
  return { invoiceId: issued.invoiceId, invoiceNo: issued.invoiceNo, netPayablePaise: net };
}
