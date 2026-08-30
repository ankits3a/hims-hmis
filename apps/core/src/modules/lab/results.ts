import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  labAnalytes, labCriticalCalls, labItems, labOrderables, labResults, labSpecimenItems,
  labSpecimens, orderItems, orders, patients, workflowInstances,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { transition } from "../../kernel/workflow/instances";
import { resolvePatientId } from "../patients";
import { analytesFor, rangesFor } from "./catalogue";
import { LabError } from "./errors";
import { evaluateFormula } from "./formula";
import { flagFor, resolveRange } from "./ranges";
import {
  labNotifiableFlagged, labResultCriticalFlagged, labResultDeltaFlagged, labResultEntered,
} from "./events";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { Db } from "../../kernel/db/client";
import type { Siblings } from "./formula";

/**
 * PLAN 17b T6 / DD2, DD3, DD12 — **THE NUMBER**: manual entry, the absurd envelope, the range
 * snapshotted at entry, the flag, the delta, the critical call, and the formula analytes.
 *
 * ═══ THE ITEM MUST BE RESULTABLE, AND THAT IS 17a's THREE-PART HANDOVER, NOT A GUESS ═══
 *
 * 17a §6.2: *"An accessioned item is `order_items.status = 'in_progress'` with
 * `lab_items.tat_started_at` set and exactly one `active` row in `lab_specimen_items`. That triple
 * is 17b's precondition for `enterResult`, and `item_not_resultable` is the refusal when it does not
 * hold."* All three are checked, and each on its own: an item whose tube was rejected after
 * accession is `in_progress` with its clock running and NO active tube, and keying a number against
 * it would report a result for a specimen that was poured away.
 *
 * ═══ THE RANGE IS RESOLVED HERE AND WRITTEN DOWN (T6 A6 / DD2) ═══
 *
 * `resolveRange` is 17a's pure function and this is its only caller. Its answer is SNAPSHOTTED onto
 * the row — `ref_low`, `ref_high`, `ref_text`, `ref_range_id`, `ref_note` — because a range-book
 * edit must never re-flag a value a pathologist has already signed. A resolver consulted at report
 * time could not say which range the signature was against, which is the one thing NABL asks.
 *
 * ═══ THE AGE IS TAKEN AT COLLECTION, NOT AT ENTRY ═══
 *
 * `ranges.ts` bands on the age AT COLLECTION in IST days, so the instant handed to it is the TUBE's
 * `collected_at` and not the moment a technologist typed. A sample drawn at 23:50 on a child's
 * birthday eve and keyed at 00:10 is a specimen from a child who was younger, and the band that
 * decides the flag has to agree with the physiology rather than with the keyboard.
 *
 * ═══ WHAT THIS FILE DOES **NOT** DO ═══
 *
 * It never verifies (`verify.ts`), never publishes, and never consults the delivery interlock: a
 * result exists and is readable by the ordering clinician the instant it is keyed, whatever anybody
 * owes (DD6, 02 O-1). The interlock holds a DOCUMENT, and there is no document yet.
 */

/** The permission a person needs to key a number. `lab.results.read` is the DOCTOR's; this is the bench's. */
export const LAB_RESULTS_ENTER = "lab.results.enter";

export type LabEntryMode = "manual" | "manual_from_printout";

export type EnterResultInput = {
  orderItemId: string;
  analyteId: string;
  /** The keyed value, as text. A `numeric` analyte parses it; `text`/`coded` store it verbatim. */
  value: string;
  unit?: string | null;
  entryMode: LabEntryMode;
  remarks?: string | null;
  /**
   * 02 H1 — the SECOND holder of `lab.results.enter` who let an absurd value through. A `users.id`,
   * and it may not be the enterer: an envelope one person can wave through is not an envelope.
   */
  absurdOverride?: { by: string };
  /** DD13 / E40 — a rerun's result supersedes the row it replaces. Set by `requestRerun`'s caller. */
  supersedesResultId?: string | null;
  rerunOf?: string | null;
};

export type EnteredResult = {
  resultId: string;
  analyteId: string;
  flag: string | null;
  deltaFlagged: boolean;
  /** DD12 — the call the entry opened, or null. Opened at ENTRY, never at verify. */
  criticalCallId: string | null;
};

