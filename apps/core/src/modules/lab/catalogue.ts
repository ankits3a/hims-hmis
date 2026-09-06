import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  labAnalytes, labOrderableAnalytes, labOrderables, labReferenceRanges, labReflexRules,
} from "../../kernel/db/schema";
import { assertFormulaParses } from "./formula";
import { isFutureIstDay } from "./ranges";
import { LabError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17a T3 / DD1 — THE CATALOGUE: what a lab can be asked for, and what it measures.
 *
 * ═══ THE TWO LEVELS, AND WHY THE ORDERABLE HAS NO IDENTITY OF ITS OWN ═══
 *
 * An ORDERABLE is what a doctor ticks and a counter bills; an ANALYTE is what a bench measures and
 * a report prints. `lab_orderables` is keyed by `service_id` — the `services` row IS the orderable's
 * identity — because one orderable is one tariff line is one `order_items` row, and giving it a
 * second id would create a mapping nobody reconciles and a class of bug where the two disagree
 * about which test was billed (§2.54, applied before the drift rather than after).
 *
 * ═══ THE VERSION IS BUMPED, AND RESULTS KEEP THE UNIT THEY WERE ENTERED WITH (E41) ═══
 *
 * A curator who changes an analyte's unit from mg/dL to mmol/L has not changed last week's results:
 * those rows carry their own `unit` and their own snapshotted range. The `version` on the orderable
 * and the analyte is what lets a reader tell that the catalogue moved under a historical report —
 * it is not an optimistic-locking token and nothing compares it on write.
 */

/** Every permission this file gates on. Declared by the manifest; granted to `pathologist` (DD16). */
const MANAGE = "lab.catalogue.manage";

async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  /**
   * A `user` ACTOR ONLY, and the refusal is by TYPE before it is by permission — `hasPermission`
   * takes a `users.id`, and handing it a system or patient id returns false, which would report
   * "this user does not hold the permission" about something that is not a user (22c-A review D11's
   * aliasing argument, one door over).
   */
  /**
   * ═══ `permission_denied`, NOT `catalogue_invalid` — 17b T6 repairing 17a §9.2 F28 ═══
   *
   * These two refusals were `catalogue_invalid` (422) because the union carried no authorization
   * code when T3 was written and its header forbids a task widening it. 17b's §0 instructs the
   * repair; the code exists now. A curator who lacks the grant was being told their catalogue entry
   * was malformed, which sends them to fix a payload that was never the problem.
   */
  if (actor.type !== "user") {
    throw new LabError("permission_denied", `a ${actor.type} actor may not curate the catalogue`);
  }
  if (!(await hasPermission(exec as Db, actor.id, MANAGE, "hospital"))) {
    throw new LabError("permission_denied", `curating the catalogue requires ${MANAGE}`);
  }
}

export type OrderableInput = {
  serviceId: string;
  code: string;
  nameEn: string;
  nameHi?: string | null;
  discipline: string;
  specimenType: string;
  container: string;
  minVolumeMl?: string | null;
  benchKey?: string | null;
  tatMinutesRoutine: number;
  tatMinutesStat?: number | null;
  requiresFasting?: boolean;
  consentRequired?: boolean;
  sensitive?: boolean;
  notifiable?: boolean;
  /** E33 / 02 E6 — PCPNDT. Accepted in the input ONLY so it can be refused by name. */
  reportsFoetalSex?: boolean;
  active?: boolean;
  /** Report order: the analyte codes this orderable expands into, in the order they print. */
  analyteCodes: readonly string[];
};

export type AnalyteInput = {
  code: string;
  nameEn: string;
  nameHi?: string | null;
  resultType: "numeric" | "text" | "coded" | "formula";
  unit?: string | null;
  decimals?: number;
  formula?: string | null;
  formulaGuard?: string | null;
  absurdLow?: string | null;
  absurdHigh?: string | null;
  criticalLow?: string | null;
  criticalHigh?: string | null;
  deltaAbs?: string | null;
  deltaPct?: string | null;
  deltaWindowHours?: number | null;
  loincCode?: string | null;
  /**
   * 17d T1 / D1 — who this analyte is FOR, which the range book cannot say (an absent sex row is a
   * gap in curation, not a claim). All three optional and NULL by default: an undeclared analyte
   * applies to everybody, which is every analyte the catalogue carried before this phase.
   */
  appliesToSex?: "male" | "female" | null;
  appliesMinAgeDays?: number | null;
  appliesMaxAgeDays?: number | null;
};

