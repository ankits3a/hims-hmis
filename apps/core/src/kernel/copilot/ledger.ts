import { and, eq, gte, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  COPILOT_ASK_OUTCOMES, COPILOT_ROUTES, copilotActs, copilotAsks, copilotNoticeAcks,
} from "../db/schema";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import { copilotAsksPruned } from "./events";
import type { CopilotAskOutcome, CopilotRoute } from "../db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * E0.1 — THE COPILOT LEDGER (decision 0064; spec /opt/hmis-context/SPEC-copilot-ledger-2026-10-10.md)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One row per request that reaches `POST /copilot/ask`, whatever became of it — answered, not
 * understood, refused, scrubbed, malformed or failed. G6(a) reconciles this table against the
 * edge's count of that route, so a ledger that skips the odd refusal reconciles with nothing.
 *
 * WHAT A ROW NEVER HOLDS: the raw question, the rehydrated subject (a UHID, a phone number) or any
 * patient id. The question is stored AS MASKED, and not at all when the scrubber fired — a scrubbed
 * question is by definition one that still carried an identifier.
 *
 * The health read is AGGREGATE ONLY. Distinct askers is a number; there is no per-person list and
 * no "fewest questions" view anywhere (plan E0.1 check 4; staff are data principals under the DPDP
 * Act, owner ruling 2026-10-10: notice first).
 */

/** Plan E0.1: asks keep 180 days, the `notifications` class. The database floor is 179 (migration 0194). */
export const COPILOT_ASK_RETAIN_DAYS = 180;

/** The staff notice's version. Raise it when the wording changes in substance, and everyone sees it again. */
export const COPILOT_NOTICE_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AskRecord = {
  actor: Actor;
  outcome: CopilotAskOutcome;
  route: CopilotRoute;
  intent: string | null;
  answerKey: string | null;
  ms: number;
  maskedQuestion: string | null;
  screen: string | null;
  source?: "chip" | "typed" | null;
  /** Tests only; production rows take the database's clock. */
  at?: Date;
};

/** Awaited by the controller BEFORE the answer leaves: an answer the ledger could not record is not sent. */
export async function recordAsk(db: Db, r: AskRecord): Promise<string> {
  const id = newId();
  await db.insert(copilotAsks).values({
    id,
    ...(r.at !== undefined ? { at: r.at } : {}),
    actorType: r.actor.type,
    actorId: r.actor.id,
    outcome: r.outcome,
    route: r.route,
    intent: r.intent,
    answerKey: r.answerKey,
    ms: Math.max(0, Math.round(r.ms)),
    maskedQuestion: r.maskedQuestion,
    screen: r.screen,
    source: r.source ?? null,
  });
  return id;
}

/**
 * The retention prune — the table's ONE delete door. The trigger lets a DELETE through only inside
 * a transaction that named itself the prune, and only for rows older than 179 days by the
 * database's clock, so a shorter window is refused loudly rather than honoured quietly.
 */
export async function pruneCopilotAsks(
  db: Db,
  opts: { retainDays?: number; batchSize?: number; now?: Date } = {},
): Promise<number> {
  const retainDays = opts.retainDays ?? COPILOT_ASK_RETAIN_DAYS;
  const batchSize = opts.batchSize ?? 5000;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - retainDays * DAY_MS);
  const deleted = await withTx(db, async (tx) => {
    await tx.execute(sql`select set_config('hmis.retention_prune', 'copilot_asks', true)`);
    return tx
      .delete(copilotAsks)
      .where(sql`${copilotAsks.id} in (select id from ${copilotAsks} where ${lt(copilotAsks.at, cutoff)} limit ${batchSize})`)
      .returning({ id: copilotAsks.id });
  });
  return deleted.length;
}

/**
 * THE COPILOT'S OWN NIGHTLY PRUNE — owner ruling 2026-10-10 (option a). Ask rows are staff
 * operational rows, not patient event records, so they get their own 180-day deletion, ALWAYS ON
 * and independent of `RETENTION_ENABLED`: the patient-record retention sweep stays inert under owner
 * ruling 6, and its legal holds govern patient records, which an ask row is not. Bounded batches
 * (a run must end), one count event per run that deleted anything, `copilot_acts` never touched.
 */
