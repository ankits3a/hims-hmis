import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  coveredMembers, entitlementCounters, entitlementMovements, membershipInstances, membershipPlans,
  patientMatchQueue, patients,
} from "../../../kernel/db/schema";
import { normalizeForSearch } from "../../../kernel/search/normalize";
import { appendEvent } from "../../../kernel/events/append";
import { withTx } from "../../../kernel/db/client";
import { resolvePatientId, visiblePatientIds } from "../../patients";
import { MembershipError } from "../errors";
import { instrumentHolderLinked } from "../events";
import type { Db, Tx } from "../../../kernel/db/client";

/**
 * PLAN 09 T5 — THE RECONCILE QUEUE: the one place a human decides what the importer refused to
 * guess.
 *
 * ═══ A FUZZY MATCH NEVER AUTO-LINKS, WHATEVER THE SCORE (E3) ═══
 *
 * The importer can see that "Sunanda Phatak" in a partner's drop is one edit away from a
 * "Sunandaa Phatak" this hospital already registered. It may not act on that. A wrong link is a
 * clinical record attached to the wrong person: it is invisible to the person it happened to, it
 * survives every later correction because nothing downstream doubts it, and there is no score at
 * which the consequence stops being that. So the candidates are SCORED and STORED, the instance
 * lands with a null patient, and `resolved_patient_id` is only ever written by a person.
 *
 * The queue carries three producers this phase — a fuzzy name match, O-5's cap overflow, and
 * DD9/C5's lapsed restore — and one it does not: DD11's `merge_duplicate` has no detector in
 * Plan 09, because detecting it means watching a merge execute and no task in this phase names a
 * file under `modules/patients/`. It is in the schema's own reason list and stays unowned.
 *
 * ═══ THE CANDIDATES ARE GATED WHEN THEY ARE READ, NOT WHEN THEY ARE WRITTEN ═══
 *
 * 11h's close ruled that a patient id is not a capability. The importer is a batch job and stores
 * every candidate it found; the READER runs them through `visiblePatientIds` — the patients
 * module's single gate, never re-implemented here — so a reconciler without
 * `patients.confidential.read` never learns that a confidential patient resembles this holder.
 * That is the `search-providers.ts` shape, for the same reason: one gate, in the module that owns
 * the rule.
 */

/** The four reasons the schema's own column comment lists. `merge_duplicate` has no producer yet. */
export const MATCH_QUEUE_REASONS = ["fuzzy_match", "merge_duplicate", "cap_overflow", "lapsed_restore"] as const;
export type MatchQueueReason = (typeof MATCH_QUEUE_REASONS)[number];

export type MatchCandidate = {
  patientId: string;
  /** 0..1. `similarity()`'s own number, never rounded into a band — a human sees what was measured. */
  score: number;
  /** What matched, in words. A score with no explanation is a number a desk cannot act on. */
  why: string;
};

/**
 * THE THRESHOLD IS `patients/search.ts`'s, DUPLICATED WITH ITS REASON WRITTEN DOWN.
 *
 * `patientFuzzyCondition` is private to the patients module and the module-isolation rule means it
 * cannot be imported — the same wall that already put three copies of the IST clock in this
 * repository, each with a header saying so. Copying the CONSTANT and the `%`-plus-`similarity`
 * shape keeps this lane and the palette agreeing about who resembles whom; re-deriving a threshold
 * here would have made the reconcile queue and the search box disagree about the same two names.
 *
 * `%` is what `patients_name_trgm_idx` can serve; the explicit `similarity()` pins OUR threshold so
 * the behaviour does not move with the server's `pg_trgm.similarity_threshold` GUC.
 */
export const MATCH_TRIGRAM_THRESHOLD = 0.3;

/** How many candidates one holder is worth showing. More than a handful is a listing, not a match. */
const MAX_CANDIDATES = 5;

