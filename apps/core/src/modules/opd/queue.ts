import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import {
  opdDepartments, opdDoctorLeaves, opdDoctorSchedules, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions, resources,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { encounterFeeStatuses } from "../billing";
import type { FeeStatusVia } from "../billing";
import { loadOpdConfig } from "./config";
import { getEncounter, joinQueueInTx } from "./encounters";
import { OpdError } from "./errors";
import { queueCalled, queueFeeStatusChanged, queueSkipUndone, queueSkipped } from "./events";
import { classOf, nextInQueue, orderQueue } from "./queue-engine";
import type { SkipReason } from "./skip-reasons";
import { istDate, istWeekday } from "./time";
import type { OpdConfig } from "./config";
import type { EncounterRow, QueueEntryRow } from "./encounters";
import type { DoctorRow } from "./masters";
import type { QueueClass, QueueEntryState } from "./queue-engine";
import type { SessionRow, SessionStatus } from "./sessions";
import type { PatientSummary } from "../patients";
import type { Db, Tx } from "../../kernel/db/client";

export type SkipInput = { reason: SkipReason; note?: string | null };

/** Entry statuses that still occupy the doctor's day. */
const LIVE_ENTRY_STATUSES = ["waiting_vitals", "waiting", "called", "in_consult"] as const;
/** How many upcoming tokens a public board shows. */
const BOARD_NEXT = 5;

/** The row → the engine's pure view. eligible_at is only set when the row becomes 'waiting'; before that arrival order stands in. */
function toState(row: QueueEntryRow): QueueEntryState {
  return {
    id: row.id, tokenNo: row.tokenNo, kind: row.kind === "appointment" ? "appointment" : "walk_in",
    appointmentAt: row.appointmentAt, eligibleAt: row.eligibleAt ?? row.createdAt, seq: row.seq,
    danger: row.danger, reEntry: row.reEntry, perk: row.perk, skips: row.skips,
  };
}

/**
 * ══════════ THE TOKEN THAT WAITS FOR ITS BILL (OWNER RULING 2026-09-20) ══════════
 *
 * Owner: *"It waits for bill to be paid until doctor opens the token from his dashboard manually …
 * once the bill is paid then the token automatically moves to the display board in the queue
 * towards the doctor consultation."*
 *
 * The entry ids of WAITING tokens whose consultation fee is `unsettled` and whose doctor has not
 * opened them. They are held out of the callable order, out of `callNext`, and off the public
 * board — a patient who has not paid is not announced to the hall and is not the next one in.
 *
 * ═══ DERIVED, NEVER STORED, AND THAT IS WHAT MAKES "AUTOMATICALLY" TRUE ═══
 *
 * There is no `held` column and there must not be one. `encounterFeeStatuses` IS the invoice
 * ledger, read (its own header: *"it cannot drift from the money because it IS the money"*), so
 * the instant a receipt lands the very next read of this function returns a smaller set and the
 * token is in the order and on the board. A stored flag would need somebody to remember to clear
 * it, and the day it was forgotten a paid patient would sit in a corridor while the board called
 * numbers past them.
 *
 * ═══ AND IT HOLDS ONLY WHAT IT KNOWS ═══
 *
 * `unsettled` and nothing else. `free` (a revisit inside its window), `settled`, `credit` and
 * `null` — the hospital that has not configured billing at all — are not held: the same four
 * answers `feeGate` gives, from the same projection, so the queue and the consulting-room door can
 * never disagree about who has paid.
 */
async function heldForPaymentIds(exec: Db | Tx, entries: QueueEntryRow[]): Promise<Set<string>> {
  const waiting = entries.filter((r) => r.status === "waiting");
  if (waiting.length === 0) return new Set();
  /*
    ═══ THE CANDIDATE QUERY IS A JOIN, NOT AN 18,000-ID `IN` LIST — AND IT IS WHY THIS IS AFFORDABLE ═══

    MEASURED, not assumed: the first cut of this function selected every waiting encounter by id and
    handed the lot to `encounterFeeStatuses`, and `perf-opd-queue.test.ts` put the public board at
    **1,034 ms against its 500 ms ceiling** (baseline ~225 ms) on the 300-doctor, 18,000-token
    fixture. A board a TV polls every fifteen seconds cannot cost a second.

    So the DATABASE narrows the set, not the process. A waiting token can only be unpaid if somebody
    waved this visit past the counter — that is what FD-32's gate at the vitals bay means: without a
    `fee_bypass_by`, an unpaid patient never reaches `waiting` at all, because they cannot get their
    vitals charted. `fee_bypass_by IS NOT NULL AND consult_fee_override_by IS NULL` is therefore the
    whole candidate population, it is two null checks on an indexed join, and in a real hospital it
    returns a handful of rows on a board carrying hundreds. Re-measured on the same fixture with the
    join in place: **fastest 304 ms against the 500 ms ceiling** (the un-held baseline is ~225 ms),
    and that ~80 ms is the price of scanning a 200,000-row encounter table for the two nulls — a
    cost that falls with the size of the hospital, not with the size of the queue.

    THE BOUNDARY THIS DRAWS, SAID OUT LOUD: a visit that PAID and then had its receipt voided is
    unpaid with no waiver on it, and is NOT held here. It is not silently seen either — the fee gate
    at `startConsultation` refuses it exactly as it did before this ruling, so the doctor gets a
    sentence at the door rather than a hidden row. Holding that case too would cost the ledger read
    this comment exists to avoid.
  */
  const candidates = await exec
    .selectDistinct({ id: opdEncounters.id, visitType: opdEncounters.visitType })
    .from(opdEncounters)
    .innerJoin(opdQueueEntries, eq(opdQueueEntries.encounterId, opdEncounters.id))
    .where(and(
      inArray(opdQueueEntries.sessionId, [...new Set(waiting.map((r) => r.sessionId))]),
      eq(opdQueueEntries.status, "waiting"),
      isNotNull(opdEncounters.feeBypassBy),
      isNull(opdEncounters.consultFeeOverrideBy),
    ));
  if (candidates.length === 0) return new Set();
  /*
    AND THE HANDFUL IS CHECKED AGAINST THE MONEY. A waiver is not a debt: the patient may have paid
    at the counter ten minutes later, and `encounterFeeStatuses` — the invoice ledger, read — is the
    only thing that knows. `unsettled` and nothing else holds: `free`, `settled`, `credit` and the
    unconfigured hospital's `null` all pass, which are the same four answers `feeGate` gives, from
    the same projection, so the queue and the consulting-room door cannot disagree about who paid.
  */
  const statuses = await encounterFeeStatuses(exec, candidates);
  const unpaid = new Set(candidates.filter((c) => statuses.get(c.id) === "unsettled").map((c) => c.id));
  if (unpaid.size === 0) return new Set();
  return new Set(waiting.filter((r) => unpaid.has(r.encounterId)).map((r) => r.id));
}

/** What every read surface needs from one session's live rows: who is being served, who is next, how many wait. */
function summarise(
  entries: QueueEntryRow[], callsMade: number, cfg: OpdConfig, now: Date, held: ReadonlySet<string> = new Set(),
): { nowServing: number | null; next: number[]; waitingCount: number; heldForPaymentCount: number } {
  /*
    A HELD TOKEN IS NOT WAITING — not in the count, not in `next`, not on the hall's screen. It is
    counted separately so the staff surfaces can say "and three are with the cashier", which is a
    fact a desk must act on and the public board must never show.
  */
  const waiting = entries.filter((r) => r.status === "waiting" && !held.has(r.id));
  const ordered = orderQueue(waiting.map(toState), now, { perkEveryNth: cfg.perkEveryNth }, callsMade);
  /*
    A PARKED TOKEN IS NOT BEING SERVED, and this is the line where that has to be said. The fallback
    to `in_consult` exists for the doctor who takes a patient straight from waiting without calling
    them — and with a park it would announce the person who has STEPPED OUT: "now serving 1" over an
    empty chair, while the doctor sees token 2 and the parked patient's family sends them back in.
    When every in-consult row is held, nobody is being served and the board says nothing, which is
    the true answer rather than the last one that happened to be true.
  */
  const serving = entries.find((r) => r.status === "called")
    ?? entries.find((r) => r.status === "in_consult" && r.parkedAt === null);
  return {
    nowServing: serving?.tokenNo ?? null, next: ordered.slice(0, BOARD_NEXT).map((x) => x.tokenNo),
    waitingCount: waiting.length, heldForPaymentCount: entries.filter((r) => r.status === "waiting" && held.has(r.id)).length,
  };
}

export type QueueEntryView = QueueEntryRow & {
  position: number | null; queueClass: QueueClass | null;
  encounter: {
    id: string; patientId: string; visitType: string; dangerFlagged: boolean; status: string;
    /**
     * OWNER RULING 2026-09-20 — the two sentences that explain an unpaid token, carried to the
     * doctor's rail because "why is this person here without a bill" is the question the ruling
     * asks the doctor to answer. `feeBypassReason` is the bay's or the front desk's (FD-32);
     * `consultFeeOverrideReason` is a doctor's own, and its presence is what puts an unsettled
     * token back in the callable order.
     */
    feeBypassReason: string | null; consultFeeOverrideReason: string | null;
  };
  patient: PatientSummary | null;
  /**
   * RC-1 T3 / D1 — the token's stamp, DERIVED from the invoice ledger by `encounterFeeStatuses`
   * (never stored): free · settled · credit · unsettled. `null` when billing is unconfigured —
   * unknown, rendered as nothing.
   */
  feeStatus: "free" | "settled" | "credit" | "unsettled" | null;
};
export type QueueView = {
  session: SessionRow; doctor: DoctorRow; ordered: QueueEntryView[]; current: QueueEntryView | null; inConsult: QueueEntryView[];
  /**
   * ═══ THE ROWS THAT FELL OUT — ADDED 2026-09-13, AND THEY WERE VISIBLE NOWHERE ═══
   *
   * A token skipped `max_skips_before_left` times becomes `left`, and until this field existed the
   * view carried the COUNT of them and not one identity. `left` is rendered by no screen in this
   * application, so a patient whose visit is still open — measured: `left` entry, `waiting`
   * encounter — was callable by nobody and findable by nobody. The count said "1" and could not say
   * who.
   *
   * They are ordered newest-first: a doctor looking for the patient they just lost is looking for
   * the most recent one, and the list is naturally short (each row is a patient who was called
   * three times and did not come).
   */
  left: QueueEntryView[];
  /**
   * ═══ THE TOKENS WITH THE CASHIER (OWNER RULING 2026-09-20) ═══
   *
   * Waiting, vitals done, fee `unsettled`, doctor has not opened them: out of `ordered` (so
   * `callNext` cannot reach them and the board does not announce them) and HERE, where the
   * doctor's own screen shows them. Not hidden — the whole point of the ruling is that the doctor
   * can see who is stuck at the counter and decide, patient by patient, to see them anyway.
   *
   * In arrival order, not engine order: they hold no queue position to argue about, and the one a
   * doctor is looking for is the one who has been waiting longest.
   */
  heldForPayment: QueueEntryView[];
  waitingVitals: number;
  counts: { waiting: number; called: number; inConsult: number; done: number; left: number; heldForPayment: number };
};

/** The doctor-day queue as the desk and the consultation screen read it: the engine's order, with the facts each row needs. */
export async function listQueue(db: Db, actor: Actor, doctorId: string, serviceDate: string, now: Date = new Date()): Promise<QueueView | null> {
  const cfg = await loadOpdConfig(db);
  const doctor = (await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId)))[0];
  if (!doctor) throw new OpdError("unknown_doctor", `unknown doctor ${doctorId}`);
  const session = (await db
    .select().from(opdQueueSessions)
    .where(and(eq(opdQueueSessions.doctorId, doctorId), eq(opdQueueSessions.serviceDate, serviceDate))))[0];
  if (!session) return null;

  const rows = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.sessionId, session.id)).orderBy(asc(opdQueueEntries.seq));
  const encounterIds = rows.map((r) => r.encounterId);
  const encounters = encounterIds.length === 0 ? [] : await db.select().from(opdEncounters).where(inArray(opdEncounters.id, encounterIds));
  const encounterById = new Map(encounters.map((e) => [e.id, e] as const));
  // Demographics come from the patients module — the OPD module reads no patient table (spec §4).
  const summaries = await getPatientSummaries(db, actor, encounters.map((e) => e.patientId));
  const summaryByPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
  // The stamp, batched: a fixed number of queries however long the queue (the CI perf budget).
  const feeStatuses = await encounterFeeStatuses(db, encounters);

  const toView = (row: QueueEntryRow, position: number | null, queueClass: QueueClass | null): QueueEntryView => {
    const encounter = encounterById.get(row.encounterId)!;
    return {
      ...row, position, queueClass,
      encounter: {
        id: encounter.id, patientId: encounter.patientId, visitType: encounter.visitType,
        dangerFlagged: encounter.dangerFlagged, status: encounter.status,
        feeBypassReason: encounter.feeBypassReason, consultFeeOverrideReason: encounter.consultFeeOverrideReason,
      },
      patient: summaryByPatient.get(encounter.patientId) ?? null,
      feeStatus: feeStatuses.get(encounter.id) ?? null,
    };
  };

  const byId = new Map(rows.map((r) => [r.id, r] as const));
  /*
    THE HOLD IS APPLIED BEFORE THE ENGINE RUNS, not after it. Ordering the held tokens and then
    dropping them would leave the positions the doctor reads with holes in them — "3 of 7" with
    four rows on the screen — and the engine's perk-every-nth counter would advance for patients
    nobody can call. The queue the doctor sees is the queue the doctor can act on.
  */
  const held = await heldForPaymentIds(db, rows);
  const ordered = orderQueue(rows.filter((r) => r.status === "waiting" && !held.has(r.id)).map(toState), now, { perkEveryNth: cfg.perkEveryNth }, session.callsMade)
    .map((state, i) => toView(byId.get(state.id)!, i + 1, classOf(state, now)));
  const called = rows.find((r) => r.status === "called");
  const count = (status: string): number => rows.filter((r) => r.status === status).length;
  return {
    session, doctor, ordered,
    current: called === undefined ? null : toView(called, null, null),
    inConsult: rows.filter((r) => r.status === "in_consult").map((r) => toView(r, null, null)),
    // Newest first: the row a doctor is hunting for is the one that just fell out. No position and
    // no class — a left row is not in the ordering, and giving it one would say it was.
    left: rows.filter((r) => r.status === "left").sort((a, b) => b.seq - a.seq).map((r) => toView(r, null, null)),
    // No position and no class: a held token is not in the ordering, and giving it one would say it was.
    heldForPayment: rows.filter((r) => held.has(r.id)).sort((a, b) => a.seq - b.seq).map((r) => toView(r, null, null)),
    waitingVitals: count("waiting_vitals"),
    counts: {
      waiting: rows.filter((r) => r.status === "waiting" && !held.has(r.id)).length,
      called: count("called"), inConsult: count("in_consult"), done: count("done"), left: count("left"),
      heldForPayment: held.size,
    },
  };
}