const MAX_PRUNE_BATCHES = 100;
const SYSTEM_ACTOR: Actor = { type: "system", id: "copilot-ask-prune" };

export async function runCopilotAskPrune(
  db: Db,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 5000;
  let total = 0;
  for (let i = 0; i < MAX_PRUNE_BATCHES; i += 1) {
    const removed = await pruneCopilotAsks(db, { retainDays: COPILOT_ASK_RETAIN_DAYS, batchSize, now });
    total += removed;
    if (removed < batchSize) break;
  }
  if (total > 0) {
    await withTx(db, (tx) =>
      appendEvent(tx, copilotAsksPruned.make({
        actor: SYSTEM_ACTOR,
        payload: {
          rows: total,
          retainDays: COPILOT_ASK_RETAIN_DAYS,
          cutoff: new Date(now.getTime() - COPILOT_ASK_RETAIN_DAYS * DAY_MS).toISOString(),
        },
      })),
    );
  }
  return total;
}

export type RouteTimings = { asks: number; p50Ms: number | null; p95Ms: number | null };

export type CopilotHealth = {
  /** The IST day read. */
  date: string;
  asks: number;
  /** Distinct people who asked — a count, never a list. */
  askers: number;
  byOutcome: Record<CopilotAskOutcome, number>;
  byRoute: Record<CopilotRoute, RouteTimings>;
  /** notUnderstood ÷ asks (goal G3a); null on a day with no asks. */
  notUnderstoodShare: number | null;
  /** Act rows written that day (zero until E0.2 writes any). */
  acts: number;
};

/** One IST day's totals. `date` is `YYYY-MM-DD`. */
export async function readCopilotHealth(db: Db, date: string): Promise<CopilotHealth> {
  const from = new Date(`${date}T00:00:00+05:30`);
  const to = new Date(from.getTime() + DAY_MS);

  const asks = await db
    .select({ actorType: copilotAsks.actorType, actorId: copilotAsks.actorId, outcome: copilotAsks.outcome, route: copilotAsks.route, ms: copilotAsks.ms })
    .from(copilotAsks)
    .where(and(gte(copilotAsks.at, from), lt(copilotAsks.at, to)));
  const [acts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(copilotActs)
    .where(and(gte(copilotActs.at, from), lt(copilotActs.at, to)));

  const byOutcome = Object.fromEntries(COPILOT_ASK_OUTCOMES.map((o) => [o, 0])) as Record<CopilotAskOutcome, number>;
  for (const a of asks) byOutcome[a.outcome as CopilotAskOutcome] += 1;

  const byRoute = Object.fromEntries(COPILOT_ROUTES.map((r) => {
    const ms = asks.filter((a) => a.route === r).map((a) => a.ms).sort((x, y) => x - y);
    return [r, { asks: ms.length, p50Ms: percentile(ms, 0.5), p95Ms: percentile(ms, 0.95) }];
  })) as Record<CopilotRoute, RouteTimings>;

  return {
    date,
    asks: asks.length,
    askers: new Set(asks.filter((a) => a.actorType === "user").map((a) => a.actorId)).size,
    byOutcome,
    byRoute,
    notUnderstoodShare: asks.length === 0 ? null : byOutcome.notUnderstood / asks.length,
    acts: acts?.n ?? 0,
  };
}

/** Continuous percentile (Postgres `percentile_cont`), rounded to a millisecond. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

/** Has this user dismissed the current staff notice? */
export async function noticeSeen(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: copilotNoticeAcks.userId })
    .from(copilotNoticeAcks)
    .where(and(eq(copilotNoticeAcks.userId, userId), eq(copilotNoticeAcks.version, COPILOT_NOTICE_VERSION)));
  return rows.length > 0;
}

/** Records the dismissal. First write wins; a second tap is a no-op. */
export async function acknowledgeNotice(db: Db, userId: string): Promise<void> {
  await db.insert(copilotNoticeAcks).values({ userId, version: COPILOT_NOTICE_VERSION }).onConflictDoNothing();
}
