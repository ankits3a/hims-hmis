import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { appendEvent } from "../../kernel/events/append";
import { aerbSettings, aerbTldBadges, aerbTldReads } from "../../kernel/db/schema/aerb";
import { users } from "../../kernel/db/schema/auth";
import { AerbError } from "./errors";
import { requireManage } from "./access";
import { doseLimitWarning } from "./events";
import {
  ANNUAL_LIMIT_MSV, DEFAULT_INVESTIGATION_LEVEL_MSV_PER_MONTH, FIVE_YEAR_AVERAGE_LIMIT_MSV,
  FIVE_YEAR_TOTAL_LIMIT_MSV, investigationLevelFor,
} from "./limits";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T4 — **THE TLD BADGE PROGRAMME, AND THE LADDER THAT RECORDS RATHER THAN ACTS.**
 *
 * ═══ D9 — RECORD-ONLY, AND THAT IS A DECISION RATHER THAN AN OMISSION ═══
 *
 * A reading over the investigation level sets a flag, emits an event and appears on the RSO's
 * screen. It does not change a roster, does not page anybody and adds no scheduler job — 18a's own
 * posture for its SLAs, and the reason is sharper here: a TLD report arrives from the laboratory
 * **weeks after the period it describes**. A system that pulled a radiographer off fluoroscopy duty
 * today on the strength of a reading about last quarter would be making a duty-roster decision
 * (Plan 20's) out of a register entry about the past.
 *
 * ═══ THE COMPARISON IS THE READ'S OWN, AND IT IS STORED ═══
 *
 * The investigation level in force when the reading was entered travels with the row, exactly as
 * `over_drl` does one register over: a hospital that lowers its level next year must not
 * retroactively turn last year's readings into incidents.
 */

const SETTINGS_ID = "main";

/**
 * T6 — the DECISION is `access.ts`'s and is made in exactly one place; this file keeps only the
 * sentence a machine gets when it tries to write the badge book.
 */
async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  await requireManage(exec, actor, "a badge is issued to a person by a person");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PASS 2 — the shape check alone let `2026-02-31` reach the `date` column as a raw 22008 → 500. */
function assertDate(value: string, field: string): void {
  if (!DATE_RE.test(value)) {
    throw new AerbError("invalid_validity", `${field} must be YYYY-MM-DD, got "${value}"`, { field });
  }
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    throw new AerbError("invalid_validity", `${field} "${value}" is not a real date`, { field });
  }
}

/**
 * PASS 2 — `fileLicence` got both a pre-read AND a 23505 catch; these two got only the pre-read,
 * and `errors.ts` says of these very codes that the index is what makes them true under
 * concurrency. Under that concurrency the raw violation escaped as the 500 the codes exist to
 * eliminate. One helper, both call sites.
 */
function asNamedConflict<T>(e: unknown, code: "badge_already_issued" | "read_already_recorded", message: string): T {
  if ((e as { code?: unknown }).code === "23505") throw new AerbError(code, message);
  throw e;
}

/** The policy row's value, or D10's default when the RSO has never set one. Creates nothing. */
export async function investigationLevelPerMonth(exec: Db | Tx): Promise<number> {
  const rows = await (exec as Db).select().from(aerbSettings).where(eq(aerbSettings.id, SETTINGS_ID));
  const row = rows[0];
  return row === undefined ? DEFAULT_INVESTIGATION_LEVEL_MSV_PER_MONTH : Number(row.investigationLevelMsvPerMonth);
}

