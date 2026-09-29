import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import {
  approvals, breakGlassGrants, opdEncounters, patientAllergies, patientGuardians, patientMergeRequests, patients, users,
} from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { displayName } from "./display-name";
import { withTx } from "../../kernel/db/client";
import { patientMerged, patientUnmerged } from "./events";
import { PatientError } from "./uhid";
import { assertAbhaFree } from "./abha-holders";
import type { Db, Tx } from "../../kernel/db/client";

/** Registered as DATA at go-live (runbook, T10 docs); tests register them inline. No engine work — Plan 04 gate report §8. */
export const MERGE_APPROVAL_TYPE = "patient_merge";
export const UNMERGE_APPROVAL_TYPE = "patient_unmerge";

export type MergeRequestRow = typeof patientMergeRequests.$inferSelect;
type MovedRows = { allergyIds: string[]; guardianIds: string[] };

/**
 * UX-AUDIT 2026-09-28 · BOARD (merge review) — A REFUSED MERGE CLOSES ITS REQUEST.
 *
 * The defect, measured on origin/main: the approval engine is a kernel and knows nothing about merge
 * requests, so when the Medical Superintendent REFUSED a `patient_merge` approval the approval row
 * went to `rejected` and this module's row stayed `status = 'requested'` for ever. The partial unique
 * index `patient_merge_requests_pending_loser_ux` (one live request per loser) then refused every
 * later request for that record — a refusal locked the record out of the merge flow permanently,
 * which is the opposite of what refusing means ("keep both records open").
 *
 * THE FIX IS A SETTLE, NOT A CONSUMER. `status = 'requested'` with a `rejected` approval becomes
 * `refused`, by one conditional UPDATE, run wherever a request is read or asked again: before a new
 * request for the same record (inside its transaction, so the unique index sees the closed row),
 * before a detail read, before an execute, before the list. The same shape `materials/item-merge.ts`
 * uses (`settleItemMerges`), and for the same reason this file keeps check-on-execute: the person
 * waiting at the screen must not depend on a polled dispatcher. Idempotent; a request already
 * settled is not touched again.
 *
 * ADDITIVE: `status` is a plain text column with no CHECK, so `refused` needs no migration. The
 * approval keeps its own audit — `approval.rejected`, with the MS's note, written by the kernel in
 * the decision's transaction — and this row points at it through `approval_id`.
 */
export async function settleRefusedMerges(
  exec: Db | Tx,
  scope: { loserId?: string; ids?: readonly string[] } = {},
): Promise<number> {
  const rejected = exec.select({ id: approvals.id }).from(approvals).where(eq(approvals.status, "rejected"));
  const conditions = [eq(patientMergeRequests.status, "requested"), inArray(patientMergeRequests.approvalId, rejected)];
  if (scope.loserId !== undefined) conditions.push(eq(patientMergeRequests.loserId, scope.loserId));
  if (scope.ids !== undefined) {
    if (scope.ids.length === 0) return 0;
    conditions.push(inArray(patientMergeRequests.id, [...scope.ids]));
  }
  const closed = await exec
    .update(patientMergeRequests)
    .set({ status: "refused" })
    .where(and(...conditions))
    .returning({ id: patientMergeRequests.id });
  return closed.length;
}

/**
 * UX-AUDIT 2026-09-28 · BOARD — SEALED RECORDS. OWNER RULING (merge review, Q2): merging a sealed
 * (confidential) record needs the Medical Superintendent to record a break-glass on it FIRST.
 *
 * The approval engine decides in the kernel and cannot ask this module anything, so the rule is
 * checked where every other merge rule is checked: at execute. For each sealed record in the pair,
 * the person who DECIDED the approval must hold a break-glass grant (`kernel/auth/break-glass.ts`)
 * naming that record — or hospital-wide — recorded after the request was filed and not after now.
 * A grant recorded by anyone else does not count; nor does one from before this request existed.
 *
 * Expiry is deliberately not required at execute: the grant is the MS's recorded justification for
 * this merge, and the MRD officer who runs the merge an hour later must not find it lapsed under a
 * decision already made. What must be true is that the glass was broken for THIS request, by the
 * person who approved it.
 */
