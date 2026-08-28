import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { otCases, otCounts, otIncidents } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { assertNotSodPair } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { OtError } from "./errors";
import { countMismatch, incidentReported } from "./events";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T5 / DD7 — **THE COUNTS: two people, rows not checkboxes, and "correct" is DERIVED.**
 *
 * ═══ H8 — NOBODY TYPES "COUNTS CORRECT" ═══
 *
 * There is no `counts_correct` column and no such input anywhere in this module. A round is a set of
 * ROWS, each carrying `expected` and `counted`, and "correct" is `expected = counted` on every
 * `final` row — computed at sign-out, from the rows, every time. A boolean would be a nurse's
 * summary of an arithmetic she did in her head at the end of a four-hour list, and the retained
 * swab it is supposed to prevent is exactly what happens when that summary is wrong.
 *
 * ═══ F11 — THE TWO-PERSON RULE HAS THREE ENFORCERS, AND THEY CATCH DIFFERENT THINGS ═══
 *
 *   1. **`ot_counts_two_person_ck`**, the CHECK on the table: survives raw SQL and a future
 *      migration, and refuses `scrub_by = circulating_by` however the row arrives.
 *   2. **`assertNotSodPair(db, "scrub_circulating", …)`**, the kernel engine: the CHECK refuses the
 *      row silently from the caller's point of view — a constraint name in an error. The SoD engine
 *      EMITS `sod.violation_blocked`, so the ATTEMPT is auditable. Spec §11.9 named this pair and
 *      nothing seeded it until T1; it is seeded now.
 *   3. This function's own ordering: the SoD check runs BEFORE the insert, so the event is appended
 *      even when the CHECK would also have refused.
 *
 * ═══ B4 — THE OPTIMISTIC VERSION, AND WHY A MERGE IS THE WRONG ANSWER ═══
 *
 * Two nurses recounting the same round on two screens is a real Friday-afternoon event. The row
 * carries `version`; a write against a stale one is a 409 and the second nurse re-reads. Merging —
 * taking the higher count, or the later write — would silently pick one of two disagreeing counts
 * of how many swabs are inside a patient.
 */

export type CountRow = typeof otCounts.$inferSelect;
export type CountRound = "initial" | "closing" | "final";

export type RecordCountInput = {
  caseId: string;
  round: CountRound;
  itemType: string;
  expected: number;
  counted: number;
  scrubBy: string;
  circulatingBy: string;
  /** B4 — the version the caller READ. Omitted on the first write of a (case, round, item). */
  version?: number;
};

/**
 * Records or re-records ONE count row. The SoD check runs on `db` rather than the caller's `tx`
 * because `assertNotSodPair` must append its event in its OWN transaction — the block has to
 * survive the caller's rollback, which is what makes an attempted violation auditable.
 */
export async function recordCount(
  db: Db, actor: Actor, input: RecordCountInput,
): Promise<{ countId: string; version: number }> {
  if (!Number.isSafeInteger(input.expected) || input.expected < 0
    || !Number.isSafeInteger(input.counted) || input.counted < 0) {
    throw new OtError("count_mismatch", "expected and counted must be non-negative integers");
  }
  // The engine first: an attempt by one nurse to be both people is a fact worth recording even
  // though the CHECK would refuse the row anyway.
  await assertNotSodPair(db, "scrub_circulating",
    { type: "user", id: input.scrubBy }, { type: "user", id: input.circulatingBy });

  return withTx(db, async (tx) => {
    const existing = (await tx.select().from(otCounts).where(and(
      eq(otCounts.caseId, input.caseId), eq(otCounts.round, input.round), eq(otCounts.itemType, input.itemType),
    )))[0];

    if (existing === undefined) {
      const countId = newId();
      await tx.insert(otCounts).values({
        id: countId, caseId: input.caseId, round: input.round, itemType: input.itemType,
        expected: input.expected, counted: input.counted,
        scrubBy: input.scrubBy, circulatingBy: input.circulatingBy, version: 1,
      });
      return { countId, version: 1 };
    }

    if (input.version === undefined || input.version !== existing.version) {
      throw new OtError(
        "stale_version",
        `this ${input.round} ${input.itemType} count was version ${String(existing.version)} when you read it and is now being written at ${String(input.version ?? 0)} — re-read it`,
        { current: existing.version, submitted: input.version ?? null },
      );
    }
    const updated = await tx.update(otCounts)
      .set({
        expected: input.expected, counted: input.counted,
        scrubBy: input.scrubBy, circulatingBy: input.circulatingBy,
        version: existing.version + 1, recordedAt: new Date(),
      })
      // The version is in the WHERE as well as in the check above: the read-then-write between them
      // is what a second writer slips through, and this makes the update itself single-winner.
      .where(and(eq(otCounts.id, existing.id), eq(otCounts.version, existing.version)))
      .returning({ id: otCounts.id, version: otCounts.version });
    if (updated.length === 0) {
      throw new OtError("stale_version", `the ${input.round} ${input.itemType} count was written concurrently — re-read it`);
    }
    return { countId: updated[0]!.id, version: updated[0]!.version };
  });
}

