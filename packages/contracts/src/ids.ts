import { ulid } from "ulid";

export function newEventId(): string {
  return ulid();
}

/** Entity ids (users, sessions, grants, …) share the event-id grammar: one ULID everywhere.
 * WARNING (audit A1, ledger §3.26): ulid() is NOT monotonic — two ids minted in the same
 * millisecond sort by 80 bits of randomness, never by insertion order. NEVER use `ORDER BY id`
 * where recency or insertion order matters; give the table a database-side monotone column
 * instead (bigserial `seq` — the events.seq / regulated_prices.seq precedent). */
export function newId(): string {
  return ulid();
}