export type EnterResultOutcome = EnteredResult & {
  /** DD3 — the formula analytes this entry made computable, in report order. */
  computed: EnteredResult[];
  /** The item's own state after the entry: `in_analysis` while analytes are outstanding. */
  itemState: string;
};

/* ─────────────────────────────── the context an entry needs ─────────────────────────────── */

type ResultContext = {
  orderItemId: string;
  orderId: string;
  orderGroupId: string;
  encounterNo: string;
  serviceDate: string;
  serviceId: string;
  instanceId: string;
  itemStatus: string;
  /** The order's raw patient id, and the CANONICAL one behind it (the merge chain, E4/02 A3). */
  rawPatientId: string;
  patientId: string;
  specimenId: string;
  collectedAt: Date;
  orderable: typeof labOrderables.$inferSelect;
  subject: { dob: string | null; sex: string | null };
};

/**
 * `user` ACTORS ONLY, and by TYPE before permission.
 *
 * `hasPermission` takes a `users.id`; handed a system or patient id it returns FALSE, which would
 * report "this user does not hold the permission" about something that is not a user (22c-A review
 * D11's aliasing argument, and the shape `assertMayDesk` and `assertMayManage` already take). There
 * is no automated entry in this phase by construction: `entry_mode = 'interface'` does not exist
 * until 17-E, so a machine has nothing it could legitimately be keying.
 */
