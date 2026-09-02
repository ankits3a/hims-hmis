import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, opdQueueEntries, opdQueueSessions, opdVitals } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { loadOpdConfig } from "./config";
import { getEncounter, moveEncounter } from "./encounters";
import { OpdError } from "./errors";
import { visibleEncounterFor } from "./read-gate";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { vitalsAmended, vitalsDangerFlagged, vitalsRecorded } from "./events";
import { ageYearsAt } from "./time";
import {
  bandFor, checkCarriedLock, evaluateVitals, holdProbeErrors, inputToReadings, missingRequired,
  readingsToInput, sanityGates, UNLOCK_REASONS, validateVitalsRanges,
} from "./vitals-rules";
import type { DangerFlag } from "./events";
import type { EncounterRow, QueueEntryRow } from "./encounters";
import { SCALAR_READING_KEYS } from "./vitals-rules";
import type { ContextChip, GateOverrides, Readings, UnlockReasons, VitalsInput } from "./vitals-rules";
import type { VitalKey } from "./config";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ VD-1 T1 — WHAT THE BAY SENDS BESIDE THE NUMBERS ═══
 *
 * Everything the shipped desk could not say. `readings` is the authority when present: the scalar
 * vitals are DERIVED from it (`readingsToInput`) rather than sent alongside it, so the blob and
 * the columns can never disagree. A caller that sends only the flat body — the shipped screen,
 * until VD-2 replaces it — gets a single typed take synthesised for it, and every row in the table
 * therefore carries the same shape.
 */
export type VitalsDetail = {
  readings?: Readings;
  contextChips?: ContextChip[];
  /** Keys not measured today, carried from the last reading. They are PRESENT for completeness (D7). */
  carriedForward?: VitalKey[];
  /** D11 — declared, never inferred. Trims the required set to BP + pulse + SpO₂. */
  emergency?: boolean;
  /**
   * T2 / D9 — the per-key answer to a sanity gate. A gate is a refusal a named human can pass
   * through: the value is then recorded WITH the disagreement, flagged hard rather than accepted
   * quietly. The string is the reason and it is stored on the reading.
   */
  overrides?: GateOverrides;
  /** T2 / D7 — why a carried value is being re-measured. One of `UNLOCK_REASONS`, never free text. */
  unlockReasons?: UnlockReasons;
};

/**
 * ═══ VD-1 T2 — THE DISAGREEMENT IS STORED BESIDE THE NUMBER, NOT INSTEAD OF IT ═══
 *
 * An override and an unlock are both a person saying *"I know what this looks like, and I am
 * recording it anyway."* Both belong on the reading itself, where the doctor reading the chart
 * sees them, rather than only in an event nobody opens: an unlocked height keeps the OLD value in
 * its note, and an overridden weight keeps the reason. A record that shows a number without
 * showing that somebody argued with it is a record that has lost the argument.
 */
function annotate(
  readings: Readings, overrides: GateOverrides, unlockReasons: UnlockReasons, last: VitalsRow | null,
): Readings {
  const out: Readings = { ...readings };
  for (const key of SCALAR_READING_KEYS) {
    const r = out[key];
    if (r === undefined) continue;
    const parts: string[] = [];
    const reason = overrides[key];
    if (reason !== undefined) parts.push(`override: ${reason}`);
    const unlock = unlockReasons[key];
    if (unlock !== undefined) {
      const old = last?.[key] ?? null;
      parts.push(old === null ? `unlocked: ${unlock}` : `unlocked: ${unlock} (was ${old})`);
    }
    if (r.note !== undefined) parts.push(r.note);
    if (parts.length > 0) out[key] = { ...r, note: parts.join(" · ") };
  }
  const bpReason = overrides.sbp ?? overrides.dbp;
  if (out.bp !== undefined && bpReason !== undefined) {
    out.bp = { ...out.bp, note: [`override: ${bpReason}`, out.bp.note].filter((x) => x !== undefined).join(" · ") };
  }
  return out;
}

