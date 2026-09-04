import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  stockBalances, stockBatches, stockLedger, stockReservations,
} from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { batchRecalled } from "./events";
import { istDay } from "./grn";
import { requireStore } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type LedgerRow = typeof stockLedger.$inferSelect;
export type BalanceRow = typeof stockBalances.$inferSelect;
export type BatchRow = typeof stockBatches.$inferSelect;
export type ReservationRow = typeof stockReservations.$inferSelect;

/** DD6's five reasons. The sign is the reason's business, not the caller's. */
export type MovementReason = "grn" | "issue" | "receive" | "consume" | "return";

export type MovementInput = {
  resourceId: string;
  batchId: string;
  /** SIGNED. Positive INTO the resource, negative OUT of it. Never zero (`stock_ledger_qty_delta_ck`). */
  qtyDelta: number;
  reason: MovementReason;
  refType?: string | null;
  refId?: string | null;
  eventId?: string | null;
  patientId?: string | null;
  encounterId?: string | null;
  costCenter?: string | null;
  occurredAt: Date;
  /** The downtime convention: `occurred_at` MAY precede this. Defaults to the database's now. */
  recordedAt?: Date;
};

/**
 * PLAN 14 T5 / DD6 — **THE LEDGER. THE ONLY WRITER OF `stock_ledger` AND `stock_balances`.**
 *
 * ═══ THE FOUR PROPERTIES, AND WHERE EACH IS ENFORCED ═══
 *
 *   1. **APPEND-ONLY.** There is no update path and no delete path to `stock_ledger` anywhere in
 *      this codebase. That is not a trigger; it is the absence of code, and A11 is a grep as much
 *      as it is a test. The same holds for `stock_batches.ownership` (DD5).
 *   2. **BALANCES MOVE IN THE SAME TRANSACTION.** `stock_balances` is the read model billing,
 *      pharmacy and the board query. It is written by `postMovement` beside the ledger row, never
 *      by a projector, never eventually.
 *   3. **THE LOCK IS ORDERED AND IT IS A SET LOCK.** `select … order by resource_id, batch_id for
 *      update` in ONE statement — the `receipts.ts:637` shape, set-then-rows, never row-then-set.
 *      A9's mutant locks in the CALLER'S line order, which deadlocks two multi-line issues touching
 *      the same two batches in opposite orders.
 *   4. **NEGATIVE STOCK IS REFUSED, FULL STOP.** No backfill-order exception. A dispense recorded
 *      before its GRN during a downtime window is a real case (doc 16 H1) and it is 16c's, with
 *      11c's downtime kit. `occurred_at` MAY precede `recorded_at` — both columns exist for it —
 *      **but the balance check applies in RECORDED order**, because that is the order the rows
 *      actually arrived and the only order a lock can serialise.
 *
 * ═══ WHY THE CHECK IS IN CODE *AND* IN THE DATABASE ═══
 *
 * `stock_balances_non_negative_ck` defends the invariant against every write path including raw SQL
 * in a future migration, and it is the backstop. It cannot tell a caller WHY, though: a constraint
 * violation surfaces as a name and a 500. So the refusal is made here first, with
 * `insufficient_stock` and the numbers in `detail`, and the CHECK catches whatever this file has
 * not thought of. **A8's mutant is a `postMovement` that reads, checks, then updates without `for
 * update`** — against which the CHECK fires at COMMIT with a constraint name, or, if the CHECK were
 * missing, the balance simply goes negative.
 */

/** Available = on hand, minus what is spoken for, minus what is frozen. What an outbound may take. */
function available(row: { qtyOnHand: number; qtyReserved: number; qtyFrozen: number }): number {
  return row.qtyOnHand - row.qtyReserved - row.qtyFrozen;
}