async function assertMay(exec: Db | Tx, actor: Actor, permission: string, act: string): Promise<void> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not ${act}`);
  }
  if (!(await hasPermission(exec as Db, actor.id, permission, "hospital"))) {
    throw new LabError("permission_denied", `${act} requires ${permission}`);
  }
}

/**
 * THE PRECONDITION, ALL THREE PARTS OF IT (17a §6.2).
 *
 * Exported because `verify.ts` and `reports.ts` need the same joined row and a second copy of this
 * join would be two hand-maintained answers to one question (§2.54).
 */
export async function resultContext(tx: Tx, orderItemId: string): Promise<ResultContext> {
  const [row] = await tx
    .select({
      orderItemId: orderItems.id,
      itemStatus: orderItems.status,
      serviceId: orderItems.serviceId,
      orderId: orders.id,
      orderGroupId: orders.orderGroupId,
      encounterNo: orders.encounterNo,
      serviceDate: orders.serviceDate,
      patientId: orders.patientId,
      kind: orders.kind,
      instanceId: labItems.instanceId,
      tatStartedAt: labItems.tatStartedAt,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .where(eq(orderItems.id, orderItemId));
  if (!row || row.kind !== "lab") {
    throw new LabError("unknown_item", `no lab order item ${orderItemId}`);
  }

  if (row.itemStatus !== "in_progress" || row.tatStartedAt === null) {
    throw new LabError(
      "item_not_resultable",
      `order item ${orderItemId} is ${row.itemStatus} and its turnaround clock ` +
        `${row.tatStartedAt === null ? "has not started" : "has started"} — a result may only be ` +
        "keyed against an item whose specimen reached the bench",
    );
  }

  /**
   * THE ACTIVE TUBE. `lab_specimen_items_active_ux` admits at most one, so this is a read of an
   * invariant rather than a guard — but its ABSENCE is the case that matters: a tube rejected after
   * accession leaves the item `in_progress` with the clock running and no live specimen (17a's
   * redraw path), and a number keyed then would be reported against blood that was poured away.
   */
  const [tube] = await tx
    .select({
      specimenId: labSpecimens.id, collectedAt: labSpecimens.collectedAt,
      receivedAt: labSpecimens.receivedAt, status: labSpecimens.status,
    })
    .from(labSpecimenItems)
    .innerJoin(labSpecimens, eq(labSpecimens.id, labSpecimenItems.specimenId))
    .where(and(eq(labSpecimenItems.orderItemId, orderItemId), eq(labSpecimenItems.active, true)));
  if (!tube || tube.status !== "received") {
    throw new LabError(
      "item_not_resultable",
      `order item ${orderItemId} has no received specimen — its tube is ` +
        `${tube ? tube.status : "gone (rejected and awaiting a redraw)"}`,
    );
  }

  const [orderable] = await tx.select().from(labOrderables)
    .where(eq(labOrderables.serviceId, row.serviceId));
  if (!orderable) throw new LabError("unknown_orderable", `no lab orderable for service ${row.serviceId}`);

  /**
   * THE CANONICAL PATIENT, because the delta and the range both read a PERSON rather than a row.
   * `merge.ts` does not repoint `orders.patient_id`, so the same person legitimately holds orders
   * under two ids and a delta keyed on the raw one would miss yesterday's value entirely (02 A3).
   */
  const canonical = (await resolvePatientId(tx, row.patientId)) ?? row.patientId;
  const [patient] = await tx
    .select({ dob: patients.dob, administrativeGender: patients.administrativeGender })
    .from(patients).where(eq(patients.id, canonical));

  return {
    orderItemId: row.orderItemId,
    orderId: row.orderId,
    orderGroupId: row.orderGroupId,
    encounterNo: row.encounterNo,
    serviceDate: row.serviceDate,
    serviceId: row.serviceId,
    instanceId: row.instanceId,
    itemStatus: row.itemStatus,
    rawPatientId: row.patientId,
    patientId: canonical,
    specimenId: tube.specimenId,
    /** A tube received without a recorded draw instant bands on its ARRIVAL, never on `now`. */
    collectedAt: tube.collectedAt ?? tube.receivedAt ?? new Date(),
    orderable,
    subject: {
      dob: patient?.dob ? isoDay(patient.dob) : null,
      sex: patient?.administrativeGender ?? null,
    },
  };
}

/** `patients.dob` arrives as a `Date` at UTC midnight; `resolveRange` wants the calendar day. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ─────────────────────────────────── the entry itself ─────────────────────────────────── */

/**
 * KEY ONE VALUE.
 *
 * `Tx`-first: every refusal here is a plain refusal that writes nothing, so there is no audit lane
 * to keep alive across a rollback and nothing is gained by the `Db`-first shape `printLabels` and
 * `verifyResult` need (17a §6.8, F20/F27's mechanism).
 */
export async function enterResult(
  tx: Tx,
  actor: Actor,
  input: EnterResultInput,
  now: Date = new Date(),
): Promise<EnterResultOutcome> {
  await assertMay(tx, actor, LAB_RESULTS_ENTER, "enter a lab result");
  const ctx = await resultContext(tx, input.orderItemId);

  const analytes = await analytesFor(tx, ctx.serviceId);
  const analyte = analytes.find((a) => a.id === input.analyteId);
  if (!analyte) {
    throw new LabError(
      "unknown_analyte",
      `analyte ${input.analyteId} is not part of ${ctx.orderable.code} — an orderable reports the ` +
        "analytes its catalogue entry names and no others",
    );
  }
  if (analyte.resultType === "formula") {
    throw new LabError(
      "catalogue_invalid",
      `${analyte.code} is a CALCULATED analyte — it is computed from its siblings on this specimen ` +
        "(DD3) and keying it by hand would put a typed number where an arithmetic one belongs",
    );
  }

  /**
   * ═══ 02 H1 — THE ABSURD ENVELOPE, AND THE OVERRIDE IS A SECOND PAIR OF HANDS (T6 A8) ═══
   *
   * A glucose of 1200 mg/dL is a decimal point, not a patient. The refusal is not a warning: a
   * value outside the envelope does not reach `lab_results` at all unless a SECOND holder of
   * `lab.results.enter` puts their name on it, and that holder may not be the person who typed it.
   * An override the enterer can grant themselves is a dialog people learn to click.
   */
  const numeric = analyte.resultType === "numeric" ? parseNumeric(input.value, analyte.code) : null;
  let absurdOverriddenBy: string | null = null;
  if (numeric !== null && outsideAbsurdEnvelope(numeric, analyte)) {
    const override = input.absurdOverride;
    if (!override) {
      throw new LabError(
        "absurd_value",
        `${analyte.code} ${input.value}${analyte.unit ? ` ${analyte.unit}` : ""} is outside the ` +
          `plausible envelope (${analyte.absurdLow ?? "−∞"} … ${analyte.absurdHigh ?? "∞"}) — ` +
          "re-check the sample and the decimal point, or have a second enterer override it",
        { analyteCode: analyte.code, absurdLow: analyte.absurdLow, absurdHigh: analyte.absurdHigh },
      );
    }
    if (override.by === actor.id) {
      throw new LabError(
        "absurd_override_same_actor",
        "an absurd-value override names a SECOND holder of lab.results.enter — the person who " +
          "keyed the value cannot be the person who vouches for it",
      );
    }
    if (!(await hasPermission(tx as Db, override.by, LAB_RESULTS_ENTER, "hospital"))) {
      throw new LabError(
        "permission_denied",
        `the named override ${override.by} does not hold ${LAB_RESULTS_ENTER}`,
      );
    }
    absurdOverriddenBy = override.by;
  }

  const primary = await writeResult(tx, actor, ctx, {
    analyte, value: input.value, numeric, unit: input.unit ?? analyte.unit,
    entryMode: input.entryMode, remarks: input.remarks ?? null, absurdOverriddenBy,
    supersedesResultId: input.supersedesResultId ?? null, rerunOf: input.rerunOf ?? null,
  }, now);

  /**
   * ═══ DD3 — THE FORMULA ANALYTES, COMPUTED WHEN AND ONLY WHEN EVERY INPUT EXISTS ═══
   *
   * A calculated analyte is written the moment its last input is keyed and never before: an LDL
   * computed from a cholesterol and a missing triglyceride is a number nobody measured. When every
   * input IS present and the guard refuses (E38 — TG ≥ 400), the row is written as TEXT carrying
   * the reason, which is `formula.ts`'s own rule: the wrong number this engine can produce is
   * silent and clinical, so an honest failure is the only failure.
   */
  const computed = await computeFormulaAnalytes(tx, actor, ctx, analytes, input.entryMode, now);

  const itemState = await projectItemState(tx, actor, ctx, analytes);

  return { ...primary, computed, itemState };
}

function parseNumeric(value: string, code: string): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n)) {
    throw new LabError(
      "catalogue_invalid",
      `${code}: the catalogue declares this analyte \`numeric\` and "${value}" is not a number`,
    );
  }
  return n;
}

