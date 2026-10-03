import { and, eq, inArray } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { dispenseTakenOver } from "./events";
import { PharmacyError } from "./errors";
import { getDispense, getDispenseRow } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DispenseView } from "./queue";

/**
 * ═══ TAKE OVER A COLLEAGUE'S TICKET (owner 2026-10-03) ═══
 *
 * A pharmacist claimed a ticket, added medicines, and left the desk; the patient is still at the window.
 * DECIDED (standard hospital pharmacy practice: the counter is shared, the ticket is not abandoned): any
 * holder of `pharmacy.dispense.place` takes it over with a reason, at any stage before hand-over —
 * claimed, verified, picked or billed. The lines, picks, reservations and bill stay as they are; only the
 * holder changes. The write is conditional on the holder it read, so two takers cannot both win, and the
 * `dispense.taken_over` event names who it came from, who has it now and why.
 */
export const TAKEABLE_STATUSES = ["claimed", "verified", "picked", "billed"] as const;

export async function takeOverDispense(db: Db, actor: Actor, dispenseId: string, reason: string, now: Date): Promise<DispenseView> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "a ticket is taken over by a person");
  const why = reason.trim();
  if (why.length < 3) throw new PharmacyError("reason_required", "taking over a colleague's ticket records why");
  const d = await getDispenseRow(db, dispenseId);
  if (!(TAKEABLE_STATUSES as readonly string[]).includes(d.status) || d.claimedBy === null) {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}: only a held ticket before hand-over can be taken over`, { status: d.status });
  }
  if (d.claimedBy === actor.id) return getDispense(db, actor, d.id, now);
  const from = d.claimedBy;
  await withTx(db, async (tx) => {
    const won = await tx.update(pharmacyDispenses).set({ claimedBy: actor.id })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.claimedBy, from), inArray(pharmacyDispenses.status, [...TAKEABLE_STATUSES])))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while it was being taken over`);
    await appendEvent(tx, dispenseTakenOver.make({
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, fromUserId: from, toUserId: actor.id, status: d.status, reason: why },
    }));
  });
  return getDispense(db, actor, d.id, now);
}
