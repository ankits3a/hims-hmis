import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { daycareEncounters, otCaseGates, otCases } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { startInstance, transition } from "../../kernel/workflow/instances";
import { loadPricingContext, priceInvoiceLines } from "../tariff";
import { getPatient } from "../patients";
import { PAYER_CLASS_VALUES, ANAESTHESIA_TYPE_VALUES } from "../../kernel/db/schema/ot";
import { activeDefinition, criteriaFor } from "./definitions";
import { requiredDeposit } from "./deposit";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { OtError } from "./errors";
import { caseCancelled, daycareBooked, payerClassChanged } from "./events";
import { DAYCARE_CASE_DEF_KEY, OT_GATE_DEF_KEY, POSTPONE_REASONS } from "./workflow-def";
import type { CriteriaEntry } from "./definitions";
import type { PayerClass } from "./deposit";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T3 — **BOOKING: the first place a case can be refused, and the last place it is cheap.**
 *
 * ═══ THE CONSULT DOES NOT ADVISE A PROCEDURE — THE BOOKING CAPTURES ONE (DD5 / F7) ═══
 *
 * The adversarial pass measured it: `opd_encounters.advice` is FREE TEXT and there is no structured
 * "procedure advised" branch anywhere in OPD. So this module captures the procedure itself and the
 * book screen deep-links from the consult; **OPD's schema is not touched by this phase.**
 * `opdEncounterId` is the back-reference to the advising consult and it is optional, because a
 * walk-in booked at the counter is a real case and refusing it would be inventing a rule.
 *
 * ═══ THREE REFUSALS AND ONE SOFT BLOCK, AND THE ORDER IS DELIBERATE ═══
 *
 *   1. **criteria** — is this procedure class in the ACTIVE whitelist at all? (A2)
 *   2. **privilege** — may THIS surgeon do it? (A3)
 *   3. **duplicate** — same patient, same date, same procedure? (A9, soft: `force` by `ot_incharge`)
 *
 * Criteria before privilege because "we do not do that operation here" is a different conversation
 * from "not with that surgeon", and a coordinator told the second when the first is true will go
 * looking for another surgeon. The duplicate check is LAST because it is the only one a human may
 * legitimately override, and running it first would make the two hard refusals reachable only after
 * somebody had already forced past a warning.
 *
 * ═══ THE QUOTE IS PINNED AT BOOKING (A5 / B10) ═══
 *
 * `quote_paise` and `tariff_version_id` are written together and never recomputed. A tariff revision
 * activated between booking and surgery does not move a quote the patient was given — and, more
 * sharply, does not move the DEPOSIT that was computed from it. Re-pricing at read is the mutant,
 * and it is the natural implementation: a reader that calls `loadPricingContext(now)` is simpler
 * than one that stores a number.
 */

export type BookCaseInput = {
  patientId: string;
  opdEncounterId?: string;
  procedureCode: string;
  procedureClass: string;
  laterality?: "left" | "right" | "bilateral";
  surgeonId: string;
  anaesthetistId?: string;
  anaesthesiaType?: (typeof ANAESTHESIA_TYPE_VALUES)[number];
  asaGrade?: number;
  listDate: string; // IST calendar date, YYYY-MM-DD
  payerClass: PayerClass;
  schemeRef?: string;
  implantEstimatePaise?: number;
  sanctionedPaise?: number;
  creditAvailablePaise?: number;
  entitlementPaise?: number;
  /** A9 — `ot_incharge` may force past the duplicate soft block. */
  force?: boolean;
  /** N13 — a same-day return to theatre reuses the encounter and takes no second deposit. */
  returnOfCaseId?: string;
  /** N8 — a bilateral second case on an encounter that already exists. */
  encounterId?: string;
};