function outsideAbsurdEnvelope(
  value: number,
  analyte: { absurdLow: string | null; absurdHigh: string | null },
): boolean {
  if (analyte.absurdLow !== null && value < Number(analyte.absurdLow)) return true;
  if (analyte.absurdHigh !== null && value > Number(analyte.absurdHigh)) return true;
  return false;
}

type WriteResultInput = {
  analyte: typeof labAnalytes.$inferSelect;
  value: string;
  numeric: number | null;
  unit: string | null;
  entryMode: LabEntryMode;
  remarks: string | null;
  absurdOverriddenBy: string | null;
  supersedesResultId: string | null;
  rerunOf: string | null;
};

/**
 * ONE ROW, WITH ITS RANGE SNAPSHOT, ITS FLAG, ITS DELTA AND ITS CALL.
 *
 * Shared by the keyed value and by every computed one, because a calculated LDL is a REPORTED
 * analyte: it carries a reference range, it can be critical, and a clinician reading it has no way
 * to tell it apart from a measured one. Two code paths here would mean the calculated half quietly
 * losing whichever of those four the second copy forgot.
 */
async function writeResult(
  tx: Tx,
  actor: Actor,
  ctx: ResultContext,
  input: WriteResultInput,
  now: Date,
): Promise<EnteredResult> {
  const { analyte } = input;
  const ranges = await rangesFor(tx, analyte.id);
  const range = resolveRange(analyte, ranges, ctx.subject, ctx.collectedAt);

  const flag = input.numeric === null ? null : flagFor(input.numeric, range);
  const delta = input.numeric === null
    ? null
    : await deltaAgainstPreviousVerified(tx, ctx, analyte, input.numeric, now);

  const resultId = newId();
  await tx.insert(labResults).values({
    id: resultId,
    orderItemId: ctx.orderItemId,
    analyteId: analyte.id,
    specimenId: ctx.specimenId,
    /** EXACTLY ONE VALUE COLUMN — `lab_results_one_value_ck` refuses a row with two or none. */
    valueNumeric: input.numeric === null ? null : input.value.trim(),
    valueText: input.numeric === null && analyte.resultType !== "coded" ? input.value : null,
    valueCoded: input.numeric === null && analyte.resultType === "coded" ? input.value : null,
    unit: input.unit,
    flag,
    refLow: range.low,
    refHigh: range.high,
    refText: range.text,
    refRangeId: range.refRangeId,
    refNote: range.note,
    deltaFlag: delta !== null,
    deltaPrevResultId: delta?.priorResultId ?? null,
    absurdOverriddenBy: input.absurdOverriddenBy,
    enteredByType: actor.type,
    enteredById: actor.id,
    enteredAt: now,
    entryMode: input.entryMode,
    verificationStatus: "unverified",
    pathologistReviewPending: false,
    rerunOf: input.rerunOf,
    supersedesResultId: input.supersedesResultId,
    remarks: input.remarks,
  });

  await appendEvent(tx, labResultEntered.make({
    actor,
    patientId: ctx.patientId,
    encounterId: ctx.encounterNo,
    correlationId: ctx.orderId,
    payload: {
      resultId, orderItemId: ctx.orderItemId, analyteId: analyte.id, enteredBy: actor.id,
      flag, entryMode: input.entryMode, absurdOverridden: input.absurdOverriddenBy !== null,
    },
  }));

  if (delta !== null) {
    await appendEvent(tx, labResultDeltaFlagged.make({
      actor,
      patientId: ctx.patientId,
      correlationId: ctx.orderId,
      payload: {
        resultId, priorResultId: delta.priorResultId, analyteId: analyte.id,
        patientId: ctx.patientId, priorValue: delta.priorValue, value: input.value.trim(),
      },
    }));
  }

  /**
   * ═══ DD12 — THE CALL OPENS AT ENTRY, BEFORE ANY SIGNATURE (T6 A5 / 02 F1) ═══
   *
   * The 15-minute clinical need is the TELEPHONE CALL, not the verification. At 02:00 with no
   * pathologist logged in, a ladder that waited for a signature would ring nobody at all — E34
   * exactly — so the technologist who keyed a potassium of 6.8 opens the call, and the signature
   * follows by 09:00 (R-014's default, adopted).
   */
  const criticalCallId = flag === "LL" || flag === "HH"
    ? await openCriticalCall(tx, actor, ctx, {
        resultId, analyteId: analyte.id, value: input.value.trim(), band: flag === "LL" ? "low" : "high",
      }, now)
    : null;

  /**
   * 28a's REGISTER SUBSCRIBES TO THIS WHEN IT EXISTS, AND IT IS EMITTED ON EVERY RESULT OF A
   * NOTIFIABLE ORDERABLE RATHER THAN ON A POSITIVE ONE.
   *
   * Deciding "positive" here would mean the lab holding an opinion about a dengue NS1's cut-off
   * that the catalogue does not carry and that differs per kit. Over-reporting is the safe
   * direction — 28a filters on values it can see — and under-reporting a notifiable disease is a
   * statutory failure, not a tidiness one.
   */
  if (ctx.orderable.notifiable) {
    await appendEvent(tx, labNotifiableFlagged.make({
      actor,
      patientId: ctx.patientId,
      correlationId: ctx.orderId,
      payload: {
        resultId, orderItemId: ctx.orderItemId, patientId: ctx.patientId,
        serviceId: ctx.serviceId, analyteId: analyte.id,
      },
    }));
  }

  return { resultId, analyteId: analyte.id, flag, deltaFlagged: delta !== null, criticalCallId };
}

