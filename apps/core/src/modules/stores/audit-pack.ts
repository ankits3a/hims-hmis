import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AuditPack, AuditPackFilter } from "./types";

/** STORES S2a (#1112) — RED-FIRST STUB. */
export async function storesAuditPack(_db: Db, _actor: Actor, _filter: AuditPackFilter, _now: Date = new Date()): Promise<AuditPack> {
  return Promise.reject(new Error("not built: stores S2a audit pack"));
}