/**
 * Who in this hospital resembles this holder?
 *
 * NAME ONLY, AND DELIBERATELY NOT PHONE. An Indian family shares one mobile number: father,
 * mother, two children and a grandparent on the same handset is the ordinary case, not the edge
 * one. A phone lane here would file a queue row for every member of every family in the drop and
 * bury the real matches under them — which is the same failure as auto-linking, arriving as noise
 * instead of as a wrong link.
 */
export async function findPatientCandidates(db: Db | Tx, holderName: string): Promise<MatchCandidate[]> {
  const folded = normalizeForSearch(holderName);
  if (folded.length < 2) return [];
  const rows = await db
    .select({
      id: patients.id,
      name: patients.name,
      score: sql<number>`similarity(lower(${patients.name}), ${folded})`,
    })
    .from(patients)
    .where(
      and(
        eq(patients.status, "active"),
        sql`lower(${patients.name}) % ${folded}`,
        sql`similarity(lower(${patients.name}), ${folded}) > ${MATCH_TRIGRAM_THRESHOLD}`,
      ),
    )
    .orderBy(desc(sql`similarity(lower(${patients.name}), ${folded})`), asc(patients.id))
    .limit(MAX_CANDIDATES);
  return rows.map((r) => ({
    patientId: r.id,
    score: Number(r.score),
    why: `holder name "${holderName}" resembles registered patient "${r.name}"`,
  }));
}

export type EnqueueInput = {
  instanceId: string;
  memberId?: string | null;
  reason: MatchQueueReason;
  candidates: MatchCandidate[];
  note?: string;
};

/** Writes inside the caller's transaction: a queue row for a drop that rolled back would be a lie. */
export async function enqueueMatches(tx: Tx, rows: readonly EnqueueInput[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const values = rows.map((r) => ({
    id: newId(),
    instanceId: r.instanceId,
    memberId: r.memberId ?? null,
    reason: r.reason,
    candidates: r.candidates,
    state: "open",
    note: r.note ?? null,
  }));
  await tx.insert(patientMatchQueue).values(values);
  return values.map((v) => v.id);
}

export type MatchQueueItem = {
  id: string;
  instanceId: string;
  memberId: string | null;
  reason: string;
  state: string;
  cardCode: string;
  holderName: string;
  planTitle: string;
  /** Already gated: a candidate this caller may not see is not in this array and was not counted. */
  candidates: (MatchCandidate & { patientName: string; uhid: string })[];
  note: string | null;
  at: Date;
};

/** DD9/C5 — a restore against a counter whose own validity had lapsed. A FLAG, never a queue row. */
export type LapsedRestoreItem = {
  movementId: string;
  instanceId: string;
  cardCode: string;
  holderName: string;
  benefitKey: string;
  invoiceId: string | null;
  at: Date;
};

function parseCandidates(raw: unknown): MatchCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: MatchCandidate[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { patientId, score, why } = entry as { patientId?: unknown; score?: unknown; why?: unknown };
    if (typeof patientId !== "string" || patientId === "") continue;
    out.push({
      patientId,
      score: typeof score === "number" ? score : 0,
      why: typeof why === "string" ? why : "",
    });
  }
  return out;
}

/**
 * The open worklist, oldest first — a reconcile queue is worked in arrival order, and `seq` is the
 * only column that can say what that was (§3.26: a ULID cannot).
 */