async function assertSealedBrokenGlass(
  exec: Db | Tx,
  req: MergeRequestRow,
  decidedBy: string | null,
  now: Date,
): Promise<void> {
  const pair = await exec
    .select({ id: patients.id, uhid: patients.uhid, isConfidential: patients.isConfidential })
    .from(patients)
    .where(inArray(patients.id, [req.winnerId, req.loserId]));
  const sealed = pair.filter((p) => p.isConfidential);
  if (sealed.length === 0) return;
  for (const p of sealed) {
    const grants = decidedBy === null ? [] : await exec
      .select({ id: breakGlassGrants.id })
      .from(breakGlassGrants)
      .where(and(
        eq(breakGlassGrants.userId, decidedBy),
        or(eq(breakGlassGrants.patientId, p.id), isNull(breakGlassGrants.patientId)),
        gte(breakGlassGrants.createdAt, req.requestedAt),
        lte(breakGlassGrants.createdAt, now),
      ))
      .limit(1);
    if (grants.length === 0) {
      throw new PatientError(
        "sealed_needs_break_glass",
        "this merge includes a sealed record: the Medical Superintendent who approved it must record a break-glass on it before the merge runs",
        { patientId: p.id },
      );
    }
  }
}

export async function createMergeRequest(
  tx: Tx,
  actor: Actor,
  input: { winnerId: string; loserId: string; note: string },
): Promise<{ mergeRequestId: string; approvalId: string; instanceId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") throw new PatientError("reason_required", "a merge request needs a reason (§11.5 review)");
  if (input.winnerId === input.loserId) throw new PatientError("merge_same_patient");

  const rows = await tx.select().from(patients).where(inArray(patients.id, [input.winnerId, input.loserId]));
  const winner = rows.find((r) => r.id === input.winnerId);
  const loser = rows.find((r) => r.id === input.loserId);
  if (!winner || !loser) throw new PatientError("patient_not_found");
  if (winner.status !== "active" || loser.status !== "active") {
    throw new PatientError("patient_not_active", "both records must be active to merge");
  }

  // UX-AUDIT 2026-09-28 · BOARD — a refused earlier request for this record is closed FIRST, in this
  // transaction, so the one-live-request-per-loser index sees it closed (`settleRefusedMerges`).
  await settleRefusedMerges(tx, { loserId: input.loserId });

  const mergeRequestId = newId();
  // Tx-first requestApproval (Plan 04): the approval, its workflow instance, and this row
  // commit together or not at all. A duplicate-pending conflict below rolls ALL of it back.
  const { approvalId, instanceId } = await requestApproval(tx, actor, {
    typeKey: MERGE_APPROVAL_TYPE,
    subject: { type: "patient_merge_request", id: mergeRequestId },
    patientId: input.loserId,
    requestNote: note,
  });

  const inserted = await tx
    .insert(patientMergeRequests)
    .values({
      id: mergeRequestId,
      winnerId: input.winnerId,
      loserId: input.loserId,
      approvalId,
      requestNote: note,
      snapshot: { winnerBefore: winner, loserBefore: loser },
      requestedBy: actor.id,
    })
    .onConflictDoNothing()
    .returning({ id: patientMergeRequests.id });
  if (inserted.length === 0) {
    // Lost the partial-unique race (one pending request per loser) — unwind everything.
    throw new PatientError("merge_already_requested", "a pending merge request already exists for this record");
  }
  return { mergeRequestId, approvalId, instanceId };
}

