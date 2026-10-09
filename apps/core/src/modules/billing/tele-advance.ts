import { feeServiceFor, FEE_LINE_ID } from "./charge-rules";
import { chargeRulesAt, loadBillingConfig } from "./config";
import { previewInvoice } from "./invoices";
import type { EncounterRow } from "../opd";
import type { Db } from "../../kernel/db/client";

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