/**
 * **THE ORDERED SET LOCK (DD6, A9).** One statement, `order by resource_id, batch_id`, mode FOR
 * UPDATE, over every `(resource, batch)` pair the caller is about to touch.
 *
 * The ORDER is the deadlock property and the SINGLE STATEMENT is the correctness property, and they
 * are different things:
 *   · Ordering by `(resource_id, batch_id)` rather than by the caller's line order means two
 *     multi-line issues touching batches X and Y in opposite orders acquire them in the SAME order
 *     and serialise instead of deadlocking (A9).
 *   · One statement rather than a loop means no window exists between the first lock and the last
 *     in which a third session can interleave.
 *
 * Rows that do not exist yet cannot be locked, and that is correct rather than a gap: a
 * `(resource, batch)` with no balance row has nothing to lose, and the INSERT that creates it takes
 * its own lock through the primary key. The refusal that matters — an outbound movement against a
 * balance that is not there — is `insufficient_stock`, raised below.
 */
async function lockBalances(tx: Tx, pairs: { resourceId: string; batchId: string }[]): Promise<void> {
  if (pairs.length === 0) return;
  const tuples = sql.join(
    pairs.map((p) => sql`(${p.resourceId}, ${p.batchId})`),
    sql`, `,
  );
  await tx.execute(sql`
    select resource_id, batch_id from stock_balances
    where (resource_id, batch_id) in (${tuples})
    order by resource_id, batch_id
    for update
  `);
}

/** The batch, or `unknown_batch`. Read INSIDE the lock so a concurrent recall cannot slip past. */
async function requireBatch(tx: Tx, batchId: string): Promise<BatchRow> {
  const rows = await tx.select().from(stockBatches).where(eq(stockBatches.id, batchId));
  const row = rows[0];
  if (row === undefined) throw new MaterialsError("unknown_batch", `batch ${batchId} not found`);
  return row;
}

/**
 * **THE ONE WRITER.** Locks, checks, upserts the balance, appends the row, returns the new balance.
 *
 * `postMovements` below is the multi-line form and is what callers with more than one line MUST
 * use — a loop over `postMovement` would take one lock per line and reintroduce exactly the
 * interleave A9 is about.
 */
export async function postMovement(
  tx: Tx,
  actor: Actor,
  input: MovementInput,
): Promise<{ ledgerEntryId: string; balanceAfter: number }> {
  const [result] = await postMovements(tx, actor, [input]);
  // `postMovements` returns one result per input and throws otherwise, so this is a type narrowing
  // rather than a possibility.
  if (result === undefined) throw new MaterialsError("negative_stock", "postMovement produced no result");
  return result;
}

/**
 * Several movements, ONE ordered set lock, ONE transaction (A9).
 *
 * Two lines against the SAME `(resource, batch)` are summed for the availability check rather than
 * checked one at a time, because checking them separately would let a pair that is individually
 * affordable and jointly not slip through — the classic aggregation defect, and the reason this
 * function exists at all rather than a loop in the caller.
 */
