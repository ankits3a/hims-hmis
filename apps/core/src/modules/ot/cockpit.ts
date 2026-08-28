import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  daycareEncounters, otCaseGates, otCases, otChecklistRuns, otIncidents, resources,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { transition } from "../../kernel/workflow/instances";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { assignResource, releaseResource } from "../../kernel/resources/registry";
import { verifyQrScan } from "../patients";
import { OT_RESOURCE_KINDS } from "./kinds";
import { OtError } from "./errors";
import {
  anaesthetistSubstituted, daycareCheckedIn, deathOnTableRecorded, incidentReported,
  lateEntryFlagged, procedureConverted, timeoutHalted,
} from "./events";
import { caseState } from "./booking";
import { TERMINAL_GATE_STATES, caseGates } from "./gates";
import { countsFor, finalCountVerdict, lockedCountsFor, openCountMismatch } from "./counts";
import { deployingImplants } from "./implants";
import type { AppConfig } from "../../kernel/config";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T5 / DD7 + DD8 — **THE COCKPIT: the states a case walks and the facts it cannot skip.**
 *
 * ═══ THE FIVE TIMESTAMPS ARE SET BY THEIR TRANSITIONS AND BY NOTHING ELSE (DD8) ═══
 *
 * `wheel_in`, `induction`, `incision`, `closure`, `wheel_out` are written by `signIn`, `timeOut`,
 * `markIncision`, `markClosure` and `wheelOut` respectively, each from the SERVER's clock — no
 * route accepts them, no update path reaches them, and `0035`'s `ot_cases_timestamps_immutable`
 * trigger refuses a change to any of them once non-null, whatever writes it.
 *
 * That last clause is A15's whole point. A grep over controller DTOs proves the routes do not
 * accept them TODAY; the trigger proves nobody can, including the correction screen somebody will
 * ask for in six months and the data fix somebody will run at 2 a.m.
 *
 * ═══ EVERY HARD STOP IS A REFUSAL WITH THE RULE IN IT, NOT A BOOLEAN ═══
 *
 * `timed_out` needs a completed time-out run with two distinct participants. `signed_out` needs
 * every final count to agree AND no implant still waiting for its ledger fact. Each of those is
 * computed at the moment of the transition, from rows, and the error names the rule so the modal
 * the nurse sees can too.
 */

/** The theatre kinds this module may assign, and the kernel's for the bays. One import each. */
const THEATRE_KINDS = OT_RESOURCE_KINDS;

type CaseRow = typeof otCases.$inferSelect;

async function requireCase(tx: Tx, caseId: string): Promise<CaseRow> {
  const rows = await tx.select().from(otCases).where(eq(otCases.id, caseId));
  const kase = rows[0];
  if (!kase) throw new OtError("unknown_case", `unknown case ${caseId}`);
  return kase;
}

/**
 * A1/A2 — **HOLDING VERIFICATION: the wristband against the case, before anything else.**
 *
 * A mismatch is NOT a silent refusal: it writes an `identity_mismatch` near-miss and emits
 * `incident.reported`. The case stays exactly where it is. Two patients called Sunita Devi on one
 * list is edge row N14, and the fact that somebody scanned the wrong one is worth more to a quality
 * review than the fact that the screen said no.
 */
export async function verifyHolding(
  db: Db, cfg: AppConfig, actor: Actor, caseId: string, qrPayload: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const kase = await withTx(db, (tx) => requireCase(tx, caseId));
  const scan = await verifyQrScan(db, cfg, actor, qrPayload);

  if (!scan.ok || scan.patient.id !== kase.patientId) {
    const reason = scan.ok ? "wrong_patient" : scan.reason;
    await withTx(db, async (tx) => {
      const incidentId = newId();
      await tx.insert(otIncidents).values({
        id: incidentId, encounterId: kase.encounterId, caseId, kind: "identity_mismatch",
        detail: { reason, scannedPatientId: scan.ok ? scan.patient.id : null, expectedPatientId: kase.patientId },
        reportedBy: actor.id,
      });
      await appendEvent(tx, incidentReported.make({
        actor, patientId: kase.patientId, encounterId: kase.encounterId,
        payload: { incidentId, encounterId: kase.encounterId, caseId, kind: "identity_mismatch" },
      }));
    });
    return { ok: false, reason };
  }

  await withTx(db, async (tx) => {
    const encounter = (await tx.select().from(daycareEncounters)
      .where(eq(daycareEncounters.id, kase.encounterId)))[0]!;
    if (encounter.checkedInAt === null) {
      await tx.update(daycareEncounters)
        .set({ checkedInAt: new Date(), status: "checked_in", reVerifyIdentity: false, updatedBy: actor.id, updatedAt: new Date() })
        .where(eq(daycareEncounters.id, kase.encounterId));
      await appendEvent(tx, daycareCheckedIn.make({
        actor, patientId: kase.patientId, encounterId: kase.encounterId,
        payload: { encounterId: kase.encounterId, patientId: kase.patientId, at: new Date().toISOString() },
      }));
    } else {
      // A5's re-verification after a merge: the flag clears without a second check-in event.
      await tx.update(daycareEncounters).set({ reVerifyIdentity: false })
        .where(eq(daycareEncounters.id, kase.encounterId));
    }
  });
  return { ok: true };
}

