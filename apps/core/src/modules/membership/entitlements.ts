import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { percentAmount } from "../tariff";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { entitlementCounters, entitlementMovements } from "../../kernel/db/schema";
import { istDayIndex } from "./coupon-rules";
import { MembershipError } from "./errors";
import type { BenefitTerm, ResolvedInstruments, ResolvedMembership } from "./instruments";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 09 T4 — DD10's ENTITLEMENT LEDGER: the grant, the signed movement log, and the two writers
 * that move it. Consume and restore ship in one file on purpose (T4's scope note): they are one
 * property, and the class where one task ships a mechanism dormant and another arms it (§2.86) is
 * exactly what splitting them would invite.
 *
 * ═══ REMAINING IS DERIVED, NEVER STORED ═══
 *
 * `entitlement_counters` holds `granted_qty`; `entitlement_movements` holds every consume as a
 * NEGATIVE delta and every restore as a POSITIVE one. `remaining = granted_qty + Σ delta`.
 * Nothing is ever updated, which is what lets migration 0022's `BEFORE UPDATE OR DELETE` trigger
 * be TOTAL over both tables — and it is why D6's "a restore is a negating ROW" and C1's
 * reversibility are the same sentence rather than two mechanisms.
 *
 * *(`schema/membership.ts`'s header writes the identity as `granted_qty − Σ delta` while its own
 * `delta` column comment says "signed: negative consumes, positive restores". The COLUMN comment
 * is the one the rows obey — a consume is stored `-n` — so the sum is added, not subtracted. The
 * schema file is frozen for this phase; recorded here rather than corrected there.)*
 *
 * ═══ THE SERIALIZER IS `SELECT … FOR UPDATE` ON THE PARENT ROW (DD10) ═══
 *
 * Remaining is computed INSIDE that lock and the movement is appended inside it too, because the
 * pair is a read-modify-write and READ COMMITTED opens the window on its own. §3 Q6 measured both
 * halves before a line of this file existed: **over-consumption in 0/20 trials with the lock and
 * 20/20 without it**, and — the half that changes the TEST rather than the code — a forced
 * interleave alone does NOT discriminate the outcome, because the forced ordering serialises the
 * compute step anyway. `entitlements.contention.test.ts` therefore asserts the BLOCK, and its own
 * re-measurement against THIS writer agrees: **0/20 with the lock, 19/20 with it removed.**
 *
 * ═══ AN EXHAUSTED COUNTER IS NARROWED OUT BEFORE PRICING, NOT REFUSED AT COMMIT ═══
 *
 * `narrowToUsableEntitlements` runs at composition time (billing's `priceDraft`) and drops the
 * benefit terms a counter can no longer honour, so a member who has used up four free consults is
 * simply billed in full. If the refusal lived only at the consume, the FIFTH visit of that member
 * would fail to invoice at all — a counter that stops selling to the person who bought the card.
 * The in-transaction refusal below is therefore reached only by a genuine RACE: two invoices for
 * the last unit, where one of them must lose.
 */

/** One counter with its movement log folded in. `remainingQty` is derived; nothing stores it. */
export type EntitlementCounterState = {
  counterId: string;
  instanceId: string;
  benefitKey: string;
  /**
   * FD-7 T6 / R3 — `'count'` or `'paise'`. Every quantity on this type is IN THIS UNIT: a count
   * counter's `remainingQty` is whole visits, a paise counter's is money. The two are never mixed in
   * one counter, so no conversion exists anywhere and none is wanted.
   */
  unit: string;
  grantedQty: number;
  /** Σ of every signed delta — negative while units are out, back to 0 when all are restored. */
  movedQty: number;
  remainingQty: number;
  validFrom: Date;
  validTo: Date;
  /** `'active' | 'void'`. A void counter honours nothing and is never consumed. */
  state: string;
};

/** One line's worth of benefit to consume: which instrument, which counter key, which stored line. */
export type EntitlementConsume = {
  instanceId: string;
  benefitKey: string;
  invoiceLineId: string;
  /**
   * FD-7 T6 / R3 — WHAT THE WINNING BENEFIT ACTUALLY TOOK OFF THIS LINE, in paise.
   *
   * A COUNT counter ignores it: one line is one unit, and that has not changed. A PAISE counter
   * decrements by exactly this, because the thing being drawn down IS the money. The caller already
   * had it — `invoices.ts` reads `winner.amountPaise` two lines away to build the coupon redemption
   * — so nothing new is computed and, as everywhere else in this file, nothing is divided.
   */
  amountPaise: number;
};

export type EntitlementRestore = {
  movementId: string;
  counterId: string;
  invoiceLineId: string | null;
  qty: number;
  /** C5 — the counter's own validity had lapsed when the restore landed. */
  lapsed: boolean;
};

/**
 * O-2's counter half: a bundle's OWN validity governs its counters, independently of the
 * membership's. The comparison is IST CALENDAR DAYS, the same predicate `membershipUsableAt` uses
 * and for the same reason (B6): `valid_to` is stored as an instant and a member reads a DATE off a
 * printed card, so comparing raw instants would refuse a counter at 05:30 IST on its own last day.
 */
export function counterLiveAt(counter: { state: string; validFrom: Date; validTo: Date }, at: Date): boolean {
  if (counter.state !== "active") return false;
  const day = istDayIndex(at);
  return istDayIndex(counter.validFrom) <= day && day <= istDayIndex(counter.validTo);
}

/**
 * The (instrument, benefit) pair as ONE map key. The separator is safe in both directions because
 * the first half is a ULID — a fixed alphabet with no `|` in it — so no benefit key, however it is
 * spelled in a commissioning file, can shift the boundary.
 */
function counterKey(instanceId: string, benefitKey: string): string {
  return `${instanceId}|${benefitKey}`;
}

/** Every counter of these instances, with `remaining` folded from the movement log. */
export async function entitlementCountersOf(
  exec: Db | Tx,
  instanceIds: string[],
): Promise<EntitlementCounterState[]> {
  if (instanceIds.length === 0) return [];
  const counters = await exec
    .select()
    .from(entitlementCounters)
    .where(inArray(entitlementCounters.instanceId, instanceIds))
    .orderBy(asc(entitlementCounters.id));
  if (counters.length === 0) return [];
  const moved = await movedQtyByCounter(exec, counters.map((c) => c.id));
  return counters.map((c) => {
    const movedQty = moved.get(c.id) ?? 0;
    return {
      counterId: c.id,
      instanceId: c.instanceId,
      benefitKey: c.benefitKey,
      unit: c.unit,
      grantedQty: c.grantedQty,
      movedQty,
      remainingQty: c.grantedQty + movedQty,
      validFrom: c.validFrom,
      validTo: c.validTo,
      state: c.state,
    };
  });
}

/**
 * Σ signed delta per counter. ONE table, unqualified column names unambiguous — the caveat every
 * billing aggregate carries: drizzle renders a column interpolated into a `sql` SELECT FIELD
 * without its table qualifier, so a two-table version of this could silently compare the wrong
 * columns and return zero.
 */
async function movedQtyByCounter(exec: Db | Tx, counterIds: string[]): Promise<Map<string, number>> {
  if (counterIds.length === 0) return new Map();
  const rows = await exec
    .select({
      counterId: entitlementMovements.counterId,
      total: sql<string>`coalesce(sum(${entitlementMovements.delta}), 0)`,
    })
    .from(entitlementMovements)
    .where(inArray(entitlementMovements.counterId, counterIds))
    .groupBy(entitlementMovements.counterId);
  return new Map(rows.map((r) => [r.counterId, Number(r.total)] as const));
}

/**
 * THE PRE-PRICING NARROWING. A benefit term whose key names a counter that cannot honour one more
 * unit — exhausted, lapsed or void — is dropped from the value the money path sees; a term that
 * names NO counter is an unlimited percentage benefit and passes through untouched.
 *
 * Pure and synchronous, so the composed `PricingContext` stays exactly as deterministic as DD2
 * requires. `resolveInstruments`' result is treated as immutable: a narrowed copy is returned.
 */
export function narrowToUsableEntitlements(
  resolved: ResolvedInstruments,
  counters: EntitlementCounterState[],
  at: Date,
): ResolvedInstruments {
  if (counters.length === 0) return resolved;
  const live = new Map<string, EntitlementCounterState>();
  for (const counter of counters) {
    if (counterLiveAt(counter, at) && counter.remainingQty > 0) {
      live.set(counterKey(counter.instanceId, counter.benefitKey), counter);
    } else {
      live.delete(counterKey(counter.instanceId, counter.benefitKey));
    }
  }
  const seen = new Set(counters.map((c) => counterKey(c.instanceId, c.benefitKey)));

  const memberships = resolved.memberships.map((instrument): ResolvedMembership => {
    const benefits: BenefitTerm[] = [];
    for (const term of instrument.benefits) {
      const key = counterKey(instrument.instanceId, term.benefitKey);
      // A term naming NO counter is an unlimited percentage benefit — untouched, as before.
      if (!seen.has(key)) { benefits.push(term); continue; }
      if (!live.has(key)) continue;   // exhausted, lapsed or void — dropped, in EITHER unit
      benefits.push(term);
    }
    return benefits.length === instrument.benefits.length
      && benefits.every((b, i) => b === instrument.benefits[i])
      ? instrument
      : { ...instrument, benefits };
  });
  return { ...resolved, memberships };
}

/**
 * ═══ CLOSE REVIEW / CRITICAL — A BALANCE IS NOT A CAP, AND THE DIFFERENCE COST THE PATIENT ═══
 *
 * T6 shipped R3's value lane by narrowing the benefit term's `capPaise` to the counter's remaining
 * balance. That is wrong, and silently so: `benefitCandidate` **REJECTS an over-cap ask rather than
 * clamping it** — a deliberate, documented rule (B4/K3), because a cap is a CONTROL and clamping
 * would turn every misconfigured coupon into a quiet payout at its cap.
 *
 * So a package with ₹40 left against a ₹100 benefit produced NO DISCOUNT AT ALL. The patient paid in
 * full and their balance sat unused — the exact opposite of T6's own promise that "it is a benefit
 * worth exactly ₹4,200 today, and the patient pays the rest". Every T6 test asserted the narrowed
 * CAP and none asserted the resulting MONEY, which is why a green suite shipped it.
 *
 * THE FIX IS TO CLAMP THE VALUE, NOT THE CAP. A term whose ask exceeds the balance becomes a
 * `flat_paise` term worth exactly the balance — an honest, smaller benefit rather than a capped one
 * that gets refused. `benefitCandidate` then finds `raw === value <= cap` and applies it, and it
 * still clamps to the line's gross on its own (`Math.min(raw, grossPaise)`), so a ₹4,200 balance
 * against a ₹500 line gives ₹500 rather than ₹4,200.
 *
 * IT RUNS WHERE THE GROSS IS KNOWN, which is why it is a second pass rather than part of the
 * narrowing above: "does the ask exceed the balance" is unanswerable for a percentage until the bill
 * has been priced once.
 *
 * NOT ADDRESSED HERE, because it is not new and not this lane's: a MULTI-LINE bill can have one
 * benefit win on several lines and together ask for more than the counter holds, and
 * `consumeEntitlements` then refuses the invoice. **The count lane has behaved exactly this way
 * since Plan 09** — two lines against a one-visit counter refuse identically — so it is a
 * pre-existing property of a per-line benefit sharing one counter, and it fails SAFE (a loud
 * refusal, never an over-draw).
 */
export function clampValueEntitlementsToBalance(
  resolved: ResolvedInstruments,
  counters: EntitlementCounterState[],
  billGrossPaise: number,
): ResolvedInstruments {
  const paise = new Map<string, number>();
  for (const counter of counters) {
    if (counter.unit === "paise") paise.set(counterKey(counter.instanceId, counter.benefitKey), counter.remainingQty);
  }
  if (paise.size === 0) return resolved;

  const memberships = resolved.memberships.map((instrument): ResolvedMembership => {
    let changed = false;
    const benefits = instrument.benefits.map((term): BenefitTerm => {
      const remaining = paise.get(counterKey(instrument.instanceId, term.benefitKey));
      if (remaining === undefined) return term;
      const ask = term.kind === "percent_bps" ? percentAmount(billGrossPaise, term.value) : term.value;
      if (ask <= remaining) return term;   // the balance covers it — the plan's own terms stand
      changed = true;
      // The plan's OWN cap still binds: a benefit worth "up to ₹150" never becomes worth more.
      return { ...term, kind: "flat_paise", value: Math.min(remaining, term.capPaise ?? remaining) };
    });
    return changed ? { ...instrument, benefits } : instrument;
  });
  return { ...resolved, memberships };
}

/**
 * Which counter a WINNING benefit consumes. The contest's winner names a benefit KEY and never an
 * instrument — `benefitCandidate` sets `ruleKey = term.benefitKey` — so when two cards of the same
 * plan survive a merge and both carry that key, this picks the FIRST in arrival order that still
 * has a live counter.
 *
 * That is DD11 working as written rather than a guess: two instruments' counters are two separate
 * counters, both consumable, and the duplicate is surfaced to a human in the reconcile queue —
 * "silently voiding one of two things a patient paid for because the hospital merged its own
 * duplicate records is a worse error than the one it prevents". Arrival order makes the choice
 * DETERMINISTIC, which is the property a later reconciliation needs.
 */
export function counterForWinner(
  resolved: ResolvedInstruments,
  counters: EntitlementCounterState[],
  args: { benefitKey: string; at: Date },
): { instanceId: string; counterId: string } | null {
  for (const instrument of resolved.memberships) {
    if (!instrument.benefits.some((t) => t.benefitKey === args.benefitKey)) continue;
    const counter = counters.find(
      (c) =>
        c.instanceId === instrument.instanceId &&
        c.benefitKey === args.benefitKey &&
        counterLiveAt(c, args.at) &&
        c.remainingQty > 0,
    );
    if (counter !== undefined) return { instanceId: instrument.instanceId, counterId: counter.counterId };
  }
  return null;
}

/**
 * DD10's WRITE. One ordered `SELECT … FOR UPDATE` over every counter this invoice touches, then
 * remaining computed and the movements appended INSIDE that lock.
 *
 * ONE ORDERED STATEMENT, NEVER ROW-THEN-SET — the Plan 06.1 C1 lesson the billing writers already
 * follow: two invoices consuming two counters in opposite orders would otherwise deadlock. Sorting
 * by counter id gives every writer in the hospital the same acquisition order.
 *
 * The refusal is `entitlement_exhausted`, and it is reached only by a race (see the file header).
 */
export async function consumeEntitlements(
  tx: Tx,
  actor: Actor,
  input: { invoiceId: string; at: Date; consumes: EntitlementConsume[] },
): Promise<{ movementIds: string[]; byCounter: Map<string, number> }> {
  const byCounter = new Map<string, number>();
  if (input.consumes.length === 0) return { movementIds: [], byCounter };

  const wanted = await tx
    .select()
    .from(entitlementCounters)
    .where(
      inArray(
        entitlementCounters.instanceId,
        [...new Set(input.consumes.map((c) => c.instanceId))],
      ),
    );
  const counterOf = new Map(wanted.map((c) => [counterKey(c.instanceId, c.benefitKey), c] as const));

  const needed = new Map<string, number>();
  const consumeRows: { counterId: string; consume: EntitlementConsume; ask: number }[] = [];
  for (const consume of input.consumes) {
    const counter = counterOf.get(counterKey(consume.instanceId, consume.benefitKey));
    if (counter === undefined) continue; // an unlimited benefit — nothing to decrement
    /*
     * FD-7 T6 / R3 — how much of the counter this line asks for, IN THE COUNTER'S OWN UNIT.
     * A count counter asks for one visit, exactly as it always has. A paise counter asks for the
     * money the benefit actually took off this line, which the caller already had in hand.
     */
    const ask = counter.unit === "paise" ? consume.amountPaise : 1;
    if (ask <= 0) continue; // a benefit that took nothing off draws nothing down
    needed.set(counter.id, (needed.get(counter.id) ?? 0) + ask);
    consumeRows.push({ counterId: counter.id, consume, ask });
  }
  if (consumeRows.length === 0) return { movementIds: [], byCounter };

  const lockedIds = [...needed.keys()].sort();
  // THE SERIALIZER (DD10, measured in §3 Q6). One statement, id order, mode FOR UPDATE.
  await tx
    .select({ id: entitlementCounters.id })
    .from(entitlementCounters)
    .where(inArray(entitlementCounters.id, lockedIds))
    .orderBy(asc(entitlementCounters.id))
    .for("update");

  // Everything below runs while the lock is held: a second consumer of the same counter queues on
  // the statement above and reads THIS transaction's movements only after it commits.
  const locked = await tx.select().from(entitlementCounters).where(inArray(entitlementCounters.id, lockedIds));
  const moved = await movedQtyByCounter(tx, lockedIds);
  for (const counter of locked) {
    if (!counterLiveAt(counter, input.at)) {
      throw new MembershipError(
        "counter_lapsed",
        `entitlement "${counter.benefitKey}" is not live on this counter`,
        { counterId: counter.id, state: counter.state, validFrom: counter.validFrom, validTo: counter.validTo },
      );
    }
    const remainingQty = counter.grantedQty + (moved.get(counter.id) ?? 0);
    const askQty = needed.get(counter.id) ?? 0;
    if (remainingQty < askQty) {
      throw new MembershipError(
        "entitlement_exhausted",
        `entitlement "${counter.benefitKey}" has ${String(remainingQty)} left and this bill asks for ${String(askQty)}`,
        { counterId: counter.id, remainingQty, askQty },
      );
    }
  }

  const movementIds: string[] = [];
  for (const row of consumeRows) {
    const id = newId();
    await tx.insert(entitlementMovements).values({
      id,
      counterId: row.counterId,
      /*
       * FD-7 T6 / R3 — `-row.ask`, which is `-1` for a count counter (one line, one visit, exactly
       * as before) and the negated money for a paise counter. The log stays a log of signed
       * integers in the counter's own unit, which is why `restoreEntitlements` — negating
       * `-movement.delta` — needed NO CHANGE AT ALL to reverse a value draw-down correctly.
       */
      delta: -row.ask,
      kind: "consume",
      invoiceId: input.invoiceId,
      invoiceLineId: row.consume.invoiceLineId,
      reversalOfId: null,
      lapsedRestore: false,
      reason: null,
      actorId: actor.id,
      at: input.at,
    });
    movementIds.push(id);
    byCounter.set(row.counterId, (byCounter.get(row.counterId) ?? 0) + row.ask);
  }
  return { movementIds, byCounter };
}

/**
 * C2/DD9 — RESTORE, PROPORTIONAL TO THE REVERSED LINE AND NEVER TO THE INVOICE.
 *
 * Every live consume against ONE of the named invoice lines is negated by a POSITIVE row that
 * points at it. A two-line invoice with one line credited therefore restores one unit and leaves
 * the other line's unit consumed, which is the whole of Book row D4 — the mutant that restores the
 * whole counter is what makes the per-line scoping load-bearing rather than incidental.
 *
 * A PARTIAL-QTY credit on a line restores that line's unit IN FULL, and that is a decision rather
 * than a rounding: a counter holds whole visits, `granted_qty` is an integer, and there is no
 * half-consult to give back. It also keeps this file free of division, which S12's sweep over
 * `modules/billing` and the tariff engine's `divHalfUp` monopoly both want.
 *
 * ═══ C5 — A RESTORE AFTER THE COUNTER'S VALIDITY LAPSED HAPPENS ANYWAY, AND IS FLAGGED ═══
 *
 * Refusing it would silently keep money the patient received no value for. `lapsed_restore` is the
 * flag, and it is what the reconcile queue shows.
 */
export async function restoreEntitlements(
  tx: Tx,
  actor: Actor,
  input: { invoiceId: string; invoiceLineIds: string[]; at: Date; reason: string },
): Promise<EntitlementRestore[]> {
  if (input.invoiceLineIds.length === 0) return [];

  const consumed = await tx
    .select()
    .from(entitlementMovements)
    .where(
      and(
        eq(entitlementMovements.kind, "consume"),
        eq(entitlementMovements.invoiceId, input.invoiceId),
        inArray(entitlementMovements.invoiceLineId, input.invoiceLineIds),
      ),
    )
    .orderBy(asc(entitlementMovements.seq));
  if (consumed.length === 0) return [];

  // Already-restored consumes are skipped, so two credit notes over the same line cannot hand the
  // unit back twice. The predicate is a QUERY over the log (`reversal_of_id`), never a status
  // column — the `allocations` reversal shape, and the only one an append-only table can have.
  const restoredRows = await tx
    .select({ reversalOfId: entitlementMovements.reversalOfId })
    .from(entitlementMovements)
    .where(
      and(
        eq(entitlementMovements.kind, "restore"),
        inArray(entitlementMovements.counterId, [...new Set(consumed.map((m) => m.counterId))]),
      ),
    );
  const alreadyRestored = new Set(restoredRows.map((r) => r.reversalOfId));

  const open = consumed.filter((m) => !alreadyRestored.has(m.id));
  if (open.length === 0) return [];

  const counterIds = [...new Set(open.map((m) => m.counterId))].sort();
  // Same ordered lock as the consume: a restore and a consume of one counter are the same
  // read-modify-write from opposite directions, and they must queue on the same statement.
  await tx
    .select({ id: entitlementCounters.id })
    .from(entitlementCounters)
    .where(inArray(entitlementCounters.id, counterIds))
    .orderBy(asc(entitlementCounters.id))
    .for("update");
  const counters = await tx.select().from(entitlementCounters).where(inArray(entitlementCounters.id, counterIds));
  const liveness = new Map(counters.map((c) => [c.id, counterLiveAt(c, input.at)] as const));

  const out: EntitlementRestore[] = [];
  for (const movement of open) {
    const lapsed = liveness.get(movement.counterId) !== true;
    const id = newId();
    await tx.insert(entitlementMovements).values({
      id,
      counterId: movement.counterId,
      delta: -movement.delta, // the NEGATION of the row it names — never an edit of it (D6)
      kind: "restore",
      invoiceId: movement.invoiceId,
      invoiceLineId: movement.invoiceLineId,
      reversalOfId: movement.id,
      lapsedRestore: lapsed,
      reason: input.reason,
      actorId: actor.id,
      at: input.at,
    });
    out.push({
      movementId: id,
      counterId: movement.counterId,
      invoiceLineId: movement.invoiceLineId,
      qty: -movement.delta,
      lapsed,
    });
  }
  return out;
}

/** The movement log of one counter, arrival order (`seq`, never the ULID — §3.26). */
export async function entitlementMovementsOf(
  exec: Db | Tx,
  counterId: string,
): Promise<(typeof entitlementMovements.$inferSelect)[]> {
  return exec
    .select()
    .from(entitlementMovements)
    .where(eq(entitlementMovements.counterId, counterId))
    .orderBy(asc(entitlementMovements.seq));
}