/**
 * ═══ E33 / 02 E6 — THE PCPNDT REFUSAL, AND IT IS THE FIRST THING THIS FILE DOES ═══
 *
 * The Pre-Conception and Pre-Natal Diagnostic Techniques Act makes communicating the sex of a
 * foetus a criminal offence. T1 put a CHECK on the column so a direct INSERT cannot do it either;
 * this refusal exists so the message names the LAW rather than a constraint, at the moment a
 * curator typed it. **It is a refusal and not a validation warning**: there is no workflow in which
 * the right answer is "yes, but".
 */
export async function upsertAnalyte(exec: Db | Tx, actor: Actor, input: AnalyteInput): Promise<string> {
  await assertMayManage(exec, actor);

  if (input.resultType === "formula") {
    if (input.formula === null || input.formula === undefined) {
      throw new LabError("catalogue_invalid", `analyte ${input.code}: a formula analyte needs a formula`);
    }
    // Parsed at UPSERT — the only moment a bad formula is cheap to refuse (see `formula.ts`).
    assertFormulaParses(input.formula, input.formulaGuard ?? null);
  } else if (input.formula !== null && input.formula !== undefined) {
    throw new LabError("catalogue_invalid", `analyte ${input.code}: only a formula analyte may carry a formula`);
  }
  if (input.absurdLow !== null && input.absurdLow !== undefined
      && input.absurdHigh !== null && input.absurdHigh !== undefined
      && Number(input.absurdLow) > Number(input.absurdHigh)) {
    throw new LabError("catalogue_invalid", `analyte ${input.code}: the absurd envelope is inverted`);
  }
  /**
   * 17d T1 — refused HERE as well as by `lab_analytes_applies_age_ck`, and for the reason the
   * inverted envelope above is: a curator at a screen gets a sentence naming their analyte, and the
   * table constraint is the backstop for everything that never passes through this function.
   */
  if (input.appliesMinAgeDays !== null && input.appliesMinAgeDays !== undefined
      && input.appliesMaxAgeDays !== null && input.appliesMaxAgeDays !== undefined
      && input.appliesMinAgeDays >= input.appliesMaxAgeDays) {
    throw new LabError("catalogue_invalid", `analyte ${input.code}: the applicable age band is inverted`);
  }

  const existing = (await (exec as Db).select({ id: labAnalytes.id })
    .from(labAnalytes).where(eq(labAnalytes.code, input.code)))[0];
  const row = {
    code: input.code, loincCode: input.loincCode ?? null, nameEn: input.nameEn, nameHi: input.nameHi ?? null,
    resultType: input.resultType, unit: input.unit ?? null, decimals: input.decimals ?? 1,
    formula: input.formula ?? null, formulaGuard: input.formulaGuard ?? null,
    absurdLow: input.absurdLow ?? null, absurdHigh: input.absurdHigh ?? null,
    criticalLow: input.criticalLow ?? null, criticalHigh: input.criticalHigh ?? null,
    deltaAbs: input.deltaAbs ?? null, deltaPct: input.deltaPct ?? null,
    deltaWindowHours: input.deltaWindowHours ?? null,
    appliesToSex: input.appliesToSex ?? null,
    appliesMinAgeDays: input.appliesMinAgeDays ?? null,
    appliesMaxAgeDays: input.appliesMaxAgeDays ?? null,
    updatedBy: actor.id, updatedAt: new Date(),
  };
  if (existing) {
    await (exec as Db).update(labAnalytes).set(row).where(eq(labAnalytes.id, existing.id));
    return existing.id;
  }
  const id = newId();
  await (exec as Db).insert(labAnalytes).values({ ...row, id, createdBy: actor.id });
  return id;
}

