import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { interfaces } from "../db/schema";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import { interfaceDown, interfaceRestored } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";

// PLAN 11c D6 — §11.14's INTERFACE HEARTBEAT FRAMEWORK. The seam ships; a synthetic proves it.
//
// Stage 1 has no physical printers. What this file delivers is the SEAM 11b's real printer and
// scanner registration lands on — a device says "I am alive", a job notices when one stops saying
// it, and both edges leave an event a human can be woken up for. The behaviour is complete and
// tested against a synthetic registrant; only the devices are pending.
//
// THREE RULES, AND EACH ONE IS A FIXTURE IN `interfaces.test.ts` RATHER THAN A CLAIM HERE:
//
//   1. The sweep downs only ACTIVE rows currently `up` whose `last_seen_at` is older than THEIR
//      OWN `stale_after_ms` (Book V9). Per row, never a global constant.
//   2. A REGISTERED-BUT-NEVER-SEEN INTERFACE IS NEVER DOWNED (Book V10). `last_seen_at IS NULL`
//      means `unknown`, and `unknown` is not `down`: nothing has been lost, so an event would be
//      noise on every deployment that registered a device before plugging it in.
//   3. A heartbeat flips `unknown → up` SILENTLY and `down → up` WITH `interface.restored`
//      (Book V11). The silent edge is the common one — every commissioned device crosses it once
//      — and the loud edge is the one an incident review reads.
//
// NEITHER WRITE PATH READS THE WALL CLOCK. `now` is a parameter with a `new Date()` default
// everywhere (GC8), so every instant in a test is derived from that test's own pin.
//
// EVERY STATUS TRANSITION IS A CONDITIONAL UPDATE WITH `.returning()`, AND THAT IS NOT DECORATION.
// The scheduler's advisory lock is noise-reduction ONLY (`kernel/worker/scheduler.ts` D3) — no
// sweep's correctness may depend on it — so two workers running this sweep in the same second must
// not both append `interface.down` for the same device. `UPDATE … WHERE status = 'up' RETURNING`
// is the shipped single-winner shape (and since 11d D10 the SWEEP's own claim additionally names
// `last_seen_at` — this sentence describes the property, not the whole WHERE clause):
// the loser updates zero rows, gets an empty array back and
// appends nothing.

/** The three statuses `interfaces.status` may hold. `unknown` is what a fresh registration is. */
export const INTERFACE_STATUSES = ["unknown", "up", "down"] as const;
export type InterfaceStatus = (typeof INTERFACE_STATUSES)[number];

/** D6's device kinds. A code constant at stage 1, promotable to data when a real device demands it. */
export const INTERFACE_KINDS = ["printer", "scanner", "other"] as const;
export type InterfaceKind = (typeof INTERFACE_KINDS)[number];

/**
 * D6's per-device staleness floor and default, in ONE place because two places would drift.
 *
 * The floor is 30 s and it is not arbitrary: the sweep's own shipped cadence is
 * `WORKER_INTERFACE_SWEEP_INTERVAL_MS` = 60 000, so a window shorter than one sweep interval would
 * mark a perfectly healthy device down on the first tick after every heartbeat — an alert storm
 * produced entirely by arithmetic. 30 s is the smallest window an operator can ask for and still
 * be describing a real outage rather than the sampling grid.
 */
export const INTERFACE_STALE_AFTER_MIN_MS = 30_000;
export const INTERFACE_STALE_AFTER_DEFAULT_MS = 180_000;

/**
 * The registration body, exported so the controller and this module cannot disagree about the
 * floor above. `location` is optional — a device nobody has told us where to find is still a
 * device worth watching.
 */
export const interfaceRegistrationSchema = z.object({
  kind: z.enum(INTERFACE_KINDS),
  name: z.string().min(1).max(200),
  location: z.string().max(200).nullish(),
  staleAfterMs: z.coerce
    .number()
    .int()
    .min(INTERFACE_STALE_AFTER_MIN_MS)
    .default(INTERFACE_STALE_AFTER_DEFAULT_MS),
});
export type InterfaceRegistration = z.infer<typeof interfaceRegistrationSchema>;

/** The row as every read surface renders it. `lastSeenAt` is an ISO instant or null (never seen). */
export type InterfaceView = {
  id: string;
  kind: string;
  name: string;
  location: string | null;
  staleAfterMs: number;
  status: InterfaceStatus;
  lastSeenAt: string | null;
  active: boolean;
};

/** The house convention for a refusal a controller maps once (`ModeError` beside it, `ApprovalError`). */
export class InterfaceError extends Error {
  constructor(
    readonly code: "interface_not_found",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "InterfaceError";
  }
}

/** The sweep and the heartbeat are system writes; a heartbeat carries its caller's actor instead. */
const SWEEP_ACTOR: Actor = { type: "system", id: "interface-sweep" };

type Row = typeof interfaces.$inferSelect;