/** Embeds approval statuses so the review UI needs no approvals-engine read permission. */
export async function getMergeRequest(
  db: Db,
  mergeRequestId: string,
): Promise<{
  request: MergeRequestRow; approvalStatus: string | null; unmergeApprovalStatus: string | null;
  /* UX-AUDIT 2026-09-28 · BOARD — additive: what the approver's seat and the refusal row need. */
  decisionNote: string | null; decidedAt: Date | null; requestedByName: string | null;
  sealed: { winner: boolean; loser: boolean };
} | null> {
  await settleRefusedMerges(db, { ids: [mergeRequestId] }); // UX-AUDIT 2026-09-28 · BOARD — a refusal reads as refused
  const rows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const request = rows[0];
  if (!request) return null;
  const approval = await getApproval(db, request.approvalId);
  const unmergeApproval = request.unmergeApprovalId !== null ? await getApproval(db, request.unmergeApprovalId) : null;
  const [requester] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, request.requestedBy));
  const pair = await db.select({ id: patients.id, isConfidential: patients.isConfidential })
    .from(patients).where(inArray(patients.id, [request.winnerId, request.loserId]));
  const sealedIds = new Set(pair.filter((p) => p.isConfidential).map((p) => p.id));
  return {
    request,
    approvalStatus: approval?.status ?? null,
    unmergeApprovalStatus: unmergeApproval?.status ?? null,
    decisionNote: approval?.decisionNote ?? null,
    decidedAt: approval?.decidedAt ?? null,
    requestedByName: requester?.fullName ?? null,
    sealed: { winner: sealedIds.has(request.winnerId), loser: sealedIds.has(request.loserId) },
  };
}

/**
 * Check-on-execute (owner decision Q3), and this STAYS check-on-execute BY DESIGN even though
 * Plan 08.5 puts runDispatchCycle on a clock: the gate is verified against the approvals row at
 * execution time, never via an event consumer, because a merge is a synchronous admin action a
 * human is waiting on at the screen — trading that for the dispatcher's at-least-once, polled
 * delivery would buy nothing (Global Constraint 1, roadmap trap 1). The worker existing does not
 * change this file's shape.
 */
export async function executeMerge(
  db: Db,
  actor: Actor,
  mergeRequestId: string,
): Promise<{ winnerId: string; loserId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  await settleRefusedMerges(db, { ids: [mergeRequestId] }); // UX-AUDIT 2026-09-28 · BOARD
  const reqRows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const req = reqRows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  if (req.status === "refused") throw new PatientError("merge_refused", "the Medical Superintendent refused this merge; both records stay open");
  const approval = await getApproval(db, req.approvalId);
  if (!approval || approval.status !== "granted") {
    throw new PatientError("approval_not_granted", "the merge approval must be granted first (§11.5)");
  }
  await assertSealedBrokenGlass(db, req, approval.decidedBy, new Date()); // UX-AUDIT 2026-09-28 · BOARD — owner Q2

  return withTx(db, async (tx) => {
    // Single-winner claim FIRST — everything after runs at most once per request.
    const claimed = await tx
      .update(patientMergeRequests)
      .set({ status: "executed", executedBy: actor.id, executedAt: new Date() })
      .where(and(eq(patientMergeRequests.id, mergeRequestId), eq(patientMergeRequests.status, "requested")))
      .returning({ id: patientMergeRequests.id });
    if (claimed.length === 0) throw new PatientError("merge_not_requested", "already executed or unmade");

    const movedAllergies = await tx
      .update(patientAllergies)
      .set({ patientId: req.winnerId })
      .where(eq(patientAllergies.patientId, req.loserId))
      .returning({ id: patientAllergies.id });
    const movedGuardians = await tx
      .update(patientGuardians)
      .set({ patientId: req.winnerId })
      .where(eq(patientGuardians.patientId, req.loserId))
      .returning({ id: patientGuardians.id });
    // Photos deliberately NEVER move: the loser's photo stays on the frozen row (intact for
    // unmerge, hidden behind chain resolution); the winner's own photo — or absence — stands.

    const frozen = await tx
      .update(patients)
      .set({ status: "merged", mergedIntoPatientId: req.winnerId, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, req.loserId), eq(patients.status, "active")))
      .returning({ uhid: patients.uhid });
    if (frozen.length === 0) throw new PatientError("patient_not_active", "loser record changed concurrently");

    const moved: MovedRows = {
      allergyIds: movedAllergies.map((r) => r.id),
      guardianIds: movedGuardians.map((r) => r.id),
    };
    await tx.update(patientMergeRequests).set({ movedRows: moved }).where(eq(patientMergeRequests.id, mergeRequestId));

    const winnerRows = await tx.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, req.winnerId));
    await appendEvent(
      tx,
      patientMerged.make({
        actor,
        patientId: req.winnerId,
        correlationId: approval.instanceId, // §10.5: correlation = the backing workflow instance
        payload: {
          winnerPatientId: req.winnerId,
          loserPatientId: req.loserId,
          winnerUhid: winnerRows[0]!.uhid,
          loserUhid: frozen[0]!.uhid,
          mergeRequestId,
        },
      }),
    );
    return { winnerId: req.winnerId, loserId: req.loserId };
  });
}