export async function postMovements(
  tx: Tx,
  actor: Actor,
  inputs: MovementInput[],
): Promise<{ ledgerEntryId: string; balanceAfter: number }[]> {
  if (inputs.length === 0) return [];
  for (const m of inputs) {
    if (!Number.isSafeInteger(m.qtyDelta) || m.qtyDelta === 0) {
      throw new MaterialsError(
        "negative_stock",
        `a movement of ${String(m.qtyDelta)} is not a movement — the ledger records changes (DD6)`,
        { qtyDelta: m.qtyDelta },
      );
    }
  }

  // THE LOCK, FIRST, over the DEDUPED pair set in a deterministic order.
  /**
   * The composite key for a `(resource, batch)` pair.
   *
   * **The separator is `\u0001`, written as an escape and never as a literal control character.**
   * The first version of this line carried a literal NUL byte, which made the whole file BINARY to
   * git — no diff, no blame, no line-level review on the most important file in the phase. Found by
   * the close pass's own `git show --stat`, which reported `Bin 0 -> 24638 bytes`.
   *
   * A control character is still the right SEPARATOR — resource and batch ids are ULIDs (Crockford
   * base32), so no id can contain one, and a printable separator would be a character an id could
   * in principle acquire. Writing it as an ESCAPE keeps the file text.
   */
  const SEP = "\u0001";
  const pairKey = (m: { resourceId: string; batchId: string }): string => `${m.resourceId}${SEP}${m.batchId}`;
  const pairs = [...new Map(inputs.map((m) => [pairKey(m), { resourceId: m.resourceId, batchId: m.batchId }])).values()];
  await lockBalances(tx, pairs);

  // Everything below happens INSIDE the lock.
  const balances = new Map<string, BalanceRow>();
  if (pairs.length > 0) {
    /**
     * CLOSE REVIEW m7 — **the predicate is the PAIR set, not the batch set.**
     *
     * This filtered on `batchId` alone, so it read EVERY store's balance of every batch touched and
     * threw all but the matching pairs away in the `Map`. On a batch held in forty stores an issue
     * of one line read forty rows to use one: O(stores) work for an O(1) answer, growing with the
     * hospital rather than with the movement. **The same shape Plan 13's CLOSE/M5 fixed in
     * `heightOf`** — a correct answer assembled in the application from an over-broad read.
     *
     * The `OR` of `(resource, batch)` equalities matches `stock_balances`' primary key exactly, so
     * it reads precisely the rows `lockBalances` just locked and no others.
     */
    const rows = await tx.select().from(stockBalances)
      .where(or(...pairs.map((p) => and(
        eq(stockBalances.resourceId, p.resourceId),
        eq(stockBalances.batchId, p.batchId),
      ))));
    for (const r of rows) balances.set(pairKey(r), r);
  }

  // The NET delta per pair, so two lines against one balance are checked together.
  const net = new Map<string, number>();
  for (const m of inputs) net.set(pairKey(m), (net.get(pairKey(m)) ?? 0) + m.qtyDelta);

  const batches = new Map<string, BatchRow>();
  for (const batchId of new Set(inputs.map((m) => m.batchId))) {
    batches.set(batchId, await requireBatch(tx, batchId));
  }

  for (const m of inputs) {
    const batch = batches.get(m.batchId);
    if (batch === undefined) throw new MaterialsError("unknown_batch", `batch ${m.batchId} not found`);
    // DD14 — a frozen batch refuses every OUTBOUND movement. Inbound is refused at the GRN gate
    // (DD8 rule 8) rather than here, so that a `return` of already-issued stock into quarantine
    // stays possible: the safe direction for a recalled batch is "back", never "out".
    if (batch.recallStatus === "frozen" && m.qtyDelta < 0) {
      throw new MaterialsError(
        "batch_frozen",
        `batch ${batch.batchNo} is recall-frozen and no stock may leave any location (DD14)`,
        { batchId: m.batchId, batchNo: batch.batchNo },
      );
    }
  }

  for (const [key, delta] of net) {
    if (delta >= 0) continue;
    const current = balances.get(key);
    const avail = current === undefined ? 0 : available(current);
    if (avail < -delta) {
      const [resourceId, batchId] = key.split(SEP);
      throw new MaterialsError(
        "insufficient_stock",
        `store holds ${String(avail)} available of this batch; the movement needs ${String(-delta)}`,
        {
          resourceId, batchId, available: avail, required: -delta,
          onHand: current?.qtyOnHand ?? 0, reserved: current?.qtyReserved ?? 0, frozen: current?.qtyFrozen ?? 0,
        },
      );
    }
  }

  const results: { ledgerEntryId: string; balanceAfter: number }[] = [];
  for (const m of inputs) {
    /**
     * ═══ CLOSE REVIEW C1 — THE UPSERT IS AN INCREMENT, AND IT MUST STAY ONE ═══
     *
     * This wrote an APPLICATION-COMPUTED ABSOLUTE VALUE (`before + delta`, from a read taken before
     * the insert) and it was a LOST UPDATE on the one path `lockBalances` cannot cover.
     *
     * `SELECT … FOR UPDATE` locks rows that EXIST. For a `(resource, batch)` pair with no balance
     * row yet, it locks nothing — the docstring above says so and then argues the gap away on the
     * grounds that "the INSERT that creates it takes its own lock through the primary key". **That
     * is true and it is not sufficient.** Under `INSERT … ON CONFLICT DO UPDATE`, the second
     * session blocks on the first's tuple and then takes the DO UPDATE path — writing ITS OWN
     * absolute value over the winner's. Both had read 0; both write `q`; the ledger sums to `2q`.
     *
     * **Reachable through three shipped routes**, all with a batch that exists and a
     * `(store, batch)` balance that does not: two concurrent `postGrn`s of one batch into a store
     * that has never held it; two concurrent `issueStock`s from DIFFERENT sources into the shared
     * `IN-TRANSIT` store; two concurrent `receiveStock`s into a destination new to the batch. The
     * loss lands HIGH, so `stock_balances_non_negative_ck` never fires — which is the corrected A8
     * note's own lesson ("the CHECK is not the backstop for this case; only the lock is") applied
     * to the case the lock does not reach.
     *
     * The increment below is atomic at the row level: Postgres evaluates
     * `stock_balances.qty_on_hand + delta` against the LOCKED, POST-WINNER row, so the two
     * transactions compose instead of overwriting. `RETURNING` then gives the TRUE post-value
     * rather than the caller's arithmetic — which also removes the `after` map that existed only to
     * simulate it, and which was itself wrong under contention.
     *
     * `reserveStock` and `releaseReservation` already used the increment form. This file no longer
     * contains two answers to one question.
     *
     * ═══ SECOND-PASS FINDING R2 — WHY THIS IS **TWO STATEMENTS** AND NOT ONE UPSERT ═══
     *
     * The first version of this fix kept the single `INSERT … ON CONFLICT DO UPDATE` and moved only
     * the `set:` clause to an increment, leaving `values({ qtyOnHand: m.qtyDelta })` as the proposed
     * row. **It failed five ledger tests and eight consumer tests outright**, every one of them on
     * `stock_balances_non_negative_ck`, and the reason is a Postgres ordering fact worth writing
     * down because it is not obvious from the statement:
     *
     * **A CHECK constraint is evaluated against the PROPOSED tuple, BEFORE the unique index reports
     * the conflict that would have sent execution down the `DO UPDATE` branch.** So an outbound
     * movement of −4 into a location holding 10 proposed a row with `qty_on_hand = −4`, and the
     * CHECK rejected it before Postgres ever noticed the row already existed and that the real
     * post-value was 6. The generated SQL was correct; the insert branch's *values* were not.
     *
     * That is the C1 remediation shipping its own defect — Plan 13's lesson, live, on the very fix
     * the close pass was blocked on. It is caught here only because the suite was RUN.
     *
     * The two-statement form below has no such branch:
     *
     *   1. `ON CONFLICT DO NOTHING` with **zero** — materialise the row if it is missing. Zero is
     *      not a fabricated stock figure; it is "this location now has a line for this batch,
     *      holding nothing", and it satisfies the CHECK by construction.
     *   2. `UPDATE … SET qty_on_hand = qty_on_hand + delta RETURNING` — the atomic increment, whose
     *      result the CHECK now judges. **The CHECK stays a real backstop**, which the tempting
     *      one-statement alternative (`values({ qtyOnHand: Math.max(delta, 0) })`) would have
     *      quietly destroyed: it would turn an unguarded negative movement into a silent zero row
     *      instead of an error.
     *
     * Concurrency is unchanged and is the whole point. Two transactions inserting a NEW pair: the
     * loser's `DO NOTHING` WAITS on the winner's tuple, then skips; both then take the UPDATE's own
     * row lock in turn, so `0 → q → 2q`. No update is lost, and the ledger and the balance agree.
     */
    await tx.insert(stockBalances).values({
      resourceId: m.resourceId, batchId: m.batchId,
      itemId: batches.get(m.batchId)?.itemId ?? "",
      qtyOnHand: 0, updatedAt: new Date(),
    }).onConflictDoNothing({ target: [stockBalances.resourceId, stockBalances.batchId] });

    const [written] = await tx.update(stockBalances)
      .set({ qtyOnHand: sql`${stockBalances.qtyOnHand} + ${m.qtyDelta}`, updatedAt: new Date() })
      .where(and(
        eq(stockBalances.resourceId, m.resourceId),
        eq(stockBalances.batchId, m.batchId),
      ))
      .returning({ qtyOnHand: stockBalances.qtyOnHand });
    if (written === undefined) {
      // Unreachable: the statement above guarantees the row inside this transaction. Loud rather
      // than `?? 0`, which would report a balance of zero for a movement that did happen.
      throw new Error(
        `stock_balances row for (${m.resourceId}, ${m.batchId}) vanished between materialise and increment`,
      );
    }
    const balanceAfter = written.qtyOnHand;

    const ledgerEntryId = newId();
    await tx.insert(stockLedger).values({
      id: ledgerEntryId,
      resourceId: m.resourceId, batchId: m.batchId,
      itemId: batches.get(m.batchId)?.itemId ?? "",
      qtyDelta: m.qtyDelta, reason: m.reason,
      refType: m.refType ?? null, refId: m.refId ?? null, eventId: m.eventId ?? null,
      patientId: m.patientId ?? null, encounterId: m.encounterId ?? null,
      costCenter: m.costCenter ?? null,
      actorId: actor.id,
      occurredAt: m.occurredAt,
      ...(m.recordedAt === undefined ? {} : { recordedAt: m.recordedAt }),
    });
    results.push({ ledgerEntryId, balanceAfter });
  }
  return results;
}