/**
 * §11.1 call. One transaction, serialized per session: two "call next" clicks at nearly the same instant may compute
 * DIFFERENT heads (an appointment crossing its due time between their clocks), which the status belt below cannot
 * catch — so the session row (a row OUTSIDE the entry's own write path) is locked first and makes the pre-check
 * authoritative. Every loser, whichever way the interleaving falls, gets the SAME code: call_conflict.
 */
export async function callNext(db: Db, actor: Actor, sessionId: string, now: Date = new Date()): Promise<{ entry: QueueEntryRow | null; encounter: EncounterRow | null }> {
  return withTx(db, async (tx) => {
    const cfg = await loadOpdConfig(tx);
    // Serialize callers per session: two "call next" clicks at nearly the same instant may compute DIFFERENT heads
    // (an appointment crossing its due time between their clocks); the row lock makes the pre-check below authoritative.
    const sRows = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId)).for("update");
    const session = sRows[0];
    if (!session) throw new OpdError("unknown_session");
    if (session.status === "closed") throw new OpdError("session_closed");
    if (session.status === "out") throw new OpdError("doctor_out");
    const live = await tx.select().from(opdQueueEntries).where(and(eq(opdQueueEntries.sessionId, sessionId), inArray(opdQueueEntries.status, ["waiting", "called"])));
    if (live.some((r) => r.status === "called")) throw new OpdError("call_conflict", "a token is already called — start or skip it first");
    /*
      THE HOLD IS RE-READ INSIDE THE LOCK, not carried in from the screen that clicked. Between the
      doctor reading the rail and pressing "call next", a receipt can land (the token becomes
      callable) or a void can reverse one (it stops being) — and the authority on which of those is
      true right now is the ledger, in this transaction, under the session row lock.
    */
    const held = await heldForPaymentIds(tx, live);
    const head = nextInQueue(live.filter((r) => r.status === "waiting" && !held.has(r.id)).map(toState), now, { perkEveryNth: cfg.perkEveryNth }, session.callsMade);
    if (!head) return { entry: null, encounter: null };
    const updated = await tx.update(opdQueueEntries)
      .set({ status: "called", calledAt: now, callCount: sql`${opdQueueEntries.callCount} + 1` })
      .where(and(eq(opdQueueEntries.id, head.id), eq(opdQueueEntries.status, "waiting"))).returning();
    if (updated.length === 0) throw new OpdError("call_conflict", "entry moved concurrently"); // belt — the SAME code as the pre-check
    await tx.update(opdQueueSessions)
      .set({ callsMade: sql`${opdQueueSessions.callsMade} + 1`, status: session.status === "not_started" ? "in" : session.status, openedAt: session.openedAt ?? now })
      .where(eq(opdQueueSessions.id, sessionId));
    const encounter = (await getEncounter(tx, updated[0]!.encounterId))!;
    await appendEvent(tx, queueCalled.make({ actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, entryId: updated[0]!.id, doctorId: session.doctorId, serviceDate: session.serviceDate,
      sessionId, roomId: session.roomId, tokenNo: updated[0]!.tokenNo, callCount: updated[0]!.callCount,
    } }));
    return { entry: updated[0]!, encounter };
  });
}