export async function requestUnmerge(
  tx: Tx,
  actor: Actor,
  input: { mergeRequestId: string; note: string; actFirst?: boolean },
): Promise<{ approvalId: string; instanceId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") throw new PatientError("reason_required", "an unmerge request needs a reason");
  const rows = await tx.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, input.mergeRequestId));
  const req = rows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  if (req.status !== "executed") throw new PatientError("merge_not_executed", "only an executed merge can be unmade");

  const { approvalId, instanceId } = await requestApproval(tx, actor, {
    typeKey: UNMERGE_APPROVAL_TYPE,
    subject: { type: "patient_merge_request", id: input.mergeRequestId },
    patientId: req.loserId,
    requestNote: note,
    ...(input.actFirst === true ? { actFirst: true } : {}),
  });
  // Claim the ONE unmerge slot (conditional on null) — a lost race unwinds the approval too.
  const claimed = await tx
    .update(patientMergeRequests)
    .set({ unmergeApprovalId: approvalId })
    .where(and(eq(patientMergeRequests.id, input.mergeRequestId), isNull(patientMergeRequests.unmergeApprovalId)))
    .returning({ id: patientMergeRequests.id });
  if (claimed.length === 0) {
    throw new PatientError("unmerge_already_requested", "an unmerge request already exists (a rejected one needs the manual path — v1)");
  }
  return { approvalId, instanceId };
}

export async function executeUnmerge(db: Db, actor: Actor, mergeRequestId: string): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const req = rows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  if (req.status !== "executed") throw new PatientError("merge_not_executed");
  if (req.unmergeApprovalId === null) throw new PatientError("unmerge_not_requested");

  const approval = await getApproval(db, req.unmergeApprovalId);
  // E-15 act-first-review-after: an acted-first request executes while its review is pending.
  // Direct null-check (not a boolean variable) so TS narrows `approval` for the closure below.
  if (approval === null || !(approval.status === "granted" || (approval.actedFirst && approval.status === "pending"))) {
    throw new PatientError("approval_not_granted", "unmerge needs a grant, or an act-first request");
  }

  await withTx(db, async (tx) => {
    const claimed = await tx
      .update(patientMergeRequests)
      .set({ status: "unmerged", unmergedBy: actor.id, unmergedAt: new Date() })
      .where(and(eq(patientMergeRequests.id, mergeRequestId), eq(patientMergeRequests.status, "executed")))
      .returning({ id: patientMergeRequests.id });
    if (claimed.length === 0) throw new PatientError("merge_not_executed", "already unmade");

    const moved = (req.movedRows ?? { allergyIds: [], guardianIds: [] }) as MovedRows;
    if (moved.allergyIds.length > 0) {
      await tx.update(patientAllergies).set({ patientId: req.loserId }).where(inArray(patientAllergies.id, moved.allergyIds));
    }
    if (moved.guardianIds.length > 0) {
      await tx.update(patientGuardians).set({ patientId: req.loserId }).where(inArray(patientGuardians.id, moved.guardianIds));
    }
    /*
      ABDM S1 — ONE ABHA, ONE PATIENT survives an unmerge. A merged row is outside the ABHA indexes
      (`abha-holders.ts`), so while it was frozen its winner may have been verified with the same
      ABHA; putting the loser back would make two active holders. Refused, naming the holder.
    */
    const [loser] = await tx.select({ abhaNumber: patients.abhaNumber, abhaAddress: patients.abhaAddress })
      .from(patients).where(eq(patients.id, req.loserId));
    if (loser !== undefined) {
      await assertAbhaFree(tx, actor, { abhaNumber: loser.abhaNumber, abhaAddress: loser.abhaAddress }, req.loserId);
    }
    const unfrozen = await tx
      .update(patients)
      .set({ status: "active", mergedIntoPatientId: null, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, req.loserId), eq(patients.status, "merged")))
      .returning({ id: patients.id });
    if (unfrozen.length === 0) throw new PatientError("patient_not_active", "loser record changed concurrently");

    await appendEvent(
      tx,
      patientUnmerged.make({
        actor,
        patientId: req.loserId,
        correlationId: approval.instanceId,
        payload: { winnerPatientId: req.winnerId, loserPatientId: req.loserId, mergeRequestId },
      }),
    );
  });
}

