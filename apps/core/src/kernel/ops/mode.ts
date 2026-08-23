import { desc, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { configValidationReports, operatingModeChanges } from "../db/schema";
import { appendEvent } from "../events/append";
import { modeChanged } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";
import type { OperatingMode } from "../db/schema/ops";

export { OPERATING_MODES } from "../db/schema/ops";
export type { OperatingMode } from "../db/schema/ops";

/**
 * D3's freshness window. The only way out of `commissioning` is through a validation report that
 * is PERSISTED, ALL-GREEN and NOT OLDER THAN THIS — which is what stops D-17 from being a script
 * nobody is forced to run.
 */
export const VALIDATION_FRESH_HOURS = 24;

/**
 * Entering either of these is an event a human is woken up for, so it may not happen silently: a
 * note is mandatory (D2 / Book V4), and the alerts consumer raises an owner alert (D4 / Book V6).
 */
export const MODES_REQUIRING_NOTE: readonly OperatingMode[] = ["downtime", "degraded"];

export type ModeErrorCode =
  | "mode_commissioning_is_initial_only"
  | "golive_gate_unsatisfied"
  | "mode_note_required"
  | "mode_unchanged";

/** Why the go-live gate said no. Named, because "refused" alone tells the duty manager nothing. */
export type GateDetail = "no_report" | "stale_report" | "report_not_ok";

/** The house convention for a refusal a controller maps once (`ApprovalError` / `AlertsError`). */
export class ModeError extends Error {
  constructor(
    readonly code: ModeErrorCode,
    readonly detail?: GateDetail,
    message?: string,
  ) {
    super(message ?? (detail === undefined ? code : `${code}: ${detail}`));
    this.name = "ModeError";
  }
}

/**
 * ZERO ROWS READS AS `commissioning`, AND THAT IS LOAD-BEARING RATHER THAN A FALLBACK (D1 / Book
 * V1). A freshly-migrated deployment — including the production stack as it stands today, which
 * is UAT and not a go-live — IS commissioning until D-17's gate passes. A default of `normal`
 * would mean every new deployment silently claimed to be a running hospital.
 *
 * ORDER BY `seq`, NEVER `id` AND NEVER `at` (§3.26 / audit A1). `newId()` is a plain `ulid()`, so
 * two changes inside one millisecond sort by 80 bits of randomness; `at` is an injected clock
 * value that two callers can legitimately share. The `bigserial` is the only column the database
 * itself guarantees to be monotone in insertion order.
 *
 * ONE INDEXED SELECT, NO CACHE, NO MIDDLEWARE (GC5). The api runs multi-process; an in-memory
 * mode would be a different answer per worker within milliseconds of a declaration.
 */
export async function getOperatingMode(exec: Db | Tx): Promise<OperatingMode> {
  const rows = await exec
    .select({ toMode: operatingModeChanges.toMode })
    .from(operatingModeChanges)
    .orderBy(desc(operatingModeChanges.seq))
    .limit(1);
  const row = rows[0];
  return row === undefined ? "commissioning" : (row.toMode as OperatingMode);
}

export type ModeChangeInput = {
  to: OperatingMode;
  note?: string | null;
};

export type ModeChangeResult = {
  id: string;
  from: OperatingMode;
  to: OperatingMode;
  note: string | null;
  reportId: string | null;
  eventId: string;
};

/**
 * THE TRANSITION MATRIX IS CODE, NOT DEFINITION DATA (D2). Operating mode bears no SLA, no
 * approver ladder and no per-subject instances, and the decisive reason it is not a workflow
 * instance is dependency direction: A DOWNTIME DECLARATION MUST NOT DEPEND ON THE WORKFLOW ENGINE
 * BEING HEALTHY, because degraded-and-down is exactly when it is declared. This function depends
 * on the database and the event append and nothing else.
 *
 * The four refusals, and the order they are evaluated in — the order is deliberate and each step
 * says why it sits where it does:
 *
 *   1. `mode_commissioning_is_initial_only` — `commissioning` is what an empty table reads as and
 *      is NEVER a target. Checked FIRST OF THE FOUR because it is categorical: no state of the
 *      world makes it legal, so it does not deserve a LEDGER READ to establish. It is no longer
 *      the first STATEMENT in the function — 11d D5's advisory lock is, and the block above it
 *      says why — but that reason is untouched: the lock reads no row of `operating_mode_changes`.
 *   2. `mode_unchanged` — a no-op transition is refused so the history never carries a change
 *      that changed nothing, and so `downtime → downtime` cannot quietly re-alert every owner.
 *   3. `mode_note_required` — entering `downtime` or `degraded` without a note. Before the gate
 *      because it is input validation over an argument, and a caller who forgot the note should
 *      be told that whether or not the go-live gate would also have refused.
 *   4. `golive_gate_unsatisfied` — D3. See `assertGoLiveGate` below.
 *
 * `reportId` IS NOT AN ARGUMENT. It is filled from the report the guard itself read, so the row
 * can never claim an authorisation that never happened — a caller-supplied id would let a client
 * name any report it liked.
 *
 * Tx-typed on purpose: the row and its event are ONE append. `now` is injected (GC8); nothing
 * here reads the wall clock.
 */
export async function changeOperatingMode(
  tx: Tx,
  actor: Actor,
  input: ModeChangeInput,
  now: Date = new Date(),
): Promise<ModeChangeResult> {
  /**
   * 11d D5 / MAJOR 1 — THE DECISION IS SERIALISED, NOT MERELY THE WRITE, AND THIS IS THE FIRST
   * STATEMENT OF THE FUNCTION ON PURPOSE. Every clause below was measured before it was written.
   *
   * WHAT IT FIXES. Under READ COMMITTED all four refusals below are check-then-act with nothing
   * between the check and the act. 11c's discovery reviewer measured what that costs, 15 rounds
   * per case: two identical `normal → downtime` declarations BOTH appended in 14/15; a concurrent
   * `→ downtime` and `→ degraded` BOTH succeeded in 15/15, leaving `current = degraded` while the
   * duty manager who declared downtime had been told the hospital was in downtime; and two
   * concurrent go-live exits left TWO `commissioning` exit rows in 15/15.
   *
   * `pg_advisory_xact_lock`, NOT `select … FOR UPDATE`. A row lock can only serialise callers that
   * find a row, and the commissioning exit is the case with NO ROWS AT ALL — `getOperatingMode`
   * reads zero rows and answers `commissioning`, which its own header explains is load-bearing
   * rather than a fallback. That zero-row case is exactly the third measured case, so a primitive
   * that cannot cover it is the wrong primitive however natural it looks beside a `select`.
   *
   * THE `_xact_` VARIANT, NOT THE SESSION VARIANT `kernel/worker/scheduler.ts` ALREADY USES. That
   * file's `pgLocks` header records the discipline a session-scoped lock imposes: it pins ONE
   * checked-out pooled client for the lock's whole lifetime and must be explicitly unlocked, so
   * releasing the client without unlocking leaves the lock held until that connection happens to
   * close. A transaction-scoped lock is released by COMMIT **or ROLLBACK** — the only discipline
   * that survives a `ModeError` thrown between here and the append, and this function throws on
   * four separate paths. MEASURED (spike Question A): a throw between the lock and the append left
   * ZERO granted advisory locks anywhere, and the next transaction acquired in 1.5-1.8 ms against
   * the ~203 ms of a genuinely contended acquisition. **So none of the four refusals below needs
   * an unlock call** — which is the first thing a reader will worry about, and adding one would be
   * the actual bug: it would drop the lock while the transaction still holds what it was taken to
   * protect.
   *
   * FIRST — AHEAD OF THE `commissioning` REFUSAL AND AHEAD OF `getOperatingMode(tx)`, BOTH. A lock
   * taken after the read serialises the WRITES and not the DECISIONS, so the second measured case
   * survives it completely intact: both callers read `normal`, both decide on it, and one of them
   * is told a transition the ledger then contradicts. Book V11 is a row of its own for exactly
   * this, because a correctly-named lock in the wrong place reads as correct in every code review.
   *
   * THE PRIMITIVE ITSELF IS MEASURED, NOT ASSUMED (spike Question A, five runs, each against a
   * control that would have caught a trivially-true result): `withTx` holds ONE backend for the
   * transaction's life; against a 200 ms hold the loser waited 203.0-204.0 ms where the identical
   * choreography with this statement removed waited 0 ms in all five; `pg_locks` named the wait
   * exactly (`locktype=advisory`, `mode=ExclusiveLock`, `objid=774876239`) where the no-lock
   * control's same snapshot returned no rows at all; and after acquiring, the loser's re-read SEES
   * the winner's committed row. `hashtext('hmis.operating_mode')` is `774876239`, widening to the
   * single-argument `pg_advisory_xact_lock(bigint)` overload — the same resolution `scheduler.ts`
   * already relies on — and calling it twice in one transaction does not self-deadlock.
   */
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"hmis.operating_mode"}))`);

  const to = input.to;
  if (to === "commissioning") {
    throw new ModeError(
      "mode_commissioning_is_initial_only",
      undefined,
      "commissioning is the initial mode and can never be a transition target",
    );
  }

  const from = await getOperatingMode(tx);
  if (to === from) {
    throw new ModeError("mode_unchanged", undefined, `already in mode ${from}`);
  }

  const note = normaliseNote(input.note);
  if (MODES_REQUIRING_NOTE.includes(to) && note === null) {
    throw new ModeError("mode_note_required", undefined, `entering ${to} requires a note`);
  }

  // Leaving commissioning AT ALL rides the gate, not merely leaving it for `ramp`/`normal`. D2's
  // matrix says "leaving `commissioning` requires D3's gate" and D3 names ramp|normal only
  // because they are the realistic targets; gating just those two would leave
  // `commissioning → downtime → normal` as a two-step way around D-17 entirely.
  const reportId = from === "commissioning" ? await assertGoLiveGate(tx, now) : null;

  const id = newId();
  await tx.insert(operatingModeChanges).values({
    id,
    fromMode: from,
    toMode: to,
    note,
    reportId,
    actorId: actor.id,
    at: now,
  });

  const { eventId } = await appendEvent(
    tx,
    modeChanged.make({
      actor,
      occurredAt: now,
      // No patientId, ever (GC6): a mode change is a hospital-wide fact and this event is fanned
      // to browsers through `alert.raised`.
      //
      // `changeId` IS THE ROW INSERTED FOUR LINES ABOVE, IN THIS SAME TRANSACTION (11d D6). The
      // payload could not carry it before, so every consumer downstream had to refer to the change
      // by its MODE WORD — which is not an identity and cannot be deep-linked.
      payload: { changeId: id, from, to, note, reportId },
    }),
  );

  return { id, from, to, note, reportId, eventId };
}

/** Whitespace-only is not a note. `""` and `"   "` are refusals, not values. */
function normaliseNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const trimmed = note.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * D3 — E-10 AND D-17 COMPOSE INTO ONE GUARD, and this is the whole of it.
 *
 * IT READS THE PERSISTED LATEST ROW, BY `seq` (Book V8's mutant class). Not a value the caller
 * passed, not a value some earlier run held in memory, and not "any ok row that exists": a
 * validation that passed last week and a validation that passed and was then superseded by a red
 * one are exactly the two states a hospital must not be allowed to go live on. `ORDER BY seq DESC
 * LIMIT 1` is the only read here, for the same non-monotonic-ULID reason `getOperatingMode` gives.
 *
 * The three details, and why `report_not_ok` is checked before `stale_report`: a report that is
 * red is red whatever its age, and telling the duty manager "your report is stale" about a report
 * that also FAILED would send them to re-run it rather than to fix the configuration.
 *
 * Returns the id of the report that satisfied the gate — the caller records it on the change row.
 */
async function assertGoLiveGate(tx: Tx, now: Date): Promise<string> {
  const rows = await tx
    .select({ id: configValidationReports.id, ok: configValidationReports.ok, at: configValidationReports.at })
    .from(configValidationReports)
    .orderBy(desc(configValidationReports.seq))
    .limit(1);

  const latest = rows[0];
  if (latest === undefined) {
    throw new ModeError(
      "golive_gate_unsatisfied",
      "no_report",
      "no configuration validation report has ever been recorded",
    );
  }
  if (!latest.ok) {
    throw new ModeError(
      "golive_gate_unsatisfied",
      "report_not_ok",
      `the latest configuration validation report (${latest.id}) is not ok`,
    );
  }
  const ageMs = now.getTime() - latest.at.getTime();
  if (ageMs > VALIDATION_FRESH_HOURS * 60 * 60 * 1000) {
    throw new ModeError(
      "golive_gate_unsatisfied",
      "stale_report",
      `the latest configuration validation report (${latest.id}) is older than ${VALIDATION_FRESH_HOURS}h`,
    );
  }
  return latest.id;
}
