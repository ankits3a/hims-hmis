import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TicketTimeline } from "./types";

/** STORES S2a (#1112) — RED-FIRST STUB. */
export async function ticketTimeline(_db: Db, _actor: Actor, _indentId: string): Promise<TicketTimeline> {
  return Promise.reject(new Error("not built: stores S2a timeline"));
}