/**
 * ═══ CONSULT V2 — RECALL: SAY THE CALLED TOKEN AGAIN (owner, 2026-09-23) ═══
 *
 * The patient was called and has not come in. The doctor presses the alarm on the card and the corridor
 * board announces the same token again. Nothing about the queue moves — the entry stays `called`, keeps
 * its place and its `calledAt` — only `callCount` rises, and a `queue.called` event is appended exactly
 * as `callNext` appends one: that event IS the announcement the display speaks, and it is the audit
 * (who pressed it, when, and the running count). Skip is untouched; a recall is not a skip.
 *
 * The same authority as Call next and Skip (`opd.queue.operate`, on the route), and only a token that
 * is `called` right now.
 */
export async function recallCalled(db: Db, actor: Actor, entryId: string): Promise<{ entry: QueueEntryRow }> {
  return withTx(db, async (tx) => {
    const [row] = await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, entryId)).for("update");
    if (!row) throw new OpdError("unknown_queue_entry");
    const [session] = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, row.sessionId));
    if (!session) throw new OpdError("unknown_session");
    if (row.status !== "called") throw new OpdError("queue_entry_state_conflict", `a recall needs a called token, not ${row.status}`);
    const updated = await tx.update(opdQueueEntries)
      .set({ callCount: sql`${opdQueueEntries.callCount} + 1` })
      .where(and(eq(opdQueueEntries.id, entryId), eq(opdQueueEntries.status, "called"))).returning();
    if (updated.length === 0) throw new OpdError("call_conflict", "entry moved concurrently");
    const encounter = (await getEncounter(tx, row.encounterId))!;
    await appendEvent(tx, queueCalled.make({ actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, entryId, doctorId: session.doctorId, serviceDate: session.serviceDate,
      sessionId: session.id, roomId: session.roomId, tokenNo: updated[0]!.tokenNo, callCount: updated[0]!.callCount,
    } }));
    return { entry: updated[0]! };
  });
}