/** R3 — the owner's number, and it is data. Below the statutory limit by construction. */
export async function setInvestigationLevel(
  tx: Tx, actor: Actor, perMonthMsv: number,
): Promise<void> {
  await assertMayManage(tx, actor);
  if (!(perMonthMsv > 0)) {
    throw new AerbError("invalid_validity", "the investigation level must be greater than zero");
  }
  /**
   * An investigation level at or above the ANNUAL statutory limit is not a policy, it is a typo:
   * the level exists to trigger questions long before a limit is approached. Refused rather than
   * stored, because a register whose trigger is above its own ceiling never fires.
   */
  if (perMonthMsv * 12 >= ANNUAL_LIMIT_MSV) {
    throw new AerbError(
      "invalid_validity",
      `an investigation level of ${String(perMonthMsv)} mSv/month is ${String(perMonthMsv * 12)} mSv a `
      + `year, at or above the ${String(ANNUAL_LIMIT_MSV)} mSv statutory single-year limit — the level `
      + "exists to raise questions BEFORE the limit is approached",
      { perMonthMsv, annualLimitMsv: ANNUAL_LIMIT_MSV },
    );
  }
  await tx.insert(aerbSettings)
    .values({ id: SETTINGS_ID, investigationLevelMsvPerMonth: String(perMonthMsv), updatedBy: actor.id })
    .onConflictDoUpdate({
      target: aerbSettings.id,
      set: { investigationLevelMsvPerMonth: String(perMonthMsv), updatedBy: actor.id, updatedAt: new Date() },
    });
}

export interface IssueBadgeInput {
  userId: string;
  badgeNo: string;
  issuedOn: string;
  remarks?: string | null;
}

export async function issueBadge(tx: Tx, actor: Actor, input: IssueBadgeInput): Promise<{ badgeId: string }> {
  await assertMayManage(tx, actor);
  assertDate(input.issuedOn, "issuedOn");
  /**
   * CLOSE REVIEW — these were the partial unique indexes talking, and what reached the RSO was a
   * 500 with `aerb_tld_badges_user_active_ux` in the body. `errors.ts` says in a section header
   * that not one refusal in this module is a 500; the index is still what makes it true under
   * concurrency, and this is what makes it a sentence.
   */
  const clash = await tx.select({ id: aerbTldBadges.id, badgeNo: aerbTldBadges.badgeNo, userId: aerbTldBadges.userId })
    .from(aerbTldBadges)
    .where(and(
      eq(aerbTldBadges.status, "active"),
      or(eq(aerbTldBadges.userId, input.userId), eq(aerbTldBadges.badgeNo, input.badgeNo)),
    ));
  const held = clash[0];
  if (held !== undefined) {
    throw new AerbError(
      "badge_already_issued",
      held.userId === input.userId
        ? `this worker already wears badge ${held.badgeNo} — two badges on one person are two partial `
          + "pictures of one exposure and neither is their dose. Return or report the first one, then issue this"
        : `badge ${input.badgeNo} is already issued to somebody else`,
      { badgeNo: input.badgeNo, activeBadgeId: held.id },
    );
  }
  const badgeId = newId();
  try {
    await tx.insert(aerbTldBadges).values({
      id: badgeId, userId: input.userId, badgeNo: input.badgeNo,
      issuedOn: input.issuedOn, status: "active", remarks: input.remarks ?? null, createdBy: actor.id,
    });
  } catch (e) {
    return asNamedConflict(e, "badge_already_issued",
      `badge ${input.badgeNo} or this worker's badge was issued by somebody else while this was being recorded`);
  }
  return { badgeId };
}

/** Returned or lost. The row stays: whose badge read 4 mSv in 2026 is an inspector's question. */
export async function closeBadge(
  tx: Tx, actor: Actor, badgeId: string, status: "returned" | "lost", onDate: string,
): Promise<void> {
  await assertMayManage(tx, actor);
  assertDate(onDate, "onDate");
  const rows = await tx.select().from(aerbTldBadges).where(eq(aerbTldBadges.id, badgeId));
  const badge = rows[0];
  if (!badge) throw new AerbError("unknown_person", `no TLD badge ${badgeId}`, { badgeId });
  if (badge.status !== "active") {
    throw new AerbError("already_surrendered", `badge ${badge.badgeNo} is already ${badge.status}`, { badgeId });
  }
  /** CLOSE REVIEW — the CHECK was reaching the RSO as a 500. It is a typo, and it says so now. */
  if (onDate < badge.issuedOn) {
    throw new AerbError(
      "invalid_validity",
      `badge ${badge.badgeNo} was issued on ${badge.issuedOn} and cannot be returned on ${onDate}`,
      { badgeId, issuedOn: badge.issuedOn, onDate },
    );
  }
  await tx.update(aerbTldBadges)
    .set({ status, returnedOn: onDate })
    .where(eq(aerbTldBadges.id, badgeId));
}