export type BookCaseResult = {
  encounterId: string;
  encounterNo: string;
  caseId: string;
  workflowInstanceId: string;
  quotePaise: number;
  requiredDepositPaise: number;
  gateKinds: string[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The criteria entry for a class, or the A2 refusal. */
async function requireCriteria(exec: Db | Tx, procedureClass: string): Promise<CriteriaEntry> {
  const criteria = await activeDefinition(exec, "criteria");
  const entry = criteriaFor(criteria, procedureClass);
  if (!entry) {
    throw new OtError(
      "criteria_refused",
      `"${procedureClass}" is not in the ACTIVE day-care criteria whitelist`,
      { procedureClass, allowed: criteria.entries.map((e) => e.procedureClass) },
    );
  }
  return entry;
}

/** R-3.15 / A3 — outside the ACTIVE privilege list, booking is REFUSED, never warned. */
async function assertPrivileged(tx: Tx, surgeonId: string, procedureClass: string): Promise<void> {
  const privileges = await activeDefinition(tx, "privileges");
  const surgeon = privileges.surgeons.find((s) => s.surgeonId === surgeonId);
  /**
   * BOTH legs are refusals and they are separate on purpose. A surgeon with NO entry is not
   * credentialed for day-care at all; a surgeon with an entry that omits this class is credentialed
   * for something else. The mutant A3 names collapses them — it treats "has ANY privilege" as
   * privileged, which is the shape a hurried implementation takes and which credentials every
   * surgeon for every procedure the moment they are credentialed for one.
   */
  if (!surgeon || !surgeon.procedureClasses.includes(procedureClass as CriteriaEntry["procedureClass"])) {
    throw new OtError(
      "privilege_refused",
      `surgeon ${surgeonId} is not privileged for "${procedureClass}"`,
      { surgeonId, procedureClass, holds: surgeon?.procedureClasses ?? [] },
    );
  }
}

/** A9 — (patient, list date, procedure class) already booked and not terminal. */
async function assertNotDuplicate(
  tx: Tx, input: { patientId: string; listDate: string; procedureClass: string },
): Promise<void> {
  const rows = (await tx.execute(sql`
    select c.id from ot_cases c
      join workflow_instances w on w.id = c.workflow_instance_id
     where c.patient_id = ${input.patientId}
       and c.list_date = ${input.listDate}
       and c.procedure_class = ${input.procedureClass}
       and w.status = 'active'
     limit 1
  `)).rows as { id: string }[];
  if (rows.length > 0) {
    throw new OtError(
      "duplicate_booking",
      `this patient already has a live "${input.procedureClass}" case on ${input.listDate} (case ${rows[0]!.id}) — an ot_incharge may force it`,
      { existingCaseId: rows[0]!.id },
    );
  }
}

/**
 * The package quote, PINNED. `loadPricingContext` runs outside any lock and the engine is pure, so
 * this holds no connection — the `priceDraftWithBenefits` shape.
 */
async function quoteFor(
  db: Db, packageServiceCode: string, at: Date,
): Promise<{ quotePaise: number; tariffVersionId: string }> {
  const ctx = await loadPricingContext(db, { at, tags: [] });
  const service = Object.values(ctx.services).find((s) => s.code === packageServiceCode);
  if (!service) {
    throw new OtError(
      "criteria_refused",
      `the criteria name package service "${packageServiceCode}", which the tariff does not carry — the go-live runbook creates one per class (DD6/F8)`,
      { packageServiceCode },
    );
  }
  const [line] = priceInvoiceLines(ctx, [{ lineId: "package", serviceId: service.id, qty: 1 }]);
  return { quotePaise: line!.netPaise, tariffVersionId: ctx.tariff.versionId };
}

/**
 * A4 — ONE gate instance per kind the class's `requiredGates` names, and NOT ONE MORE.
 *
 * The mutant creates every kind for every case, and its harm is not noise: a non-lateral D&C with a
 * `site_marking` gate can never reach `ready`, because there is no laterality for the triple
 * equality to compare. A case blocked for ever by a gate that should not exist is indistinguishable,
 * from the coordinator's chair, from a system that is simply broken.
 */
async function createGates(
  tx: Tx, caseId: string, patientId: string, encounterId: string, entry: CriteriaEntry,
): Promise<string[]> {
  for (const kind of entry.requiredGates) {
    const { instanceId } = await startInstance(tx, OT_GATE_DEF_KEY, {
      type: "ot_gate", id: `${caseId}:${kind}`, patientId, encounterId,
    });
    await tx.insert(otCaseGates).values({
      id: newId(), caseId, kind, workflowInstanceId: instanceId,
      waivable: entry.waivableGates.includes(kind),
    });
  }
  return [...entry.requiredGates];
}

export async function bookCase(
  db: Db, actor: Actor, input: BookCaseInput, now: Date = new Date(),
): Promise<BookCaseResult> {
  if (!DATE_RE.test(input.listDate)) {
    throw new OtError("criteria_refused", `listDate must be an IST calendar date (YYYY-MM-DD), got "${input.listDate}"`);
  }
  const patient = await getPatient(db, actor, input.patientId);
  if (!patient) throw new OtError("unknown_case", `unknown patient ${input.patientId}`);

  /**
   * Everything that reads the TARIFF happens before the transaction (§14.5): `loadPricingContext`
   * takes `Db`, not `Tx`, and pricing must not hold a connection while it runs. The criteria are
   * read here to find the package service — and read AGAIN inside the transaction, which is not
   * redundancy: between these two lines an MS may publish a new whitelist, and the entry the case is
   * WRITTEN against must be the one that was active when the row was inserted.
   */
  const preQuote = await requireCriteria(db, input.procedureClass);
  const quote = await quoteFor(db, preQuote.packageServiceCode, now);

  return db.transaction(async (tx) => {
    const entry = await requireCriteria(tx, input.procedureClass);
    if (entry.packageServiceCode !== preQuote.packageServiceCode) {
      throw new OtError(
        "definition_not_active",
        `the criteria definition changed while this booking was being priced (package ${preQuote.packageServiceCode} -> ${entry.packageServiceCode}) — re-quote`,
      );
    }
    await assertPrivileged(tx, input.surgeonId, input.procedureClass);
    if (input.force === true) {
      /**
       * ═══ CLOSE REVIEW (MINOR 10) — `force` IS THE IN-CHARGE'S CALL, WHICH IS WHAT A9 SAYS ═══
       *
       * The plan reads "unless `force` by `ot_incharge`", and the boolean was taken straight from
       * the request body — so any holder of `ot.cases.book`, which includes every day-care
       * coordinator, could clear the duplicate soft-block. The block exists because a patient
       * booked twice for one day is nearly always a mistake and occasionally a real second
       * procedure; deciding which is a supervisory judgement, and it is the one the plan assigns.
       */
      if (actor.type !== "user" || !(await actorHoldsAnyRole(tx, actor.id, ["ot_incharge"]))) {
        throw new OtError(
          "duplicate_booking",
          "clearing the duplicate-booking block is the OT in-charge's call (A9) — book without `force`, or ask them",
          { patientId: input.patientId, listDate: input.listDate },
        );
      }
    } else {
      await assertNotDuplicate(tx, {
        patientId: input.patientId, listDate: input.listDate, procedureClass: input.procedureClass,
      });
    }

    const policy = await activeDefinition(tx, "deposit_policy");
    const implantEstimate = input.implantEstimatePaise ?? 0;
    const depositPaise = requiredDeposit(policy, {
      payerClass: input.payerClass,
      quotePaise: quote.quotePaise,
      implantEstimatePaise: implantEstimate,
      sanctionedPaise: input.sanctionedPaise,
      creditAvailablePaise: input.creditAvailablePaise,
      entitlementPaise: input.entitlementPaise,
    });

    // N8 / N13 — a bilateral second case and a same-day return to theatre ride the SAME encounter,
    // which is what makes `consumptionsFor(encounterId)` span them and what stops a second deposit.
    let encounterId = input.encounterId ?? null;
    let encounterNo: string;
    if (encounterId === null) {
      encounterId = newId();
      encounterNo = await nextEpisodeNo(tx, "daycare", input.listDate);
      await tx.insert(daycareEncounters).values({
        id: encounterId, encounterNo, patientId: input.patientId,
        opdEncounterId: input.opdEncounterId ?? null, payerClass: input.payerClass,
        schemeRef: input.schemeRef ?? null, createdBy: actor.id, updatedBy: actor.id,
      });
    } else {
      const rows = await tx.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId));
      const existing = rows[0];
      if (!existing) throw new OtError("unknown_case", `unknown day-care encounter ${encounterId}`);
      if (existing.patientId !== input.patientId) {
        throw new OtError("unknown_case", `encounter ${encounterId} belongs to a different patient`);
      }
      encounterNo = existing.encounterNo;
    }

    const theatre = await theatreId(tx);
    const seqRows = (await tx.execute(sql`
      select coalesce(max(seq), 0) + 1 as "next" from ot_cases
       where list_date = ${input.listDate} and theatre_resource_id = ${theatre}
    `)).rows as { next: number }[];

    const caseId = newId();
    const { instanceId } = await startInstance(tx, DAYCARE_CASE_DEF_KEY, {
      type: "ot_case", id: caseId, patientId: input.patientId, encounterId,
    });
    await tx.insert(otCases).values({
      id: caseId, encounterId, patientId: input.patientId,
      theatreResourceId: theatre,
      listDate: input.listDate, seq: Number(seqRows[0]!.next),
      procedureCode: input.procedureCode, procedureClass: input.procedureClass,
      laterality: input.laterality ?? null,
      surgeonId: input.surgeonId, anaesthetistId: input.anaesthetistId ?? null,
      anaesthesiaType: input.anaesthesiaType ?? null, asaGrade: input.asaGrade ?? null,
      packageServiceCode: entry.packageServiceCode,
      quotePaise: quote.quotePaise, tariffVersionId: quote.tariffVersionId,
      payerClass: input.payerClass, workflowInstanceId: instanceId,
      returnOfCaseId: input.returnOfCaseId ?? null,
      createdBy: actor.id, updatedBy: actor.id,
    });

    const gateKinds = await createGates(tx, caseId, input.patientId, encounterId, entry);

    await appendEvent(tx, daycareBooked.make({
      actor, patientId: input.patientId, encounterId,
      payload: {
        encounterId, encounterNo, caseId, patientId: input.patientId,
        procedureClass: input.procedureClass, listDate: input.listDate,
        payerClass: input.payerClass, quotePaise: quote.quotePaise,
        requiredDepositPaise: depositPaise,
      },
    }));

    return {
      encounterId, encounterNo, caseId, workflowInstanceId: instanceId,
      quotePaise: quote.quotePaise, requiredDepositPaise: depositPaise, gateKinds,
    };
  });
}