export async function upsertOrderable(exec: Db | Tx, actor: Actor, input: OrderableInput): Promise<void> {
  await assertMayManage(exec, actor);

  /**
   * THE FOETAL-SEX REFUSAL. It is checked before anything is written and it names the Act, because
   * the person reading the error is a curator who needs to know this is not a configuration
   * question. T1's `lab_orderables_no_foetal_sex_ck` refuses it at the table as well; two controls
   * on one risk, deliberately (E33).
   */
  if (input.reportsFoetalSex === true) {
    throw new LabError(
      "foetal_sex_refused",
      `orderable ${input.code}: an investigation that reports foetal sex cannot be catalogued — ` +
        "PCPNDT Act 1994. This is not a configuration option",
    );
  }
  if (input.tatMinutesRoutine <= 0) {
    throw new LabError("catalogue_invalid", `orderable ${input.code}: a test with no turnaround has no SLA`);
  }
  if (input.analyteCodes.length === 0) {
    throw new LabError("catalogue_invalid", `orderable ${input.code}: an orderable with no analytes measures nothing`);
  }

  const analytes = await (exec as Db).select({ id: labAnalytes.id, code: labAnalytes.code })
    .from(labAnalytes).where(inArray(labAnalytes.code, [...input.analyteCodes]));
  const byCode = new Map(analytes.map((a) => [a.code, a.id] as const));
  const missing = input.analyteCodes.filter((c) => !byCode.has(c));
  if (missing.length > 0) {
    // NAMED, not counted: a curator seeing "3 analytes missing" has to find which three.
    throw new LabError("unknown_analyte", `orderable ${input.code}: unknown analytes ${missing.join(", ")}`);
  }

  const existing = (await (exec as Db).select({ version: labOrderables.version })
    .from(labOrderables).where(eq(labOrderables.serviceId, input.serviceId)))[0];
  const row = {
    serviceId: input.serviceId, code: input.code, nameEn: input.nameEn, nameHi: input.nameHi ?? null,
    discipline: input.discipline, specimenType: input.specimenType, container: input.container,
    minVolumeMl: input.minVolumeMl ?? null, benchKey: input.benchKey ?? null,
    tatMinutesRoutine: input.tatMinutesRoutine, tatMinutesStat: input.tatMinutesStat ?? null,
    requiresFasting: input.requiresFasting ?? false, consentRequired: input.consentRequired ?? false,
    sensitive: input.sensitive ?? false, notifiable: input.notifiable ?? false,
    reportsFoetalSex: false, active: input.active ?? true,
    updatedBy: actor.id, updatedAt: new Date(),
  };
  if (existing) {
    // E41 — the version bump is what tells a later reader the catalogue moved under a historical
    // report. Results keep their own unit and their own snapshotted range regardless.
    await (exec as Db).update(labOrderables)
      .set({ ...row, version: existing.version + 1 }).where(eq(labOrderables.serviceId, input.serviceId));
    await (exec as Db).delete(labOrderableAnalytes)
      .where(eq(labOrderableAnalytes.serviceId, input.serviceId));
  } else {
    await (exec as Db).insert(labOrderables).values({ ...row, version: 1, createdBy: actor.id });
  }
  await (exec as Db).insert(labOrderableAnalytes).values(
    input.analyteCodes.map((code, i) => ({ serviceId: input.serviceId, analyteId: byCode.get(code)!, position: i + 1 })),
  );
}

/** The analytes an orderable expands into, IN REPORT ORDER — what a report reads down. */
export async function analytesFor(exec: Db | Tx, serviceId: string): Promise<(typeof labAnalytes.$inferSelect)[]> {
  const rows = await (exec as Db)
    .select({ analyte: labAnalytes, position: labOrderableAnalytes.position })
    .from(labOrderableAnalytes)
    .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
    .where(eq(labOrderableAnalytes.serviceId, serviceId))
    .orderBy(labOrderableAnalytes.position);
  return rows.map((r) => r.analyte);
}

/**
 * EVERY orderable in the catalogue — PHASE 11i T2.
 *
 * The census has to ask two questions the desk never asks: "is the catalogue empty?" and "is every
 * orderable priced in the active tariff version?". Both are questions about the WHOLE catalogue,
 * and `getOrderable` answers only about one service. This is the module's own read, so a caller
 * outside the module still goes through the seam rather than selecting from `lab_orderables` —
 * `kernel/ops/validate.ts:20`'s rule: a check that builds its own view eventually validates
 * something the engine will never see.
 */
