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

  /**
   * ═══ CLOSE REVIEW M3 — THE SUPERSESSION CHAIN IS DERIVED, NOT REMEMBERED ═══
   *
   * `EnterResultInput` declared `supersedesResultId` and `rerunOf` and `requestRerun`'s header said
   * they were *"set by the caller"*. **There was no such caller**: `enterResult` has one call site,
   * the bench route, and its zod schema named neither — so zod stripped them and every re-keyed
   * value was written with a NULL chain. An NABL auditor following `supersedes_result_id` back to
   * the number that was wrong found nothing, on the one path that exists to answer that question.
   *
   * A field a caller must remember is a field a caller forgets, and 22c-A's C1 is the same shape one
   * layer out. So the chain is computed HERE, from the rows: a value keyed for an analyte that
   * already carries one supersedes it, which is exactly what a rerun is. The caller-supplied fields
   * remain as an override for a path that genuinely knows better; nothing in this phase uses them.
   */
  const [priorForAnalyte] = await tx.select({ id: labResults.id })
    .from(labResults)
    .where(and(eq(labResults.orderItemId, ctx.orderItemId), eq(labResults.analyteId, analyte.id)))
    .orderBy(desc(labResults.enteredAt)).limit(1);
  const primary = await writeResult(tx, actor, ctx, {
    analyte, value: input.value, numeric, unit: input.unit ?? analyte.unit,
    entryMode: input.entryMode, remarks: input.remarks ?? null, absurdOverriddenBy,
    supersedesResultId: input.supersedesResultId ?? priorForAnalyte?.id ?? null,
    rerunOf: input.rerunOf ?? priorForAnalyte?.id ?? null,
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
  /**
   * `Number("")` IS `0`, AND IT IS FINITE (close review M9). A value of one space passed the route's
   * `z.string().min(1)`, parsed to 0 here, and was then written back as `""` into a
   * `numeric(14,4)` column — a raw `invalid input syntax for type numeric` that no error class in
   * `toHttp` recognises, so it reached the bench as a **500**. That is the fourth instance of the
   * escape this module's own mapper says the repository has shipped three times.
   */
  if (value.trim() === "") {
    throw new LabError("catalogue_invalid", `${code}: a result needs a value, and this one is blank`);
  }
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

  /**
   * ═══ THE PATIENT IS IN THE `WHERE` CLAUSE, NOT IN A JS LOOP (CLOSE REVIEW M6) ═══
   *
   * This query used to name the analyte, the status, the window and NO PATIENT AT ALL, and then
   * resolve the merge chain per candidate in JavaScript until a canonical match was found. On a
   * hospital doing 400 CBCs a day with haemoglobin's 168-hour window that is ~2,800 rows across
   * ~2,500 distinct patients — and a FIRST-TIME patient's entry runs the loop to the end, issuing
   * ~2,500 sequential round-trips **inside the entry transaction, holding it open**, on the bench's
   * hot path. The old comment called the loop "short by construction"; it is short in the number of
   * ANALYTES and unbounded in the number of PATIENTS.
   *
   * The chain is walked ONCE, forwards, before the query: every id that merges into this canonical
   * patient, transitively. That set is what SQL filters on, and it is small by construction — it is
   * one person's registrations.
   */
  const chain = await mergeChainOf(tx, ctx.patientId);

  const candidates = await tx
    .select({
      id: labResults.id,
      valueNumeric: labResults.valueNumeric,
      enteredAt: labResults.enteredAt,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(labResults.analyteId, analyte.id),
      eq(labResults.verificationStatus, "verified"),
      gte(labResults.enteredAt, since),
      isNotNull(labResults.valueNumeric),
      inArray(orders.patientId, chain),
    ))
    .orderBy(desc(labResults.enteredAt))
    .limit(1);

  const row = candidates[0];
  if (!row || row.valueNumeric === null) return null;
  const prior = Number(row.valueNumeric);
  if (!Number.isFinite(prior)) return null;
  const moved = Math.abs(value - prior);
  const movedPct = prior === 0 ? Infinity : (moved / Math.abs(prior)) * 100;
  const flagged = (abs !== null && moved >= abs) || (pct !== null && movedPct >= pct);
  return flagged ? { priorResultId: row.id, priorValue: row.valueNumeric } : null;
}

/**
 * EVERY PATIENT ID THAT IS THIS PERSON — the canonical one and every registration merged into it,
 * transitively. `merge.ts` does not repoint `orders.patient_id`, so one person legitimately holds
 * orders under several ids and a delta keyed on the canonical one alone would miss yesterday's
 * haemoglobin entirely (02 A3).
 *
 * Walked FORWARDS from the canonical row rather than resolved per candidate: the set is one
 * person's registrations, which is small, where the candidate set is every patient in the window.
 * The loop is bounded by the chain's own depth and cannot revisit an id.
 */
async function mergeChainOf(tx: Tx, canonicalId: string): Promise<string[]> {
  const ids = new Set([canonicalId]);
  let frontier = [canonicalId];
  while (frontier.length > 0) {
    const losers = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(inArray(patients.mergedIntoPatientId, frontier));
    frontier = losers.map((l) => l.id).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

/* ──────────────────────────────── the critical call ladder ──────────────────────────────── */

/**
 * The subject a call is opened ABOUT. A narrow shape rather than a `ResultContext`, because
 * `amendResult` opens the ladder for a `completed` item and `resultContext` refuses one — the
 * function that decides an item is resultable must not also be the only way to name its patient.
 */
type CallSubject = { orderItemId: string; orderId: string; encounterNo: string; patientId: string };

async function openCriticalCall(
  tx: Tx,
  actor: Actor,
  ctx: CallSubject,
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

  /**
   * ═══ CLOSE REVIEW C3 — "ALREADY WRITTEN" IS NOT "STILL CURRENT" ═══
   *
   * `done` used to count ANY row for the analyte, so a rerun that corrected an INPUT left the
   * derived value computed from the superseded one. Total cholesterol keyed 500 (a transposition of
   * 150), HDL 50, TG 120 wrote LDL = 426; the rerun corrected the cholesterol to 150 and the LDL was
   * SKIPPED, so a signed report read *cholesterol 150, LDL 426* — an arithmetically impossible pair
   * a cardiologist would act on. `siblingValues` already argues that the newest row is the current
   * value; that is true of the inputs and was false of the outputs, because the outputs were never
   * rewritten.
   *
   * A formula analyte is therefore recomputed whenever its current value DISAGREES with what its
   * current inputs imply — and the recomputation is a SUPERSEDING row (DD13), never an edit, so the
   * number a report was signed against stays readable.
   */
  const currentRows = await tx.select().from(labResults)
    .where(eq(labResults.orderItemId, ctx.orderItemId)).orderBy(labResults.enteredAt);
  const currentByAnalyte = new Map<string, typeof labResults.$inferSelect>();
  for (const row of currentRows) currentByAnalyte.set(row.analyteId, row);
  const written: EnteredResult[] = [];

  for (let pass = 0; pass < formulas.length; pass += 1) {
    const siblings = await siblingValues(tx, ctx, analytes);
    let progressed = false;
    for (const analyte of formulas) {
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

      /**
       * NOTHING TO DO WHEN THE CURRENT ROW ALREADY SAYS THIS. The comparison is on the RENDERED
       * value, which is what a report prints and what `siblingValues` reads back — comparing the
       * float would make a re-entry of the same number write a superseding row every time.
       */
      const existing = currentByAnalyte.get(analyte.id);
      const existingValue = existing
        ? (existing.valueNumeric ?? existing.valueText ?? existing.valueCoded ?? "")
        : null;
      if (existing && existingValue === (outcome.computed ? `${Number(value)}` : value)) continue;
      if (existing && existingValue !== null && Number(existingValue) === Number(value)
          && outcome.computed) continue;

      const superseded = await writeResult(tx, actor, ctx, {
        analyte,
        value,
        numeric: outcome.computed ? Number(value) : null,
        unit: outcome.computed ? analyte.unit : null,
        entryMode,
        remarks: null,
        absurdOverriddenBy: null,
        /** DD13 — a recomputation REPLACES rather than edits, and names what it replaced. */
        supersedesResultId: existing?.id ?? null,
        rerunOf: null,
      }, now);
      written.push(superseded);
      const [fresh] = await tx.select().from(labResults).where(eq(labResults.id, superseded.resultId));
      if (fresh) currentByAnalyte.set(analyte.id, fresh);
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

/* ────────────────── DD13 / E40 — THE SIGNED CORRECTION AFTER PUBLICATION ────────────────── */

export type AmendResultInput = {
  /** The VERIFIED row this correction replaces. It is never edited and never deleted. */
  resultId: string;
  value: string;
  unit?: string | null;
  remarks?: string | null;
};

/**
 * ═══ 02 H8 / E40 — A PATHOLOGIST CORRECTS A VALUE THEY HAVE ALREADY SIGNED ═══
 *
 * `lab_results_immutable` refuses every UPDATE on a verified row, and `enterResult` refuses an item
 * that has reached `completed`. Both are correct and together they left DD13's own instrument
 * unbuildable: *"a correction after verification is a NEW row carrying `supersedes_result_id` and a
 * new report version"* — with nothing able to write that row (§9.2 F38, found by T7 A6).
 *
 * This is that writer, and it is deliberately NOT `enterResult` with a flag:
 *
 *   · it needs `lab.reports.amend`, not `lab.results.enter` — correcting a published number is an
 *     amendment, and the permission that gates the amended REPORT gates the value inside it;
 *   · the new row is entered AND verified by the amending pathologist in one act, because a signed
 *     correction is one person's statement about their own earlier signature. The entry-time SoD
 *     would block exactly the person answerable for it, and a control that pushes a 22:00 typo
 *     correction onto paper protects nobody;
 *   · the superseded row STAYS readable for ever, which is what makes "which number did the
 *     patient's doctor act on" answerable after the fact.
 *
 * It writes no report. `amendReport` publishes version n+1 over the rows this leaves behind, so a
 * correction that is never published is a correction nobody acted on — visible, and not delivered.
 */
export async function amendResult(
  tx: Tx,
  actor: Actor,
  input: AmendResultInput,
  now: Date = new Date(),
): Promise<EnteredResult> {
  await assertMay(tx, actor, "lab.reports.amend", "amend a signed lab result");

  const [prior] = await tx.select().from(labResults).where(eq(labResults.id, input.resultId));
  if (!prior) throw new LabError("unknown_result", `no lab result ${input.resultId}`);
  if (prior.verificationStatus === "unverified") {
    throw new LabError(
      "report_not_amendable",
      `result ${input.resultId} has not been signed — an unsigned number is corrected with a ` +
        "rerun, not with an amendment",
    );
  }

  const [analyte] = await tx.select().from(labAnalytes).where(eq(labAnalytes.id, prior.analyteId));
  if (!analyte) throw new LabError("unknown_analyte", `no analyte ${prior.analyteId}`);

  /**
   * `resultContext` asserts the item is RESULTABLE and this one is not — it is `completed`, which
   * is the only state an amendment happens in. The pieces it would have supplied are read directly,
   * and the ENVELOPE is deliberately not touched: the department finished, and a correction does
   * not un-finish it.
   */
  const [row] = await tx
    .select({
      orderId: orders.id, encounterNo: orders.encounterNo, patientId: orders.patientId,
      serviceId: orderItems.serviceId, instanceId: labItems.instanceId,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .where(eq(orderItems.id, prior.orderItemId));
  if (!row) throw new LabError("unknown_item", `no lab order item ${prior.orderItemId}`);

  const canonical = (await resolvePatientId(tx, row.patientId)) ?? row.patientId;
  const numeric = analyte.resultType === "numeric" ? parseNumeric(input.value, analyte.code) : null;
  if (numeric !== null && outsideAbsurdEnvelope(numeric, analyte)) {
    throw new LabError(
      "absurd_value",
      `${analyte.code} ${input.value} is outside the plausible envelope — an amendment is not an ` +
        "override, and a corrected value is still a value",
    );
  }

  /**
   * ═══ THE CORRECTED VALUE IS FLAGGED AGAINST THE RANGE IT WAS SIGNED AGAINST ═══
   *
   * The range on the prior row, and the analyte's own critical band. A correction is a statement
   * about the VALUE, not about the range book, so re-resolving the range here would silently
   * re-flag against whatever the curator has done since.
   */
  const flag = numeric === null ? prior.flag : flagFor(numeric, {
    refRangeId: prior.refRangeId, low: prior.refLow, high: prior.refHigh, text: prior.refText,
    criticalLow: analyte.criticalLow, criticalHigh: analyte.criticalHigh, note: prior.refNote,
  });

  const resultId = newId();
  await tx.insert(labResults).values({
    id: resultId,
    orderItemId: prior.orderItemId,
    analyteId: prior.analyteId,
    specimenId: prior.specimenId,
    valueNumeric: numeric === null ? null : input.value.trim(),
    valueText: numeric === null && analyte.resultType !== "coded" ? input.value : null,
    valueCoded: numeric === null && analyte.resultType === "coded" ? input.value : null,
    unit: input.unit ?? prior.unit,
    /** The RANGE IS THE ONE IT WAS SIGNED AGAINST — the correction is to the value, not to the book. */
    flag,
    refLow: prior.refLow,
    refHigh: prior.refHigh,
    refText: prior.refText,
    refRangeId: prior.refRangeId,
    refNote: prior.refNote,
    deltaFlag: false,
    absurdOverriddenBy: null,
    enteredByType: actor.type,
    enteredById: actor.id,
    enteredAt: now,
    entryMode: prior.entryMode,
    /** ENTERED AND SIGNED IN ONE ACT — see the header. The SoD refusal would block the one person
     *  who is answerable for the earlier signature. */
    verificationStatus: "verified",
    verifiedBy: actor.id,
    verifiedAt: now,
    pathologistReviewPending: false,
    supersedesResultId: prior.id,
    remarks: input.remarks ?? null,
  });

  await appendEvent(tx, labResultEntered.make({
    actor,
    patientId: canonical,
    encounterId: row.encounterNo,
    correlationId: row.orderId,
    payload: {
      resultId, orderItemId: prior.orderItemId, analyteId: prior.analyteId, enteredBy: actor.id,
      flag, entryMode: prior.entryMode, absurdOverridden: false,
    },
  }));

  /**
   * ═══ CLOSE REVIEW C2 — A CORRECTED VALUE OPENS THE CALL LADDER LIKE ANY OTHER (DD12) ═══
   *
   * This function shipped computing a flag and then throwing it away: it returned `flag: null`,
   * evented `flag: null`, opened no `lab_critical_calls` row and emitted no
   * `lab.result_critical_flagged`. **The path where the value is KNOWN to have been wrong was the
   * one path with no telephone call.** A potassium signed at 22:00 as 4.2 and corrected to 6.9 at
   * 09:00 produced a critical result on a signed report that nobody was told about, and the open-
   * ladder handover list did not show it.
   *
   * `writeResult` opens the ladder for every other value in this module; an amendment is not an
   * exception to DD12 and there is no reading of 02 F1 under which it could be.
   */
  const criticalCallId = flag === "LL" || flag === "HH"
    ? await openCriticalCall(tx, actor, {
        orderItemId: prior.orderItemId, orderId: row.orderId,
        encounterNo: row.encounterNo, patientId: canonical,
      }, {
        resultId, analyteId: prior.analyteId, value: input.value.trim(),
        band: flag === "LL" ? "low" : "high",
      }, now)
    : null;

  /**
   * AND THE NOTIFIABLE FLAG, for the same reason. Correcting a dengue NS1 from negative to positive
   * is precisely the event 28a's register exists to receive, and `writeResult`'s own header calls
   * under-reporting a notifiable disease a statutory failure rather than a tidiness one.
   */
  const [orderable] = await tx.select({ notifiable: labOrderables.notifiable, serviceId: labOrderables.serviceId })
    .from(labOrderables).where(eq(labOrderables.serviceId, row.serviceId));
  if (orderable?.notifiable === true) {
    await appendEvent(tx, labNotifiableFlagged.make({
      actor,
      patientId: canonical,
      correlationId: row.orderId,
      payload: {
        resultId, orderItemId: prior.orderItemId, patientId: canonical,
        serviceId: row.serviceId, analyteId: prior.analyteId,
      },
    }));
  }

  return { resultId, analyteId: prior.analyteId, flag, deltaFlagged: false, criticalCallId };
}