/**
 * The unit's ONE theatre (DD3). Resolved by code rather than passed in, because a booking screen
 * that could choose a theatre would be a screen that could choose the wrong one — and there is
 * exactly one. When 15d or the major suite adds a second, this becomes an input and the seed's
 * `OT_THEATRE_CODE` stops being the answer.
 */
async function theatreId(tx: Tx): Promise<string> {
  const rows = (await tx.execute(sql`
    select id from resources where kind = 'theatre' and status <> 'retired' order by code limit 1
  `)).rows as { id: string }[];
  const found = rows[0];
  if (!found) {
    throw new OtError("criteria_refused", "no theatre resource exists — `seed:ot` creates OT-1 (DD3)");
  }
  return found.id;
}

/** R-3.12 — every cancellation carries its reason AND its attribution class, from day one. */
export async function cancelCase(
  db: Db, actor: Actor,
  input: { caseId: string; reason: string; attribution: "patient" | "hospital" | "surgeon" | "payer" | "clinical" },
): Promise<{ state: string }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(otCases).where(eq(otCases.id, input.caseId));
    const kase = rows[0];
    if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);
    const before = await currentState(tx, kase.workflowInstanceId);
    const { state } = await transition(tx, kase.workflowInstanceId, "cancelled", actor, { note: input.reason });
    await tx.update(otCases).set({
      cancellationReason: input.reason, cancellationAttribution: input.attribution,
      updatedBy: actor.id, updatedAt: new Date(),
    }).where(eq(otCases.id, input.caseId));
    await appendEvent(tx, caseCancelled.make({
      actor, patientId: kase.patientId, encounterId: kase.encounterId,
      payload: {
        caseId: kase.id, encounterId: kase.encounterId, reason: input.reason,
        attribution: input.attribution, atState: before,
      },
    }));
    return { state };
  });
}

