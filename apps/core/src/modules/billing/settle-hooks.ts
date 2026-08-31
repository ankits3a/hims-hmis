import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

/**
 * RC-1 T3 / D2 — WHO NEEDS TO KNOW THE MOMENT A FEE IS COVERED.
 *
 * The mirror of `registerConsultStartGuard`, pointed the other way: OPD registers a hook here
 * (its `queue.fee_settled` board flip), and billing calls every hook INSIDE the transaction that
 * covered the fee — settlement at issue, credit extension at issue, or a later allocation that
 * closes the invoice. The hook receives the tx so its event rides the same commit as the money:
 * a board that flipped for a rollback would be lying to the hall.
 *
 * The seam is keyed and idempotent under re-registration for the same reason the guard registry
 * is: a second Nest testing module in one process must not double-register.
 */
export type FeeSettledVia = "invoice" | "credit_extended" | "allocation";
export type FeeSettledHook = (
  tx: Tx,
  actor: Actor,
  info: { encounterId: string; invoiceId: string; via: FeeSettledVia },
  now: Date,
) => Promise<void>;

const hooks = new Map<string, FeeSettledHook>();

export function registerFeeSettledHook(key: string, hook: FeeSettledHook): () => void {
  hooks.set(key, hook);
  return () => {
    hooks.delete(key);
  };
}

/** Called by the settle paths. Hooks run inside the caller's transaction; a hook that throws aborts the settle — deliberately, the same one-commit rule as the money itself. */
export async function emitFeeSettled(
  tx: Tx,
  actor: Actor,
  info: { encounterId: string; invoiceId: string; via: FeeSettledVia },
  now: Date,
): Promise<void> {
  for (const hook of hooks.values()) {
    await hook(tx, actor, info, now);
  }
}