function toView(row: Row): InterfaceView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    location: row.location,
    staleAfterMs: row.staleAfterMs,
    status: row.status as InterfaceStatus,
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
    active: row.active,
  };
}

/**
 * Register a device. NO EVENT IS APPENDED, deliberately (the catalog's own no-per-run-noise rule):
 * a registration is a configuration act with a row of its own, and the two names this plan adds to
 * `ops/events.ts` are the two LIVENESS EDGES, which is what a human is woken up for.
 *
 * The row starts `unknown` with `last_seen_at` NULL — the schema's defaults, restated as explicit
 * values here so a reader of this function does not have to open the schema to learn what state a
 * fresh device is in, and so Book V10's "never seen" fixture is produced by this function rather
 * than by a column default that a later migration could quietly change.
 */
export async function registerInterface(
  db: Db,
  input: InterfaceRegistration,
  now: Date = new Date(),
): Promise<InterfaceView> {
  const id = newId();
  const rows = await db
    .insert(interfaces)
    .values({
      id,
      kind: input.kind,
      name: input.name,
      location: input.location ?? null,
      staleAfterMs: input.staleAfterMs,
      status: "unknown",
      lastSeenAt: null,
      active: true,
      createdAt: now,
    })
    .returning();
  return toView(rows[0]!);
}

/** Newest last: `seq` is the only monotone column (`newId()` is a non-monotonic ULID — audit A1). */
export async function listInterfaces(db: Db): Promise<InterfaceView[]> {
  const rows = await db.select().from(interfaces).orderBy(asc(interfaces.seq));
  return rows.map(toView);
}

/**
 * Retire a device. `active = false` takes it out of the SWEEP's population and nothing else — its
 * status column is left exactly as it stands, because rewriting it would either invent an outage
 * (`down`) or erase one that was real (`up`). A retired device simply stops being asked about.
 */