/** Moves a `ready` case into the holding bay. The gates are re-checked here, not trusted. */
export async function toHolding(db: Db, actor: Actor, caseId: string): Promise<{ state: string }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, caseId);
    const state = await caseState(tx, caseId);
    if (state !== "ready") {
      throw new OtError(
        "not_ready",
        `a case in "${state}" cannot enter the holding bay — every required gate must be terminal first (A6)`,
        { state },
      );
    }
    // Re-checked at the door. `ready` was computed when the last gate closed; a gate cannot re-open
    // in this phase, but reading the gates here rather than trusting the state costs one query and
    // means the invariant is enforced where the patient actually moves.
    const open = (await caseGates(tx, caseId))
      .filter((g) => !(TERMINAL_GATE_STATES as readonly string[]).includes(g.state));
    if (open.length > 0) {
      throw new OtError("gate_open", `still open: ${open.map((g) => g.kind).join(", ")}`, { open: open.map((g) => g.kind) });
    }
    return transition(tx, kase.workflowInstanceId, "in_holding", actor);
  });
}

/**
 * A12 — **SIGN-IN: the registry assign and the state move, in ONE transaction.**
 *
 * The assign comes FIRST. `assignResource` takes the theatre's row `FOR UPDATE` and refuses
 * `already_occupied` (finding T5-a fixed that lock into the kernel), so two concurrent sign-ins on
 * one theatre serialise there — and the loser's transaction rolls back before its case has moved.
 * The mutant sets the case state first, or assigns outside the transaction: both leave a case in
 * `signed_in` for a theatre it does not have.
 *
 * F3/F18 — the actor must BE the case's assigned anaesthetist, or hold `anaesthetist` and be
 * recorded as a substitution. Refusing a substitute outright would stop a list that a covering
 * consultant is standing ready to run; recording nothing would lose who actually gave the
 * anaesthetic.
 */
export async function signIn(db: Db, actor: Actor, caseId: string): Promise<{ state: string; wheelIn: Date }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, caseId);
    const state = await caseState(tx, caseId);
    if (state !== "in_holding") {
      throw new OtError("bad_transition", `a case in "${state}" cannot be signed in — it must be in the holding bay`, { state });
    }
    if (kase.anaesthetistId === null) {
      throw new OtError("bad_transition", "this case has no assigned anaesthetist (F18) — it should not have been published");
    }
    if (actor.type !== "user") throw new OtError("bad_transition", "sign-in is a clinician's act");

    const substituting = actor.id !== kase.anaesthetistId;
    if (substituting && !(await actorHoldsAnyRole(tx, actor.id, ["anaesthetist"]))) {
      throw new OtError(
        "bad_transition",
        `${actor.id} is neither the assigned anaesthetist nor a holder of the anaesthetist role (F18)`,
      );
    }

    const at = new Date();
    // THE ASSIGN FIRST — see the header. `already_occupied` from the kernel is mapped to 409.
    await assignResource(tx, actor, THEATRE_KINDS, kase.theatreResourceId, {
      occupantType: "ot_case", occupantRef: caseId, at, reason: "sign-in",
    });
    const moved = await transition(tx, kase.workflowInstanceId, "signed_in", actor);
    await tx.update(otCases).set({ wheelIn: at, updatedBy: actor.id, updatedAt: at }).where(eq(otCases.id, caseId));
    await tx.update(daycareEncounters).set({ status: "in_theatre", updatedBy: actor.id, updatedAt: at })
      .where(eq(daycareEncounters.id, kase.encounterId));

    if (substituting) {
      await appendEvent(tx, anaesthetistSubstituted.make({
        actor, patientId: kase.patientId, encounterId: kase.encounterId,
        payload: { caseId, plannedAnaesthetistId: kase.anaesthetistId, actualAnaesthetistId: actor.id },
      }));
    }
    return { state: moved.state, wheelIn: at };
  });
}

