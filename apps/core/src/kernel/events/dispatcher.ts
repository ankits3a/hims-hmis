import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { SubscriptionBus, DispatchedEvent } from "./subscriptions";

export async function runDispatchCycle(
  db: Db,
  bus: SubscriptionBus,
  batchSize = 100,
): Promise<number> {
  let delivered = 0;

  for (const { consumer, events: names, handler } of bus.consumers()) {
    await db.execute(
      sql`insert into event_cursors (consumer) values (${consumer}) on conflict do nothing`,
    );
    const cursorRows = (await db.execute(
      sql`select last_seq as "lastSeq" from event_cursors where consumer = ${consumer}`,
    )).rows as [{ lastSeq: number | string }];
    let lastSeq = Number(cursorRows[0]!.lastSeq);

    const rows = (await db.execute(sql`
      select seq, event_id as "eventId", name, payload,
             patient_id as "patientId", correlation_id as "correlationId"
      from events
      where seq > ${lastSeq} and name = any(${sql.param(names)}::text[])
      order by seq asc
      limit ${batchSize}
    `)).rows as unknown as DispatchedEvent[];

    for (const row of rows) {
      try {
        await handler({ ...row, seq: Number(row.seq) });
      } catch {
        break; // cursor stays; retried next cycle
      }
      lastSeq = Number(row.seq);
      delivered += 1;
      await db.execute(
        sql`update event_cursors set last_seq = ${lastSeq}, updated_at = now() where consumer = ${consumer}`,
      );
    }
  }

  return delivered;
}