/**
 * ═══ VD-1 T2 — THE LAST READING, WHICH THE GATES CANNOT WORK WITHOUT ═══
 *
 * Two of the four gates compare against history: the shrinking adult needs the last height, and
 * the carried-value lock needs the number it claims to be carrying. This is that read, and it is
 * deliberately NOT the patient-scoped history reader — no merge chain, no PHI audit row, no
 * `opd.consult`. It answers one internal question inside a write the actor is already performing
 * on this patient, and a disclosure log entry for a comparison nobody is shown would make the PHI
 * log answer *"what did they actually see"* wrong, which is the only question it exists for.
 *
 * `status = 'active'` is the ONLY filter, and it is doing all the work: a value corrected by an
 * amendment is not the value this reading is carried from (D2), and the amend flow supersedes the
 * old row before writing the new one, so the row being replaced is already excluded.
 *
 * **THERE IS DELIBERATELY NO `recordedAt < now` CLAUSE, AND THE FIRST VERSION HAD ONE.** It was
 * put there to exclude "the row being written" — which does not exist yet, because this read
 * happens before the insert, so the clause excluded nothing it was meant to. What it DID exclude
 * was any reading recorded at the same instant, which under a pinned test clock is the entire
 * history and in production is a genuine same-minute re-measure. A filter whose stated purpose is
 * already impossible is a filter that can only do harm.
 */
export async function lastActiveVitals(db: Db | Tx, patientId: string): Promise<VitalsRow | null> {
  const rows = await db
    .select().from(opdVitals)
    .where(and(eq(opdVitals.patientId, patientId), eq(opdVitals.status, "active")))
    .orderBy(desc(opdVitals.recordedAt)).limit(1);
  return rows[0] ?? null;
}

export type VitalsRow = typeof opdVitals.$inferSelect;

/**
 * VD-2 T0 / F1 — the chart BEFORE the one being amended. An amendment's gates and its carried lock
 * compare against the visit's predecessor, never against the row being replaced: correcting a
 * mistyped 151 → 147 on the same visit must not fire `shrinking_adult` against the number being
 * corrected, and a carried height must still equal the chart it was carried FROM.
 */
export async function lastActiveVitalsBefore(db: Db | Tx, patientId: string, excludeVitalsId: string): Promise<VitalsRow | null> {
  const rows = await db
    .select().from(opdVitals)
    .where(and(eq(opdVitals.patientId, patientId), eq(opdVitals.status, "active"), ne(opdVitals.id, excludeVitalsId)))
    .orderBy(desc(opdVitals.recordedAt)).limit(1);
  return rows[0] ?? null;
}

/**
 * VD-2 T0 / F3 — A CARRIED KEY WITH NO NUMBER CARRIES THE NUMBER IN. `checkCarriedLock` skips an
 * absent value and `missingRequired` excuses a carried key, so a body naming `carriedForward:
 * ["heightCm"]` with no height wrote a NULL scalar under carried provenance — the chart said
 * "carried" and carried nothing, and the doctor dosed from a blank. The server owns the carried
 * number (D7: a carried value is a claim about provenance), so it copies it in; a carry with no
 * chart to carry from is refused by name rather than charted as nothing.
 */
export function carryIn(charted: VitalsInput, carriedForward: readonly VitalKey[], last: VitalsRow | null): void {
  const nothingToCarry: { key: VitalKey; carried: null; supplied: null }[] = [];
  for (const key of carriedForward) {
    if (charted[key] !== undefined && charted[key] !== null) continue;
    const carried = last?.[key] ?? null;
    if (carried === null) { nothingToCarry.push({ key, carried: null, supplied: null }); continue; }
    charted[key] = carried;
  }
  if (nothingToCarry.length > 0) {
    throw new OpdError(
      "carried_value_locked",
      `nothing to carry forward for: ${nothingToCarry.map((l) => l.key).join(", ")} — measure it`,
      { locked: nothingToCarry, reasons: UNLOCK_REASONS },
    );
  }
}