// ═══════════════════════════════════ FEFO ═══════════════════════════════════

/**
 * **FIRST-EXPIRED, FIRST-OUT (DD9, A10).** The earliest-expiring available batch first.
 *
 * `order by expiry_date asc NULLS LAST, id` — and every clause is load-bearing:
 *   · **`expiry_date`, never `id`.** A10's mutant picks by creation order, and the discriminating
 *     fixture is *two batches of one item where the LATER-CREATED one expires EARLIER*. Creation
 *     order coinciding with expiry order is §2.102's trap and it cannot discriminate.
 *   · **`NULLS LAST`.** A batch with no expiry (a non-dated class) is not "expiring first"; sorting
 *     nulls first would empty the undated stock before anything perishable, which is backwards.
 *   · **`id` as the tie-break**, so two batches expiring the same day are picked in a stable order
 *     rather than an arbitrary one that changes between plans.
 *
 * Frozen batches are skipped (DD14) and so are fully-reserved and fully-frozen quantities: what is
 * offered is `on_hand − reserved − frozen`, the same number `postMovement` will check.
 *
 * Returns as many batches as it takes, in order, and **may return LESS than `qtyBase`** — the
 * caller decides whether a short pick is an error. `issueStock` (T7) treats it as
 * `insufficient_stock`; a screen showing "what could we pick" treats it as information.
 */