export interface RecordReadInput {
  badgeId: string;
  periodStart: string;
  periodEnd: string;
  hp10Msv: number;
  hp007Msv?: number | null;
  reportedOn: string;
  labRef?: string | null;
  remarks?: string | null;
}

export interface RecordReadOutcome {
  readId: string;
  /** TRUE when the reading met or exceeded the pro-rated investigation level. */
  investigation: boolean;
  investigationLevelMsv: number;
}

/**
 * Enters one laboratory report. **The comparison is Hp(10) against the investigation level
 * pro-rated onto the wearing period** — a quarterly badge is compared against roughly three times
 * the monthly figure, not against the monthly figure itself, which is the mutant that turns every
 * quarterly report into an incident.
 *
 * Hp(0.07) is recorded and compared against nothing here: the skin limit is separate and far
 * higher, and a shallow reading measured against a whole-body trigger would flag a radiographer for
 * a dose the Rules do not consider one.
 */
export async function recordBadgeRead(
  tx: Tx, actor: Actor, input: RecordReadInput,
): Promise<RecordReadOutcome> {
  await assertMayManage(tx, actor);
  for (const [v, f] of [[input.periodStart, "periodStart"], [input.periodEnd, "periodEnd"], [input.reportedOn, "reportedOn"]] as const) {
    assertDate(v, f);
  }
  if (input.periodEnd < input.periodStart) {
    throw new AerbError("invalid_validity", `periodEnd ${input.periodEnd} is before periodStart ${input.periodStart}`);
  }
  if (input.hp10Msv < 0) {
    throw new AerbError("invalid_validity", "a dose reading is not negative — the laboratory reported an error");
  }

  const badgeRows = await tx.select().from(aerbTldBadges).where(eq(aerbTldBadges.id, input.badgeId));
  const badge = badgeRows[0];
  if (!badge) throw new AerbError("unknown_person", `no TLD badge ${input.badgeId}`, { badgeId: input.badgeId });

  /**
   * CLOSE REVIEW — a re-entered report was the unique index and a 500. The schema's own comment
   * promises "a re-entered report is a CORRECTION, not a second dose"; there is no correction route
   * yet, and until there is, this refusal is what says so.
   */
  const already = await tx.select({ id: aerbTldReads.id })
    .from(aerbTldReads)
    .where(and(
      eq(aerbTldReads.badgeId, input.badgeId),
      eq(aerbTldReads.periodStart, input.periodStart),
      eq(aerbTldReads.periodEnd, input.periodEnd),
    ));
  if (already[0] !== undefined) {
    throw new AerbError(
      "read_already_recorded",
      `badge ${badge.badgeNo} already carries a reading for ${input.periodStart}..${input.periodEnd} — `
      + "a re-entered report is a correction, not a second dose, and this register has no correction "
      + "route yet. Raise it with the RSO rather than entering it twice",
      { badgeId: input.badgeId, periodStart: input.periodStart, periodEnd: input.periodEnd, readId: already[0].id },
    );
  }

  /**
   * CLOSE REVIEW — a period the badge was not worn for. The badge's own dates bound the reading:
   * a laboratory report for a quarter before the badge was issued is a report about a different
   * badge, and one after it was returned is a report about nobody.
   */
  if (input.periodEnd < badge.issuedOn) {
    throw new AerbError(
      "invalid_validity",
      `badge ${badge.badgeNo} was issued on ${badge.issuedOn}; a reading for a period ending `
      + `${input.periodEnd} is about a badge somebody else was wearing`,
      { badgeId: input.badgeId, issuedOn: badge.issuedOn, periodEnd: input.periodEnd },
    );
  }

  const perMonth = await investigationLevelPerMonth(tx);
  const level = investigationLevelFor(perMonth, input.periodStart, input.periodEnd);
  const investigation = input.hp10Msv >= level;

  const readId = newId();
  try {
    await tx.insert(aerbTldReads).values({
    id: readId,
    badgeId: input.badgeId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    hp10Msv: String(input.hp10Msv),
    hp007Msv: input.hp007Msv === null || input.hp007Msv === undefined ? null : String(input.hp007Msv),
    reportedOn: input.reportedOn,
    labRef: input.labRef ?? null,
    investigationFlag: investigation,
    investigationLevelMsv: String(level.toFixed(3)),
      remarks: input.remarks ?? null,
      recordedBy: actor.id,
    });
  } catch (e) {
    return asNamedConflict(e, "read_already_recorded",
      `a reading for ${input.periodStart}..${input.periodEnd} was entered by somebody else while this was being recorded`);
  }

  if (investigation) {
    /**
     * D9 — the event carries the WORKER, because a dose-limit warning is about a person and an RSO
     * reading a consumer that could not say whose badge it was would learn nothing. It carries the
     * reading and the period and nothing else: no patient, no procedure, no roster.
     */
    await appendEvent(tx, doseLimitWarning.make({
      payload: {
        badgeId: input.badgeId, userId: badge.userId, badgeNo: badge.badgeNo,
        periodStart: input.periodStart, periodEnd: input.periodEnd,
        hp10Msv: input.hp10Msv, investigationLevelMsv: Number(level.toFixed(3)),
      },
      actor,
      correlationId: input.badgeId,
    }));
  }

  return { readId, investigation, investigationLevelMsv: level };
}