/** recordVitals runs on either of these; anything else is encounter_state_conflict. */
const RECORDABLE: readonly string[] = ["registered", "waiting"];
/** Queue-entry statuses a danger flag is stamped onto — the encounter's live-at-vitals-time set. */
const DANGER_ENTRY_STATUSES = ["waiting_vitals", "waiting", "called"] as const;

/**
 * ═══ THE VISIT THAT HAS NOT JOINED A QUEUE — FOUND BY THE RC-1 LANE'S CLOSE REVIEWER ═══
 *
 * This function asserted `entries[0]!` from the day it was written, and the assertion was TRUE
 * until 2026-08-31: `openVisit` always created a queue entry, so every encounter had one.
 *
 * **RC-1 T3 made an encounter with ZERO entries reachable over HTTP.** `POST /opd/walk-in
 * {join: "defer"}` — the bill-first counter flow — opens the visit and stops: no session, no
 * token, no queue entry (`encounters.ts`, the `join === "defer"` branch), and the entry arrives
 * later from `POST /opd/visits/:id/join-queue` once billing releases the token. Meanwhile
 * `listVisits` selects from `opd_encounters` with **no queue join at all**, so that visit appears
 * on the vitals worklist like any other, and submitting vitals for it dereferenced `undefined`.
 *
 * Two guards rather than one, because they answer different questions:
 *   · the PRE-FLIGHT below refuses before any work is attempted — that is the behaviour a person
 *     at the bay sees, and it says WHY in the counter's own terms;
 *   · this one enforces the invariant where it is actually relied upon, so a future caller that
 *     reaches here by another route gets a domain refusal rather than a TypeError. A non-null
 *     assertion justified by a guard forty lines away is a comment, not a check.
 *
 * REFUSING IS THE ANSWER, AND RECORDING-AND-CATCHING-UP IS NOT. This function's contract IS the
 * `waiting_vitals → waiting` flip, which is the gate that decides who the doctor may call. A
 * bill-first patient with no token would end up with vitals on the chart and still not callable —
 * the gate silently un-applied to exactly the patients whose flow is unusual. Under `bill_first`
 * the sequence is bill → join-queue → vitals, and the refusal states that precondition out loud.
 */
const NOT_QUEUED = "this visit has not joined a queue yet — a bill-first walk-in takes vitals after billing releases its token";

async function latestEntry(db: Db | Tx, encounterId: string): Promise<QueueEntryRow | null> {
  const entries = await db
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  return entries[0] ?? null;
}

/** The encounter's latest queue entry (seq, never id) and its session's room — the doctor-day event fields. */
async function latestEntryWhere(tx: Tx, encounterId: string): Promise<{ entry: QueueEntryRow; roomId: string | null }> {
  const entry = await latestEntry(tx, encounterId);
  if (entry === null) throw new OpdError("unknown_queue_entry", NOT_QUEUED, { encounterId });
  const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId));
  return { entry, roomId: sessions[0]!.roomId };
}

/**
 * §11.8: one vitals reading. Recording on a `registered` encounter moves it to `waiting` FIRST (the queue
 * entry waiting_vitals → waiting) — a role_denied refusal on that move writes nothing, ever (the move precedes
 * the insert). A danger flag never auto-clears (D4): a later normal reading leaves danger_flagged/danger true —
 * the doctor sees the history.
 */
