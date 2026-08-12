import { ulid } from "ulid";

export function newEventId(): string {
  return ulid();
}

/** Entity ids (users, sessions, grants, …) share the event-id grammar: one ULID everywhere. */
export function newId(): string {
  return ulid();
}