export async function listMatchQueue(
  db: Db,
  actor: Actor,
  opts: { state?: "open" | "resolved" | "dismissed"; limit?: number } = {},
): Promise<MatchQueueItem[]> {
  const cap = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: patientMatchQueue.id,
      instanceId: patientMatchQueue.instanceId,
      memberId: patientMatchQueue.memberId,
      reason: patientMatchQueue.reason,
      state: patientMatchQueue.state,
      candidates: patientMatchQueue.candidates,
      note: patientMatchQueue.note,
      at: patientMatchQueue.at,
      cardCode: membershipInstances.cardCode,
      holderName: membershipInstances.holderName,
      planTitle: membershipPlans.title,
    })
    .from(patientMatchQueue)
    .innerJoin(membershipInstances, eq(membershipInstances.id, patientMatchQueue.instanceId))
    .innerJoin(membershipPlans, eq(membershipPlans.id, membershipInstances.planId))
    .where(eq(patientMatchQueue.state, opts.state ?? "open"))
    .orderBy(asc(patientMatchQueue.seq))
    .limit(cap);

  const parsed = rows.map((r) => ({ row: r, candidates: parseCandidates(r.candidates) }));
  const allIds = [...new Set(parsed.flatMap((p) => p.candidates.map((c) => c.patientId)))];
  // ONE gate call for the whole page, and it is the patients module's own.
  const visible = new Set(await visiblePatientIds(db, actor, allIds));
  const named =
    allIds.length === 0
      ? []
      : await db
          .select({ id: patients.id, name: patients.name, uhid: patients.uhid })
          .from(patients)
          .where(inArray(patients.id, allIds));
  const byId = new Map(named.map((p) => [p.id, p]));

  return parsed.map(({ row, candidates }) => ({
    id: row.id,
    instanceId: row.instanceId,
    memberId: row.memberId,
    reason: row.reason,
    state: row.state,
    cardCode: row.cardCode,
    holderName: row.holderName,
    planTitle: row.planTitle,
    candidates: candidates
      .filter((c) => visible.has(c.patientId))
      .map((c) => ({
        ...c,
        patientName: byId.get(c.patientId)?.name ?? "",
        uhid: byId.get(c.patientId)?.uhid ?? "",
      })),
    note: row.note,
    at: row.at,
  }));
}

/**
 * DD9/C5 — the lapsed restores, read from the FLAG rather than from a queue row.
 *
 * T4 writes `entitlement_movements.lapsed_restore = true` and no queue row, because DD9's own
 * words are *"the flag is what the reconcile queue shows"*. Nothing else in the repository surfaces
 * it, so this reader is what makes that sentence true. It is a READ of another lane's append-only
 * log and writes nothing.
 */
export async function listLapsedRestores(db: Db, limit = 50): Promise<LapsedRestoreItem[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  const rows = await db
    .select({
      movementId: entitlementMovements.id,
      instanceId: entitlementCounters.instanceId,
      benefitKey: entitlementCounters.benefitKey,
      invoiceId: entitlementMovements.invoiceId,
      at: entitlementMovements.at,
      cardCode: membershipInstances.cardCode,
      holderName: membershipInstances.holderName,
    })
    .from(entitlementMovements)
    .innerJoin(entitlementCounters, eq(entitlementCounters.id, entitlementMovements.counterId))
    .innerJoin(membershipInstances, eq(membershipInstances.id, entitlementCounters.instanceId))
    .where(eq(entitlementMovements.lapsedRestore, true))
    .orderBy(desc(entitlementMovements.seq))
    .limit(cap);
  return rows;
}

/**
 * The stored reason, narrowed to the event's own enum. A row whose reason is not one of the four is
 * impossible today (the schema comment lists exactly these) — but the event schema would THROW on
 * it at append time and take the human's decision down with it, so an unrecognised word is carried
 * as the one that says least rather than as a crash inside somebody's click.
 */
function queueReason(raw: string): MatchQueueReason {
  return (MATCH_QUEUE_REASONS as readonly string[]).includes(raw) ? (raw as MatchQueueReason) : "fuzzy_match";
}

export type ResolveMatchInput = { queueItemId: string; patientId: string; note?: string };

/**
 * A HUMAN LINKS THE HOLDER. This is the only writer of `membership_instances.patient_id` outside
 * the grace-honor path, and it refuses any patient the queue row did not offer.
 *
 * ═══ THE PATIENT ID IS RESOLVED THROUGH THE MERGE CHAIN (DD11) ═══
 *
 * Merge never rewrites another module's rows, so a candidate recorded before a merge names the
 * LOSER. Linking to a merged-away record would put the card on a patient who is no longer anybody
 * — invisible at the counter, exactly the outcome DD11 exists to prevent — so the decision is
 * recorded against the id the human chose and the LINK is written to the survivor.
 */