export async function listOrderables(exec: Db | Tx): Promise<(typeof labOrderables.$inferSelect)[]> {
  return (exec as Db).select().from(labOrderables).orderBy(labOrderables.code);
}

/** One orderable, or `unknown_orderable`. The desk's lookup, and the refusal 17b's entry reuses. */
export async function getOrderable(
  exec: Db | Tx,
  serviceId: string,
): Promise<typeof labOrderables.$inferSelect> {
  const row = (await (exec as Db).select().from(labOrderables)
    .where(eq(labOrderables.serviceId, serviceId)))[0];
  if (!row) throw new LabError("unknown_orderable", `no lab orderable for service ${serviceId}`);
  return row;
}

/**
 * This analyte's range rows, for `resolveRange`. Loaded once per analyte and passed in (purity).
 *
 * ═══ ORDERED, AND THAT IS A CORRECTNESS PROPERTY RATHER THAN A TIDINESS ONE ═══
 *
 * `pickBySex` takes the FIRST row matching the patient's sex (`ranges.ts:83`, `rows.find(...)`), and
 * this select had no `ORDER BY`. Two bands overlapping for one (sex, age window) would therefore
 * decide which reference interval a report is flagged against **by the order Postgres happened to
 * return rows in** — the same shape that had `attachMachineValue` attaching a machine value to an
 * arbitrary order item, one table over in this same phase.
 *
 * `putReferenceRange` now refuses to create such an overlap, so this ordering should never be what
 * decides anything. It is here for the book that was loaded before that door existed: **an
 * unordered query is a decision nobody made**, and two reads of identical data must not resolve
 * differently. Narrowest-starting band first, sex breaking the tie, id last so the order is total.
 */
export async function rangesFor(
  exec: Db | Tx,
  analyteId: string,
): Promise<(typeof labReferenceRanges.$inferSelect)[]> {
  return (exec as Db).select().from(labReferenceRanges)
    .where(eq(labReferenceRanges.analyteId, analyteId))
    .orderBy(labReferenceRanges.ageMinDays, labReferenceRanges.sex, labReferenceRanges.id);
}

/**
 * ═══ THE RANGE BOOK'S DOOR — AND THE GUARD THAT STOPS THE DOOR BEING THE DEFECT ═══
 *
 * `lab_reference_ranges` had exactly two writes in the tree, both in `seed-lab-catalogue.ts` — a
 * `delete` of every row and an `insert` — and that script refuses production by design. So a
 * hospital loading its own catalogue through `POST /lab/catalogue/analytes` and `/orderables` got
 * analytes and orderables and **no reference bands**: every flag inert, `standup:check`'s
 * `lab_range_sources_present` red for ever, and a printed report with no biological reference
 * interval, which is not a report an NABL laboratory may issue.
 *
 * **Two latent defects become reachable the moment this function exists, so both are refused here
 * rather than in a follow-up.** They are unreachable today only because the sole writer is a curated
 * fixture — measured: 124 rows, zero overlaps, every `effective_from` the same past date.
 *
 *  1. **OVERLAP.** See `rangesFor` above. Refused per SEX VALUE, not across them: `pickBySex` prefers
 *     an exact sex and falls back to `any`, so a general adult band beside a narrower one for women
 *     is the DESIGN. A refusal that compared age windows without comparing the sex would make the
 *     book unable to express the most ordinary thing in it, and the curator would discover the rule
 *     by having their real range book rejected.
 *
 *  2. **A FUTURE `effective_from`.** The column is `notNull()` and **nothing reads it** — not
 *     `ranges.ts`, not `resolveRange`, not this file — and there is no `effective_to`, so the book
 *     has no versioning at all. A band dated next year would take effect the instant it was written.
 *     Giving the column a reader is range-book VERSIONING: it changes how every historical result
 *     resolves and it is its own phase. **Until then the honest act is to refuse a date the code
 *     will silently ignore**, rather than accept it and appear to have honoured it.
 *
 * The high bound is EXCLUSIVE, matching `resolveRange`'s own age filter (`ageDays >= min && ageDays
 * < max`) — so two bands that merely touch at 6570 days are adjacent and not overlapping. A refusal
 * that used a closed interval here would contradict the resolver and reject a correctly built book.
 */
