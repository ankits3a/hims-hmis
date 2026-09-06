import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  invoiceLines, labAnalytes, labItems, labResults, labSpecimenItems, orderItems, orders,
  workflowInstances,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { placeOrder } from "../../kernel/orders/place";
import { startInstance, transition } from "../../kernel/workflow/instances";
import { BillingError, issueInvoice } from "../billing";
import { TariffError } from "../tariff";
import { activeReflexRules, analytesFor } from "./catalogue";
import { LabError } from "./errors";
import { formulaInputCodes } from "./formula";
import { getEncounter } from "../opd";
import { resolvePatientId } from "../patients";
import { canonicalNames } from "./criticals";
import { matchReflex } from "./reflex";
import { currentValue, deferNearMiss, flushNearMiss, liveRowsFor, resultContext } from "./results";
import {
  labNightReleaseReviewed, labReflexAdded, labResultVerified, labSodViolationBlocked,
} from "./events";
import { LAB_ITEM_DEF_KEY } from "./workflow-def";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * ═══ 17-E T7 / D18 — ONE ANSWER PER LINE, AND THE GUARD IS HERE ═══
 *
 * `reports.ts` prints the LAST VERIFIED ROW per analyte. That rule is correct and this task does
 * not touch it — **because verification is where a number becomes reportable, so verification is
 * the door.** Removing the machine's auto-supersession without a guard here would have moved the
 * silent overwrite one layer up: two live values, both signable, and the report carrying whichever
 * a pathologist happened to click second. Widening the report's reader instead is the shape that
 * cost 22c-A its C1.
 *
 * Three refusals, and each names a different fact:
 *
 *   · `result_superseded` — a later row replaced this one. Nothing else in the module refused it,
 *     and a superseded row signed after its replacement is the last verified row for the analyte,
 *     so `reports.ts` would print the number a re-key corrected. FOUND AT T7, not planned.
 *   · `rerun_unchosen` on the row's own analyte — the analyser ran the tube twice and nobody has
 *     said which run the report carries.
 *   · `rerun_unchosen` on a formula's INPUT — the derived value on the row is arithmetic over a
 *     number the laboratory is still deciding about. Close review C3 measured what publishing one
 *     of those costs: *cholesterol 150, LDL 426*, a pair a cardiologist acts on.
 *
 * **THE THIRD IS PER INPUT AND NOT PER PANEL, deliberately.** A lipid profile carries four formula
 * analytes; VLDL is `TG / 5` and does not care that the cholesterol was repeated. A guard written
 * over the panel would stop every lipid profile in the laboratory on any one repeated analyte,
 * which is a refusal nobody can act on and therefore one everybody learns to route around.
 */
async function assertReportable(
  tx: Tx,
  result: typeof labResults.$inferSelect,
  ctx: { serviceId: string; orderItemId: string },
): Promise<void> {
  const rows = await tx.select().from(labResults)
    .where(eq(labResults.orderItemId, result.orderItemId))
    .orderBy(labResults.enteredAt);

  if (!liveRowsFor(rows, result.analyteId).some((r) => r.id === result.id)) {
    throw new LabError(
      "result_superseded",
      `result ${result.id} was superseded by a later row for the same analyte — the laboratory's ` +
        "answer is the row that replaced it, and signing this one would put the corrected number " +
        "back on the report",
    );
  }

  const own = currentValue(rows, result.analyteId);
  if (own === undefined || own.id !== result.id) {
    throw new LabError(
      "rerun_unchosen",
      `this analyte carries more than one live value — an analyser rerun keeps both, and the bench ` +
        "chooses which the report carries, with a reason, before either can be signed",
      { orderItemId: result.orderItemId, analyteId: result.analyteId },
    );
  }

  /**
   * The row's own analyte is resolved. If it is a FORMULA, every analyte its expression names must
   * be resolved too — the arithmetic is only as decided as its least decided input.
   */
  const analytes = await analytesFor(tx, ctx.serviceId);
  const mine = analytes.find((a) => a.id === result.analyteId);
  if (!mine || mine.resultType !== "formula" || !mine.formula) return;

  const byCode = new Map(analytes.map((a) => [a.code, a] as const));
  for (const code of formulaInputCodes(mine.formula, mine.formulaGuard)) {
    const input = byCode.get(code);
    if (!input) continue;
    const liveInputs = liveRowsFor(rows, input.id);
    if (liveInputs.length > 1 && currentValue(rows, input.id) === undefined) {
      throw new LabError(
        "rerun_unchosen",
        `${mine.code} is computed from ${code}, which carries more than one live value — a derived ` +
          "number is only as decided as its inputs, and one signed over an undecided input is a " +
          "figure nobody measured",
        { orderItemId: result.orderItemId, analyteId: input.id, derivedAnalyteId: result.analyteId },
      );
    }
  }
}

