import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { sodPairs } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { sodViolationBlocked } from "./events";
import type { Db } from "../db/client";

export const SOD_PAIR_SEED: { pairKey: string; description: string }[] = [
  { pairKey: "requester_approver", description: "Requester vs approver of any approvals-engine item" },
  { pairKey: "cashier_refund_approver", description: "Cashier vs refund/void approver" },
  { pairKey: "po_approver_grn_receiver", description: "PO approver vs GRN receiver" },
  { pairKey: "stock_custodian_cycle_counter", description: "Stock custodian vs cycle counter (incl. ward sub-stores)" },
  { pairKey: "narcotics_issuer_witness", description: "Narcotics issuer vs witness" },
  { pairKey: "payout_preparer_payout_approver", description: "Payout preparer vs payout approver" },
  { pairKey: "workflow_drafter_activator", description: "Workflow-definition drafter vs activator" },
  { pairKey: "quality_auditor_audited_station", description: "Quality auditor vs audited-station holder for that audit" },
  { pairKey: "downtime_declarer_cash_reconciler", description: "Downtime declarer vs downtime-cash reconciler" },
];

export async function seedSodPairs(db: Db): Promise<void> {
  for (const pair of SOD_PAIR_SEED) {
    await db
      .insert(sodPairs)
      .values(pair)
      .onConflictDoUpdate({ target: sodPairs.pairKey, set: { description: pair.description } });
  }
}

export class SodViolationError extends Error {
  constructor(readonly pairKey: string) {
    super(`segregation-of-duties violation: ${pairKey}`);
    this.name = "SodViolationError";
  }
}

export async function assertNotSodPair(
  db: Db,
  pairKey: string,
  actorA: Actor,
  actorB: Actor,
): Promise<void> {
  const known = await db.select({ pairKey: sodPairs.pairKey }).from(sodPairs).where(eq(sodPairs.pairKey, pairKey));
  if (known.length === 0) throw new Error(`unknown SoD pair key: ${pairKey}`);
  if (actorA.type !== actorB.type || actorA.id !== actorB.id) return;

  // Own transaction on `db`, never the caller's tx: the block must survive the caller's rollback.
  await withTx(db, (tx) =>
    appendEvent(
      tx,
      sodViolationBlocked.make({
        actor: actorA,
        payload: {
          pairKey,
          actorAType: actorA.type,
          actorAId: actorA.id,
          actorBType: actorB.type,
          actorBId: actorB.id,
        },
      }),
    ),
  );
  throw new SodViolationError(pairKey);
}
