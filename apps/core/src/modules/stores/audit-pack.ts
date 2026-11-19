import { and, asc, eq, gt, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { events, roleAssignments, storeIndents, users } from "../../kernel/db/schema";
import { STORES_AUDIT_READ, holds, recordAct } from "./access";
import { StoresError } from "./errors";
import { STORES_ACT_EVENT } from "./events";
import type { AuditPack, AuditPackFilter, AuditPackRow } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S2a (#1112, decision 16) — THE AUDIT PACK: for a ticket, an item, a person or a store over a window,
 * every movement, approval, act and reversal in `seq` order, with the actor and their roles, as rows (print)
 * and CSV. It reads ONE stream, the events table: every Stores act (`stores.act_recorded`, S1's single event)
 * and every materials event (`material.*`: the indent's raise and issue, the transfer's issue and receipt, a
 * discrepancy, a GRN, a write-off). Filters combine with AND. Each export writes one `audit_export` act, after
 * the read, so an export never lists itself and the next export lists it.
 *
 * Roles are the actor's role keys as held when the pack is read (the role table keeps no history).
 */
export const AUDIT_PACK_MAX_ROWS = 5000;
/** Events are partitioned by `recorded_at`; a scan or a downtime entry is recorded after it occurred, never this long before. */
const RECORDED_BEFORE_OCCURRED_MS = 24 * 60 * 60_000;
/** A cell a spreadsheet would read as a formula starts with one of these; it is written with a leading quote. */
const FORMULA_START = /^[=+\-@\t\r]/;
const CSV_HEADER = ["seq", "at", "what", "actor", "actor_name", "roles", "store", "item", "ref", "before", "after", "reason"];

export function csvCell(v: unknown): string {
  const raw = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  const s = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function storesAuditPack(db: Db, actor: Actor, filter: AuditPackFilter, now: Date = new Date()): Promise<AuditPack> {
  if (!(await holds(db, actor, STORES_AUDIT_READ))) throw new StoresError("not_permitted", "the audit pack needs stores.audit.read", { permission: STORES_AUDIT_READ });
  if (!(filter.from instanceof Date) || !(filter.to instanceof Date) || Number.isNaN(filter.from.getTime()) || Number.isNaN(filter.to.getTime()) || filter.from > filter.to) {
    throw new StoresError("bad_window", "the window is from ≤ to");
  }

  const limit = filter.limit === undefined ? AUDIT_PACK_MAX_ROWS : Math.max(1, Math.min(AUDIT_PACK_MAX_ROWS, Math.trunc(filter.limit)));
  // Only Stores' own places: a materials event is in the pack when a Stores store is its source, destination or store.
  // Pharmacy's indents, transfers and GRNs share the stream and stay out of a Stores audit.
  const storesPlaces = sql`(select r.id from resources r where r.kind = 'store' and r.attributes->>'domain' = 'stores')`;
  const conds = [
    // The window first: `recorded_at` prunes the monthly partitions, `occurred_at` is the window asked for.
    gte(events.recordedAt, new Date(filter.from.getTime() - RECORDED_BEFORE_OCCURRED_MS)),
    gte(events.occurredAt, filter.from), lte(events.occurredAt, filter.to),
    or(eq(events.name, STORES_ACT_EVENT), and(like(events.name, "material.%"), or(
      sql`${events.payload}->>'fromResourceId' in ${storesPlaces}`, sql`${events.payload}->>'toResourceId' in ${storesPlaces}`,
      sql`${events.payload}->>'storeResourceId' in ${storesPlaces}`,
    ))),
  ];
  if (filter.afterSeq !== undefined) conds.push(gt(events.seq, filter.afterSeq));
  if (filter.ticketId !== undefined) {
    const [ind] = await db.select({ transferId: storeIndents.transferId }).from(storeIndents).where(eq(storeIndents.id, filter.ticketId));
    const refs = [filter.ticketId, ...(ind?.transferId == null ? [] : [ind.transferId])];
    conds.push(or(inArray(events.correlationId, refs), sql`${events.payload}->>'indentId' = ${filter.ticketId}`, sql`${events.payload}->>'refId' = ${filter.ticketId}`));
  }
  if (filter.itemId !== undefined) {
    conds.push(or(sql`${events.payload}->>'itemId' = ${filter.itemId}`, sql`${events.payload}->'lines' @> ${JSON.stringify([{ itemId: filter.itemId }])}::jsonb`));
  }
  if (filter.personId !== undefined) conds.push(eq(events.actorId, filter.personId));
  if (filter.storeId !== undefined) {
    const s = filter.storeId;
    conds.push(or(
      sql`${events.payload}->>'storeId' = ${s}`, sql`${events.payload}->>'fromResourceId' = ${s}`,
      sql`${events.payload}->>'toResourceId' = ${s}`, sql`${events.payload}->>'resourceId' = ${s}`,
      // S2c (#1119): a gate pass's act sits at OUT-ON-PASS and names its source store on each line.
      sql`${events.payload}->'lines' @> ${JSON.stringify([{ storeId: s }])}::jsonb`,
    ));
  }
  const page = await db.select().from(events).where(and(...conds)).orderBy(asc(events.seq)).limit(limit + 1);
  const truncated = page.length > limit;
  const found = truncated ? page.slice(0, limit) : page;
  const nextAfterSeq = truncated ? found.at(-1)!.seq : null;

  const people = [...new Set(found.map((e) => e.actorId))];
  const names = new Map(people.length === 0 ? [] : (await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.n] as const));
  const roles = new Map<string, string[]>();
  if (people.length > 0) {
    for (const r of await db.select({ u: roleAssignments.userId, k: roleAssignments.roleKey }).from(roleAssignments).where(inArray(roleAssignments.userId, people))) {
      roles.set(r.u, [...new Set([...(roles.get(r.u) ?? []), r.k])].sort());
    }
  }
  const rows: AuditPackRow[] = found.map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const str = (k: string): string | null => (typeof p[k] === "string" ? p[k] : null);
    const isAct = e.name === STORES_ACT_EVENT;
    return {
      seq: e.seq, at: e.occurredAt.toISOString(), what: isAct ? (str("act") ?? e.name) : e.name,
      actor: { id: e.actorId, name: names.get(e.actorId) ?? e.actorId, roles: roles.get(e.actorId) ?? [] },
      storeId: str("storeId") ?? str("fromResourceId") ?? str("resourceId"),
      itemId: str("itemId"),
      ref: str("refId") ?? str("indentId") ?? str("transferId") ?? e.correlationId,
      before: isAct ? (p.before ?? null) : null,
      after: isAct ? (p.after ?? null) : (p.lines ?? p.gaps ?? null),
      reason: str("reason"),
    };
  });
  const csv = [CSV_HEADER.join(","), ...rows.map((r) => [
    r.seq, r.at, r.what, r.actor.id, r.actor.name, r.actor.roles.join(";"), r.storeId, r.itemId, r.ref, r.before, r.after, r.reason,
  ].map(csvCell).join(","))].join("\n") + "\n"
    + (truncated ? `# truncated at ${String(found.length)} rows; ask again with afterSeq=${String(nextAfterSeq)}\n` : "");

  const shown = {
    ticketId: filter.ticketId ?? null, itemId: filter.itemId ?? null, personId: filter.personId ?? null, storeId: filter.storeId ?? null,
    from: filter.from.toISOString(), to: filter.to.toISOString(),
  };
  await withTx(db, (tx) => recordAct(tx, actor, now, {
    act: "audit_export", storeId: filter.storeId ?? null, itemId: filter.itemId ?? null, refId: filter.ticketId ?? null,
    after: { ...shown, rows: rows.length, truncated },
  }));
  return { filter: shown, rows, csv, truncated, nextAfterSeq };
}