/**
 * PLAN 17b T6 / DD8, DD11 — **THE SIGNATURE**: separation of duties, the compare-and-set, the
 * synchronous reflex, and `completed` on the envelope when the last analyte is signed.
 *
 * ═══ THIS FUNCTION IS `Db`-FIRST, AND F20/F27 ARE WHY ═══
 *
 * `lab.sod_violation_blocked` is an event about a REFUSAL, and a refusal rolls its own transaction
 * back by construction. 17a shipped `printLabels` `Db`-first for exactly this reason (F20: the
 * near-miss flag appended on the transaction that then rolled back left no trace at all), and 17a's
 * §9.2 F27 records the same defect one module over, still open in `issueInvoice`. So the audit lane
 * is written on the `Db` — its own transaction, which survives — and the work is done on a `Tx`
 * opened here. **NABL asks how often the single-operator path was used; a control nobody can count
 * is a control nobody can audit.**
 *
 * ═══ THE SoD IS ABOUT THE RESULT ROW, NOT ABOUT A ROLE (T6 A1) ═══
 *
 * The `lab_item` definition already declares `pathologist` on `resulted → verified` and the workflow
 * engine checks it itself (17a S4). That is a different claim from this one. **The verifier is not
 * the person who keyed the number** is a fact about `lab_results.entered_by_id`, and no role list
 * can express it: a small hospital's night pathologist holds every permission in the module and
 * still may not sign their own transcription. The check is therefore per ROW, and a mutant that
 * checks the role instead passes every test that does not put both hats on one head.
 *
 * ═══ NIGHT MODE IS A PROPERTY OF THE CLOCK, NOT A FLAG THE CALLER SENDS (F34) ═══
 *
 * DD11 says the relaxation is *"the active `lab_item` definition's `single_operator_night_mode`
 * flag"*. That field does not exist: `defineWorkflow` validates a closed shape and `workflow-def.ts`
 * is 17a's file, frozen for this phase (§8). Accepting `nightMode: true` as an INPUT was the other
 * option and it is worse than no control at all — a boolean that switches off separation of duties
 * is switched on by whoever wants it off. So night mode is derived from the INSTANT, in IST, and a
 * verifier cannot choose it. 02 F2's case is *"the technologist is alone at night"*, which is a fact
 * about the shift; deriving it from the shift is closer to the ruling than a caller-supplied flag.
 * **Recorded as a finding rather than absorbed** (§9.2 F34), with 17-E named as the phase that adds
 * the real per-deployment switch.
 */

/** IST hours during which a single operator may release their own result (DD11 / 02 F2). */
export const NIGHT_MODE_FROM_HOUR_IST = 21;
export const NIGHT_MODE_TO_HOUR_IST = 7;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** PURE, and exported because a boundary proved through five layers is a boundary nobody can read. */
export function isSingleOperatorNight(at: Date): boolean {
  const hour = new Date(at.getTime() + IST_OFFSET_MS).getUTCHours();
  return hour >= NIGHT_MODE_FROM_HOUR_IST || hour < NIGHT_MODE_TO_HOUR_IST;
}

/** DD8 — the reflex order's placer. A `system` actor under `protocol` authority (17a S9). */
export const LAB_REFLEX_ACTOR: Actor = { type: "system", id: "lab-reflex" };

export const LAB_RESULTS_VERIFY = "lab.results.verify";

export type VerifyResultInput = { resultId: string };

export type ReflexPlacement = {
  ruleId: string;
  ruleVersion: number;
  orderId: string;
  orderNo: string;
  orderItemId: string;
  addedServiceId: string;
  invoiceId: string;
};

/**
 * A reflex rule that FIRED and could not be acted on (close review M1). It is returned rather than
 * thrown, because the signature it would otherwise have taken with it is a clinical fact and the
 * refusal is a configuration problem — usually an unpriced test the counter never sells.
 */
export type ReflexRefusal = {
  ruleId: string;
  addedServiceId: string;
  code: string;
  reason: string;
};

