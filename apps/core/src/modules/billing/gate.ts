import { and, eq, inArray } from "drizzle-orm";
import { enteredInErrorMarks, invoiceLines, invoices } from "../../kernel/db/schema";
import { feeServiceFor } from "./charge-rules";
import { loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { invoiceSettlement } from "./invoices";
import type { ConsultStartGuard } from "../opd";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D8 — the pay-before-consult gate, billing's half of the dependency-inverted hook.
 *
 * OPD owns the registry and the thrown `consult_gate_refused` (consultation.ts); this file only
 * ever returns a VERDICT. That seam is deliberate: a `BillingError` raised inside an OPD route
 * would surface as a 500 instead of the 409 the counter screen expects, so every billing failure
 * reachable from here — a missing config row included — is converted to a not-ok verdict carrying
 * its own code, and nothing else crosses.
 */

/**
 * The registry key billing registers under. T11's `billing.module.ts` makes the call itself —
 * `registerConsultStartGuard(BILLING_FEE_GATE_KEY, feeGate)` — and its e2e proves the wiring over
 * real HTTP. This file deliberately ships no register-me wrapper: the shipped ESLint
 * module-isolation rule forbids any file under `src/modules/**` from importing another module's
 * internals, so nothing here could test one, and an untested wrapper is worse than no wrapper.
 */
export const BILLING_FEE_GATE_KEY = "billing_fee_gate";

/** Which of these invoices carry an `entered-in-error` mark (the invoices.ts reader's shape). */
async function enteredInErrorInvoiceIds(exec: Db | Tx, invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const rows = await exec
    .select({ docId: enteredInErrorMarks.docId })
    .from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, "invoice"), inArray(enteredInErrorMarks.docId, invoiceIds)));
  return new Set(rows.map((r) => r.docId));
}

/**
 * Is the encounter's consultation fee actually paid for? A non-EIE invoice for THIS encounter
 * carrying the mapped fee line, and that invoice either settled (D1's derived state — there is no
 * status column to read) or credit-extended (D2's credit lane: the money is owed, the charge was
 * raised, and the patient may be seen).
 */
async function feeCovered(exec: Db | Tx, encounterId: string, feeServiceId: string): Promise<boolean> {
  const rows = await exec
    .select({ id: invoices.id, creditExtended: invoices.creditExtended })
    .from(invoices)
    .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
    .where(and(eq(invoices.encounterId, encounterId), eq(invoiceLines.serviceId, feeServiceId)));
  // The join repeats an invoice once per matching line; the ledger below cares about documents.
  const byId = new Map(rows.map((r) => [r.id, r.creditExtended] as const));
  if (byId.size === 0) return false;
  const dead = await enteredInErrorInvoiceIds(exec, [...byId.keys()]);
  for (const [invoiceId, creditExtended] of byId) {
    if (dead.has(invoiceId)) continue;
    if (creditExtended) return true;
    if ((await invoiceSettlement(exec, invoiceId)).state === "settled") return true;
  }
  return false;
}

/**
 * The guard OPD calls. `revisit` is FREE and passes with no invoice at all (spec:224) — the check
 * is never a bare "does this encounter have an invoice", which is why the branch is resolved
 * BEFORE anything is read from the ledger.
 */
export const feeGate: ConsultStartGuard = async (db, encounter) => {
  try {
    const cfg = await loadBillingConfig(db);
    const feeServiceId = feeServiceFor(encounter, cfg.chargeRules);
    if (feeServiceId === null) return { ok: true }; // the free branch
    if (await feeCovered(db, encounter.id, feeServiceId)) return { ok: true };
    return {
      ok: false,
      code: "fee_unsettled",
      detail: { encounterId: encounter.id, visitType: encounter.visitType, feeServiceId },
    };
  } catch (e) {
    // Data, never exceptions, across the seam (D8 / self-review 5).
    if (e instanceof BillingError) return { ok: false, code: e.code, detail: e.detail };
    throw e;
  }
};