export type ChecklistPhase = "signin" | "timeout" | "signout";

/**
 * A13 — a WHO checklist run. **`participants` must hold ≥ 2 DISTINCT ids for the time-out**, and
 * the discriminating input is one id listed twice: a length check passes it, a `Set` does not.
 * A time-out is a moment when the whole team stops and speaks; one person saying it to themselves
 * is the failure the WHO checklist exists to prevent.
 *
 * A HALTED run writes a near-miss and leaves the case where it is. That is not a failure path — it
 * is the checklist working: somebody said "wait".
 */
export async function completeChecklist(
  db: Db, actor: Actor,
  input: { caseId: string; phase: ChecklistPhase; items: unknown; participants: string[]; halt?: { reason: string } },
): Promise<{ runId: string; halted: boolean }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, input.caseId);
    const distinct = new Set(input.participants);
    if (input.phase === "timeout" && distinct.size < 2) {
      throw new OtError(
        "checklist_incomplete",
        `a time-out needs at least two DISTINCT participants; ${String(input.participants.length)} were listed and ${String(distinct.size)} are different people (A13)`,
        { listed: input.participants.length, distinct: distinct.size },
      );
    }
    const runId = newId();
    const halted = input.halt !== undefined;
    await tx.insert(otChecklistRuns).values({
      id: runId, caseId: input.caseId, phase: input.phase, items: input.items as object,
      participants: [...distinct], halted, haltReason: input.halt?.reason ?? null,
      completedAt: halted ? null : new Date(), recordedBy: actor.id,
    });

    if (halted) {
      const incidentId = newId();
      await tx.insert(otIncidents).values({
        id: incidentId, encounterId: kase.encounterId, caseId: input.caseId, kind: "timeout_halted",
        detail: { phase: input.phase, reason: input.halt!.reason }, reportedBy: actor.id,
      });
      await appendEvent(tx, timeoutHalted.make({
        actor, patientId: kase.patientId, encounterId: kase.encounterId,
        payload: { caseId: input.caseId, reason: input.halt!.reason, participantCount: distinct.size },
      }));
      await appendEvent(tx, incidentReported.make({
        actor, patientId: kase.patientId, encounterId: kase.encounterId,
        payload: { incidentId, encounterId: kase.encounterId, caseId: input.caseId, kind: "timeout_halted" },
      }));
    }
    return { runId, halted };
  });
}

/** A COMPLETED, unhalted run of one phase — the fact a transition gates on. */
async function completedRun(tx: Tx, caseId: string, phase: ChecklistPhase): Promise<typeof otChecklistRuns.$inferSelect | undefined> {
  const rows = await tx.select().from(otChecklistRuns).where(and(
    eq(otChecklistRuns.caseId, caseId), eq(otChecklistRuns.phase, phase), eq(otChecklistRuns.halted, false),
  ));
  return rows.find((r) => r.completedAt !== null);
}

/** A13 — `signed_in → timed_out`, gated on a completed two-person time-out run. Sets `induction`. */
export async function timeOut(db: Db, actor: Actor, caseId: string): Promise<{ state: string }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, caseId);
    const state = await caseState(tx, caseId);
    if (state !== "signed_in") throw new OtError("bad_transition", `a case in "${state}" cannot be timed out`, { state });
    const run = await completedRun(tx, caseId, "timeout");
    if (run === undefined) {
      throw new OtError(
        "checklist_incomplete",
        "the WHO time-out has not been completed for this case — it is a state the case passes through, not a checkbox (DD7)",
      );
    }
    const at = new Date();
    const moved = await transition(tx, kase.workflowInstanceId, "timed_out", actor);
    await tx.update(otCases).set({ induction: at, updatedBy: actor.id, updatedAt: at }).where(eq(otCases.id, caseId));
    return { state: moved.state };
  });
}