/** Postpones a case with one of the declared reasons, and returns it to `booked` with a new date. */
export async function postponeCase(
  db: Db, actor: Actor,
  input: { caseId: string; reason: (typeof POSTPONE_REASONS)[number]; newListDate: string },
): Promise<{ state: string }> {
  if (!DATE_RE.test(input.newListDate)) {
    throw new OtError("criteria_refused", `newListDate must be an IST calendar date, got "${input.newListDate}"`);
  }
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(otCases).where(eq(otCases.id, input.caseId));
    const kase = rows[0];
    if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);
    await transition(tx, kase.workflowInstanceId, "postponed", actor, { note: input.reason });
    const { state } = await transition(tx, kase.workflowInstanceId, "booked", actor, { note: `re-listed ${input.newListDate}` });
    await tx.update(otCases).set({
      listDate: input.newListDate, updatedBy: actor.id, updatedAt: new Date(),
    }).where(eq(otCases.id, input.caseId));
    // §3A / D5 — the deposit STAYS. A postponed case is the same case with a later date, and
    // `releaseHolds` is deliberately NOT called here.
    return { state };
  });
}

/**
 * DD12's last row — a payer class change recomputes the required deposit and evidences BOTH classes.
 * The gate is only ever evaluated pre-wheel-in, so a post-op change surfaces as balance rather than
 * as a retroactive gate failure (§3A).
 */