export async function recordVitals(
  db: Db, actor: Actor, encounterId: string, input: VitalsInput, now: Date = new Date(), detail: VitalsDetail = {},
): Promise<{ vitals: VitalsRow; flags: DangerFlag[]; encounter: EncounterRow }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  // ONE input path (vitals-rules.ts's own header): readings win and the scalars are derived from
  // them; a flat body gets one typed take per vital synthesised. Nothing downstream branches.
  const readings = detail.readings ?? inputToReadings(input);
  const values: VitalsInput = detail.readings === undefined ? input : { ...input, ...readingsToInput(detail.readings) };
  validateVitalsRanges(values);
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (!RECORDABLE.includes(enc.status)) throw new OpdError("encounter_state_conflict", `vitals need registered or waiting, not ${enc.status}`);
  // The pre-flight half of the deferred-visit guard (see `latestEntryWhere`): refuse before the
  // transaction opens, so nothing is attempted and rolled back.
  if ((await latestEntry(db, encounterId)) === null) throw new OpdError("unknown_queue_entry", NOT_QUEUED, { encounterId });
  const cfg = await loadOpdConfig(db);
  const [summary] = await getPatientSummaries(db, actor, [enc.patientId]);
  const ageYears = summary?.dob ? ageYearsAt(summary.dob, now) : null;
  const band = bandFor(ageYears, cfg.dangerRanges);
  const carriedForward = detail.carriedForward ?? [];
  const emergency = detail.emergency === true;
  const overrides = detail.overrides ?? {};

  /**
   * ═══ T2 — THE GATES RUN BEFORE COMPLETENESS, AND THE ORDER IS THE DESIGN ═══
   *
   * A held SpO₂ can turn a complete submission into an incomplete one — that is exactly the
   * outcome the owner ruled for (*"lives in the log, not the chart"*), and it can only happen if
   * the hold runs FIRST. Running completeness first would accept the save and then quietly chart
   * a probe error, which is the defect this task exists to close.
   */
  const last = await lastActiveVitals(db, enc.patientId);
  const heldReadings = holdProbeErrors(readings, cfg.dangerRanges, overrides);
  const held = readingsToInput(heldReadings);
  const charted: VitalsInput = { ...values };
  if (heldReadings.spo2 === undefined) charted.spo2 = undefined;
  else charted.spo2 = held.spo2;

  carryIn(charted, carriedForward, last);
  const locked = checkCarriedLock(charted, carriedForward, last, detail.unlockReasons ?? {});
  if (locked.length > 0) {
    throw new OpdError(
      "carried_value_locked",
      `carried values changed without a reason: ${locked.map((l) => l.key).join(", ")}`,
      { locked, reasons: UNLOCK_REASONS },
    );
  }
  const gates = sanityGates(charted, ageYears, cfg.dangerRanges, last, overrides);
  if (gates.length > 0) throw new OpdError("vitals_gate", gates.map((g) => g.message).join("; "), { gates });

  const missing = missingRequired(charted, ageYears, cfg.dangerRanges, { emergency, carriedForward });
  if (missing.length > 0) throw new OpdError("vitals_incomplete", `missing: ${missing.join(", ")}`, { missing });
  const flags = evaluateVitals(charted, band, cfg.dangerRanges);
  /**
   * F1 — the split. Every flag is STORED and reaches the doctor; only a `danger` one moves the
   * board. A paediatric fever notice must never seat a toddler ahead of a stroke.
   */
  const dangerFlags = flags.filter((f) => f.severity !== "notice");

  return withTx(db, async (tx) => {
    let encounter: EncounterRow = enc;
    if (enc.status === "registered") {
      encounter = await moveEncounter(tx, actor, enc, "waiting", {}, now); // role_denied fails HERE, before any write
      await tx.update(opdQueueEntries)
        .set({ status: "waiting", eligibleAt: now })
        .where(and(eq(opdQueueEntries.encounterId, encounterId), eq(opdQueueEntries.status, "waiting_vitals")));
    }

    const [vitals] = await tx.insert(opdVitals).values({
      id: newId(), encounterId, patientId: encounter.patientId,
      heightCm: charted.heightCm ?? null, weightKg: charted.weightKg ?? null, sbp: charted.sbp ?? null, dbp: charted.dbp ?? null,
      pulse: charted.pulse ?? null, rr: charted.rr ?? null, spo2: charted.spo2 ?? null, tempC: charted.tempC ?? null,
      muacCm: charted.muacCm ?? null, notes: charted.notes ?? null,
      readings: annotate(heldReadings, overrides, detail.unlockReasons ?? {}, last),
      contextChips: detail.contextChips ?? [], carriedForward, emergency,
      ageYearsAtRecord: ageYears, band: band.key, dangerFlags: flags, recordedBy: actor.id, recordedAt: now,
    }).returning();

    const { entry, roomId } = await latestEntryWhere(tx, encounterId);
    const where = { doctorId: encounter.doctorId!, serviceDate: encounter.serviceDate, sessionId: entry.sessionId, roomId, tokenNo: entry.tokenNo };
    const env = { actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId };

    // VD-2 T0 — a chart ends the rest: a patient whose vitals are saved is no longer `resting`
    // (a stale `recallDue` would light the bench forever) and no longer `away`.
    if (entry.benchState !== null) {
      await tx.update(opdQueueEntries).set({ benchState: null, recallAt: null }).where(eq(opdQueueEntries.id, entry.id));
    }

    if (dangerFlags.length > 0) {
      // Not a status write — the mirror rule stands (only moveEncounter writes opd_encounters.status).
      await tx.update(opdEncounters).set({ dangerFlagged: true }).where(eq(opdEncounters.id, encounterId));
      /**
       * ═══ VD-1 T3 / D4 — THE ONE PREDICATE THAT MAKES CANCEL REAL ═══
       *
       * `ne(escalation, "cancelled")`. Without it a cancelled escalation is theatre: the nurse
       * presses CANCEL, the board is restored, and then the ordinary save re-raises `danger` on
       * the same readings a moment later and the patient jumps the queue anyway.
       *
       * **Nothing clinical is weakened by this, and that distinction is the whole design.** The
       * line above still sets `opd_encounters.danger_flagged`, and `vitals.danger_flagged` is
       * still appended, for EVERY danger reading including this one — the doctor receives the flag
       * and both takes regardless. What this predicate declines to re-impose is the BOARD
       * position, which a named human has just declined, inside ten seconds, with their id in
       * `escalation_by` and the moment in the event. The autonomy ladder: the agent bumps, only a
       * person un-bumps.
       */
      await tx.update(opdQueueEntries)
        .set({ danger: true })
        .where(and(
          eq(opdQueueEntries.encounterId, encounterId),
          inArray(opdQueueEntries.status, [...DANGER_ENTRY_STATUSES]),
          ne(opdQueueEntries.escalation, "cancelled"),
        ));
      await appendEvent(tx, vitalsDangerFlagged.make({ ...env, payload: { encounterId, patientId: encounter.patientId, vitalsId: vitals!.id, ...where, flags: dangerFlags } }));
      encounter = { ...encounter, dangerFlagged: true };
    }
    await appendEvent(tx, vitalsRecorded.make({ ...env, payload: {
      encounterId, patientId: encounter.patientId, vitalsId: vitals!.id, ...where, band: band.key,
      dangerCount: dangerFlags.length, noticeCount: flags.length - dangerFlags.length,
    } }));

    return { vitals: vitals!, flags, encounter };
  });
}