export async function fefoPick(
  db: Db | Tx,
  resourceId: string,
  itemId: string,
  qtyBase: number,
  /**
   * The calendar day the pick happens on, IST — the caller resolves the clock, exactly as the
   * worker's jobs thread theirs. Defaults to now for the callers that have no clock of their own.
   */
  asOf: Date = new Date(),
): Promise<{ batchId: string; qty: number }[]> {
  if (!Number.isSafeInteger(qtyBase) || qtyBase <= 0) {
    throw new MaterialsError("insufficient_stock", `a pick must be a positive integer, got ${String(qtyBase)}`);
  }
  const rows = await db.select({
    batchId: stockBalances.batchId,
    onHand: stockBalances.qtyOnHand,
    reserved: stockBalances.qtyReserved,
    frozen: stockBalances.qtyFrozen,
    expiryDate: stockBatches.expiryDate,
  })
    .from(stockBalances)
    .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .where(and(
      eq(stockBalances.resourceId, resourceId),
      eq(stockBalances.itemId, itemId),
      eq(stockBatches.recallStatus, "none"),
      /**
       * ═══ AND IT MUST NOT ALREADY BE EXPIRED (16c close review, second contract sweep) ═══
       *
       * FEFO ORDERS by `expiry_date asc` and, until this clause, did not EXCLUDE a date already
       * past — so the first batch this function offered was the MOST expired one the store held,
       * and `pickDispense` takes `offered[0]`. The OPD counter therefore dispensed expired
       * medicine BY PREFERENCE. Proved at the counter before it was fixed: a Crocin batch dated
       * 2026-08-01 was picked and reserved for a patient on 2026-08-17, ahead of good stock.
       *
       * It sits beside the recall exclusion because it is the same kind of clause and the same
       * argument: a batch that must not reach a patient must not be OFFERED to the person handing
       * it over. Recall was excluded here from the start; expiry was ordered by and never filtered.
       *
       * `expiry_date` is the last day the batch may be used (the pharma convention), so the
       * comparison is `>= today` and not `> today`. A NULL expiry is kept: DD8 rule 3 exempts whole
       * item classes from carrying one, and "no expiry recorded" means does-not-expire here, not
       * expired. Stock that IS expired is still transferable by NAMING its batch — which is how it
       * reaches a quarantine or destruction store — because a FEFO override skips this query.
       */
      sql`(${stockBatches.expiryDate} is null or ${stockBatches.expiryDate} >= ${istDay(asOf)}::date)`,
    ))
    .orderBy(sql`${stockBatches.expiryDate} asc nulls last`, asc(stockBatches.id));

  const picked: { batchId: string; qty: number }[] = [];
  let remaining = qtyBase;
  for (const r of rows) {
    if (remaining <= 0) break;
    const avail = r.onHand - r.reserved - r.frozen;
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    picked.push({ batchId: r.batchId, qty: take });
    remaining -= take;
  }
  return picked;
}