export type ReferenceRangeInput = {
  analyteId: string;
  sex: "male" | "female" | "other" | "any";
  ageMinDays: number;
  ageMaxDays: number;
  low?: string | null;
  high?: string | null;
  text?: string | null;
  criticalLow?: string | null;
  criticalHigh?: string | null;
  /** NABL asks where a range came from: the kit insert, the textbook, the local study. */
  source: string;
  effectiveFrom: string;
};

export async function putReferenceRange(
  exec: Db | Tx,
  actor: Actor,
  input: ReferenceRangeInput,
  now: Date = new Date(),
): Promise<string> {
  await assertMayManage(exec, actor);

  const [analyte] = await (exec as Db).select({ code: labAnalytes.code })
    .from(labAnalytes).where(eq(labAnalytes.id, input.analyteId));
  if (!analyte) {
    throw new LabError("unknown_analyte", `no lab analyte ${input.analyteId}`);
  }

  /**
   * Refused HERE as well as by `lab_reference_ranges_age_ck` and `..._value_ck`, which is
   * `upsertAnalyte`'s own argument two functions up: the table is the backstop for everything that
   * never passes through this function, and the sentence is for the curator at a screen.
   */
  if (input.ageMinDays >= input.ageMaxDays) {
    throw new LabError(
      "catalogue_invalid",
      `${analyte.code}: the age band ${input.ageMinDays}..${input.ageMaxDays} days is inverted or empty`,
    );
  }
  if ((input.low ?? null) === null && (input.high ?? null) === null && (input.text ?? null) === null) {
    throw new LabError(
      "catalogue_invalid",
      `${analyte.code}: a range that carries neither a number nor text says nothing at all`,
    );
  }
  if (input.source.trim() === "") {
    throw new LabError("catalogue_invalid", `${analyte.code}: a reference range names its source`);
  }
  if (isFutureIstDay(input.effectiveFrom, now)) {
    throw new LabError(
      "catalogue_invalid",
      `${analyte.code}: a range effective ${input.effectiveFrom} is in the future, and nothing in ` +
        "this build reads `effective_from` — it would take effect immediately, so it is refused " +
        "rather than accepted and silently ignored",
    );
  }

  const siblings = await (exec as Db).select().from(labReferenceRanges)
    .where(and(
      eq(labReferenceRanges.analyteId, input.analyteId),
      eq(labReferenceRanges.sex, input.sex),
    ));
  const clash = siblings.find(
    (r) => input.ageMinDays < r.ageMaxDays && r.ageMinDays < input.ageMaxDays,
  );
  if (clash) {
    throw new LabError(
      "range_overlap",
      `${analyte.code}: ${input.sex} ${input.ageMinDays}..${input.ageMaxDays} days overlaps the ` +
        `existing band ${clash.ageMinDays}..${clash.ageMaxDays} — two bands over one age would make ` +
        "the interval a report is flagged against depend on row order",
      { existingRangeId: clash.id },
    );
  }

  const id = newId();
  await (exec as Db).insert(labReferenceRanges).values({
    id,
    analyteId: input.analyteId,
    sex: input.sex,
    ageMinDays: input.ageMinDays,
    ageMaxDays: input.ageMaxDays,
    low: input.low ?? null,
    high: input.high ?? null,
    text: input.text ?? null,
    criticalLow: input.criticalLow ?? null,
    criticalHigh: input.criticalHigh ?? null,
    source: input.source.trim(),
    effectiveFrom: input.effectiveFrom,
    createdBy: actor.id,
    createdAt: now,
  });
  return id;
}


/** The ACTIVE reflex rules for one analyte. 17b calls it inside the verifying transaction (DD8). */
export async function activeReflexRules(
  exec: Db | Tx,
  analyteId: string,
): Promise<(typeof labReflexRules.$inferSelect)[]> {
  return (exec as Db).select().from(labReflexRules)
    .where(and(eq(labReflexRules.analyteId, analyteId), eq(labReflexRules.active, true)));
}