/**
 * ══════════════ VD-1 T5 / D2 — AMEND A SAVED CHART ══════════════
 *
 * The owner's ruling of 31-Aug: *"a saved chart is amendable at this desk — tap the ✓-with-doctor
 * row to re-open; every change is audited beside the old one; Esc abandons untouched."* A wrong
 * number typed at 09:52 and noticed at 09:54 is a thing a nurse must be able to fix without a
 * supervisor, or she will not tell anyone at all.
 *
 * ═══ A NEW ROW THAT NAMES ITS PREDECESSOR — NEVER AN EDIT ═══
 *
 * This is the LIMS pattern, inherited rather than re-derived: `lab_results.supersedes_result_id`,
 * `lab_reports.prior_version_id`, and that file's own sentence — *"there is no edit endpoint and
 * there must not be one."* The old row's `status` becomes `superseded`; the new row carries
 * `supersedes_vitals_id` and `amendment_reason`.
 *
 * **AND IT IS WHAT SEPARATES AN AMENDMENT FROM A REST-AND-RECHECK PAIR.** Both produce "two
 * readings" and nothing could tell them apart if both were rows: a pair is ONE row with two takes
 * (T1/D1), a correction is the NEXT row. The field-level trail the owner ruled — old value, actor,
 * clock — is the DIFF between versions, computed at read time. There is no second audit table,
 * because a trail that can disagree with the record is worse than no trail.
 *
 * ═══ WHAT AN AMENDMENT DOES NOT DO ═══
 *
 * It does not re-run the queue side. The encounter has already moved `registered → waiting`, the
 * token is already callable, and `moveEncounter` is not called again — a correction to a number is
 * not a second arrival. Danger flags ARE re-evaluated, because the corrected number is the one the
 * doctor will act on, and `dangerFlagged` is raised if the amendment reveals a danger the original
 * hid. It is never LOWERED: D4's rule that a danger flag never auto-clears is the same rule here,
 * and an amendment that could clear one would be the downgrade path the autonomy ladder forbids.
 */
