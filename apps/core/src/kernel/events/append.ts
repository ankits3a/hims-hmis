import { newEventId, EventInput } from "@hmis/contracts";
import { sql } from "drizzle-orm";
import { events } from "../db/schema";
import type { Tx } from "../db/client";

export async function appendEvent(
  tx: Tx,
  input: EventInput,
): Promise<{ eventId: string; seq: number }> {
  const eventId = newEventId();
  const inserted = await tx
    .insert(events)
    .values({
      eventId,
      name: input.name,
      version: input.version,
      occurredAt: input.occurredAt,
      actorType: input.actor.type,
      actorId: input.actor.id,
      patientId: input.patientId,
      encounterId: input.encounterId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      module: input.module,
      payload: input.payload,
      siteId: input.siteId,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: events.idempotencyKey })
    .returning({ eventId: events.eventId, seq: events.seq });

  if (inserted.length > 0) return inserted[0]!;

  const existing = (await tx.execute(
    sql`select event_id as "eventId", seq from events where idempotency_key = ${input.idempotencyKey}`,
  )).rows as [{ eventId: string; seq: number }];
  return existing[0]!;
}