export interface BadgeRegisterRow {
  badgeId: string;
  userId: string;
  userName: string;
  badgeNo: string;
  issuedOn: string;
  returnedOn: string | null;
  status: string;
  /** The most recent reading on THIS badge, if any — the column an RSO scans down. */
  lastPeriodEnd: string | null;
  lastHp10Msv: string | null;
  lastInvestigation: boolean | null;
  /**
   * ═══ CLOSE REVIEW, CRITICAL — EVERY CUMULATIVE BELOW IS THE **WORKER'S**, NOT THE BADGE'S ═══
   *
   * These were summed per `badge_id`. A badge is issued to a person and can be re-issued: one
   * lost mid-year and replaced starts a new row, and `aerb_tld_badges_user_active_ux` is a PARTIAL
   * index (`where status = 'active'`), so one person legitimately owns many badge rows over time.
   *
   * The consequence was the failure this whole programme exists to prevent. A radiographer reads
   * 16 mSv in Q1 and 12 in Q2, loses the badge, is re-issued, and reads 6 in Q3: **34 mSv against a
   * 30 mSv statutory single-year ceiling** — and the register showed two green rows, 28 and 6,
   * neither over the limit, with no flag anywhere. The five-year leg was worse: nobody keeps one
   * physical badge for five years, so the 100 mSv total was structurally unreachable.
   *
   * The dose belongs to the person who absorbed it. `userId` is the key.
   */
  workerYtdMsv: string;
  workerFiveYearMsv: string;
  /**
   * The worst CALENDAR YEAR this worker has on record and its total — not "this year".
   *
   * The second CRITICAL: the annual window was `periodEnd` inside the year of `asOf`, so the Q4
   * report — which `recordBadgeRead`'s own docstring says arrives weeks after the period — could
   * never count. Entered in February, a Q4 reading has `periodEnd` in LAST year and was excluded
   * from this year's window; last year was never recomputed. A year that went over the limit was
   * over it at no instant the system could ever report. Now every calendar year present in the
   * readings is summed and the worst one is carried, whenever its reports arrived.
   */
  worstYear: string | null;
  worstYearMsv: string;
  /** Against the STATUTORY limits, which are code constants and not editable (D10). */
  overAnnualLimit: boolean;
  overFiveYearLimit: boolean;
  /** How many readings this badge carries. Zero is the negative space. */
  readCount: number;
}