export async function changePayerClass(
  db: Db, actor: Actor,
  input: { encounterId: string; to: PayerClass; reason: string; sanctionedPaise?: number; creditAvailablePaise?: number; entitlementPaise?: number },
): Promise<{ from: string; to: string; requiredDepositPaise: number }> {
  if (!(PAYER_CLASS_VALUES as readonly string[]).includes(input.to)) {
    throw new OtError("criteria_refused", `"${input.to}" is not a payer class`);
  }
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(daycareEncounters).where(eq(daycareEncounters.id, input.encounterId));
    const encounter = rows[0];
    if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);
    const from = encounter.payerClass;

    const cases = await tx.select().from(otCases).where(eq(otCases.encounterId, input.encounterId));
    // N8 — `required` is the sum over every case on the encounter (§3A's two-cases-one-encounter row).
    const quotePaise = cases.reduce((sum, c) => sum + c.quotePaise, 0);
    const policy = await activeDefinition(tx, "deposit_policy");
    const depositPaise = requiredDeposit(policy, {
      payerClass: input.to, quotePaise, implantEstimatePaise: 0,
      sanctionedPaise: input.sanctionedPaise,
      creditAvailablePaise: input.creditAvailablePaise,
      entitlementPaise: input.entitlementPaise,
    });

    const changedAt = new Date();
    await tx.update(daycareEncounters)
      .set({ payerClass: input.to, updatedBy: actor.id, updatedAt: changedAt })
      .where(eq(daycareEncounters.id, input.encounterId));
    /**
     * CLOSE REVIEW M1 — and the case snapshot with it, in the SAME transaction. The deposit gate
     * reads the encounter now, so this no longer decides anything; it is here because a row that
     * says `govt_scheme` next to an encounter that says `self_pay` is a lie a reader will believe,
     * and the list DTO and every future report select from `ot_cases`.
     */
    await tx.update(otCases)
      .set({ payerClass: input.to, updatedBy: actor.id, updatedAt: changedAt })
      .where(eq(otCases.encounterId, input.encounterId));

    await appendEvent(tx, payerClassChanged.make({
      actor, patientId: encounter.patientId, encounterId: input.encounterId,
      payload: { encounterId: input.encounterId, from, to: input.to, reason: input.reason, requiredDepositPaise: depositPaise },
    }));
    return { from, to: input.to, requiredDepositPaise: depositPaise };
  });
}

/** The case's state, read from its pinned instance — never mirrored on `ot_cases` (DD4). */
export async function currentState(exec: Db | Tx, workflowInstanceId: string): Promise<string> {
  const rows = (await exec.execute(sql`
    select current_state as "state" from workflow_instances where id = ${workflowInstanceId}
  `)).rows as { state: string }[];
  const found = rows[0];
  if (!found) throw new OtError("unknown_case", `unknown workflow instance ${workflowInstanceId}`);
  return found.state;
}

/** The state of one case, by case id. The read every screen and every guard in T4–T7 uses. */
export async function caseState(exec: Db | Tx, caseId: string): Promise<string> {
  const rows = (await exec.execute(sql`
    select w.current_state as "state" from ot_cases c
      join workflow_instances w on w.id = c.workflow_instance_id
     where c.id = ${caseId}
  `)).rows as { state: string }[];
  const found = rows[0];
  if (!found) throw new OtError("unknown_case", `unknown case ${caseId}`);
  return found.state;
}