/* ─────────────────────────────────── the delta check ─────────────────────────────────── */

/**
 * ═══ 02 H2 / T6 A7 — AGAINST THE PREVIOUS **VERIFIED** RESULT OF THE **CANONICAL** PATIENT ═══
 *
 * Three words carry the whole assertion and each of them is a defect if dropped:
 *
 *   · **VERIFIED.** An unverified prior is a number nobody has signed — often the very rerun that
 *     is about to be superseded. Comparing against it compares today's value with a value the lab
 *     has not stood behind, and the flag then goes quiet at exactly the moment it is wanted.
 *   · **CANONICAL.** `merge.ts` does not repoint `orders.patient_id`, so a person merged last month
 *     holds yesterday's haemoglobin under the loser id. A delta keyed on the raw id would find
 *     nothing and report a 4 g/dL fall as an ordinary first result.
 *   · **PREVIOUS.** The most recent one, not any one in the window — `order by entered_at desc`.
 *
 * Returns `null` when the analyte declares no delta rule, when the window holds no verified prior,
 * or when the movement is within tolerance. A delta rule with neither `delta_abs` nor `delta_pct`
 * is a rule that cannot fire, and it is not treated as "always flag".
 */
async function deltaAgainstPreviousVerified(
  tx: Tx,
  ctx: ResultContext,
  analyte: typeof labAnalytes.$inferSelect,
  value: number,
  now: Date,
): Promise<{ priorResultId: string; priorValue: string } | null> {
  const abs = analyte.deltaAbs === null ? null : Number(analyte.deltaAbs);
  const pct = analyte.deltaPct === null ? null : Number(analyte.deltaPct);
  if (abs === null && pct === null) return null;
  const windowHours = analyte.deltaWindowHours ?? 0;
  if (windowHours <= 0) return null;
  const since = new Date(now.getTime() - windowHours * 3600_000);

  const candidates = await tx
    .select({
      id: labResults.id,
      valueNumeric: labResults.valueNumeric,
      enteredAt: labResults.enteredAt,
      patientId: orders.patientId,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(labResults.analyteId, analyte.id),
      eq(labResults.verificationStatus, "verified"),
      gte(labResults.enteredAt, since),
      isNotNull(labResults.valueNumeric),
    ))
    .orderBy(desc(labResults.enteredAt));

  /**
   * The merge chain is resolved PER CANDIDATE rather than pushed into the WHERE clause, because
   * `resolvePatientId` walks a chain of arbitrary depth and SQL cannot. `desk.ts` resolves its
   * group guard the same way for the same reason; the candidate set is one analyte inside one
   * window, so the loop is short by construction.
   */
  const seen = new Map<string, string>();
  for (const row of candidates) {
    let canonical = seen.get(row.patientId);
    if (canonical === undefined) {
      canonical = (await resolvePatientId(tx, row.patientId)) ?? row.patientId;
      seen.set(row.patientId, canonical);
    }
    if (canonical !== ctx.patientId) continue;

    const prior = Number(row.valueNumeric);
    if (!Number.isFinite(prior)) continue;
    const moved = Math.abs(value - prior);
    const movedPct = prior === 0 ? Infinity : (moved / Math.abs(prior)) * 100;
    const flagged = (abs !== null && moved >= abs) || (pct !== null && movedPct >= pct);
    return flagged ? { priorResultId: row.id, priorValue: row.valueNumeric! } : null;
  }
  return null;
}