// ═══════════════════════════════════ RESERVATIONS ═══════════════════════════════════

/**
 * A hold on stock that has not moved yet — the pharmacy seam (Plan 13 DD14's posture: functions
 * with tests and NO route until the first caller mounts one).
 *
 * Reserving takes the same ordered lock as a movement, because a reservation and a movement compete
 * for the same number: two sessions each reserving the last unit must serialise exactly as two
 * issues would.
 */
export async function reserveStock(
  tx: Tx,
  actor: Actor,
  input: { resourceId: string; batchId: string; qty: number; refType: string; refId: string; expiresAt?: Date | null },
): Promise<{ reservationId: string }> {
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0) {
    throw new MaterialsError("insufficient_stock", `a reservation must be a positive integer, got ${String(input.qty)}`);
  }
  await lockBalances(tx, [{ resourceId: input.resourceId, batchId: input.batchId }]);
  const batch = await requireBatch(tx, input.batchId);
  if (batch.recallStatus === "frozen") {
    throw new MaterialsError("batch_frozen", `batch ${batch.batchNo} is recall-frozen (DD14)`);
  }
  const rows = await tx.select().from(stockBalances).where(and(
    eq(stockBalances.resourceId, input.resourceId), eq(stockBalances.batchId, input.batchId),
  ));
  const current = rows[0];
  const avail = current === undefined ? 0 : available(current);
  if (avail < input.qty) {
    throw new MaterialsError(
      "insufficient_stock",
      `store holds ${String(avail)} available of this batch; the reservation needs ${String(input.qty)}`,
      { available: avail, required: input.qty },
    );
  }
  const reservationId = newId();
  await tx.insert(stockReservations).values({
    id: reservationId, resourceId: input.resourceId, batchId: input.batchId, qty: input.qty,
    refType: input.refType, refId: input.refId, expiresAt: input.expiresAt ?? null,
    status: "held", createdBy: actor.id,
  });
  await tx.update(stockBalances)
    .set({ qtyReserved: sql`${stockBalances.qtyReserved} + ${input.qty}`, updatedAt: new Date() })
    .where(and(eq(stockBalances.resourceId, input.resourceId), eq(stockBalances.batchId, input.batchId)));
  return { reservationId };
}

