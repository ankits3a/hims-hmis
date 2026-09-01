import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

/**
 * RC-1 T3 / D2 — WHO NEEDS TO KNOW THE MOMENT A FEE IS COVERED.
 *
 * The mirror of `registerConsultStartGuard`, pointed the other way: OPD registers a hook here
 * (its `queue.fee_status_changed` board flip), and billing calls every hook INSIDE the transaction
 * that moved the fee — settlement at issue, credit extension at issue, a later allocation that
 * closes the invoice, AND (RC-3 T3) the three writers that move it back OUT. The hook receives the tx so its event rides the same commit as the money:
 * a board that flipped for a rollback would be lying to the hall.
 *
 * The seam is keyed and idempotent under re-registration for the same reason the guard registry
 * is: a second Nest testing module in one process must not double-register.
 */
/**
 * RC-3 T3 / D4 — M3. The three ways money ARRIVES and the three ways it LEAVES.
 *
 * RC-1 shipped only the arriving three, which is why nothing could un-flip the board: the seam had
 * no vocabulary for a reversal, so the writers that perform one had nothing to call. The hook
 * re-derives the actual status from `encounterFeeStatuses` either way — `via` says what HAPPENED,
 * never what the status IS, and conflating the two is how a caller ends up asserting a state it did
 * not check.
 */
export type FeeStatusVia =
  | "invoice" | "credit_extended" | "allocation"
  | "allocation_reversed" | "receipt_entered_in_error" | "credit_note";
export type FeeStatusHook = (
  tx: Tx,
  actor: Actor,
  info: { encounterId: string; invoiceId: string; via: FeeStatusVia },
  now: Date,
) => Promise<void>;

const hooks = new Map<string, FeeStatusHook>();

export function registerFeeStatusHook(key: string, hook: FeeStatusHook): () => void {
  hooks.set(key, hook);
  return () => {
    hooks.delete(key);
  };
}

/** Called by the settle paths. Hooks run inside the caller's transaction; a hook that throws aborts the settle — deliberately, the same one-commit rule as the money itself. */
export async function emitFeeStatusChanged(
  tx: Tx,
  actor: Actor,
  info: { encounterId: string; invoiceId: string; via: FeeStatusVia },
  now: Date,
): Promise<void> {
  for (const hook of hooks.values()) {
    await hook(tx, actor, info, now);
  }
}
