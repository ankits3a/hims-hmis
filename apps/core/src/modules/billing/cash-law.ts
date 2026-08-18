import { and, eq, sql } from "drizzle-orm";
import { receipts, receiptTenders } from "../../kernel/db/schema";
import { assertPaise } from "../tariff";
import { BillingError } from "./errors";
import { istDay } from "./time";
import type { BillingConfig } from "./config";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D7 — the C-2 cash law (§269ST / §139A), as CA-gated DATA rather than constants: warn,
 * block and PAN thresholds all arrive on `billing_config`, so a revised statutory anchor is a
 * config edit and never a code change. Nothing in this file decides policy; it reads the
 * patient's cash episode and compares it against whatever the config currently says.
 */

/** A tender exactly as the counter hands it in — the shape every money-in path takes. */
export type TenderMode = "cash" | "upi" | "card";
export type TenderInput = { mode: TenderMode; amountPaise: number; refText?: string };

/** What a refused cash acceptance carries to the HTTP body (BillingError.detail). */
export type CashThresholdDetail = { episodeCashPaise: number; thresholdPaise: number };

export type CashLawVerdict = {
  incomingCashPaise: number;
  priorCashPaise: number;
  episodeCashPaise: number; // prior + incoming — the number every threshold compares against
  warned: boolean; // Sigma + incoming reached the warn threshold; the caller emits cash_threshold.warned
};

/**
 * The C-2 episode grain: Sigma CASH tenders across every receipt this patient carries on ONE IST
 * day. ADVANCES ARE INCLUDED by construction — the aggregation reads receipts, not invoices, and
 * an advance receipt is the same row as a bill payment (D1), so cash taken with no invoice behind
 * it still counts. Non-cash tenders are excluded at the SQL level: UPI and card leave a banking
 * trail and are not what §269ST is aimed at (K20).
 */
export async function episodeCashPaise(exec: Db | Tx, patientId: string, at: Date): Promise<number> {
  const rows = await exec
    .select({ total: sql<string>`coalesce(sum(${receiptTenders.amountPaise}), 0)` })
    .from(receiptTenders)
    .innerJoin(receipts, eq(receiptTenders.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.patientId, patientId),
        eq(receipts.serviceDay, istDay(at)),
        eq(receiptTenders.mode, "cash"),
      ),
    );
  return Number(rows[0]!.total); // sum() over bigint arrives as numeric text
}

/**
 * D7's gate, run BEFORE a receipt's cash is accepted. Refuses at or above the block threshold
 * (`cash_threshold_blocked`) and demands PAN or Form 60 strictly above the PAN threshold
 * (`pan_required`); the warn threshold is not a refusal — it rides back on the verdict so the
 * caller can emit `cash_threshold.warned` alongside the receipt it did accept.
 *
 * Block is tested BEFORE PAN: an amount past the block threshold is past the PAN threshold too,
 * and the harder refusal is the honest one to report.
 *
 * A receipt that takes NO cash is never asked for a PAN and never trips warn or block. C-2
 * governs the acceptance of cash — a card-only receipt adds nothing to the episode, and refusing
 * it because the patient paid cash earlier in the day would refuse a transaction §269ST does not
 * reach.
 */
export async function assertCashAccepted(
  exec: Db | Tx,
  cfg: BillingConfig,
  input: { patientId: string; tenders: TenderInput[]; panNumber?: string; form60?: boolean; at: Date },
): Promise<CashLawVerdict> {
  let incomingCashPaise = 0;
  for (const tender of input.tenders) {
    if (tender.mode !== "cash") continue;
    assertPaise(tender.amountPaise, "cash tender amount");
    incomingCashPaise += tender.amountPaise;
  }
  const priorCashPaise = await episodeCashPaise(exec, input.patientId, input.at);
  const episode = priorCashPaise + incomingCashPaise;
  if (incomingCashPaise === 0) {
    return { incomingCashPaise, priorCashPaise, episodeCashPaise: episode, warned: false };
  }

  if (episode >= cfg.cashBlockPaise) {
    const detail: CashThresholdDetail = { episodeCashPaise: episode, thresholdPaise: cfg.cashBlockPaise };
    throw new BillingError(
      "cash_threshold_blocked",
      `cash episode ${String(episode)}p reaches the block threshold ${String(cfg.cashBlockPaise)}p`,
      detail,
    );
  }

  const identified = (input.panNumber ?? "").trim() !== "" || input.form60 === true;
  if (episode > cfg.panThresholdPaise && !identified) {
    const detail: CashThresholdDetail = { episodeCashPaise: episode, thresholdPaise: cfg.panThresholdPaise };
    throw new BillingError(
      "pan_required",
      `cash episode ${String(episode)}p exceeds the PAN threshold ${String(cfg.panThresholdPaise)}p — PAN or Form 60 is required`,
      detail,
    );
  }

  return { incomingCashPaise, priorCashPaise, episodeCashPaise: episode, warned: episode >= cfg.cashWarnPaise };
}
