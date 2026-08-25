import { createHash } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor, SearchEntity, SearchQuery, SearchResponse } from "@hmis/contracts";
import { searchAudit } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { searchRestrictedSurfaced } from "./events";
import type { Db } from "../db/client";

/** DD4. Ninety days by default; a config knob, not a migration, when the owner rules otherwise. */
export const SEARCH_AUDIT_RETAIN_DAYS = 90;

/** Normalise before hashing so "  Asha  " and "asha" are recognisably the same search. */
function hashQuery(raw: string): string {
  return createHash("sha256").update(raw.trim().toLowerCase(), "utf8").digest("hex");
}

export type RecordSearchInput = {
  actor: Actor;
  query: SearchQuery;
  response: SearchResponse;
  source?: "text" | "voice";
  now?: Date;
};

/**
 * PLAN 11h T5 — ONE ROW PER SEARCH, WHATEVER HAPPENED.
 *
 * A zero-hit search is recorded exactly as a fruitful one is, and that is the assertion this
 * function exists to satisfy: somebody typing six surnames and opening none of them is the pattern
 * an access review is looking for, and a log that only remembers successes cannot show it. The
 * same reasoning makes an errored or timed-out provider no reason to skip the row.
 *
 * The restricted case ALSO appends to the spine (`events.ts`), inside the same transaction as the
 * audit row: if the two could diverge, the event would name an `auditId` that no row carries.
 */
export async function recordSearch(db: Db, input: RecordSearchInput): Promise<{ auditId: string }> {
  const auditId = newId();
  const now = input.now ?? new Date();

  const entityCounts: Partial<Record<SearchEntity, number>> = {};
  let totalHits = 0;
  const restrictedEntities = new Set<string>();
  let restrictedCount = 0;
  for (const g of input.response.groups) {
    entityCounts[g.entity] = (entityCounts[g.entity] ?? 0) + g.hits.length;
    totalHits += g.hits.length;
    for (const h of g.hits) {
      if (h.restricted !== undefined) {
        restrictedEntities.add(g.entity);
        restrictedCount += 1;
      }
    }
  }

  await withTx(db, async (tx) => {
    await tx.insert(searchAudit).values({
      id: auditId,
      actorId: input.actor.id,
      rawQuery: input.query.raw,
      queryHash: hashQuery(input.query.raw),
      entityCounts,
      totalHits,
      tookMs: input.response.tookMs,
      source: input.source ?? "text",
      restrictedSurfaced: restrictedCount > 0,
      at: now,
    });

    if (restrictedCount > 0) {
      await appendEvent(
        tx,
        searchRestrictedSurfaced.make({
          actor: input.actor,
          payload: { auditId, entities: [...restrictedEntities], count: restrictedCount },
        }),
      );
    }
  });

  return { auditId };
}

/**
 * THE OPEN IS THE NEEDLE. Searching produces a haystack of names a desk glanced at; opening one is
 * the moment a records-access enquiry actually asks about, and it is the only place this table
 * stores a reference to a specific record.
 *
 * It is idempotent-by-first-write: a second open against the same audit row is IGNORED rather than
 * overwriting, because one search that led to one open is the fact being recorded — a palette
 * re-render must not be able to rewrite which record was taken.
 */
export async function recordOpen(
  db: Db,
  input: { auditId: string; actor: Actor; entity: SearchEntity; id: string; now?: Date },
): Promise<{ recorded: boolean }> {
  const res = await db
    .update(searchAudit)
    .set({ openedEntity: input.entity, openedId: input.id, openedAt: input.now ?? new Date() })
    .where(and(
      eq(searchAudit.id, input.auditId),
      eq(searchAudit.actorId, input.actor.id), // an actor may only annotate their OWN search
      isNull(searchAudit.openedAt),
    ))
    .returning({ id: searchAudit.id });
  return { recorded: res.length > 0 };
}

/**
 * DD4's retention, shaped for `kernel/retention/sweep.ts` to call: a plain, batched, clock-as-a-
 * parameter delete (Global Constraint 11), returning what it removed so the sweep can report it.
 *
 * NO LEGAL-HOLD CHECK, and that is a decision rather than an omission. `retention_legal_holds` is
 * keyed on `patient_id`, and a search-audit row references no patient — it holds a query string
 * and per-entity counts. A hold on one patient cannot be evaluated against "somebody typed
 * 'sharma'", so pretending to honour it here would be a check that always passes, which is worse
 * than none: it would read like protection. If access logs ever need to survive a hold, the hold
 * model has to grow an actor/time window first, and that is an owner ruling.
 */
export async function pruneSearchAudit(
  db: Db,
  opts: { retainDays?: number; batchSize?: number; now?: Date } = {},
): Promise<number> {
  const retainDays = opts.retainDays ?? SEARCH_AUDIT_RETAIN_DAYS;
  const batchSize = opts.batchSize ?? 5000;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - retainDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(searchAudit)
    .where(sql`${searchAudit.id} in (select id from ${searchAudit} where ${lt(searchAudit.at, cutoff)} limit ${batchSize})`)
    .returning({ id: searchAudit.id });
  return deleted.length;
}

/**
 * PLAN 11h T9 — RECORD THAT AUDIO LEFT THE BUILDING, BEFORE IT LEAVES.
 *
 * Written BEFORE the transcription call, not after, and that ordering is the whole assertion: a log
 * that records only successful transcriptions cannot answer "what left the building" — the failures
 * are exactly the cases an enquiry would care about. If the provider errors, times out, or the
 * process dies mid-call, this row still says that a clip was sent, by whom, and when.
 *
 * `rawQuery` is empty at this point because the transcript does not exist yet; `attachTranscript`
 * fills it in afterwards, best-effort. The row's EXISTENCE is the record; its text is a convenience.
 */
export async function recordVoiceEgress(
  db: Db,
  input: { actor: Actor; audioBytes: number; now?: Date },
): Promise<{ auditId: string }> {
  const auditId = newId();
  await db.insert(searchAudit).values({
    id: auditId,
    actorId: input.actor.id,
    rawQuery: "",
    queryHash: hashQuery(`voice:${input.audioBytes}`),
    entityCounts: {},
    totalHits: 0,
    tookMs: 0,
    source: "voice",
    restrictedSurfaced: false,
    at: input.now ?? new Date(),
  });
  return { auditId };
}

/** Fill in what the audio turned out to say. Best-effort: the egress row is already the record. */
export async function attachTranscript(db: Db, auditId: string, text: string): Promise<void> {
  await db.update(searchAudit).set({ rawQuery: text, queryHash: hashQuery(text) }).where(eq(searchAudit.id, auditId));
}