/* ──────────────────────────────── the critical call ladder ──────────────────────────────── */

async function openCriticalCall(
  tx: Tx,
  actor: Actor,
  ctx: ResultContext,
  input: { resultId: string; analyteId: string; value: string; band: "low" | "high" },
  now: Date,
): Promise<string> {
  const callId = newId();
  await tx.insert(labCriticalCalls).values({
    id: callId, resultId: input.resultId, openedAt: now, openedBy: actor.id, attempts: [],
  });
  await appendEvent(tx, labResultCriticalFlagged.make({
    actor,
    patientId: ctx.patientId,
    encounterId: ctx.encounterNo,
    correlationId: ctx.orderId,
    payload: {
      resultId: input.resultId, callId, orderItemId: ctx.orderItemId, analyteId: input.analyteId,
      patientId: ctx.patientId, value: input.value, band: input.band,
    },
  }));
  return callId;
}

/* ────────────────────────────── the calculated analytes (DD3) ────────────────────────────── */

/**
 * Every formula analyte of this orderable whose inputs are now all present, in REPORT order.
 *
 * The pass repeats until it computes nothing new, so a formula over another formula (a non-HDL over
 * an LDL) lands in the same entry rather than waiting for an unrelated keystroke. It is bounded by
 * the analyte count, which is what stops a mutually-recursive catalogue entry spinning.
 */
