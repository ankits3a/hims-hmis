import { ulid } from "ulid";
export function newEventId(): string {
  return ulid();
}