export type VerifyResultOutcome = {
  resultId: string;
  orderItemId: string;
  /** DD11 — a night-mode release lands in the pathologist's morning queue. */
  pathologistReviewPending: boolean;
  reflex: ReflexPlacement[];
  /** M1 — rules that fired and whose ORDER could not be raised. The signature stood anyway. */
  reflexRefused: ReflexRefusal[];
  /** T6 A3 — `completed` fires exactly when the LAST analyte of the item is signed. */
  itemCompleted: boolean;
};

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * DD11 — THE MORNING AFTER: THE SECOND PAIR OF HANDS, ARRIVING LATE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Night mode is a RELAXATION of separation of duties, not an exemption from it. Between 21:00 and
 * 07:00 IST the solo pathologist on duty may sign what they keyed, the row carries
 * `pathologist_review_pending`, and the printed report says PROVISIONAL.
 *
 * **A relaxation with no compensating review is an absent control**, and until now that is what this
 * was: the flag was written, carried into three view models and onto the page, and NO QUERY ANYWHERE
 * SELECTED ON IT. `docs/runbooks/lab-go-live.md` §7 says so plainly — *"Those rows are the morning
 * queue. Somebody must work it, and this build ships no screen filter for it — read `lab_results`
 * where `pathologist_review_pending` is true."* A morning round does not begin with a DBA running
 * psql, and NABL 15189 asks who reviewed the results released in the authorised signatory's absence.
 *
 * ═══ WHY THERE IS NO MIGRATION AND NO NEW TABLE ═══
 *
 * `lab_results_forbid_verified_mutation` (0046) excludes exactly one column from the immutability
 * check — this one — and the comment above it says why: the carve-out *"is what stops 'the reviewer
 * needs one column' becoming 'the trigger was dropped'"*. **The schema anticipated this act.** So
 * clearing the flag is the state change the trigger was written to permit, and nothing else on the
 * row may move: a signed value is corrected with a superseding row, and reviewing is not correcting.
 *
 * WHO reviewed it goes in the EVENT, because the flag is a STATE and the question is about the past.
 * A boolean cannot answer "who signed this off on Tuesday morning"; the audit spine can.
 */
export type NightReleaseRow = {
  resultId: string;
  orderItemId: string;
  orderNo: string;
  patientId: string;
  patientDisplay: string;
  analyteCode: string;
  analyteName: string;
  value: string;
  unit: string | null;
  flag: string | null;
  /** WHO released it alone — the fact the review is about, so it is on the row and not a click away. */
  releasedBy: string;
  releasedAt: string;
};