async function computeFormulaAnalytes(
  tx: Tx,
  actor: Actor,
  ctx: ResultContext,
  analytes: (typeof labAnalytes.$inferSelect)[],
  entryMode: LabEntryMode,
  now: Date,
): Promise<EnteredResult[]> {
  const formulas = analytes.filter((a) => a.resultType === "formula");
  if (formulas.length === 0) return [];

  const done = new Set(
    (await tx.select({ analyteId: labResults.analyteId }).from(labResults)
      .where(eq(labResults.orderItemId, ctx.orderItemId))).map((r) => r.analyteId),
  );
  const written: EnteredResult[] = [];

  for (let pass = 0; pass < formulas.length; pass += 1) {
    const siblings = await siblingValues(tx, ctx, analytes);
    let progressed = false;
    for (const analyte of formulas) {
      if (done.has(analyte.id)) continue;
      const outcome = evaluateFormula(analyte, siblings);
      /**
       * A MISSING INPUT IS NOT A FAILURE, IT IS A WAIT. `evaluateFormula` reports a missing sibling
       * and a refused guard through the same `computed: false` door, so the two are told apart HERE
       * — by asking whether every code the formula names has a value. Writing "not calculable" the
       * moment the first analyte of a lipid profile is keyed would put a permanent text row where a
       * number is owed twenty seconds later, and DD13 makes it unrewritable.
       */
      if (!outcome.computed && !inputsAllPresent(analyte, siblings)) continue;

      const value = outcome.computed
        ? roundTo(outcome.value, analyte.decimals)
        : outcome.reason;
      written.push(await writeResult(tx, actor, ctx, {
        analyte,
        value,
        numeric: outcome.computed ? Number(value) : null,
        unit: outcome.computed ? analyte.unit : null,
        entryMode,
        remarks: null,
        absurdOverriddenBy: null,
        supersedesResultId: null,
        rerunOf: null,
      }, now));
      done.add(analyte.id);
      progressed = true;
    }
    if (!progressed) break;
  }
  return written;
}

/**
 * The numeric values already recorded on THIS specimen, keyed by analyte CODE — the map
 * `evaluateFormula` reads. Same specimen and nothing else (17a T3 A4): a formula that reached
 * across tubes would compute an LDL from this morning's cholesterol and last week's triglyceride.
 */
async function siblingValues(
  tx: Tx,
  ctx: ResultContext,
  analytes: (typeof labAnalytes.$inferSelect)[],
): Promise<Siblings> {
  const rows = await tx
    .select({ analyteId: labResults.analyteId, valueNumeric: labResults.valueNumeric })
    .from(labResults)
    .where(and(
      eq(labResults.specimenId, ctx.specimenId),
      inArray(labResults.analyteId, analytes.map((a) => a.id)),
    ))
    /**
     * ASCENDING, AND THE LAST ROW PER CODE WINS. A rerun writes a NEW row carrying
     * `supersedes_result_id` rather than editing the one it doubts, so the newest row for an
     * analyte is the current value — filtering on `supersedes_result_id IS NULL` would do the
     * exact opposite and feed the SUPERSEDED number into every formula.
     */
    .orderBy(labResults.enteredAt);
  const codeOf = new Map(analytes.map((a) => [a.id, a.code] as const));
  const out: Record<string, number | undefined> = {};
  for (const row of rows) {
    const code = codeOf.get(row.analyteId);
    if (code === undefined || row.valueNumeric === null) continue;
    out[code] = Number(row.valueNumeric);
  }
  return out;
}

/** Every analyte CODE the formula and its guard name has a value in `siblings`. */
function inputsAllPresent(
  analyte: { formula: string | null; formulaGuard: string | null },
  siblings: Siblings,
): boolean {
  const text = `${analyte.formula ?? ""} ${analyte.formulaGuard ?? ""}`;
  const codes = text.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  return codes.every((code) => siblings[code] !== undefined);
}