/** Every count row of one case, for the cockpit and for the sign-out gate. */
export async function countsFor(exec: Db | Tx, caseId: string): Promise<CountRow[]> {
  return exec.select().from(otCounts).where(eq(otCounts.caseId, caseId));
}

/**
 * ═══ CLOSE REVIEW (MINOR 19) — SIGN-OUT'S RE-CHECK HAS TO HOLD WHAT IT READ ═══
 *
 * `signOut` re-verifies the counts inside its transaction, which is right, but the read took no
 * lock — so a `recordCount` writing a MISMATCHING final row could commit between that read and the
 * transition, and the case would sign out over a discrepancy that exists in the table by the time
 * anybody looks. That is the one thing the count spine is for.
 *
 * `FOR UPDATE` on the case's count rows closes it: the concurrent writer either lands before the
 * read (and is seen) or blocks until the sign-out commits (and then finds the case already signed
 * out). Plan 14's C1 warned that `FOR UPDATE` cannot lock a row that does not exist — that is not
 * this shape, because the row this guards against is one that ALREADY exists in the losing case,
 * and a brand-new final row racing an empty table is caught by `finalCountVerdict`'s "no final
 * round is not agreement either" rule (H8).
 */
export async function lockedCountsFor(tx: Tx, caseId: string): Promise<CountRow[]> {
  return tx.select().from(otCounts).where(eq(otCounts.caseId, caseId)).for("update");
}

/**
 * A14 — **THE DERIVED VERDICT, and the round it is derived FROM is the point.**
 *
 * Only `final` rows decide sign-out. The mutant reads `initial` — which is the round that is
 * ALWAYS correct, because it is the count taken before anything has been used. A case with
 * initial 10/10 and final 10/9 is a retained swab, and an implementation that reads the wrong
 * round reports it as fine.
 *
 * A case with NO final round at all is also not correct: `mismatches` returns a marker for it, so
 * "we never counted" cannot pass as "the counts agree" (the vacuity §2.49 warns about, on a
 * surgical count).
 */
export function finalCountVerdict(rows: CountRow[]): { ok: boolean; mismatches: CountRow[]; counted: number } {
  const finals = rows.filter((r) => r.round === "final");
  const mismatches = finals.filter((r) => r.expected !== r.counted);
  return { ok: finals.length > 0 && mismatches.length === 0, mismatches, counted: finals.length };
}

/**
 * DD7 — the hard stop. Opens a `count_mismatch` incident on the case and emits both events. The
 * case STAYS where it is; the only exits are a corrected recount (a new version, both actors again)
 * or the two-actor override with an X-ray reference.
 */
export async function openCountMismatch(
  tx: Tx, actor: Actor, caseId: string, mismatches: CountRow[],
): Promise<{ incidentId: string }> {
  const kase = (await tx.select().from(otCases).where(eq(otCases.id, caseId)))[0];
  if (!kase) throw new OtError("unknown_case", `unknown case ${caseId}`);
  const incidentId = newId();
  await tx.insert(otIncidents).values({
    id: incidentId, encounterId: kase.encounterId, caseId, kind: "count_mismatch",
    detail: {
      mismatches: mismatches.map((m) => ({
        itemType: m.itemType, expected: m.expected, counted: m.counted, round: m.round,
      })),
    },
    reportedBy: actor.id,
  });
  for (const m of mismatches) {
    await appendEvent(tx, countMismatch.make({
      actor, patientId: kase.patientId, encounterId: kase.encounterId,
      payload: { caseId, round: m.round, itemType: m.itemType, expected: m.expected, counted: m.counted },
    }));
  }
  await appendEvent(tx, incidentReported.make({
    actor, patientId: kase.patientId, encounterId: kase.encounterId,
    payload: { incidentId, encounterId: kase.encounterId, caseId, kind: "count_mismatch" },
  }));
  return { incidentId };
}