/** DD8 — `timed_out → incision`, and the knife's instant. A second call is refused by the STATE,
 *  and by the trigger underneath it if anything ever reaches the column another way. */
export async function markIncision(db: Db, actor: Actor, caseId: string): Promise<{ state: string; incision: Date }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, caseId);
    const state = await caseState(tx, caseId);
    if (state !== "timed_out") {
      throw new OtError("bad_transition", `a case in "${state}" cannot start — the time-out comes first (B8)`, { state });
    }
    const at = new Date();
    const moved = await transition(tx, kase.workflowInstanceId, "incision", actor);
    await tx.update(otCases).set({ incision: at, updatedBy: actor.id, updatedAt: at }).where(eq(otCases.id, caseId));
    return { state: moved.state, incision: at };
  });
}

export async function markClosure(db: Db, actor: Actor, caseId: string): Promise<{ state: string; closure: Date }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, caseId);
    const state = await caseState(tx, caseId);
    if (state !== "incision") throw new OtError("bad_transition", `a case in "${state}" cannot close`, { state });
    const at = new Date();
    const moved = await transition(tx, kase.workflowInstanceId, "closing", actor);
    await tx.update(otCases).set({ closure: at, updatedBy: actor.id, updatedAt: at }).where(eq(otCases.id, caseId));
    return { state: moved.state, closure: at };
  });
}

/**
 * A14 + A18 — **SIGN-OUT: the two hard stops, in the order that matters.**
 *
 * The COUNTS first, because a count mismatch is a retained object and opens an incident; the
 * IMPLANTS second, because a deploying row is a bookkeeping gap rather than a clinical one. Both
 * refuse; neither is overridable here (a count mismatch's only exits are a corrected recount or the
 * two-actor override with an X-ray reference, and the override lane is `gates.ts`'s).
 */
export async function signOut(db: Db, actor: Actor, caseId: string): Promise<{ state: string }> {
  /**
   * ═══ THE CHECKS RUN OUTSIDE THE WRITE TRANSACTION, AND THAT IS NOT A STYLE CHOICE ═══
   *
   * `openCountMismatch` writes an incident row and two events, and this function then THROWS. Done
   * inside one transaction, the throw rolls the incident back with it: the nurse sees the refusal
   * and the quality review sees nothing at all. **The first version did exactly that and the test
   * caught it** — `otIncidents` came back empty after a refused sign-out.
   *
   * `assertNotSodPair` records the same rule in its own body: *"Own transaction on `db`, never the
   * caller's tx: the block must survive the caller's rollback."* A refusal that leaves no trace is
   * indistinguishable from a refusal that never happened.
   *
   * So the reads happen on `db`, the incident is written in its OWN transaction, and only the
   * transition takes a transaction of its own — which re-checks the state, because between the read
   * and the write another actor may have moved the case.
   */
  const state = await caseState(db, caseId);
  if (state !== "closing") throw new OtError("bad_transition", `a case in "${state}" cannot be signed out`, { state });

  const verdict = finalCountVerdict(await countsFor(db, caseId));
  if (!verdict.ok) {
    if (verdict.mismatches.length > 0) {
      await withTx(db, (tx) => openCountMismatch(tx, actor, caseId, verdict.mismatches));
    }
    throw new OtError(
      "count_mismatch",
      verdict.counted === 0
        ? "no FINAL count round has been recorded — sign-out is gated on the counts agreeing, and no count is not agreement (H8)"
        : `final counts disagree: ${verdict.mismatches.map((m) => `${m.itemType} ${String(m.expected)}/${String(m.counted)}`).join(", ")}`,
      { counted: verdict.counted, mismatches: verdict.mismatches.length },
    );
  }

  const waiting = await deployingImplants(db, caseId);
  if (waiting.length > 0) {
    throw new OtError(
      "implant_deploying",
      `${String(waiting.length)} implant(s) are scanned but have no ledger fact yet — the stores consumer has not confirmed them (A18)`,
      { implantIds: waiting.map((w) => w.id) },
    );
  }

  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, caseId);
    const run = await completedRun(tx, caseId, "signout");
    if (run === undefined) {
      throw new OtError("checklist_incomplete", "the WHO sign-out has not been completed for this case");
    }
    // Re-read INSIDE the transaction and HOLD the rows (MINOR 19): the checks above were on `db`,
    // the case may have moved, and an unlocked re-read could be overtaken by a concurrent
    // `recordCount` writing a mismatching final round between this line and the transition.
    const inTx = finalCountVerdict(await lockedCountsFor(tx, caseId));
    if (!inTx.ok) throw new OtError("count_mismatch", "the counts changed while signing out — re-read them");
    if ((await deployingImplants(tx, caseId)).length > 0) {
      throw new OtError("implant_deploying", "an implant was scanned while signing out and has no ledger fact yet");
    }
    return transition(tx, kase.workflowInstanceId, "signed_out", actor);
  });
}

