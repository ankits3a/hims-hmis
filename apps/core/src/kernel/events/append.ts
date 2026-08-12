import { newEventId, EventInput } from "@hmis/contracts";
import { eq } from "drizzle-orm";
import { events, eventIdempotency } from "../db/schema";
import type { Tx } from "../db/client";

export async function appendEvent(
  tx: Tx,
  input: EventInput,
): Promise<{ eventId: string; seq: number }> {
  const eventId = newEventId();

  // Claim the key first: on conflict the append becomes a no-op read, so no already-inserted
  // event row has to be undone with a savepoint inside the caller's transaction.
  if (input.idempotencyKey !== undefined) {
    const claimed = await tx
      .insert(eventIdempotency)
      .values({ idempotencyKey: input.idempotencyKey, eventId })
      .onConflictDoNothing({ target: eventIdempotency.idempotencyKey })
      .returning({ eventId: eventIdempotency.eventId });

    if (claimed.length === 0) {
      const existing = await tx
        .select({ eventId: eventIdempotency.eventId, seq: eventIdempotency.seq })
        .from(eventIdempotency)
        .where(eq(eventIdempotency.idempotencyKey, input.idempotencyKey));
      return { eventId: existing[0]!.eventId, seq: existing[0]!.seq! };
    }
  }

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
    .returning({ eventId: events.eventId, seq: events.seq });

  if (input.idempotencyKey !== undefined) {
    await tx
      .update(eventIdempotency)
      .set({ seq: inserted[0]!.seq })
      .where(eq(eventIdempotency.idempotencyKey, input.idempotencyKey));
  }

  return inserted[0]!;
}