/**
 * The badge book. Every number here is derived from the readings rather than stored, because a
 * cumulative that was written once and never recomputed is a cumulative that a corrected laboratory
 * report silently invalidates.
 */
export async function badgeRegister(
  db: Db, opts: { onDate?: string } = {},
): Promise<BadgeRegisterRow[]> {
  const asOf = opts.onDate ?? istDayString(new Date());
  const fiveYearStart = `${String(Number(asOf.slice(0, 4)) - 4)}-01-01`;

  const badges = await db.select({
    badgeId: aerbTldBadges.id,
    userId: aerbTldBadges.userId,
    userName: users.fullName,
    badgeNo: aerbTldBadges.badgeNo,
    issuedOn: aerbTldBadges.issuedOn,
    returnedOn: aerbTldBadges.returnedOn,
    status: aerbTldBadges.status,
  })
    .from(aerbTldBadges)
    .innerJoin(users, eq(users.id, aerbTldBadges.userId))
    .orderBy(asc(aerbTldBadges.status), asc(users.fullName));

  /**
   * ONE query for every reading, joined back to its badge's OWNER — so the arithmetic below is per
   * person across every badge they have ever worn, and the N+1 the phase document declared in §8.7
   * is gone with the defect that made it wrong.
   */
  const allReads = await db.select({
    badgeId: aerbTldReads.badgeId,
    userId: aerbTldBadges.userId,
    periodEnd: aerbTldReads.periodEnd,
    hp10: aerbTldReads.hp10Msv,
    flag: aerbTldReads.investigationFlag,
  })
    .from(aerbTldReads)
    .innerJoin(aerbTldBadges, eq(aerbTldBadges.id, aerbTldReads.badgeId))
    .orderBy(desc(aerbTldReads.periodEnd));

  const byBadge = new Map<string, typeof allReads>();
  const byUser = new Map<string, typeof allReads>();
  for (const r of allReads) {
    if (r.periodEnd > asOf) continue; // a reading for a period that has not closed yet
    (byBadge.get(r.badgeId) ?? byBadge.set(r.badgeId, []).get(r.badgeId)!).push(r);
    (byUser.get(r.userId) ?? byUser.set(r.userId, []).get(r.userId)!).push(r);
  }

  const sum = (rs: { hp10: string }[]) => rs.reduce((a, r) => a + Number(r.hp10), 0);

  return badges.map((b) => {
    const mine = byBadge.get(b.badgeId) ?? [];
    const theirs = byUser.get(b.userId) ?? [];
    const last = mine[0];

    /** Every calendar year the worker has readings for, whenever those reports arrived. */
    const perYear = new Map<string, number>();
    for (const r of theirs) {
      const year = r.periodEnd.slice(0, 4);
      perYear.set(year, (perYear.get(year) ?? 0) + Number(r.hp10));
    }
    let worstYear: string | null = null;
    let worstYearMsv = 0;
    for (const [year, total] of perYear) {
      if (worstYear === null || total > worstYearMsv) { worstYear = year; worstYearMsv = total; }
    }

    const thisYear = perYear.get(asOf.slice(0, 4)) ?? 0;
    const fiveYear = sum(theirs.filter((r) => r.periodEnd >= fiveYearStart));

    return {
      ...b,
      lastPeriodEnd: last?.periodEnd ?? null,
      lastHp10Msv: last?.hp10 ?? null,
      lastInvestigation: last?.flag ?? null,
      workerYtdMsv: thisYear.toFixed(3),
      workerFiveYearMsv: fiveYear.toFixed(3),
      worstYear,
      worstYearMsv: worstYearMsv.toFixed(3),
      /** ANY year over the ceiling, not merely the current one — the second CRITICAL. */
      overAnnualLimit: worstYearMsv > ANNUAL_LIMIT_MSV,
      overFiveYearLimit: fiveYear > FIVE_YEAR_TOTAL_LIMIT_MSV,
      readCount: mine.length,
    };
  });
}

