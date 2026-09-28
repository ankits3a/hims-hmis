import { eq } from "drizzle-orm";
import { invoices } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ GAP CLOSURE A3b — MEDICINE ON CREDIT, ONLY WHEN THE OWNER SAID SO ═══
 *
 * Owner ruling 2026-09-28: "nobody can issue credit except owner", whole hospital. The pharmacy's own
 * rule is money before the drug (`handover.ts`: an unsettled bill keeps the medicine at the counter).
 * The single exception is a bill billing issued ON CREDIT, and billing issues credit only against a
 * GRANTED `billing_credit_owner` approval for the exact amount on this dispense's draft
 * (`billing/invoices.ts`). So "credit extended AND an approval on the invoice" is the owner's yes,
 * read from the ledger, never from a flag the desk could send.
 *
 * Its own file, called with one line from `handOverDispense`, so the handover's other gates
 * (controlled drugs, the cold chain) and this one do not share a diff.
 */
export async function ownerCreditCovers(exec: Db | Tx, invoiceId: string): Promise<boolean> {
  const [row] = await exec
    .select({ creditExtended: invoices.creditExtended, approvalId: invoices.creditApprovalId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  return row !== undefined && row.creditExtended && row.approvalId !== null;
}
