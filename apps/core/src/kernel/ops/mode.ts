import { desc } from "drizzle-orm";
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
 *      is NEVER a target. Checked FIRST because it is categorical: no state of the world makes it
 *      legal, so it does not deserve a database read to establish.
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
      payload: { from, to, note, reportId },
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
