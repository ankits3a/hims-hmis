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
    let fee: string | null;
    try {
      fee = feeServiceFor(enc as EncounterRow, rules); // reads visitType only
    } catch (e) {
      // CLOSE MINOR-2: a visit type outside the OPD three (a hand-edited or imported row) is
      // UNKNOWN here, never a thrown 500 for the whole queue — and never an aborted settle when
      // this runs inside the flip hook. The gate makes the same conversion (gate.ts).
      if (e instanceof BillingError) continue;
      throw e;
    }
    feeById.set(enc.id, fee);
    if (fee === null) out.set(enc.id, "free");
  }
  const unresolved = encounters.filter((e) => {
    const fee = feeById.get(e.id);
    return fee !== null && fee !== undefined;
  });
  if (unresolved.length === 0) return out;
  const feeServiceIds = [...new Set([...feeById.values()].filter((v): v is string => v !== null))];

  const rows = await exec
    .select({
      id: invoices.id, encounterId: invoices.encounterId,
      creditExtended: invoices.creditExtended, netPayablePaise: invoices.netPayablePaise,
      serviceId: invoiceLines.serviceId,
    })
    .from(invoices)
    .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
    .where(and(
      inArray(invoices.encounterId, unresolved.map((e) => e.id)),
      inArray(invoiceLines.serviceId, feeServiceIds),
    ));
  /**
   * CLOSE M1 — WHICH fee service an invoice carries is tracked PER INVOICE, and the loop below
   * compares it against THIS encounter's own fee service. The first cut filtered the join on the
   * batch-wide UNION and never re-checked, so an encounter whose bill was written against the
   * OTHER visit type's consult line read `settled` here while `feeGate` (the authority) refused —
   * and the stamp changed with the queue's composition. The gate and the stamp now select
   * identically; only the batching differs.
   */
  const byInvoice = new Map<string, { encounterId: string | null; creditExtended: boolean; netPayablePaise: number; feeServices: Set<string> }>();
  for (const r of rows) {
    const inv = byInvoice.get(r.id);
    if (inv) inv.feeServices.add(r.serviceId);
    else byInvoice.set(r.id, { encounterId: r.encounterId, creditExtended: r.creditExtended, netPayablePaise: r.netPayablePaise, feeServices: new Set([r.serviceId]) });
  }
  const invoiceIds = [...byInvoice.keys()];
  const dead = await enteredInErrorDocIds(exec, "invoice", invoiceIds);
  const credited = await creditedByInvoice(exec, invoiceIds);
  const allocated = await allocatedByInvoice(exec, invoiceIds);

  for (const enc of unresolved) {
    const ownFee = feeById.get(enc.id)!;
    let status: EncounterFeeStatus = "unsettled";
    for (const [invoiceId, inv] of byInvoice) {
      if (inv.encounterId !== enc.id || dead.has(invoiceId) || !inv.feeServices.has(ownFee)) continue;
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