export interface BadgeGapRow {
  badgeId: string;
  userId: string;
  userName: string;
  badgeNo: string;
  issuedOn: string;
  lastPeriodEnd: string | null;
  /** Days since the last reading's period closed, or since the badge was issued. */
  daysSince: number;
}

/**
 * **THE NEGATIVE SPACE (the brainstorm's own question): a badge period with no read.**
 *
 * An active badge whose most recent reading closed more than `staleDays` ago — the badge that was
 * never sent, the report that never came back, the technologist wearing a dosimeter nobody is
 * reading. A register that listed only the readings it HAS could never show one of these, and every
 * one of them is a person whose exposure is unknown.
 *
 * `staleDays` defaults to 120: a quarterly programme that has produced nothing in four months has
 * missed a cycle, which is the shortest window that is unambiguous for the common periodicities.
 */
export async function badgeGaps(
  db: Db, opts: { onDate?: string; staleDays?: number } = {},
): Promise<BadgeGapRow[]> {
  const asOf = opts.onDate ?? istDayString(new Date()); // CLOSE REVIEW — the IST day, not the UTC one
  const staleDays = opts.staleDays ?? 120;
  const register = await badgeRegister(db, { onDate: asOf });
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);

  return register
    .filter((b) => b.status === "active")
    .map((b) => {
      const since = b.lastPeriodEnd ?? b.issuedOn;
      return {
        badgeId: b.badgeId, userId: b.userId, userName: b.userName, badgeNo: b.badgeNo,
        issuedOn: b.issuedOn, lastPeriodEnd: b.lastPeriodEnd,
        daysSince: Math.floor((asOfMs - Date.parse(`${since}T00:00:00Z`)) / 86_400_000),
      };
    })
    .filter((b) => b.daysSince > staleDays);
}

/** The three statutory numbers, for a screen that must show what it is comparing against. */
export const STATUTORY_LIMITS = {
  annualMsv: ANNUAL_LIMIT_MSV,
  fiveYearAverageMsv: FIVE_YEAR_AVERAGE_LIMIT_MSV,
  fiveYearTotalMsv: FIVE_YEAR_TOTAL_LIMIT_MSV,
} as const;

export interface BadgeReadRow {
  id: string;
  badgeId: string;
  badgeNo: string;
  userName: string;
  periodStart: string;
  periodEnd: string;
  hp10Msv: string;
  hp007Msv: string | null;
  reportedOn: string;
  labRef: string | null;
  investigationFlag: boolean;
  investigationLevelMsv: string | null;
}

/** Every reading, newest period first. */
export async function badgeReads(db: Db, opts: { badgeId?: string } = {}): Promise<BadgeReadRow[]> {
  return db.select({
    id: aerbTldReads.id,
    badgeId: aerbTldReads.badgeId,
    badgeNo: aerbTldBadges.badgeNo,
    userName: users.fullName,
    periodStart: aerbTldReads.periodStart,
    periodEnd: aerbTldReads.periodEnd,
    hp10Msv: aerbTldReads.hp10Msv,
    hp007Msv: aerbTldReads.hp007Msv,
    reportedOn: aerbTldReads.reportedOn,
    labRef: aerbTldReads.labRef,
    investigationFlag: aerbTldReads.investigationFlag,
    investigationLevelMsv: aerbTldReads.investigationLevelMsv,
  })
    .from(aerbTldReads)
    .innerJoin(aerbTldBadges, eq(aerbTldBadges.id, aerbTldReads.badgeId))
    .innerJoin(users, eq(users.id, aerbTldBadges.userId))
    .where(opts.badgeId === undefined ? sql`true` : eq(aerbTldReads.badgeId, opts.badgeId))
    .orderBy(desc(aerbTldReads.periodEnd));
}

