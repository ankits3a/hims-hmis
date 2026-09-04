import { asc, desc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { aerbSettings, aerbTldBadges, aerbTldReads } from "../../kernel/db/schema/aerb";
import { users } from "../../kernel/db/schema/auth";
import { AerbError } from "./errors";
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

const MANAGE = "aerb.registers.manage";
const SETTINGS_ID = "main";

async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user") {
    throw new AerbError("not_appointed", "a badge is issued to a person by a person");
  }
  if (!(await hasPermission(exec as Db, actor.id, MANAGE, "hospital"))) {
    throw new AerbError("not_appointed", `${actor.id} does not hold ${MANAGE}`, { permission: MANAGE });
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(value: string, field: string): void {
  if (!DATE_RE.test(value)) {
    throw new AerbError("invalid_validity", `${field} must be YYYY-MM-DD, got "${value}"`, { field });
  }
}

/** The policy row, created on first read with D10's default rather than refusing. */
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
  const badgeId = newId();
  await tx.insert(aerbTldBadges).values({
    id: badgeId, userId: input.userId, badgeNo: input.badgeNo,
    issuedOn: input.issuedOn, status: "active", remarks: input.remarks ?? null, createdBy: actor.id,
  });
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

  const perMonth = await investigationLevelPerMonth(tx);
  const level = investigationLevelFor(perMonth, input.periodStart, input.periodEnd);
  const investigation = input.hp10Msv >= level;

  const readId = newId();
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
  /** The most recent reading, if any — the column an RSO scans down. */
  lastPeriodEnd: string | null;
  lastHp10Msv: string | null;
  lastInvestigation: boolean | null;
  /** Calendar-year and rolling-five-year totals of Hp(10), in mSv. */
  ytdMsv: string;
  fiveYearMsv: string;
  /** Against the STATUTORY limits, which are code constants and not editable (D10). */
  overAnnualLimit: boolean;
  overFiveYearLimit: boolean;
  /** How many periods carry no reading at all — the negative space. */
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
  const asOf = opts.onDate ?? new Date().toISOString().slice(0, 10);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const fiveYearStart = `${String(Number(asOf.slice(0, 4)) - 4)}-01-01`;

  const rows = await db.select({
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

  const out: BadgeRegisterRow[] = [];
  for (const b of rows) {
    const reads = await db.select({
      periodEnd: aerbTldReads.periodEnd,
      hp10: aerbTldReads.hp10Msv,
      flag: aerbTldReads.investigationFlag,
    })
      .from(aerbTldReads)
      .where(eq(aerbTldReads.badgeId, b.badgeId))
      .orderBy(desc(aerbTldReads.periodEnd));

    const inWindow = (from: string) => reads.filter((r) => r.periodEnd >= from && r.periodEnd <= asOf);
    const sum = (rs: { hp10: string }[]) => rs.reduce((a, r) => a + Number(r.hp10), 0);
    const ytd = sum(inWindow(yearStart));
    const fiveYear = sum(inWindow(fiveYearStart));
    const last = reads[0];

    out.push({
      ...b,
      lastPeriodEnd: last?.periodEnd ?? null,
      lastHp10Msv: last?.hp10 ?? null,
      lastInvestigation: last?.flag ?? null,
      ytdMsv: ytd.toFixed(3),
      fiveYearMsv: fiveYear.toFixed(3),
      overAnnualLimit: ytd > ANNUAL_LIMIT_MSV,
      overFiveYearLimit: fiveYear > FIVE_YEAR_TOTAL_LIMIT_MSV,
      readCount: reads.length,
    });
  }
  return out;
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
  const asOf = opts.onDate ?? new Date().toISOString().slice(0, 10);
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