/** `signed_out → in_recovery`. Releases the theatre into TURNOVER and stamps `wheel_out`. */
export async function wheelOut(db: Db, actor: Actor, caseId: string): Promise<{ state: string; wheelOut: Date }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, caseId);
    const state = await caseState(tx, caseId);
    if (state !== "signed_out") throw new OtError("bad_transition", `a case in "${state}" cannot leave the theatre`, { state });
    const at = new Date();
    // `onRelease: "turnover"` — NOT `available`. A theatre that went straight back to available
    // would let the list screen offer a slot in a room still holding the last case's instruments.
    await releaseResource(tx, actor, THEATRE_KINDS, kase.theatreResourceId, { at, reason: "wheel-out" });
    const moved = await transition(tx, kase.workflowInstanceId, "in_recovery", actor);
    await tx.update(otCases).set({ wheelOut: at, updatedBy: actor.id, updatedAt: at }).where(eq(otCases.id, caseId));
    await tx.update(daycareEncounters).set({ status: "in_recovery", updatedBy: actor.id, updatedAt: at })
      .where(eq(daycareEncounters.id, kase.encounterId));
    return { state: moved.state, wheelOut: at };
  });
}

/** F24d — the C-arm dose log. `operatorUserId` is NAMED, because AERB's record is of a PERSON. No
 *  block in this phase: G4's "cannot sign out without a dose log" waits for the C-arm device row
 *  (15d), and a block on a field nothing validates would be theatre. */
export async function recordDoseLog(
  db: Db, actor: Actor,
  input: { caseId: string; dapCgyCm2: number; fluoroSeconds: number; operatorUserId: string },
): Promise<void> {
  await withTx(db, async (tx) => {
    const kase = await requireCase(tx, input.caseId);
    await tx.update(otCases)
      .set({ woundClass: kase.woundClass, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(otCases.id, input.caseId));
    const incidentId = newId();
    // Recorded on the incident table's `detail` rather than a column of its own: this phase does
    // not bill or block on it, and 15d owns the C-arm's device row and its own table.
    await tx.insert(otIncidents).values({
      id: incidentId, encounterId: kase.encounterId, caseId: input.caseId, kind: "dose_log",
      detail: { kind: "dose_log", dapCgyCm2: input.dapCgyCm2, fluoroSeconds: input.fluoroSeconds, operatorUserId: input.operatorUserId },
      reportedBy: actor.id, resolvedAt: new Date(), resolution: "recorded",
    });
  });
}

/** N11/G2 — the procedure changed on the table. `consentCovered` records whether the consent's
 *  conversion item was there; it is a FINDING when it was not, never a block — the surgeon is
 *  already inside the patient. */
export async function recordProcedureConverted(
  db: Db, actor: Actor,
  input: { caseId: string; toProcedureCode: string; reason: string },
): Promise<{ consentCovered: boolean }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, input.caseId);
    const consentGate = (await tx.select().from(otCaseGates).where(and(
      eq(otCaseGates.caseId, input.caseId), eq(otCaseGates.kind, "consent_procedure"),
    )))[0];
    const consentCovered = ((consentGate?.evidence as { consent?: { conversionCovered?: boolean } } | null)
      ?.consent?.conversionCovered) === true;
    await appendEvent(tx, procedureConverted.make({
      actor, patientId: kase.patientId, encounterId: kase.encounterId,
      payload: {
        caseId: input.caseId, fromProcedureCode: kase.procedureCode,
        toProcedureCode: input.toProcedureCode, reason: input.reason, consentCovered,
      },
    }));
    return { consentCovered };
  });
}

/**
 * R-3.22 — death on the table. Minimal and PRESENT: the case terminates, the theatre is blocked
 * with `incident` as the reason, the encounter takes a legal hold, and the MS is told. The six-task
 * cascade (police, mortuary, disclosure) is 28a's; what cannot be deferred is the event itself.
 */