export async function resolveMatch(
  db: Db,
  actor: Actor,
  input: ResolveMatchInput,
  now: Date = new Date(),
): Promise<{ queueItemId: string; instanceId: string; patientId: string }> {
  const rows = await db
    .select({
      id: patientMatchQueue.id,
      instanceId: patientMatchQueue.instanceId,
      memberId: patientMatchQueue.memberId,
      reason: patientMatchQueue.reason,
      state: patientMatchQueue.state,
      candidates: patientMatchQueue.candidates,
    })
    .from(patientMatchQueue)
    .where(eq(patientMatchQueue.id, input.queueItemId));
  const item = rows[0];
  if (item === undefined) {
    throw new MembershipError("match_candidate_unknown", `no reconcile queue item ${input.queueItemId}`);
  }
  if (item.state !== "open") {
    throw new MembershipError("match_already_resolved", `queue item ${input.queueItemId} is already ${item.state}`);
  }
  const offered = parseCandidates(item.candidates).map((c) => c.patientId);
  if (!offered.includes(input.patientId)) {
    throw new MembershipError(
      "match_candidate_unknown",
      "that patient was not among this item's candidates",
      { offered },
    );
  }
  const visible = await visiblePatientIds(db, actor, [input.patientId]);
  if (visible.length === 0) {
    throw new MembershipError("match_candidate_unknown", "that patient is not visible to you");
  }
  const resolved = await resolvePatientId(db, input.patientId);
  if (resolved === null) {
    // `visiblePatientIds` just answered for this id, so the row exists; `resolvePatientId` returns
    // null only for an id it cannot follow at all. Refusing beats writing a link nobody can read.
    throw new MembershipError("match_candidate_unknown", "that patient could not be resolved through the merge chain");
  }
  const survivor: string = resolved;

  await withTx(db, async (tx) => {
    // Single-winner conditional UPDATE (`sessions.ts`'s `beginClose` shape): two reconcilers
    // deciding the same item at once cannot both write, and the loser's own read said `open`.
    const claimed = await tx
      .update(patientMatchQueue)
      .set({
        state: "resolved",
        resolvedPatientId: survivor,
        resolvedBy: actor.id,
        resolvedAt: now,
        note: input.note ?? null,
      })
      .where(and(eq(patientMatchQueue.id, input.queueItemId), eq(patientMatchQueue.state, "open")))
      .returning({ id: patientMatchQueue.id });
    if (claimed.length === 0) {
      throw new MembershipError("match_already_resolved", `queue item ${input.queueItemId} was decided by somebody else`);
    }
    if (item.memberId === null) {
      await tx
        .update(membershipInstances)
        .set({ patientId: survivor })
        .where(eq(membershipInstances.id, item.instanceId));
    } else {
      await tx.update(coveredMembers).set({ patientId: survivor }).where(eq(coveredMembers.id, item.memberId));
    }
    await appendEvent(
      tx,
      instrumentHolderLinked.make({
        actor,
        occurredAt: now,
        patientId: survivor,
        payload: {
          queueItemId: input.queueItemId,
          instanceId: item.instanceId,
          patientId: survivor,
          reason: queueReason(item.reason),
        },
      }),
    );
  });
  return { queueItemId: input.queueItemId, instanceId: item.instanceId, patientId: survivor };
}

/** Nothing to link — the resemblance was a coincidence, or the partner's row is simply wrong. */
export async function dismissMatch(
  db: Db,
  actor: Actor,
  input: { queueItemId: string; note: string },
  now: Date = new Date(),
): Promise<{ queueItemId: string }> {
  const claimed = await db
    .update(patientMatchQueue)
    .set({ state: "dismissed", resolvedBy: actor.id, resolvedAt: now, note: input.note })
    .where(and(eq(patientMatchQueue.id, input.queueItemId), eq(patientMatchQueue.state, "open")))
    .returning({ id: patientMatchQueue.id });
  if (claimed.length === 0) {
    throw new MembershipError("match_already_resolved", `queue item ${input.queueItemId} is not open`);
  }
  return { queueItemId: input.queueItemId };
}