/** Releases a held reservation. The stock never moved; only the hold goes away. */
export async function releaseReservation(tx: Tx, _actor: Actor, reservationId: string): Promise<void> {
  const rows = await tx.select().from(stockReservations).where(eq(stockReservations.id, reservationId));
  const r = rows[0];
  if (r === undefined) throw new MaterialsError("unknown_document", `reservation ${reservationId} not found`);
  if (r.status !== "held") {
    throw new MaterialsError("already_received", `reservation ${reservationId} is already "${r.status}"`);
  }
  await lockBalances(tx, [{ resourceId: r.resourceId, batchId: r.batchId }]);
  await tx.update(stockReservations).set({ status: "released" }).where(eq(stockReservations.id, reservationId));
  await tx.update(stockBalances)
    .set({ qtyReserved: sql`${stockBalances.qtyReserved} - ${r.qty}`, updatedAt: new Date() })
    .where(and(eq(stockBalances.resourceId, r.resourceId), eq(stockBalances.batchId, r.batchId)));
}

/**
 * Turns a hold into a movement: the reservation is dropped and the same quantity leaves the shelf,
 * in ONE transaction. Dropping the hold FIRST is what makes the movement's own availability check
 * pass — otherwise the reservation would be competing with the movement it exists to guarantee.
 */
export async function consumeReservation(
  tx: Tx,
  actor: Actor,
  reservationId: string,
  movement: Omit<MovementInput, "resourceId" | "batchId" | "qtyDelta">,
): Promise<{ ledgerEntryId: string; balanceAfter: number }> {
  const rows = await tx.select().from(stockReservations).where(eq(stockReservations.id, reservationId));
  const r = rows[0];
  if (r === undefined) throw new MaterialsError("unknown_document", `reservation ${reservationId} not found`);
  if (r.status !== "held") {
    throw new MaterialsError("already_received", `reservation ${reservationId} is already "${r.status}"`);
  }
  await lockBalances(tx, [{ resourceId: r.resourceId, batchId: r.batchId }]);
  await tx.update(stockReservations).set({ status: "consumed" }).where(eq(stockReservations.id, reservationId));
  await tx.update(stockBalances)
    .set({ qtyReserved: sql`${stockBalances.qtyReserved} - ${r.qty}`, updatedAt: new Date() })
    .where(and(eq(stockBalances.resourceId, r.resourceId), eq(stockBalances.batchId, r.batchId)));
  return postMovement(tx, actor, {
    ...movement, resourceId: r.resourceId, batchId: r.batchId, qtyDelta: -r.qty,
  });
}

// ═══════════════════════════════════ RECALL (DD14) ═══════════════════════════════════

/**
 * **ONE ACTION, EVERY LOCATION (§11.10, A12).**
 *
 * Sets `recall_status = 'frozen'` on the batch and `qty_frozen = qty_on_hand` on **every** balance
 * row of that batch, in one transaction under the DD6 lock, then emits ONE `batch.recalled`
 * carrying the whole list of `{ storeResourceId, qtyFrozen }`.
 *
 * A12's mutant freezes only the store the caller passed — which is why this function takes NO
 * store argument at all. It is not "freeze here"; it is "this batch is bad", and a batch is bad
 * everywhere it is. **The discriminating fixture is one batch held in THREE stores**; one store
 * cannot tell the two implementations apart.
 *
 * `releaseRecall` (a false alarm) and the return/destroy paths are 14c's. In this phase a frozen
 * batch stays frozen, which is the safe direction: the cost of an unnecessary freeze is stock a
 * pharmacist has to un-stick by hand, and the cost of the other error is a recalled implant in a
 * patient.
 */