export async function recordDeathOnTable(
  db: Db, actor: Actor, input: { caseId: string; at?: Date; mlcApplicable: boolean; note: string },
): Promise<{ state: string; incidentId: string }> {
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, input.caseId);
    const at = input.at ?? new Date();
    const moved = await transition(tx, kase.workflowInstanceId, "deceased", actor, { note: input.note });

    // The theatre is blocked with the reason in `attributes` — DD3/F22's ONE blocked status.
    const theatre = (await tx.select().from(resources).where(eq(resources.id, kase.theatreResourceId)))[0]!;
    await tx.update(resources).set({
      status: "blocked",
      attributes: { ...(theatre.attributes as Record<string, unknown> | null ?? {}), blockReason: "incident" },
      occupantType: null, occupantRef: null, since: at, updatedBy: actor.id, updatedAt: at,
    }).where(eq(resources.id, kase.theatreResourceId));

    await tx.update(daycareEncounters)
      .set({ status: "deceased", outcome: "deceased", legalHold: true, updatedBy: actor.id, updatedAt: at })
      .where(eq(daycareEncounters.id, kase.encounterId));

    const incidentId = newId();
    await tx.insert(otIncidents).values({
      id: incidentId, encounterId: kase.encounterId, caseId: input.caseId, kind: "death_on_table",
      detail: { note: input.note, mlcApplicable: input.mlcApplicable }, reportedBy: actor.id,
    });
    await appendEvent(tx, deathOnTableRecorded.make({
      actor, patientId: kase.patientId, encounterId: kase.encounterId, occurredAt: at,
      payload: {
        caseId: input.caseId, encounterId: kase.encounterId, patientId: kase.patientId,
        at: at.toISOString(), theatreResourceId: kase.theatreResourceId, mlcApplicable: input.mlcApplicable,
      },
    }));
    await appendEvent(tx, incidentReported.make({
      actor, patientId: kase.patientId, encounterId: kase.encounterId,
      payload: { incidentId, encounterId: kase.encounterId, caseId: input.caseId, kind: "death_on_table" },
    }));
    return { state: moved.state, incidentId };
  });
}

/**
 * C1/DD8 — **BACKFILL: the only way paper re-enters, and it flags every phase it writes.**
 *
 * It performs the SAME transitions in the SAME order, so the matrix refuses an impossible order
 * (B8) exactly as it would live — there is no "backfill mode" that skips the state machine, which
 * is what would make a downtime session a hole in the audit trail. `occurred_at` comes from the
 * paper; `recorded_at` is now; `late_entry.flagged` carries both.
 *
 * The five timestamps are written by the transitions here as they are live, so the trigger applies
 * to a backfill too: a phase backfilled twice is refused by the database.
 */
/**
 * ═══ CLOSE REVIEW M7 — `wheel_out` IS NOT A BACKFILLABLE PHASE, AND WAS NEVER REACHABLE ═══
 *
 * It used to be listed, mapped to `in_recovery`. The only edge into `in_recovery` is
 * `signed_out → in_recovery`, and no phase maps to `signed_out` — so a full five-phase backfill
 * (which is what an in-charge types after a two-hour outage) applied the first four, raised
 * `unknown_transition` on the fifth, and because the whole loop is one transaction **rolled the
 * entire record back**. The operator retypes it and hits the same wall. The shipped test only
 * backfilled three phases, so nothing caught it.
 *
 * Dropping it is the right repair rather than adding a `signed_out` phase, because sign-out is
 * where the count reconciliation and the implant-ledger hard stops live (A14, A18). A backfill that
 * could reach `signed_out` would be a backfill that walks past them — the very thing M6 is about.
 * So the paper record is entered up to `closure` and the case then re-enters the LIVE path at
 * sign-out, where the counts are reconciled by a human who is present.
 */
export const BACKFILL_PHASES = ["wheel_in", "induction", "incision", "closure"] as const;
export type BackfillPhase = (typeof BACKFILL_PHASES)[number];

const PHASE_TO_STATE: Record<BackfillPhase, string> = {
  wheel_in: "signed_in", induction: "timed_out", incision: "incision",
  closure: "closing",
};

