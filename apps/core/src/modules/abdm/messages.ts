import { and, desc, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { abdmMessages } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S0 — the ONLY writer and the ONLY reader of `abdm_messages` (schema header says why the table
 * exists). Writers take rows that are already secret-free; building them is the caller's job
 * (`redact.ts`), because only the caller knows which fields were credentials.
 */
export type AbdmMessageRow = typeof abdmMessages.$inferSelect;
export type AbdmDispatch = "pending" | "handled" | "unhandled" | "failed";

export async function insertOutbound(db: Db, row: {
  kind: string; path: string; requestId: string; headers: Record<string, string>;
  body: unknown; patientId?: string | null; actorId?: string | null;
}): Promise<string> {
  const id = newId();
  await db.insert(abdmMessages).values({
    id, direction: "out", kind: row.kind, path: row.path, requestId: row.requestId,
    headers: row.headers, body: row.body ?? null, patientId: row.patientId ?? null, actorId: row.actorId ?? null,
  });
  return id;
}

export async function completeOutbound(db: Db, id: string, result: {
  httpStatus?: number | null; responseBody?: unknown; error?: string | null;
}): Promise<void> {
  await db.update(abdmMessages).set({
    httpStatus: result.httpStatus ?? null,
    responseBody: result.responseBody ?? null,
    error: result.error ?? null,
    completedAt: new Date(),
  }).where(eq(abdmMessages.id, id));
}

/**
 * Inserts an inbound callback, or returns NULL when ABDM has delivered this REQUEST-ID before —
 * `abdm_messages_in_request_ux` decides, under concurrency as well as in sequence.
 */
export async function insertInbound(db: Db, row: {
  kind: string; path: string; requestId: string; correlationRequestId: string | null;
  headers: Record<string, string>; body: unknown; httpStatus: number;
}): Promise<string | null> {
  const id = newId();
  const inserted = await db.insert(abdmMessages).values({
    id, direction: "in", kind: row.kind, path: row.path, requestId: row.requestId,
    correlationRequestId: row.correlationRequestId, headers: row.headers, body: row.body ?? null,
    httpStatus: row.httpStatus, dispatch: "pending",
  }).onConflictDoNothing().returning({ id: abdmMessages.id });
  return inserted[0]?.id ?? null;
}

/**
 * ABDM S1 — an inbound message that arrived before its patient existed (a scan-and-share profile)
 * names them once the counter has linked it, so `listAbdmMessages` audits the read against them.
 * Only ever fills a null: a message that already names a patient is not re-pointed.
 */
export async function attachPatientToMessage(db: Db, id: string, patientId: string): Promise<void> {
  await db.update(abdmMessages).set({ patientId }).where(and(eq(abdmMessages.id, id), isNull(abdmMessages.patientId)));
}

export async function markDispatch(db: Db, id: string, dispatch: AbdmDispatch, error: string | null = null): Promise<void> {
  await db.update(abdmMessages).set({ dispatch, error, completedAt: new Date() }).where(eq(abdmMessages.id, id));
}

/**
 * THE READ, PHI-AUDITED. One `abdm.messages` access per distinct patient the read returned — the
 * `billing.collection_worklist` shape — because a list of messages is a list of disclosures about
 * whoever they name. A row that names nobody (every S0 row) is logged by nobody: `phi_access_log`
 * keys on a patient, and there is none to key on.
 */
export async function listAbdmMessages(db: Db, actor: Actor, filter: {
  kind?: string; direction?: "in" | "out"; limit?: number;
} = {}): Promise<AbdmMessageRow[]> {
  const where = and(
    filter.kind !== undefined ? eq(abdmMessages.kind, filter.kind) : undefined,
    filter.direction !== undefined ? eq(abdmMessages.direction, filter.direction) : undefined,
  );
  const rows = await db.select().from(abdmMessages).where(where)
    .orderBy(desc(abdmMessages.createdAt), desc(abdmMessages.id))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 500));
  const patientIds = [...new Set(rows.map((r) => r.patientId).filter((p): p is string => p !== null))];
  for (const patientId of patientIds) {
    await recordPhiAccess(db, { actor, patientId, surface: "abdm.messages" });
  }
  return rows;
}