/*
  UX-AUDIT 2026-09-28 · BOARD (merge review) — THE REQUESTS LIST, "needs server" item 1.

  The board's right-hand list: one list, no tabs, most urgent first. Until this there was only
  `GET /merge-requests/:id`, so a request left the screen the moment the clerk navigated away, and
  the approvals worklist that does list them needs `approvals.requests.read`, which the MRD officer
  does not hold. Read here with the approval joined, so the screen needs no approvals permission —
  the same reason `getMergeRequest` embeds the approval's status.

  THE ORDER IS THE BOARD'S, and it is a question of harm: a GRANTED request not yet run leaves a
  patient split across two records until somebody runs it, so it is first; then the requests still
  waiting on the MS, least time left first; then refusals to read; then unmerges waiting; then the
  recently done. Closed requests are listed for `CLOSED_DAYS` only — the list is a desk, not an archive.

  NAMES OBEY THE SEAL. A confidential record shows its alias unless the reader holds
  `patients.confidential.read` (`display-name.ts`, the one place that rule is decided).
*/
const CLOSED_DAYS = 7;
const LIST_LIMIT = 100;
/** `patient_merge`'s closure SLA (`approval-types.ts`) — the board's "4-hour line". */
export const MERGE_SLA_MINUTES = 240;

export type MergeListSide = { id: string; uhid: string; name: string; sealed: boolean };
export type MergeRequestListItem = {
  id: string;
  status: "requested" | "executed" | "unmerged" | "refused";
  /** What the row means for the desk — the board's "no enum strings" rule, decided once here. */
  stage: "granted" | "waiting" | "refused" | "unmerge_waiting" | "done";
  approvalId: string;
  approvalStatus: string | null;
  requestNote: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: Date;
  /** The MS's 4-hour line for a waiting request; null once decided. */
  dueAt: Date | null;
  decisionNote: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  executedAt: Date | null;
  unmergeApprovalStatus: string | null;
  winner: MergeListSide;
  loser: MergeListSide;
};

function stageOf(status: string, approvalStatus: string | null, unmergeStatus: string | null): MergeRequestListItem["stage"] {
  if (status === "refused") return "refused";
  if (status === "requested") return approvalStatus === "granted" ? "granted" : "waiting";
  if (status === "executed" && unmergeStatus === "pending") return "unmerge_waiting";
  return "done";
}
const STAGE_RANK: Record<MergeRequestListItem["stage"], number> = { granted: 0, waiting: 1, refused: 2, unmerge_waiting: 3, done: 4 };