export async function nightReleasesAwaitingReview(db: Db, actor: Actor): Promise<NightReleaseRow[]> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not read the morning queue`);
  }
  if (!(await hasPermission(db, actor.id, LAB_RESULTS_VERIFY, "hospital"))) {
    throw new LabError("permission_denied", `reading the night-release queue requires ${LAB_RESULTS_VERIFY}`);
  }

  const rows = await db
    .select({
      result: labResults,
      analyteCode: labAnalytes.code,
      analyteName: labAnalytes.nameEn,
      orderNo: orders.orderNo,
      patientIdRaw: orders.patientId,
    })
    .from(labResults)
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(labResults.pathologistReviewPending, true))
    /** OLDEST FIRST: the oldest release is the one whose report has been out longest. */
    .orderBy(labResults.verifiedAt);
  if (rows.length === 0) return [];

  /**
   * The CANONICAL patient decides the name (E4 / close review pass 2 F8): a person registered twice
   * and merged carries `is_confidential` on the SURVIVING record, so joining on the raw `orders`
   * patient id would render a sealed patient's legal name on this list.
   */
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const names = await canonicalNames(db, rows.map((r) => r.patientIdRaw), canSeeConfidential);

  return rows.map((r) => ({
    resultId: r.result.id,
    orderItemId: r.result.orderItemId,
    orderNo: r.orderNo,
    patientId: names.get(r.patientIdRaw)?.id ?? r.patientIdRaw,
    patientDisplay: names.get(r.patientIdRaw)?.display ?? "\u2014",
    analyteCode: r.analyteCode,
    analyteName: r.analyteName,
    value: r.result.valueNumeric ?? r.result.valueText ?? r.result.valueCoded ?? "",
    unit: r.result.unit,
    flag: r.result.flag,
    releasedBy: r.result.verifiedBy ?? r.result.enteredById,
    releasedAt: (r.result.verifiedAt ?? r.result.enteredAt).toISOString(),
  }));
}

export type ReviewNightReleaseInput = { resultId: string; note?: string };

export async function reviewNightRelease(
  db: Db,
  actor: Actor,
  input: ReviewNightReleaseInput,
  now: Date = new Date(),
): Promise<{ resultId: string; reviewedBy: string }> {
  if (actor.type !== "user") {
    throw new LabError(
      "user_actor_required",
      `a ${actor.type} actor may not review a night release — the whole act is a second PERSON`,
    );
  }
  if (!(await hasPermission(db, actor.id, LAB_RESULTS_VERIFY, "hospital"))) {
    throw new LabError("permission_denied", `reviewing a night release requires ${LAB_RESULTS_VERIFY}`);
  }

  return await withTx(db, async (tx) => {
    const [result] = await tx.select().from(labResults).where(eq(labResults.id, input.resultId));
    if (!result) throw new LabError("unknown_result", `no lab result ${input.resultId}`);
    if (!result.pathologistReviewPending) {
      throw new LabError(
        "review_not_pending",
        `result ${input.resultId} is not awaiting a morning review — it was either signed by a ` +
          "second pair of hands at the time, or it has already been reviewed",
      );
    }

    /**
     * ═══ THE WHOLE POINT ═══
     *
     * Night mode BORROWED the second pair of hands and this is that pair arriving. If the person who
     * released it alone may also review it alone, nothing has been reviewed and the flag has been
     * cleared by the same signature that raised it. Refused as what it IS rather than with a new
     * word for the same fact.
     */
    const releasedBy = result.verifiedBy ?? result.enteredById;
    if (releasedBy === actor.id) {
      throw new LabError(
        "sod_violation",
        `result ${input.resultId} was released under night mode by this same user — the morning ` +
          "review IS the second pair of hands, and it cannot be the first pair a second time",
        { releasedBy },
      );
    }

    /**
     * ═══ NOT `resultContext`, AND THE REFUSAL IT GAVE IS THE ARGUMENT ═══
     *
     * `resultContext` is the ENTRY precondition — *"a result may only be keyed against an item whose
     * specimen reached the bench"* — and it refuses a `completed` item. By the time a result has been
     * verified its item IS completed, so every post-verification act needs its own read: `amendResult`
     * does exactly this a few hundred lines away, resolving the visit through `getEncounter` because
     * every `encounter_id` column holds a ULID and `orders.encounter_no` is the human-facing `V…`.
     *
     * **Reviewing is not keying**, and reusing the write precondition to fetch three ids would have
     * made the morning queue unworkable for the only rows that can be in it.
     */
    const [ctxRow] = await tx
      .select({
        orderId: orders.id,
        encounterNo: orders.encounterNo,
        patientIdRaw: orders.patientId,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orderItems.id, result.orderItemId));
    if (!ctxRow) throw new LabError("unknown_item", `no lab order item ${result.orderItemId}`);
    const patientId = (await resolvePatientId(tx, ctxRow.patientIdRaw)) ?? ctxRow.patientIdRaw;
    const encounterId = (await getEncounter(tx, ctxRow.encounterNo))?.id ?? ctxRow.encounterNo;

    /**
     * ONE COLUMN, and the trigger is what makes that a fact rather than a promise:
     * `lab_results_forbid_verified_mutation` refuses this UPDATE if it touches anything else.
     */
    await tx.update(labResults)
      .set({ pathologistReviewPending: false })
      .where(and(eq(labResults.id, input.resultId), eq(labResults.pathologistReviewPending, true)));

    await appendEvent(tx, labNightReleaseReviewed.make({
      actor,
      patientId,
      encounterId,
      correlationId: ctxRow.orderId,
      payload: {
        resultId: input.resultId,
        orderItemId: result.orderItemId,
        analyteId: result.analyteId,
        reviewedBy: actor.id,
        releasedBy,
        note: input.note ?? null,
        reviewedAt: now.toISOString(),
      },
    }));

    return { resultId: input.resultId, reviewedBy: actor.id };
  });
}

/**
 * SIGN ONE RESULT.
 *
 * `decls` is required for the same reason `placeOrder` requires it (17a's F2): the reflex placement
 * and the envelope's `completed` both validate against the declarations of the INSTALLED manifests,
 * and a module-level global would make every test either a boot or a lie.
 */
export async function verifyResult(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: VerifyResultInput,
  now: Date = new Date(),
): Promise<VerifyResultOutcome> {
  try {
    return await withTx(db, (tx) => verifyResultInTx(db, tx, actor, decls, input, now));
  } catch (e) {
    /** The SoD refusal's audit row, appended after this transaction has unwound (see `results.ts`). */
    await flushNearMiss(db, e);
    throw e;
  }
}

async function verifyResultInTx(
  db: Db,
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: VerifyResultInput,
  now: Date,
): Promise<VerifyResultOutcome> {
  /**
   * ═══ A `system` ACTOR IS REFUSED OUTRIGHT (T6 A9 / DD11 / CONTRACT §6.15) ═══
   *
   * This is the auto-verification seam, structurally closed. NABL permits a documented technologist
   * release; it does not permit a machine releasing a number a human typed — and `entry_mode =
   * 'interface'` does not exist until 17-E, so there is no row a system verify could even be about.
   * Refusing by TYPE also keeps `hasPermission` off a non-`users.id`, whose `false` aliases "may
   * not" with "is not a user" (22c-A review D11).
   */
  if (actor.type !== "user") {
    throw new LabError(
      "user_actor_required",
      `a ${actor.type} actor may not verify a lab result — auto-verification ships DISABLED and ` +
        "17-E is the phase that activates it",
    );
  }

  const [result] = await tx.select().from(labResults).where(eq(labResults.id, input.resultId));
  if (!result) throw new LabError("unknown_result", `no lab result ${input.resultId}`);

  if (!(await hasPermission(db, actor.id, LAB_RESULTS_VERIFY, "hospital"))) {
    throw new LabError("permission_denied", `verifying a lab result requires ${LAB_RESULTS_VERIFY}`);
  }

  /**
   * The fast refusal. It is NOT the concurrency control — the CAS below is — but a caller who reads
   * a worklist and clicks a row somebody signed an hour ago deserves a sentence rather than a
   * compare-and-set miss, and the two refusals carry the same code on purpose.
   */
  if (result.verificationStatus !== "unverified") {
    throw new LabError(
      "already_verified",
      `result ${input.resultId} is ${result.verificationStatus} — a signed result is corrected with ` +
        "a superseding row and a new report version, never re-signed",
    );
  }

  const ctx = await resultContext(tx, result.orderItemId);

  await assertReportable(tx, result, ctx);

  /* ═══ SEPARATION OF DUTIES, PER ROW (T6 A1) ═══ */
  const nightMode = isSingleOperatorNight(now);
  const sameHands = result.enteredById === actor.id;
  if (sameHands && !nightMode) {
    /**
     * THE FLAG OUTLIVES THE TRANSACTION THAT IS ABOUT TO ROLL BACK — an event appended on `tx` here
     * would be undone by the very throw it exists to record, and the refusal would leave no trace.
     *
     * It is now DEFERRED rather than written on a second connection acquired while this one is
     * still held: that nesting could exhaust a default pool of ten with no timeout to break it.
     * The event rides the error and `verifyResult` appends it once this transaction has unwound.
     */
    const blocked = labSodViolationBlocked.make({
      actor,
      patientId: ctx.patientId,
      encounterId: ctx.encounterId,
      correlationId: ctx.orderId,
      payload: {
        resultId: input.resultId, orderItemId: ctx.orderItemId,
        actorId: actor.id, enteredById: result.enteredById,
      },
    });
    throw deferNearMiss(new LabError(
      "sod_violation",
      `result ${input.resultId} was keyed by this same user — a result is signed by a second pair ` +
        "of hands, and holding both permissions is not the same as being two people",
      { enteredById: result.enteredById },
    ), blocked);
  }
  const pathologistReviewPending = sameHands;

  /**
   * ═══ THE COMPARE-AND-SET (T6 A2) — TRANSCRIBED FROM `workflow/instances.ts:136-157` ═══
   *
   * Two pathologists opening one worklist and clicking the same row is the ordinary morning race.
   * Read-then-write lets both pass the status check above, both emit `lab.result_verified`, both
   * place the reflex order and both bill the patient for it. `WHERE id = ? AND
   * verification_status = 'unverified'` makes exactly one of them the winner, and **the loser
   * reports rather than re-reading and overwriting.**
   *
   * The `lab_results_immutable` trigger fires `WHEN (OLD.verification_status <> 'unverified')`, so
   * this one UPDATE is the only mutation the table permits and the loser cannot get past it either.
   */
  const won = await tx
    .update(labResults)
    .set({
      verificationStatus: "verified",
      verifiedBy: actor.id,
      verifiedAt: now,
      pathologistReviewPending,
    })
    .where(and(eq(labResults.id, input.resultId), eq(labResults.verificationStatus, "unverified")))
    .returning({ id: labResults.id });
  if (won.length === 0) {
    throw new LabError(
      "already_verified",
      `result ${input.resultId} was signed concurrently by another verifier`,
    );
  }

  await appendEvent(tx, labResultVerified.make({
    actor,
    patientId: ctx.patientId,
    encounterId: ctx.encounterId,
    correlationId: ctx.orderId,
    payload: {
      resultId: input.resultId, orderItemId: ctx.orderItemId, orderGroupId: ctx.orderGroupId, analyteId: result.analyteId,
      verifiedBy: actor.id,
    },
  }));

  const { placed: reflex, refused: reflexRefused } =
    await placeReflexOrders(tx, actor, decls, ctx, result, now);
  const itemCompleted = await completeItemIfSigned(tx, actor, decls, ctx, now);

  return {
    resultId: input.resultId,
    orderItemId: ctx.orderItemId,
    pathologistReviewPending,
    reflex,
    reflexRefused,
    itemCompleted,
  };
}

/* ────────────────────────────── DD8 — the synchronous reflex ────────────────────────────── */

/**
 * ═══ IN THE VERIFYING TRANSACTION, AND THAT IS THE WHOLE OF T6 A4 ═══
 *
 * A reflex placed after the commit is a test the lab runs and a bill the patient pays for a
 * verification that may not have happened — and there is no compensating write, because the second
 * half of the pair is a phlebotomist's needle or an analyser's cuvette. Placing it here means a
 * throw anywhere between the signature and the commit takes BOTH back.
 *
 * ═══ CONSENT IS THE CALLER'S CHECK, AND THE CALLER IS THIS FUNCTION (T6 A4b) ═══
 *
 * `matchReflex` decides that a RULE FIRES and nothing else (17a §6.3). Whether the hospital may act
 * on it is a fact about the ORDER ITEM — `lab_items.reflex_consented_at`, taken at the desk — and a
 * reflex placed without it bills a patient for a test they never agreed to.
 */
async function placeReflexOrders(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  ctx: Awaited<ReturnType<typeof resultContext>>,
  result: typeof labResults.$inferSelect,
  now: Date,
): Promise<{ placed: ReflexPlacement[]; refused: ReflexRefusal[] }> {
  const none = { placed: [] as ReflexPlacement[], refused: [] as ReflexRefusal[] };
  if (result.valueNumeric === null) return none;

  const [labItem] = await tx
    .select({ reflexConsentedAt: labItems.reflexConsentedAt })
    .from(labItems).where(eq(labItems.orderItemId, ctx.orderItemId));
  if (!labItem || labItem.reflexConsentedAt === null) return none;

  const rules = await activeReflexRules(tx, result.analyteId);
  const matches = matchReflex(rules, { analyteId: result.analyteId, valueNumeric: result.valueNumeric });
  if (matches.length === 0) return none;

  /**
   * NOT TWICE FOR THE SAME PARENT (T6 A4b). A rerun of the trigger analyte re-verifies a value that
   * already fired the rule, and the second placement would be a second bill for one clinical
   * decision. The pointer that makes it decidable is `order_items.parent_item_id`, which
   * `placeOrder` writes from the input below.
   */
  const already = await tx
    .select({ serviceId: orderItems.serviceId })
    .from(orderItems)
    .where(and(
      eq(orderItems.parentItemId, ctx.orderItemId),
      eq(orderItems.origin, "reflex"),
    ));
  const alreadyAdded = new Set(already.map((r) => r.serviceId));

  const placed: ReflexPlacement[] = [];
  const refused: ReflexRefusal[] = [];
  for (const match of matches) {
    if (alreadyAdded.has(match.addsServiceId)) continue;

    /**
     * ═══ CLOSE REVIEW M1 — A BILLING FAILURE ON THE REFLEX MUST NOT HOLD THE SIGNATURE ═══
     *
     * The placement and its invoice ran on the verifying transaction with no boundary, so ANY
     * refusal from `issueInvoice` rolled the VERIFICATION back with them. Three of those refusals
     * are ordinary configuration, not caller error:
     *
     *   · `TariffError` — the reflexed service has no price in the active version. This one fires
     *     on an ordinary go-live gap: the counter never SELLS an FT4, so nobody notices it is
     *     unpriced until a TSH reflexes onto it.
     *   · `credit_approval_required` — the line exceeds `creditCapPaise`, and the approval it wants
     *     binds to a `draftId` minted inside this function, so **no approval could ever be granted
     *     for it**. Unconditionally unsignable.
     *   · `outstanding_cap_exceeded` — when the cap mode is `block`.
     *
     * In every one of those cases the pathologist clicked Verify and read an error naming a test
     * they never ordered, the TSH stayed `unverified`, and `listResultsForEncounter` — verified-only
     * — showed the treating doctor NOTHING. **A tariff row silenced a clinical result**, which is
     * 02 O-1 inverted: money must never hold a clinical fact, and here money held the signature.
     *
     * So the whole reflex — placement, invoice, item, tube link, projection, event — runs inside a
     * SAVEPOINT (`tx.transaction` on a `Tx`). If it fails, the savepoint rolls back and nothing of
     * the reflex survives; **the verification stands**, and the refusal is RETURNED so the caller
     * can show it and a human can price the test.
     *
     * **T6 A4 is unaffected and still holds**: a throw AFTER the reflex, anywhere in the verifying
     * transaction, still takes the reflex with it — the savepoint is released, not committed, and
     * the outer rollback reaches it. The boundary is one-way by construction, which is exactly the
     * asymmetry the defect needed: the verify may kill the reflex; the reflex may not kill the verify.
     */
    try {
      await tx.transaction(async (sp) => {
      /**
       * `orderingClinicianId` IS THE VERIFYING PATHOLOGIST (17a S9, spike-answered).
       *
       * `place.ts:126` checks `requiresClinician` for EVERY actor type, AFTER `resolveAuthority` has
       * accepted the system actor's `protocolRef` — the two guards are independent. So a reflex order
       * still owes a doctor, and the honest one is the person whose signature caused it: they are
       * answerable for the added test.
       */
      const order = await placeOrder(sp, LAB_REFLEX_ACTOR, decls, {
        kind: "lab",
        patientId: ctx.rawPatientId,
        encounterNo: ctx.encounterNo,
        serviceDate: ctx.serviceDate,
        orderGroupId: ctx.orderGroupId,
        priority: "routine",
        orderingClinicianId: actor.id,
        protocolRef: match.ruleId,
        placedAt: now,
        items: [{
          serviceId: match.addsServiceId,
          origin: "reflex",
          parentItemId: ctx.orderItemId,
          restricted: false,
        }],
      });
      const reflexItemId = order.itemIds[0]!;

      /**
       * THE MONEY, ON THIS TRANSACTION, AND ISSUED AS THE **VERIFIER** RATHER THAN AS THE SYSTEM.
       *
       * `issueInvoice` refuses a remainder without a `credit` block AND requires the ACTOR to hold
       * `billing.credit.extend` (17a §9.3 S1 / F2, which grants it to `pathologist`). A `system`
       * actor holds no permissions at all — `hasPermission` takes a `users.id` — so billing the
       * reflex as the placer would refuse every reflex in the system. The person answerable for the
       * charge is the person who signed the result that caused it.
       */
      const invoice = await issueInvoice(
        sp as unknown as Db,
        actor,
        {
          draftId: newId(),
          patientId: ctx.rawPatientId,
          encounterId: ctx.encounterId,
          lines: [{ lineId: newId(), serviceId: match.addsServiceId, qty: 1 }],
          credit: { reason: `reflex rule ${match.ruleId} (${match.because})` },
        },
        now,
      );
      const [billedLine] = await sp
        .select({ id: invoiceLines.id })
        .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.invoiceId));

      const { instanceId } = await startInstance(sp, LAB_ITEM_DEF_KEY, {
        type: "lab_item", id: reflexItemId, patientId: ctx.patientId, encounterId: ctx.encounterId,
      });
      await sp.insert(labItems).values({
        orderItemId: reflexItemId,
        instanceId,
        serviceId: match.addsServiceId,
        invoiceId: invoice.invoiceId,
        invoiceLineId: billedLine?.id ?? null,
        chargeReason: "lab_reflex",
        /** DD8 — a reflex inherits the consent that allowed it, so a reflex OF a reflex is legitimate. */
        reflexConsentedAt: now,
        priority: "routine",
        collectionSite: "opd",
        tatStartedAt: now,
      });

      /**
       * ═══ IT RIDES THE TUBE THAT IS ALREADY ON THE BENCH ═══
       *
       * The specimen has been received — that is what made the trigger result enterable — so the
       * reflex needs no second draw, and `lab_specimen_items_active_ux` makes this the item's one live
       * tube. The lab machine is walked to `accessioned` as the SYSTEM actor (which bypasses the role
       * check, 17a S4) because the physical acts it names have genuinely happened: the blood was drawn
       * and the tube was accessioned, for a test the hospital decided on afterwards.
       */
      await sp.insert(labSpecimenItems).values({
        specimenId: ctx.specimenId, orderItemId: reflexItemId, active: true,
      });
      for (const state of ["awaiting_collection", "collected", "accessioned"]) {
        await transition(sp, instanceId, state, LAB_REFLEX_ACTOR, { note: `reflex ${match.ruleId}` });
      }
      await advanceOrderItem(sp, LAB_REFLEX_ACTOR, decls, reflexItemId, "in_progress", { at: now });

      await appendEvent(sp, labReflexAdded.make({
        actor: LAB_REFLEX_ACTOR,
        patientId: ctx.patientId,
        encounterId: ctx.encounterId,
        correlationId: order.orderId,
        payload: {
          ruleId: match.ruleId, ruleVersion: match.ruleVersion, triggerResultId: result.id,
          parentItemId: ctx.orderItemId, orderId: order.orderId, orderNo: order.orderNo,
          addedServiceId: match.addsServiceId,
        },
      }));

      placed.push({
        ruleId: match.ruleId, ruleVersion: match.ruleVersion, orderId: order.orderId,
        orderNo: order.orderNo, orderItemId: reflexItemId, addedServiceId: match.addsServiceId,
        invoiceId: invoice.invoiceId,
      });
    });
    } catch (e) {
      /**
       * A refusal the LABORATORY cannot act on is recorded and carried. Anything that is not a
       * billing or tariff refusal is a genuine fault and is rethrown: a `WorkflowError` here means
       * the lab's own machine is wrong, and swallowing that would hide a defect behind a warning.
       */
      if (!(e instanceof BillingError) && !(e instanceof TariffError)) throw e;
      refused.push({
        ruleId: match.ruleId, addedServiceId: match.addsServiceId,
        code: e.code, reason: e.message,
      });
      /**
       * ═══ CLOSE REVIEW PASS 2, F6 — A REFUSAL NOBODY IS TOLD ABOUT IS NOT A CONTROL ═══
       *
       * The first version of this fix returned the refusal and nothing read it. Everything inside
       * the savepoint rolls back, so a TSH of 9.8 with reflex consent, on a deployment where the
       * reflexed test has no tariff row, signed cleanly and SILENTLY did not order it — with "how
       * often does a reflex fail to place" unanswerable. That is F20/F27's lesson in the one place
       * in this module that had not applied it.
       *
       * What this phase CAN do, it does: the refusal is returned in `VerifyResultOutcome` and the
       * verify screen shows it beside the signature. What it cannot do is append an event —
       * `LAB_EVENTS` is closed (T2's frozen file, §8) and none of its twenty-two names means "a
       * rule fired and could not be acted on"; emitting `lab.reflex_added` would be a lie about an
       * order that does not exist. **The durable record is owed and is recorded as §9.2 F44**, with
       * the runbook's pilot harvest counting it by hand until the phase that may edit `events.ts`
       * declares `lab.reflex_refused`.
       */
    }

  }
  return { placed, refused };
}

/* ──────────────── DD4 — the second projection point: `completed` at the last signature ──────────────── */

/**
 * ═══ EXACTLY WHEN THE LAST ANALYTE IS SIGNED, NEVER EARLIER (T6 A3) ═══
 *
 * A CBC has sixteen analytes and `completed` is what a ward screen, 22c-F's patient app and 26's
 * package progress all read as "the department has finished". Advancing on the FIRST signature —
 * the mutant — publishes a report with fifteen numbers missing, and every reader downstream
 * believes it.
 *
 * The count is over the ORDERABLE's analytes and the item's VERIFIED rows, so a rerun that left a
 * superseded unverified row behind cannot hold the item open for ever, and an analyte with no row
 * at all keeps it open, which is the correct direction.
 */
async function completeItemIfSigned(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  ctx: Awaited<ReturnType<typeof resultContext>>,
  now: Date,
): Promise<boolean> {
  /**
   * ═══ CLOSE REVIEW C4 — LOCK THE ORDER BEFORE COUNTING, AND THE CAS ABOVE IS NOT A SUBSTITUTE ═══
   *
   * The sibling count below is a plain READ and this repository runs READ COMMITTED. The verify CAS
   * locks THIS RESULT'S row and nothing else, so two pathologists signing the last two analytes of
   * one item each saw the OTHER analyte still unverified — the other transaction had not committed:
   *
   *     T1: CAS FT3→verified · count: FT3 verified(own), FT4 unverified → not all → return false
   *     T2: CAS FT4→verified · count: FT4 verified(own), FT3 unverified → not all → return false
   *     both COMMIT → every analyte signed, `advanceOrderItem(…'completed')` NEVER RUNS.
   *
   * The item then sits at `in_progress` with the lab instance at `resulted`, which is exactly the
   * pair `verifyWorklist` filters on — so it stays on the pathologist's queue for ever with every
   * value already signed and NO BUTTON THAT CAN CLEAR IT: a second verify throws `already_verified`,
   * and `publishReport` refuses "1 of 1 tests are not finished" permanently. There is no recovery
   * through any shipped route.
   *
   * **`kernel/orders/advance.ts` documents this identical defect one level up** — its own close
   * review C1 — and fixed it with a `FOR UPDATE`. The pattern is applied here.
   *
   * ═══ ON THE **ITEM**, NOT ON THE ORDER — CLOSE REVIEW PASS 2, F4 ═══
   *
   * The first version of this fix locked the ORDER and then called `advanceOrderItem`, which locks
   * the ITEM (its CAS) and then the order (`closeHeaderIfDone`). That is order → item → order,
   * against a module in which `cancelLabItem` and `sweepLabNonReturn` both go item → order through
   * the same function. Two of them on one order deadlock:
   *
   *     T1 verify:  locks ORDER O                         → waits for item A
   *     T2 cancel:  locks ITEM  A (advanceOrderItem's CAS) → waits for order O
   *     → 40P01, which no `LabError` maps, so it reaches a bench as a 500.
   *
   * The race this needs to serialise is two verifies of two RESULTS OF ONE ITEM, so the item is
   * both the right grain and the right lock: it contends with nothing on a sibling item, and the
   * direction stays item → order for every writer in the module.
   */
  await tx.execute(sql`select id from order_items where id = ${ctx.orderItemId} for update`);

  const analytes = await analytesFor(tx, ctx.serviceId);
  const signed = await tx
    .select({ analyteId: labResults.analyteId })
    .from(labResults)
    .where(and(
      eq(labResults.orderItemId, ctx.orderItemId),
      eq(labResults.verificationStatus, "verified"),
      inArray(labResults.analyteId, analytes.map((a) => a.id)),
    ));
  const have = new Set(signed.map((r) => r.analyteId));
  if (!analytes.every((a) => have.has(a.id))) return false;

  const [instance] = await tx
    .select({ currentState: workflowInstances.currentState })
    .from(workflowInstances).where(eq(workflowInstances.id, ctx.instanceId));
  if (instance?.currentState === "resulted") {
    await transition(tx, ctx.instanceId, "verified", actor);
  }
  /** The ENVELOPE, once, and the transitions row names the VERIFIER — never the system (T6 A3). */
  await advanceOrderItem(tx, actor, decls, ctx.orderItemId, "completed", { at: now });
  return true;
}