export async function backfillCase(
  db: Db, actor: Actor,
  input: { caseId: string; phases: { phase: BackfillPhase; occurredAt: Date }[]; reason: string },
): Promise<{ state: string; flagged: number }> {
  if (input.reason.trim() === "") throw new OtError("bad_transition", "a backfill must carry a reason");
  return withTx(db, async (tx) => {
    const kase = await requireCase(tx, input.caseId);
    const recordedAt = new Date();
    let flagged = 0;
    let state = await caseState(tx, input.caseId);

    for (const { phase, occurredAt } of input.phases) {
      if (occurredAt.getTime() > recordedAt.getTime()) {
        throw new OtError("bad_transition", `a backfilled ${phase} cannot be in the future`);
      }
      // The SAME transition the live path takes. An out-of-order backfill is refused by the matrix
      // (`unknown_transition`), not by a private ordering check that could disagree with it.
      /**
       * ═══ THE TRANSITION IS THE SYSTEM'S; THE RECORD IS THE HUMAN'S ═══
       *
       * The move is made as `system` and `late_entry.flagged` carries the human `actor`. That split
       * is the design, and the test found it: the matrix allows `in_holding → signed_in` only to an
       * `anaesthetist`, so an OT in-charge typing up a downtime record was refused `role_denied` for
       * an anaesthetic somebody else had already given, hours earlier, on paper.
       *
       * A backfill is not a clinician performing an act — the act HAPPENED, during the downtime, and
       * the person at the keyboard is a recorder. Requiring them to hold every role the case walked
       * through would mean either that only a surgeon-anaesthetist-nurse could enter a downtime
       * record, or that the roles get handed around at a keyboard, which is worse than the problem.
       *
       * **B8 is unaffected, and that is the half that matters.** `transition` skips the ROLE check
       * for a system actor and skips nothing else: the ORDER check is the pinned definition's
       * transition matrix, so an out-of-order backfill is still refused `unknown_transition`. The
       * test above proves it with `incision` before `wheel_in`.
       */
      /**
       * ═══ CLOSE REVIEW M6 — THE FACTS THE LIVE PATH CHECKS ARE CHECKED HERE TOO ═══
       *
       * The comment below argues correctly that a RECORDER should not need to hold every role the
       * case walked through. It then drew the wrong boundary: because the backfill replays raw
       * `transition` calls rather than `signIn`/`timeOut`, it skipped every fact those functions
       * gate on as well as the roles — so a case could reach `incision` with **no WHO time-out
       * recorded at all**, on a route guarded only by `ot.cockpit.operate`. `workflow-def.ts` says
       * the matrix exists so the time-out "is not a checkbox that can be skipped under pressure";
       * the backfill was the checkbox.
       *
       * A downtime record is a record of things that HAPPENED, so the fix is not to refuse the
       * backfill — it is to require the paperwork to exist before the state that presupposes it.
       * The time-out run can itself be entered late; it just has to be entered.
       */
      if (PHASE_TO_STATE[phase] === "timed_out" && (await completedRun(tx, input.caseId, "timeout")) === undefined) {
        throw new OtError(
          "checklist_incomplete",
          "a backfill cannot pass the WHO time-out without a completed time-out checklist run — record the paper checklist first (M6)",
        );
      }
      if (PHASE_TO_STATE[phase] === "signed_in" && kase.anaesthetistId === null) {
        throw new OtError(
          "bad_transition",
          "a backfill cannot sign a case in with no assigned anaesthetist (F18/M6)",
        );
      }
      const moved = await transition(
        tx, kase.workflowInstanceId, PHASE_TO_STATE[phase],
        { type: "system", id: "ot.backfill" },
        { note: `backfill by ${actor.id}: ${input.reason}` },
      );
      state = moved.state;
      await tx.update(otCases).set({ [phase === "wheel_in" ? "wheelIn" : phase]: occurredAt, updatedBy: actor.id, updatedAt: recordedAt })
        .where(eq(otCases.id, input.caseId));
      await appendEvent(tx, lateEntryFlagged.make({
        actor, patientId: kase.patientId, encounterId: kase.encounterId, occurredAt,
        payload: {
          caseId: input.caseId, phase, occurredAt: occurredAt.toISOString(),
          recordedAt: recordedAt.toISOString(), reason: input.reason,
        },
      }));
      flagged += 1;
    }
    return { state, flagged };
  });
}