export async function listMergeRequests(db: Db, actor: Actor, now: Date = new Date()): Promise<MergeRequestListItem[]> {
  await settleRefusedMerges(db);
  const since = new Date(now.getTime() - CLOSED_DAYS * 86_400_000);
  const rows = await db
    .select({ r: patientMergeRequests, ap: approvals })
    .from(patientMergeRequests)
    .leftJoin(approvals, eq(approvals.id, patientMergeRequests.approvalId))
    .where(or(
      eq(patientMergeRequests.status, "requested"),
      gte(patientMergeRequests.requestedAt, since),
      gte(patientMergeRequests.executedAt, since),
      gte(approvals.decidedAt, since),
      sql`${patientMergeRequests.unmergeApprovalId} is not null and ${patientMergeRequests.status} = 'executed'`,
    ))
    .orderBy(sql`${patientMergeRequests.requestedAt} desc`)
    .limit(LIST_LIMIT);
  if (rows.length === 0) return [];

  const patientIds = [...new Set(rows.flatMap(({ r }) => [r.winnerId, r.loserId]))];
  const people = await db
    .select({ id: patients.id, uhid: patients.uhid, name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients).where(inArray(patients.id, patientIds));
  const byId = new Map(people.map((p) => [p.id, p]));
  const unmergeIds = rows.map(({ r }) => r.unmergeApprovalId).filter((x): x is string => x !== null);
  const unmerges = unmergeIds.length === 0 ? [] : await db
    .select({ id: approvals.id, status: approvals.status }).from(approvals).where(inArray(approvals.id, unmergeIds));
  const unmergeById = new Map(unmerges.map((u) => [u.id, u.status]));
  const userIds = [...new Set(rows.flatMap(({ r, ap }) => [r.requestedBy, ...(ap?.decidedBy ? [ap.decidedBy] : [])]))];
  const staff = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, userIds));
  const nameOfUser = new Map(staff.map((u) => [u.id, u.fullName]));
  const canSee = actor.type === "user" && people.some((p) => p.isConfidential)
    ? await hasPermission(db, actor.id, "patients.confidential.read", "hospital")
    : false;
  const side = (id: string): MergeListSide => {
    const p = byId.get(id);
    return p === undefined
      ? { id, uhid: "—", name: "—", sealed: false }
      : { id, uhid: p.uhid, name: displayName(p, canSee), sealed: p.isConfidential };
  };

  const items = rows.map(({ r, ap }): MergeRequestListItem => {
    const unmergeApprovalStatus = r.unmergeApprovalId === null ? null : unmergeById.get(r.unmergeApprovalId) ?? null;
    const stage = stageOf(r.status, ap?.status ?? null, unmergeApprovalStatus);
    return {
      id: r.id,
      status: r.status as MergeRequestListItem["status"],
      stage,
      approvalId: r.approvalId,
      approvalStatus: ap?.status ?? null,
      requestNote: r.requestNote,
      requestedBy: r.requestedBy,
      requestedByName: nameOfUser.get(r.requestedBy) ?? null,
      requestedAt: r.requestedAt,
      dueAt: stage === "waiting" ? new Date(r.requestedAt.getTime() + MERGE_SLA_MINUTES * 60_000) : null,
      decisionNote: ap?.decisionNote ?? null,
      decidedByName: ap?.decidedBy ? nameOfUser.get(ap.decidedBy) ?? null : null,
      decidedAt: ap?.decidedAt ?? null,
      executedAt: r.executedAt,
      unmergeApprovalStatus,
      winner: side(r.winnerId),
      loser: side(r.loserId),
    };
  });
  const when = (i: MergeRequestListItem): number => {
    // waiting: least time left first (oldest first); everything decided: newest first.
    if (i.stage === "waiting") return i.requestedAt.getTime();
    return -(i.decidedAt ?? i.executedAt ?? i.requestedAt).getTime();
  };
  return items.sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || when(a) - when(b) || a.id.localeCompare(b.id));
}

/*
  UX-AUDIT 2026-09-28 · BOARD — "needs server" item 3: VISITS AND LAST VISIT for each record in the
  comparison, because "more visits" is one of the three reasons the board gives for which record
  survives. One grouped count over `opd_encounters` (abandoned visits excluded), keyed on the ids
  asked for — the canonical ids the comparison already holds.
*/
export type VisitSummary = { patientId: string; visits: number; lastVisitOn: string | null };

export async function visitSummaries(db: Db, patientIds: readonly string[]): Promise<VisitSummary[]> {
  const ids = [...new Set(patientIds)].filter((id) => id !== "");
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      patientId: opdEncounters.patientId,
      visits: sql<string>`count(*)`,
      lastVisitOn: sql<string | null>`max(${opdEncounters.serviceDate})`,
    })
    .from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, ids), sql`${opdEncounters.status} <> 'abandoned'`))
    .groupBy(opdEncounters.patientId);
  const byId = new Map(rows.map((r) => [r.patientId, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    return { patientId: id, visits: r === undefined ? 0 : Number(r.visits), lastVisitOn: r?.lastVisitOn ?? null };
  });
}
