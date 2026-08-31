import { and, eq, inArray } from "drizzle-orm";
import { invoiceLines, invoices } from "../../kernel/db/schema";
import { feeServiceFor } from "./charge-rules";
import { loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { allocatedByInvoice, creditedByInvoice, enteredInErrorDocIds } from "./receipts";
import { settlementState } from "./settlement";
import type { EncounterRow } from "../opd";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * RC-1 T3 / D1 — THE TOKEN'S PAID STAMP IS A PROJECTION OF THE INVOICE LEDGER, NEVER A COLUMN.
 *
 * The same derivation `feeGate` makes, batched for a queue read: `free` (the revisit branch —
 * spec:224's lawful exit), `settled` (D1's derived state), `credit` (the credit-extended exit),
 * `unsettled` (everything else). The queue view renders it; nothing writes it; it cannot drift
 * from the money because it IS the money, read.
 *
 * Batched on purpose: `listQueue` carries a CI perf budget, so this runs a FIXED number of
 * queries however long the queue is — one invoice+line join, then the three grouped ledger
 * readers `receipts.ts` already carries.
 *
 * An UNCONFIGURED billing module (no `billing_config` row, no charge rules) returns an EMPTY map
 * — status UNKNOWN, rendered as nothing. A hospital that has not configured billing has no fee
 * for a stamp to be a fact about, and inventing `unsettled` there would paint every token amber
 * on day one of commissioning.
 */
export type EncounterFeeStatus = "free" | "settled" | "credit" | "unsettled";

export async function encounterFeeStatuses(
  exec: Db | Tx,
  encounters: Pick<EncounterRow, "id" | "visitType">[],
): Promise<Map<string, EncounterFeeStatus>> {
  const out = new Map<string, EncounterFeeStatus>();
  if (encounters.length === 0) return out;

  let rules;
  try {
    rules = (await loadBillingConfig(exec)).chargeRules;
  } catch (e) {
    if (e instanceof BillingError) return out; // unconfigured — status unknown, not amber
    throw e;
  }

  const feeById = new Map<string, string | null>();
  for (const enc of encounters) {
    feeById.set(enc.id, feeServiceFor(enc as EncounterRow, rules)); // reads visitType only
    if (feeById.get(enc.id) === null) out.set(enc.id, "free");
  }
  const unresolved = encounters.filter((e) => feeById.get(e.id) !== null);
  if (unresolved.length === 0) return out;
  const feeServiceIds = [...new Set([...feeById.values()].filter((v): v is string => v !== null))];

  const rows = await exec
    .select({
      id: invoices.id, encounterId: invoices.encounterId,
      creditExtended: invoices.creditExtended, netPayablePaise: invoices.netPayablePaise,
    })
    .from(invoices)
    .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
    .where(and(
      inArray(invoices.encounterId, unresolved.map((e) => e.id)),
      inArray(invoiceLines.serviceId, feeServiceIds),
    ));
  // The join repeats an invoice once per matching line; everything below cares about documents.
  const byInvoice = new Map(rows.map((r) => [r.id, r] as const));
  const invoiceIds = [...byInvoice.keys()];
  const dead = await enteredInErrorDocIds(exec, "invoice", invoiceIds);
  const credited = await creditedByInvoice(exec, invoiceIds);
  const allocated = await allocatedByInvoice(exec, invoiceIds);

  for (const enc of unresolved) {
    let status: EncounterFeeStatus = "unsettled";
    for (const [invoiceId, inv] of byInvoice) {
      if (inv.encounterId !== enc.id || dead.has(invoiceId)) continue;
      if (inv.creditExtended) {
        if (status === "unsettled") status = "credit";
        continue;
      }
      const s = settlementState(inv.netPayablePaise, credited.get(invoiceId) ?? 0, allocated.get(invoiceId) ?? 0);
      if (s.state === "settled") {
        status = "settled";
        break;
      }
    }
    out.set(enc.id, status);
  }
  return out;
}