export async function amendVitals(
  db: Db, actor: Actor, vitalsId: string, input: VitalsInput, reason: string,
  now: Date = new Date(), detail: VitalsDetail = {},
): Promise<{ vitals: VitalsRow; flags: DangerFlag[]; superseded: string }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  if (reason.trim() === "") throw new OpdError("reason_required", "an amendment needs a reason — it is the record");

  const priorRows = await db.select().from(opdVitals).where(eq(opdVitals.id, vitalsId));
  const prior = priorRows[0];
  if (!prior) throw new OpdError("unknown_vitals", `unknown vitals ${vitalsId}`);
  if (prior.status !== "active") {
    throw new OpdError("vitals_state_conflict", "this reading has already been superseded — amend the current one", { vitalsId });
  }
  /*
   * VD-2 T0 / F6 — THE SAME GATE AS THE RECORD PATH. `recordVitals` reads the encounter with
   * `getEncounter` and the patient through `getPatientSummaries`, so a `vitals_desk` nurse charts
   * a confidential patient (the summary arrives aliased). Amend went through `visibleEncounterFor`,
   * which needs `patients.confidential.read` or break-glass — held by neither desk role — so the
   * nurse who had just saved a VIP's transposed digit got `unknown_vitals` back. One rule: whoever
   * may write the chart may correct it, and nothing more is revealed by the correction than by
   * the save (the response is the row the caller wrote).
   */
  const enc = await getEncounter(db, prior.encounterId);
  if (!enc) throw new OpdError("unknown_vitals", `unknown vitals ${vitalsId}`);

  const readings = detail.readings ?? inputToReadings(input);
  const values: VitalsInput = detail.readings === undefined ? input : { ...input, ...readingsToInput(detail.readings) };
  validateVitalsRanges(values);

  const cfg = await loadOpdConfig(db);
  const [summary] = await getPatientSummaries(db, actor, [prior.patientId]);
  const ageYears = summary?.dob ? ageYearsAt(summary.dob, now) : null;
  const band = bandFor(ageYears, cfg.dangerRanges);
  const carriedForward = detail.carriedForward ?? (prior.carriedForward as VitalKey[]);
  /*
   * CLOSE pass 2 / F2 — A VALUE THE PRIOR ROW ALREADY CHARTED IS NOT GATED AGAIN. The gates and
   * the probe hold judge what is NEW: a confirmed 68 % SpO₂ or a confirmed 22 kg is a chart fact
   * the first save established with its override, and the override lives in a note. Re-holding
   * it on the amendment of the WEIGHT made a hypoxic patient's chart un-amendable from the desk.
   */
  const overrides: GateOverrides = { ...(detail.overrides ?? {}) };
  for (const k of ["weightKg", "heightCm", "spo2"] as const) {
    if (overrides[k] === undefined && values[k] !== undefined && values[k] !== null && values[k] === prior[k]) overrides[k] = "unchanged_on_amend";
  }
  // VD-2 T0 (review MINOR) — `emergency` was accepted on the amend body and silently dropped.
  const emergency = detail.emergency ?? prior.emergency;

  // The gates apply to a correction exactly as they apply to a first save — a slipped digit is no
  // more acceptable the second time — and they compare against the reading BEFORE this one, which
  // is the prior row's own predecessor rather than the row being replaced (T0 / F1: the code passed
  // `prior` itself, so a same-visit correction fired `shrinking_adult` against the value being fixed).
  const before = await lastActiveVitalsBefore(db, prior.patientId, prior.id);
  const heldReadings = holdProbeErrors(readings, cfg.dangerRanges, overrides);
  const held = readingsToInput(heldReadings);
  const charted: VitalsInput = { ...values };
  charted.spo2 = heldReadings.spo2 === undefined ? undefined : held.spo2;

  // T0 / F1 — D7 holds on amend exactly as on record: a carried key arrives with the carried number
  // or names a preset reason, and an absent number is carried in from the predecessor (F3).
  carryIn(charted, carriedForward, before);
  const locked = checkCarriedLock(charted, carriedForward, before, detail.unlockReasons ?? {});
  if (locked.length > 0) {
    throw new OpdError(
      "carried_value_locked",
      `carried values changed without a reason: ${locked.map((l) => l.key).join(", ")}`,
      { locked, reasons: UNLOCK_REASONS },
    );
  }
  const gates = sanityGates(charted, ageYears, cfg.dangerRanges, before, overrides);
  if (gates.length > 0) throw new OpdError("vitals_gate", gates.map((g) => g.message).join("; "), { gates });
  const missing = missingRequired(charted, ageYears, cfg.dangerRanges, { emergency, carriedForward });
  if (missing.length > 0) throw new OpdError("vitals_incomplete", `missing: ${missing.join(", ")}`, { missing });
  const flags = evaluateVitals(charted, band, cfg.dangerRanges);
  const dangerFlags = flags.filter((f) => f.severity !== "notice");

  return withTx(db, async (tx) => {
    await tx.update(opdVitals).set({ status: "superseded" }).where(eq(opdVitals.id, prior.id));
    const [vitals] = await tx.insert(opdVitals).values({
      id: newId(), encounterId: prior.encounterId, patientId: prior.patientId,
      heightCm: charted.heightCm ?? null, weightKg: charted.weightKg ?? null, sbp: charted.sbp ?? null, dbp: charted.dbp ?? null,
      pulse: charted.pulse ?? null, rr: charted.rr ?? null, spo2: charted.spo2 ?? null, tempC: charted.tempC ?? null,
      muacCm: charted.muacCm ?? null, notes: charted.notes ?? null,
      readings: annotate(heldReadings, overrides, detail.unlockReasons ?? {}, before),
      contextChips: detail.contextChips ?? prior.contextChips, carriedForward, emergency,
      ageYearsAtRecord: ageYears, band: band.key, dangerFlags: flags,
      supersedesVitalsId: prior.id, amendmentReason: reason,
      recordedBy: actor.id, recordedAt: now,
    }).returning();

    const entryRow = await latestEntry(tx, prior.encounterId);
    const session = entryRow === null ? null
      : (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entryRow.sessionId)))[0] ?? null;
    const env = { actor, patientId: prior.patientId, encounterId: prior.encounterId, correlationId: enc.workflowInstanceId };

    /*
     * VD-2 T0 / F2 — AN AMENDMENT THAT REVEALS A DANGER MOVES THE BOARD, and a notice does not.
     * As shipped, `flags.length > 0` set `dangerFlagged` for a NOTICE (a child's fever corrected
     * to 38.5 — the exact inversion of F1, and `reEnterVisit` copies that flag into `danger` on
     * re-entry, seating a fever ahead of a stroke) while a revealed DANGER (SpO₂ 95 corrected to
     * 85) touched neither the queue entry nor `vitals.danger_flagged`, so the token stayed class 3
     * and the doctor's board never flashed. Now the record path's rule, verbatim: dangers move the
     * board and fire the event; notices reach the doctor on the row and move nothing. Never lowered
     * (D4): an amendment may reveal a danger and can never clear one.
     */
    if (dangerFlags.length > 0) {
      await tx.update(opdEncounters).set({ dangerFlagged: true }).where(eq(opdEncounters.id, prior.encounterId));
      if (entryRow !== null && session !== null) {
        await tx.update(opdQueueEntries)
          .set({ danger: true })
          .where(and(
            eq(opdQueueEntries.id, entryRow.id),
            inArray(opdQueueEntries.status, [...DANGER_ENTRY_STATUSES]),
            ne(opdQueueEntries.escalation, "cancelled"),
          ));
        await appendEvent(tx, vitalsDangerFlagged.make({ ...env, payload: {
          encounterId: prior.encounterId, patientId: prior.patientId, vitalsId: vitals!.id,
          doctorId: session.doctorId, serviceDate: enc.serviceDate, sessionId: session.id, roomId: session.roomId, tokenNo: entryRow.tokenNo,
          flags: dangerFlags,
        } }));
      }
    }
    await appendEvent(tx, vitalsAmended.make({
      ...env,
      payload: {
        encounterId: prior.encounterId, patientId: prior.patientId, vitalsId: vitals!.id, supersededId: prior.id,
        doctorId: session?.doctorId ?? null, serviceDate: enc.serviceDate,
        sessionId: session?.id ?? null, roomId: session?.roomId ?? null, tokenNo: entryRow?.tokenNo ?? null,
        reason, changed: changedFields(prior, vitals!), dangerCount: dangerFlags.length,
      },
    }));
    return { vitals: vitals!, flags, superseded: prior.id };
  });
}