export async function deactivateInterface(db: Db, id: string): Promise<InterfaceView> {
  const rows = await db
    .update(interfaces)
    .set({ active: false })
    .where(eq(interfaces.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new InterfaceError("interface_not_found", `no interface ${id}`);
  return toView(row);
}

export type HeartbeatResult = {
  interfaceId: string;
  status: InterfaceStatus;
  /** True only on the `down → up` edge — the one edge that appends an event (Book V11). */
  restored: boolean;
  eventId: string | null;
};

/**
 * A DEVICE SAYS IT IS ALIVE.
 *
 * `last_seen_at` moves to `now` on every call; the STATUS moves to `up` from wherever it was. The
 * only edge that is loud is `down → up` (Book V11) — and the mutant that "drops the flip" is
 * precisely a version that moves `last_seen_at` and leaves `status` alone, which is why the test
 * asserts BOTH columns and not just the timestamp.
 *
 * THE DOWN EDGE IS CLAIMED CONDITIONALLY (`WHERE status = 'down' RETURNING`), so exactly one caller
 * can win it. Two devices' agents racing the same restore — or a retry of one — append exactly one
 * `interface.restored` between them; the loser falls through to the unconditional update below and
 * appends nothing. The whole thing is one transaction: the row and its event are one append.
 *
 * `active` IS NOT CONSULTED. A retired device that starts talking again is recorded as alive
 * because that is what happened; `active` gates the SWEEP's population (see `deactivateInterface`),
 * not the truth of a heartbeat.
 */
export async function recordHeartbeat(
  db: Db,
  actor: Actor,
  id: string,
  now: Date = new Date(),
): Promise<HeartbeatResult> {
  return withTx(db, async (tx: Tx): Promise<HeartbeatResult> => {
    // The `down` claim first, and it returns the row as it looks AFTER the update — so the
    // instant the outage is measured from is read BEFORE, in the same statement's WHERE-matched
    // row, by selecting it here rather than trusting the returned (already-moved) value.
    const before = await tx
      .select({ status: interfaces.status, lastSeenAt: interfaces.lastSeenAt })
      .from(interfaces)
      .where(eq(interfaces.id, id))
      .for("update");
    const prior = before[0];
    if (prior === undefined) {
      throw new InterfaceError("interface_not_found", `no interface ${id}`);
    }

    const won = await tx
      .update(interfaces)
      .set({ status: "up", lastSeenAt: now })
      .where(and(eq(interfaces.id, id), eq(interfaces.status, "down")))
      .returning();
    const restoredRow = won[0];

    if (restoredRow === undefined) {
      // `unknown → up` (silent, the common commissioning edge) or `up → up` (the every-60-s
      // no-op). Both move the timestamp and neither appends anything.
      await tx.update(interfaces).set({ status: "up", lastSeenAt: now }).where(eq(interfaces.id, id));
      return { interfaceId: id, status: "up", restored: false, eventId: null };
    }

    const { eventId } = await appendEvent(
      tx,
      interfaceRestored.make({
        actor,
        occurredAt: now,
        // No patientId, ever (GC6): a device's liveness is a hospital-wide fact.
        payload: {
          interfaceId: restoredRow.id,
          kind: restoredRow.kind,
          name: restoredRow.name,
          seenAt: now.toISOString(),
          downSince: prior.lastSeenAt === null ? null : prior.lastSeenAt.toISOString(),
        },
      }),
    );
    return { interfaceId: id, status: "up", restored: true, eventId };
  });
}

export type InterfaceDowned = {
  interfaceId: string;
  name: string;
  kind: string;
  lastSeenAt: Date;
  staleAfterMs: number;
  eventId: string;
};

/**
 * THE TENTH JOB (D6). Registered in `kernel/worker/jobs.ts` as an `every` job at
 * `WORKER_INTERFACE_SWEEP_INTERVAL_MS` (default 60 000) — the cadence is a real config key, so
 * `JobIntervals` widened and every `JobIntervals` object literal in the suite had to admit it.
 *
 * THE CANDIDATE SET IS THE WHOLE OF BOOK V9 AND V10, and each clause earns its place:
 *
 *   `active = true`      — a retired device is not an outage.
 *   `status = 'up'`      — `down` is already down (downing it twice would re-alert every tick),
 *                          and `unknown` is Book V10: never seen, nothing lost, no event.
 *   `last_seen_at NOT NULL` — the same rule stated in the column that carries it, so a row whose
 *                          status was set to `up` by something other than a heartbeat still cannot
 *                          produce an `interface.down` that names no instant.
 *
 * THE STALENESS COMPARISON IS PER ROW AND IT IS DONE IN JS, not in SQL, and that is a decision:
 * this is a device REGISTRY — tens of rows in a hospital, not millions — so the whole candidate set
 * is one indexed read (`interfaces_status_active_idx`) and the arithmetic that decides an outage is
 * plain, readable and unit-testable rather than an `interval` expression whose parameter typing is
 * a Postgres detail. `>` is STRICT: a device seen exactly `stale_after_ms` ago is not yet late.
 *
 * The update is conditional on `status = 'up'` for the reason the file header gives: correctness
 * must not rest on the scheduler's advisory lock. One row per transaction, like
 * `sweepExpiredTempRoles` — a device that fails to flip does not hold back the others.
 *
 * AND IT IS CONDITIONAL ON `last_seen_at` TOO (11d D10), because the candidate read above happens
 * OUTSIDE any transaction: a heartbeat landing between that read and this claim moves the sighting
 * and leaves the status at `up`, so a claim that named only the status still matched and a WORKING
 * device was marked down with a false `interface.down`. `recordHeartbeat` already takes
 * `FOR UPDATE`, so the two DO serialise — they were simply serialising on a predicate that could
 * not see the update that mattered. Requiring the sighting to still be the one the read saw makes a
 * moved timestamp lose the claim exactly as a moved status already does; the loser updates zero
 * rows and appends nothing, which is the same shape the paragraph above describes. `interfaces.test.ts`
 * measures it over a floor of rounds (V20) and asserts the legitimate path is untouched (V21).
 */
export async function sweepInterfaceHeartbeats(
  db: Db,
  now: Date = new Date(),
): Promise<InterfaceDowned[]> {
  const candidates = await db
    .select()
    .from(interfaces)
    .where(
      and(
        eq(interfaces.active, true),
        eq(interfaces.status, "up"),
        isNotNull(interfaces.lastSeenAt),
      ),
    )
    .orderBy(asc(interfaces.seq));

  const downed: InterfaceDowned[] = [];
  for (const row of candidates) {
    const lastSeenAt = row.lastSeenAt;
    if (lastSeenAt === null) continue; // unreachable behind the predicate; the typechecker wants it
    if (now.getTime() - lastSeenAt.getTime() <= row.staleAfterMs) continue;

    const result = await withTx(db, async (tx: Tx): Promise<InterfaceDowned | null> => {
      const won = await tx
        .update(interfaces)
        .set({ status: "down" })
        .where(
          and(
            eq(interfaces.id, row.id),
            eq(interfaces.status, "up"),
            eq(interfaces.lastSeenAt, lastSeenAt),
          ),
        )
        .returning({ id: interfaces.id });
      if (won.length === 0) return null; // another worker downed it this tick — append nothing

      const { eventId } = await appendEvent(
        tx,
        interfaceDown.make({
          actor: SWEEP_ACTOR,
          occurredAt: now,
          // No patientId, ever (GC6).
          payload: {
            interfaceId: row.id,
            kind: row.kind,
            name: row.name,
            lastSeenAt: lastSeenAt.toISOString(),
            staleAfterMs: row.staleAfterMs,
          },
        }),
      );
      return {
        interfaceId: row.id,
        name: row.name,
        kind: row.kind,
        lastSeenAt,
        staleAfterMs: row.staleAfterMs,
        eventId,
      };
    });
    if (result !== null) downed.push(result);
  }
  return downed;
}