/**
 * The called patient did not come: back to waiting with eligible_at = now (they lose their place, never their token),
 * or out of the queue once max_skips_before_left is reached.
 */
export async function skipCalled(db: Db, actor: Actor, entryId: string, input: SkipInput, now: Date = new Date()): Promise<{ entry: QueueEntryRow }> {
  const note = input.note?.trim() ?? "";
  /*
    `other` IS THE ONLY ONE THAT NEEDS THE BOX, and it needs it absolutely: "other" with no text is
    the audit trail saying a patient lost their turn for a reason nobody wrote down, which is the
    state this whole change exists to end. The other five say what they mean on their own.
  */
  if (input.reason === "other" && note === "") throw new OpdError("reason_required", "a skip for 'other' records what the reason was");
  return withTx(db, async (tx) => {
    const cfg = await loadOpdConfig(tx);
    const current = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, entryId)))[0];
    if (!current) throw new OpdError("unknown_queue_entry", `unknown queue entry ${entryId}`);
    if (current.status !== "called") throw new OpdError("queue_entry_state_conflict", `a skip needs a called entry, not ${current.status}`);
    const skips = current.skips + 1;
    const left = skips >= cfg.maxSkipsBeforeLeft;
    const updated = await tx.update(opdQueueEntries)
      .set({
        status: left ? "left" : "waiting", skips, eligibleAt: left ? current.eligibleAt : now,
        skipReason: input.reason, skipNote: note === "" ? null : note, skippedAt: now, skippedBy: actor.id,
        /*
          THE TURN AS IT WAS, stored BEFORE this skip moves it. `eligible_at` is null until a row
          becomes `waiting` (arrival order stands in until then), and null is a faithful record of
          that: `undoSkip` writes back exactly what it finds here, including nothing.
        */
        preSkipEligibleAt: current.eligibleAt,
      })
      .where(and(eq(opdQueueEntries.id, entryId), eq(opdQueueEntries.status, "called"))).returning();
    if (updated.length === 0) throw new OpdError("queue_entry_state_conflict", "entry moved concurrently");
    const entry = updated[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0]!;
    const encounter = (await getEncounter(tx, entry.encounterId))!;
    await appendEvent(tx, queueSkipped.make({ actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, entryId: entry.id, doctorId: session.doctorId, serviceDate: session.serviceDate,
      sessionId: session.id, roomId: session.roomId, tokenNo: entry.tokenNo, skips, left,
      reason: input.reason, note: note === "" ? null : note,
    } }));
    return { entry };
  });
}