function roundTo(value: number, decimals: number): string {
  return value.toFixed(Math.max(0, Math.min(6, decimals)));
}

/* ─────────────────── the lab item's own machine, projected from the rows ─────────────────── */

/**
 * `accessioned → in_analysis` on the first result, `in_analysis → resulted` when every analyte the
 * orderable reports has one.
 *
 * **This is the LAB's machine and not the envelope's** — `transitions.ts` rules that every lab stage
 * lives INSIDE `in_progress`, so nothing here touches `order_items.status`. The envelope moves once,
 * at `completed`, and `verify.ts` owns that (T6 A3).
 *
 * The transitions are made as the ACTOR, so the workflow engine's own role check applies: entry is
 * a bench act and `accessioned → in_analysis` declares `lab_technician`. A pathologist who keys a
 * number in a one-person lab holds that role too, and one who does not gets an honest `role_denied`
 * rather than a silently skipped state.
 */
async function projectItemState(
  tx: Tx,
  actor: Actor,
  ctx: ResultContext,
  analytes: (typeof labAnalytes.$inferSelect)[],
): Promise<string> {
  const [instance] = await tx
    .select({ currentState: workflowInstances.currentState })
    .from(workflowInstances).where(eq(workflowInstances.id, ctx.instanceId));
  let state = instance?.currentState ?? "accessioned";

  if (state === "accessioned") {
    ({ state } = await transition(tx, ctx.instanceId, "in_analysis", actor));
  }
  if (state !== "in_analysis") return state;

  const have = new Set(
    (await tx.select({ analyteId: labResults.analyteId }).from(labResults)
      .where(eq(labResults.orderItemId, ctx.orderItemId))).map((r) => r.analyteId),
  );
  if (analytes.every((a) => have.has(a.id))) {
    ({ state } = await transition(tx, ctx.instanceId, "resulted", actor));
  }
  return state;
}

/* ────────────────────────────────────── the rerun ────────────────────────────────────── */

export type RequestRerunInput = {
  resultId: string;
  reason?: string | null;
};

/**
 * SEND A NUMBER BACK TO THE BENCH — free, and it is a state move rather than a new order (E13's
 * neighbour).
 *
 * A rerun does NOT delete or edit the result it doubts: `lab_results` is append-only past
 * verification by trigger and this keeps the same discipline before it. The row stays, the item
 * goes back to `in_analysis`, and the replacement value is entered with `rerun_of` naming this row
 * and `supersedes_result_id` naming it too. **No invoice, no credit note, no charge** — a laboratory
 * that repeats its own test at the pathologist's request is repeating its own work.
 *
 * It is refused once the ENVELOPE item is terminal. A `completed` item cannot return to
 * `in_progress` (`transitions.ts` declares no such edge, deliberately), so a rerun after completion
 * would strand the lab's own machine behind an envelope that says the department has finished — and
 * the honest instrument for a number that must change after publication is an AMENDMENT (T7 A6).
 */
export async function requestRerun(
  tx: Tx,
  actor: Actor,
  input: RequestRerunInput,
  now: Date = new Date(),
): Promise<{ resultId: string; orderItemId: string; state: string }> {
  await assertMay(tx, actor, "lab.results.verify", "send a lab result back for a rerun");

  const [result] = await tx.select().from(labResults).where(eq(labResults.id, input.resultId));
  if (!result) throw new LabError("unknown_result", `no lab result ${input.resultId}`);

  const ctx = await resultContext(tx, result.orderItemId);
  const [instance] = await tx
    .select({ currentState: workflowInstances.currentState })
    .from(workflowInstances).where(eq(workflowInstances.id, ctx.instanceId));
  if (instance?.currentState !== "resulted") {
    throw new LabError(
      "item_not_resultable",
      `order item ${result.orderItemId} is at "${instance?.currentState ?? "an unknown state"}" — ` +
        "a rerun sends a RESULTED item back to the bench, and a published one is amended instead",
    );
  }

  const { state } = await transition(tx, ctx.instanceId, "in_analysis", actor, {
    note: input.reason ?? `rerun of result ${input.resultId}`,
  });
  void now;
  return { resultId: input.resultId, orderItemId: result.orderItemId, state };
}