export async function recallBatch(
  tx: Tx,
  actor: Actor,
  batchId: string,
  reason: string,
): Promise<{ locations: { storeResourceId: string; qtyFrozen: number }[] }> {
  const batch = await requireBatch(tx, batchId);

  // EVERY location of this batch, locked in `(resource_id, batch_id)` order — the same order every
  // movement takes, so a recall and a concurrent issue serialise rather than deadlock.
  const existing = await tx.select().from(stockBalances).where(eq(stockBalances.batchId, batchId));
  await lockBalances(tx, existing.map((b) => ({ resourceId: b.resourceId, batchId })));

  await tx.update(stockBatches)
    .set({ recallStatus: "frozen" })
    .where(eq(stockBatches.id, batchId));
  await tx.update(stockBalances)
    .set({ qtyFrozen: sql`${stockBalances.qtyOnHand}`, updatedAt: new Date() })
    .where(eq(stockBalances.batchId, batchId));

  // Re-read AFTER the update so the event carries what was actually frozen rather than what the
  // pre-image said — a difference that matters if anything moved between the two statements, which
  // the lock is there to prevent and the re-read is there to prove.
  const frozen = await tx.select().from(stockBalances).where(eq(stockBalances.batchId, batchId));
  const locations = frozen.map((b) => ({ storeResourceId: b.resourceId, qtyFrozen: b.qtyFrozen }));

  await appendEvent(tx, batchRecalled.make({
    payload: {
      batchId, itemId: batch.itemId, batchNo: batch.batchNo, reason, locations,
    },
    actor, correlationId: batchId,
  }));
  return { locations };
}

// ═══════════════════════════════════════ READS ═══════════════════════════════════════

export async function balances(
  db: Db | Tx,
  filter: { resourceId?: string; itemId?: string; batchId?: string } = {},
): Promise<BalanceRow[]> {
  const clauses = [];
  if (filter.resourceId !== undefined) clauses.push(eq(stockBalances.resourceId, filter.resourceId));
  if (filter.itemId !== undefined) clauses.push(eq(stockBalances.itemId, filter.itemId));
  if (filter.batchId !== undefined) clauses.push(eq(stockBalances.batchId, filter.batchId));
  const q = db.select().from(stockBalances)
    .orderBy(asc(stockBalances.resourceId), asc(stockBalances.batchId));
  return clauses.length === 0 ? q : q.where(and(...clauses));
}

/**
 * The movement history, **ordered by `seq` and never by `id` or `occurred_at`**.
 *
 * `id` is a ULID and ULIDs are never an ordering key (`ids.ts`'s WARNING, ledger §3.26):
 * two rows minted in the same millisecond sort by their random tail. `occurred_at` is the INJECTED
 * instant and may run backwards across rows — that is the whole point of the downtime convention.
 * `seq` is the database's own monotone sequence and is the only total order that exists.
 */
export async function movementsFor(
  db: Db | Tx,
  filter: { batchId?: string; resourceId?: string; itemId?: string; encounterId?: string },
  opts: { limit?: number; order?: "asc" | "desc" } = {},
): Promise<LedgerRow[]> {
  const clauses = [];
  if (filter.batchId !== undefined) clauses.push(eq(stockLedger.batchId, filter.batchId));
  if (filter.resourceId !== undefined) clauses.push(eq(stockLedger.resourceId, filter.resourceId));
  if (filter.itemId !== undefined) clauses.push(eq(stockLedger.itemId, filter.itemId));
  if (filter.encounterId !== undefined) clauses.push(eq(stockLedger.encounterId, filter.encounterId));
  const ordering = opts.order === "desc" ? desc(stockLedger.seq) : asc(stockLedger.seq);
  const base = db.select().from(stockLedger);
  const q = clauses.length === 0 ? base : base.where(and(...clauses));
  return opts.limit === undefined ? q.orderBy(ordering) : q.orderBy(ordering).limit(opts.limit);
}

/** The batch, or `undefined`. A read; `requireBatch` is the refusing form and is private. */
export async function getBatch(db: Db | Tx, batchId: string): Promise<BatchRow | undefined> {
  const rows = await db.select().from(stockBatches).where(eq(stockBatches.id, batchId));
  return rows[0];
}

/** Where a batch is, and how much of it. The recall screen's list and 14c's leakage triangle. */
export async function batchLocations(db: Db | Tx, batchId: string): Promise<BalanceRow[]> {
  return balances(db, { batchId });
}

/** Re-exported so callers reach the store guard through the ledger's surface, as T6 and T7 do. */
export { requireStore };