/**
 * ═══ THE SKIP THAT SHOULD NOT HAVE HAPPENED (owner, 2026-09-13) ═══
 *
 * *"When as a doctor, I clicked 'Skip' by mistake and that patient is no where to be seen in my
 * dashboard to undo my mistake."*
 *
 * Both halves were true, and the second one is worse than the first. A skip below the cap put the
 * patient back among the waiting with their turn moved to now — recoverable, but silently, with no
 * marker saying it had happened. A skip that REACHED the cap wrote `left`, and `left` is rendered
 * by no screen in this application: the patient's visit stays open and callable by nobody. Measured
 * in the owner's own data the same afternoon — one patient, three skips, `left`, encounter
 * `waiting`.
 *
 * WHAT AN UNDO RESTORES is the state the skip changed and nothing else: the status (`left` back to
 * `waiting`), the counter, and the turn (`eligible_at`). It is the MOST RECENT skip only — the
 * column holds one prior turn, so a second undo has nothing to restore and refuses rather than
 * quietly leaving the patient at the back of the queue.
 *
 * NO TIME WINDOW, deliberately. A window is a rule a doctor cannot see and would have to discover
 * by losing a patient to it, and it would grant nothing: `markInConsult` already lets a doctor take
 * a waiting patient without calling them, so an undo hands back only what the doctor could always
 * have done by hand — with their name on it, which is the part that was missing.
 */
export async function undoSkip(db: Db, actor: Actor, entryId: string, now: Date = new Date()): Promise<{ entry: QueueEntryRow }> {
  return withTx(db, async (tx) => {
    const current = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, entryId)))[0];
    if (!current) throw new OpdError("unknown_queue_entry", `unknown queue entry ${entryId}`);
    if (current.status !== "waiting" && current.status !== "left") {
      throw new OpdError("queue_entry_state_conflict", `an undo needs a waiting or left entry, not ${current.status}`);
    }
    /*
      ═══ A ROW THAT FELL OUT IS RECOVERABLE WHETHER OR NOT IT SAYS WHY ═══

      Found by walking the owner's own data in a browser, and it is the difference between a guard
      on the RIGHT property and a guard on the adjacent one. The first draft refused any entry
      without a standing skip mark — and the patient this whole change exists for, skipped three
      times on the build BEFORE `skip_reason` existed, is exactly that: `left`, no reason, visit
      open. The one row the fix was written for was the one row it refused.

      `left` IS ITS OWN EVIDENCE. A token does not reach it by any road but the skip cap, so the
      reason column being empty says the skip predates this column — never that nothing happened.
      A `waiting` row is different: without a mark there is genuinely no skip to take back, and
      saying so is better than silently decrementing a counter.
    */
    if (current.skippedAt === null && current.status !== "left") {
      throw new OpdError("queue_entry_state_conflict", "this token has no skip to undo");
    }
    const skippedAt = current.skippedAt;
    const updated = await tx.update(opdQueueEntries)
      .set({
        status: "waiting", skips: Math.max(0, current.skips - 1),
        /*
          THE TURN COMES BACK, and on a `left` row it never left: `skipCalled` moves `eligible_at`
          to now only when the token stays in the queue (`left ? current.eligibleAt : now`), so a
          row that fell out still carries the turn it arrived with. An unmarked one therefore keeps
          what it has, and a marked one gets back what the skip took.
        */
        eligibleAt: skippedAt === null ? current.eligibleAt : current.preSkipEligibleAt,
        skipReason: null, skipNote: null, skippedAt: null, skippedBy: null, preSkipEligibleAt: null,
      })
      /*
        THE BELT IS WHICHEVER FACT THIS UNDO IS ACTING ON. For a marked skip it is `skipped_at`:
        two doctors undoing the same skip must not both decrement the counter, and the loser finds
        the mark already cleared. For an unmarked `left` row there is no mark, so the status IS the
        claim — the loser finds it `waiting` and refuses.
      */
      .where(and(
        eq(opdQueueEntries.id, entryId),
        skippedAt === null ? eq(opdQueueEntries.status, "left") : eq(opdQueueEntries.skippedAt, skippedAt),
      )).returning();
    if (updated.length === 0) throw new OpdError("queue_entry_state_conflict", "entry moved concurrently");
    const entry = updated[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0]!;
    const encounter = (await getEncounter(tx, entry.encounterId))!;
    await appendEvent(tx, queueSkipUndone.make({ actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, entryId: entry.id, doctorId: session.doctorId, serviceDate: session.serviceDate,
      sessionId: session.id, roomId: session.roomId, tokenNo: entry.tokenNo,
      skips: entry.skips, reason: current.skipReason, skippedAt: skippedAt?.toISOString() ?? null,
      undoneAt: now.toISOString(), wasLeft: current.status === "left",
    } }));
    return { entry };
  });
}