/**
 * The field-level trail, computed rather than stored: which scalar vitals differ between the
 * superseded row and its replacement, with both values. This is the owner's *"old value beside the
 * new"*, and it is derived so that it cannot drift from the rows it describes.
 */
export function changedFields(prior: VitalsRow, next: VitalsRow): { field: string; from: number | null; to: number | null }[] {
  const keys = ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC", "muacCm"] as const;
  const out: { field: string; from: number | null; to: number | null }[] = [];
  for (const k of keys) {
    const from = prior[k] ?? null;
    const to = next[k] ?? null;
    if (from !== to) out.push({ field: k, from, to });
  }
  return out;
}

/**
 * VD-2 CLOSE / pass-1 MAJOR — THE CHART, FOR THE NURSE WHO MAY CORRECT IT. T0/F6 opened `amend` to
 * the desk for a confidential patient; the bay then read the chart through `listVitals`, which is
 * the 07a read gate and answers `[]` without `patients.confidential.read` — so the correction F6
 * made lawful was unreachable from the screen it was fixed for. The same rule as the write, then:
 * whoever may amend the chart may read the row they are about to amend, and the read is logged.
 */
export async function getVitalsForAmend(db: Db, actor: Actor, vitalsId: string): Promise<VitalsRow | null> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const rows = await db.select().from(opdVitals).where(eq(opdVitals.id, vitalsId));
  const row = rows[0];
  if (!row) return null;
  const enc = await getEncounter(db, row.encounterId);
  if (!enc) return null;
  const [summary] = await getPatientSummaries(db, actor, [row.patientId]);
  await recordPhiAccess(db, {
    actor, patientId: row.patientId, surface: "opd.vitals", encounterId: row.encounterId,
    sealed: summary?.restricted ?? true, reason: null,
  });
  return row;
}

export async function listVitals(db: Db, actor: Actor, encounterId: string): Promise<VitalsRow[]> {
  // PLAN 07a T1 — an encounter id is not a capability. Same empty answer as an unknown encounter.
  const seen = await visibleEncounterFor(db, actor, encounterId);
  if (!seen) return [];
  await recordPhiAccess(db, {
    actor, patientId: seen.encounter.patientId, surface: "opd.vitals", encounterId,
    sealed: seen.sealed, reason: seen.breakGlass?.reason ?? null,
  });
  return db.select().from(opdVitals).where(eq(opdVitals.encounterId, encounterId)).orderBy(asc(opdVitals.recordedAt));
}