/** called | waiting → in_consult (a doctor may take a patient without calling). T7's startConsultation owns the encounter move. */
export async function markInConsult(tx: Tx, encounterId: string, now: Date): Promise<QueueEntryRow> {
  const current = (await tx
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
  if (!current) throw new OpdError("unknown_queue_entry", `no queue entry for encounter ${encounterId}`);
  if (current.status !== "called" && current.status !== "waiting") {
    throw new OpdError("queue_entry_state_conflict", `a consultation starts from called or waiting, not ${current.status}`);
  }
  const updated = await tx.update(opdQueueEntries)
    .set({ status: "in_consult", calledAt: current.calledAt ?? now }) // never called: the doctor took them at `now`
    .where(and(eq(opdQueueEntries.id, current.id), eq(opdQueueEntries.status, current.status))).returning();
  if (updated.length === 0) throw new OpdError("queue_entry_state_conflict", "entry moved concurrently");
  return updated[0]!;
}

/** Any live entry → done (T7's completion). null when the encounter has no live entry left. */
export async function markDone(tx: Tx, encounterId: string, now: Date): Promise<QueueEntryRow | null> {
  const current = (await tx
    .select().from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
  if (!current) return null;
  /*
    THE PARK MARK IS CLEARED WITH THE ROW IT BELONGS TO. A doctor may complete a patient who was
    parked — they came back, the note was already written, and the completion is the next click —
    so `done` and `parked_at` must never be true of the same row: "parked" means HELD MID-
    CONSULTATION, and a finished visit is not held. The other three writers that move an entry out
    of `in_consult` (abandon → cancelled, re-entry → done, transfer → transferred) take the row off
    the board altogether, where no reader asks the question; this is the one path a parked patient
    is actually carried along.
  */
  const updated = await tx.update(opdQueueEntries)
    .set({ status: "done", doneAt: now, parkedAt: null, parkedBy: null })
    .where(and(eq(opdQueueEntries.id, current.id), eq(opdQueueEntries.status, current.status))).returning();
  return updated[0] ?? null;
}

export type BoardItem = {
  sessionId: string; roomId: string | null; roomCode: string | null; doctorId: string; doctorName: string;
  departmentName: string; status: SessionStatus; nowServing: number | null; next: number[]; waitingCount: number;
};

/**
 * The public display board (§11.5): token, room and doctor ONLY — never a patient name, never a patient id.
 * The day's open sessions, ordered by room code; `next` is up to five upcoming tokens in engine order.
 */
export async function boardSnapshot(db: Db, serviceDate: string, roomIds?: string[], now: Date = new Date()): Promise<BoardItem[]> {
  const cfg = await loadOpdConfig(db);
  const rows = await db
    // PLAN 13 T6 — the join target moved to the registry and the join STAYS A LEFT JOIN: a session
    // with no room still belongs on the board (it sorts to the end, below).
    .select({ session: opdQueueSessions, doctorName: opdDoctors.displayName, departmentName: opdDepartments.name, roomCode: resources.code })
    .from(opdQueueSessions)
    .innerJoin(opdDoctors, eq(opdQueueSessions.doctorId, opdDoctors.id))
    .innerJoin(opdDepartments, eq(opdDoctors.departmentId, opdDepartments.id))
    .leftJoin(resources, eq(opdQueueSessions.roomId, resources.id))
    .where(and(
      eq(opdQueueSessions.serviceDate, serviceDate),
      ne(opdQueueSessions.status, "closed"),
      roomIds === undefined ? undefined : inArray(opdQueueSessions.roomId, roomIds),
    ));
  const entriesBySession = await liveEntriesBySession(db, rows.map((r) => r.session.id));
  /*
    ONE batched hold for the whole board rather than one per session: the TV in the hall polls this,
    and `encounterFeeStatuses` costs the same fixed handful of queries for four hundred tokens as
    for four. The board itself says NOTHING about money — a held token is simply not announced.
  */
  const held = await heldForPaymentIds(db, [...entriesBySession.values()].flat());
  return rows
    .map((r): BoardItem => {
      const { nowServing, next, waitingCount } = summarise(entriesBySession.get(r.session.id) ?? [], r.session.callsMade, cfg, now, held);
      return {
        sessionId: r.session.id, roomId: r.session.roomId, roomCode: r.roomCode, doctorId: r.session.doctorId,
        doctorName: r.doctorName, departmentName: r.departmentName, status: r.session.status as SessionStatus,
        nowServing, next, waitingCount,
      };
    })
    .sort((a, b) => {
      if (a.roomCode === b.roomCode) return a.doctorName.localeCompare(b.doctorName);
      if (a.roomCode === null) return 1; // a session with no room sits at the end of the board
      if (b.roomCode === null) return -1;
      return a.roomCode.localeCompare(b.roomCode);
    });
}

export type DoctorSummary = {
  doctor: DoctorRow; sessionId: string | null; status: SessionStatus | "none"; waitingCount: number;
  waitingVitalsCount: number; nowServing: number | null; scheduledToday: boolean; roomCode: string | null;
  /** OWNER RULING 2026-09-20 — waiting, vitals done, fee unsettled, doctor has not opened them. */
  heldForPaymentCount: number;
  /**
   * ═══ FD-7 T8 — THE BOARD DID NOT KNOW ABOUT LEAVE, AT ALL ═══
   *
   * `scheduledToday` was read off `opd_doctor_schedules` alone, so a doctor on approved leave stayed
   * on the board all day reading "scheduled, 0 waiting". Two things followed from that, and the
   * second is the one that reaches a patient:
   *
   *   · the desk's "session not opened" alert (`desk-provider.ts:56`) nagged about a doctor who was
   *     away, every day of their leave;
   *   · **an empty queue is the SHORTEST queue.** With the owner's 03-Sep ruling that the department
   *     queue auto-assigns to the least-waiting doctor, a doctor on leave would win that comparison
   *     every time — the walk-in router would have sent every arriving patient to the one person in
   *     the building guaranteed not to see them.
   *
   * `availableSlots` and `bookAppointment` have consulted `opd_doctor_leaves` since Plan 07
   * (`appointments.ts:23`); the QUEUE side never did. `scheduledToday` now means "working today" —
   * which is what every one of its five readers already assumed it meant — and `onLeaveToday` says
   * WHY somebody is not, because "not on the board" and "away today" are different things to a clerk
   * standing in front of a patient who asked for that doctor by name.
   */
  onLeaveToday: boolean;
  /**
   * RC-1 T5 / D7 — wait v0's pace term: the department's `avg_consult_minutes` (a masters column,
   * default 6). The seat renders `waitingCount × this` as minutes AND a clock time; a future pace
   * model replaces THIS COLUMN'S READ, never the wire shape.
   */
  avgConsultMinutes: number;
};

/** The front desk's overview of a department's doctors for one IST day (every active doctor, session or not). */
export async function summaryByDoctor(db: Db, departmentId: string | undefined, serviceDate: string, now: Date = new Date()): Promise<DoctorSummary[]> {
  const cfg = await loadOpdConfig(db);
  const doctors = await db
    .select().from(opdDoctors)
    .where(departmentId === undefined ? eq(opdDoctors.active, true) : and(eq(opdDoctors.active, true), eq(opdDoctors.departmentId, departmentId)));
  if (doctors.length === 0) return [];
  const doctorIds = doctors.map((d) => d.id);

  const sessions = await db
    .select().from(opdQueueSessions)
    .where(and(inArray(opdQueueSessions.doctorId, doctorIds), eq(opdQueueSessions.serviceDate, serviceDate)));
  const sessionByDoctor = new Map(sessions.map((s) => [s.doctorId, s] as const));
  const entriesBySession = await liveEntriesBySession(db, sessions.map((s) => s.id));
  // The same batched hold the board takes, over the whole department's live rows (see `heldForPaymentIds`).
  const held = await heldForPaymentIds(db, [...entriesBySession.values()].flat());

  // One batched read of the day's templates — the same predicate sessions.roomForDoctorDay uses, for many doctors at once.
  const weekday = istWeekday(serviceDate);
  const templates = await db
    .select({ doctorId: opdDoctorSchedules.doctorId, startTime: opdDoctorSchedules.startTime, roomId: opdDoctorSchedules.roomId })
    .from(opdDoctorSchedules)
    .where(and(
      inArray(opdDoctorSchedules.doctorId, doctorIds), eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, weekday),
      lte(opdDoctorSchedules.validFrom, serviceDate),
      or(isNull(opdDoctorSchedules.validTo), sql`${opdDoctorSchedules.validTo} >= ${serviceDate}`),
    ));
  const scheduledRoom = new Map<string, string>();
  for (const t of [...templates].sort((a, b) => (a.startTime < b.startTime ? -1 : 1))) {
    if (!scheduledRoom.has(t.doctorId)) scheduledRoom.set(t.doctorId, t.roomId);
  }

  /*
   * FD-7 T8 — the day's approved leave, batched over the same doctor set. The predicate is exactly
   * `appointments.ts:23`'s (`status = 'scheduled'`, `from <= date <= to`, inclusive both ends) so
   * the queue and the appointment book cannot disagree about who is away — a doctor the book refuses
   * to book and the board offers a walk-in to would be worse than either behaviour alone.
   */
  const leaves = await db
    .select({ doctorId: opdDoctorLeaves.doctorId })
    .from(opdDoctorLeaves)
    .where(and(
      inArray(opdDoctorLeaves.doctorId, doctorIds), eq(opdDoctorLeaves.status, "scheduled"),
      lte(opdDoctorLeaves.fromDate, serviceDate), gte(opdDoctorLeaves.toDate, serviceDate),
    ));
  const onLeave = new Set(leaves.map((l) => l.doctorId));

  const roomIds = [...new Set([...sessions.map((s) => s.roomId), ...scheduledRoom.values()].filter((r): r is string => r !== null))];
  const rooms = roomIds.length === 0 ? [] : await db.select({ id: resources.id, code: resources.code }).from(resources).where(inArray(resources.id, roomIds));
  const roomCode = new Map(rooms.map((r) => [r.id, r.code] as const));

  // D7 — one batched read of the doctors' departments for the pace column.
  const deptIds = [...new Set(doctors.map((d) => d.departmentId))];
  const depts = deptIds.length === 0
    ? []
    : await db.select({ id: opdDepartments.id, avgConsultMinutes: opdDepartments.avgConsultMinutes }).from(opdDepartments).where(inArray(opdDepartments.id, deptIds));
  const avgByDept = new Map(depts.map((d) => [d.id, d.avgConsultMinutes] as const));

  return doctors
    .map((doctor): DoctorSummary => {
      const session = sessionByDoctor.get(doctor.id);
      const entries = session === undefined ? [] : entriesBySession.get(session.id) ?? [];
      const { nowServing, waitingCount, heldForPaymentCount } = summarise(entries, session?.callsMade ?? 0, cfg, now, held);
      const room = session?.roomId ?? scheduledRoom.get(doctor.id) ?? null;
      return {
        doctor, sessionId: session?.id ?? null, status: (session?.status as SessionStatus | undefined) ?? "none",
        waitingCount, waitingVitalsCount: entries.filter((r) => r.status === "waiting_vitals").length,
        // The desk's own figure: tokens ready for the doctor and stuck at the cashier. A staff
        // screen acts on it (send them to pay); the public board never sees it.
        heldForPaymentCount,
        nowServing,
        // A doctor on leave is NOT scheduled today, whatever the weekly template says.
        scheduledToday: scheduledRoom.has(doctor.id) && !onLeave.has(doctor.id),
        onLeaveToday: onLeave.has(doctor.id),
        roomCode: room === null ? null : roomCode.get(room) ?? null,
        avgConsultMinutes: avgByDept.get(doctor.departmentId) ?? 6,
      };
    })
    .sort((a, b) => a.doctor.displayName.localeCompare(b.doctor.displayName));
}

/**
 * RC-1 T3 / D2 — the hook billing calls inside its settling transaction (`registerFeeStatusHook`,
 * wired by `opd.module.ts`). It appends `queue.fee_status_changed` — the board flip — ONLY when:
 * the encounter exists, its consult fee is actually covered per `encounterFeeStatuses` (so a
 * pharmacy-only invoice settling flips nothing), and a LIVE queue entry is on the board (a
 * deferred bill-first visit has no token yet — its token is BORN paid at `joinQueue`, and a flip
 * for a token that never showed UNPAID would just be noise).
 */
export async function queueFeeStatusHook(
  tx: Tx,
  actor: Actor,
  info: { encounterId: string; invoiceId: string; via: FeeStatusVia },
  now: Date,
): Promise<void> {
  const encounter = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, info.encounterId)))[0];
  if (!encounter) return;
  /**
   * RC-3 T3 — THE BAIL ON `unsettled` IS GONE, AND THAT IS THE WHOLE OF M3's FIX HERE.
   *
   * This hook has always RE-DERIVED the status rather than trusting its caller, so it already
   * computed the truth after a reversal — and then threw it away, because the guard treated
   * "unsettled" as "nothing to say". It is the opposite: a board showing PAID over money that has
   * been reversed is the one state the hall must not be left in.
   *
   * `undefined` (no fee service on this encounter at all) still returns: there is no stamp to move.
   */
  const status = (await encounterFeeStatuses(tx, [encounter])).get(encounter.id);
  if (status === undefined) return;

  /**
   * THE DIRECTION DECIDES WHETHER `unsettled` IS NEWS — and getting this wrong broke RC-1's M1
   * discriminator, which is how it was found.
   *
   * On an ARRIVING via, `unsettled` means "money came in and it did not cover THIS encounter's fee"
   * — a pharmacy-only invoice settling, exactly RC-1 M1's case. There is nothing to tell the hall:
   * the token was UNPAID before and is UNPAID now, and an event saying so would be noise on every
   * unrelated invoice in the hospital. RC-1's silence there was correct and is preserved.
   *
   * On a LEAVING via, `unsettled` is the entire point: money that WAS covering this fee has gone,
   * and the board is still showing PAID. That is M3.
   *
   * So the guard is about the direction of the money, not the value of the status. Removing it
   * altogether — the first thing I tried — turned M3's fix into a regression of M1's.
   */
  const ARRIVING: readonly FeeStatusVia[] = ["invoice", "credit_extended", "allocation"];
  if (status === "unsettled" && ARRIVING.includes(info.via)) return;
  const entry = (await tx
    .select().from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounter.id), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
  if (!entry) {
    /**
     * ═══ RC-4 CLOSE F1 (CRITICAL) — A DEFERRED VISIT JOINS WHERE ITS MONEY LANDS ═══
     *
     * "Its token is born PAID at `joinQueue`" was true only while the seat that opened the visit
     * stayed mounted and remembered it; every other road to the money — a reload, `/billing`, an
     * Escape — left a paid patient with no token. The join now happens HERE, inside the settling
     * transaction, for exactly the visit that has never had an entry: `registered`, today, with a
     * doctor, and (the deferred proxy) NO queue entry at all — a queue-first visit whose entry has
     * `left` or `done` has rows and is not re-entered by a payment; that is `re-enter`'s act.
     * Money done means `settled`, `credit`, or `free` (a revisit inside its window, reached here
     * by an invoice for something else on the visit) — the same three the seat counts.
     *
     * ═══ CLOSE REVIEW PASS 2, N1 (MAJOR) — `unsettled` DOES REACH THIS BRANCH, ON A LEAVING VIA ═══
     * The first remediation removed this guard on the argument that a leaving via "needs money that
     * was covering the fee, which would have joined the visit" — and R37 stayed green because no
     * fixture built the road. The road: a LAB invoice against a deferred visit settles (arriving,
     * fee still `unsettled` → returned above), then its receipt is voided or its allocation
     * reversed → a LEAVING via with the fee `unsettled` → without this line, four guards pass and
     * an UNPAID token is minted in the bill-first lane. The pass-2 reviewer built the road; the
     * test beside this (`fee-status.test.ts`, "N1") walks it and goes red without the guard.
     *
     * `joinQueueInTx` can only throw for a state this branch has already excluded (it re-reads the
     * same row under `FOR UPDATE`); a throw here WOULD abort the settle (`settle-hooks.ts`), which
     * is why every precondition is checked before the call rather than caught after it.
     */
    if (status === "unsettled") return;
    if (actor.type !== "user" || encounter.status !== "registered" || encounter.doctorId === null) return;
    const anyEntry = (await tx.select({ id: opdQueueEntries.id }).from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounter.id)).limit(1))[0];
    if (anyEntry) return;
    if (encounter.serviceDate !== istDate(now)) return;
    await joinQueueInTx(tx, actor, encounter.id, now);
    return;
  }
  const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0];
  if (!session) return;
  await appendEvent(tx, queueFeeStatusChanged.make({
    actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: info.invoiceId,
    payload: {
      encounterId: encounter.id, patientId: encounter.patientId, doctorId: session.doctorId,
      serviceDate: session.serviceDate, sessionId: session.id, roomId: session.roomId, tokenNo: entry.tokenNo,
      status, invoiceId: info.invoiceId, via: info.via,
    },
  }));
}

/** The live rows of many sessions in one query, grouped. */
async function liveEntriesBySession(db: Db, sessionIds: string[]): Promise<Map<string, QueueEntryRow[]>> {
  const grouped = new Map<string, QueueEntryRow[]>();
  if (sessionIds.length === 0) return grouped;
  const rows = await db
    .select().from(opdQueueEntries)
    .where(and(inArray(opdQueueEntries.sessionId, sessionIds), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
    .orderBy(asc(opdQueueEntries.seq));
  for (const row of rows) {
    const list = grouped.get(row.sessionId);
    if (list === undefined) grouped.set(row.sessionId, [row]);
    else list.push(row);
  }
  return grouped;
}
