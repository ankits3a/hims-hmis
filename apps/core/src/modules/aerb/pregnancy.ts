import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { aerbPregnancyDeclarations, aerbTldBadges, aerbTldReads } from "../../kernel/db/schema/aerb";
import { users } from "../../kernel/db/schema/auth";
import { AerbError } from "./errors";
import { requireManage } from "./access";
import { PREGNANT_WORKER_FOETAL_LIMIT_MSV } from "./limits";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 T4 — **A RADIATION WORKER'S PREGNANCY DECLARATION.**
 *
 * Voluntary and confidential (ICRP 103, AERB): she tells the RSO; the RSO records it here. From that
 * day the dose to the foetus must stay under 1 mSv for the rest of the pregnancy, so:
 *
 *   · her badge reads worn after the declaration are summed and compared with that limit
 *     (`foetalDoseSince`, on the register and on every TLD import line);
 *   · while it is active she stands on the RSO's list — "declared pregnant worker: reassign or
 *     restrict her ionising work" — until the RSO ends it or her expected date passes.
 *
 * ═══ DECIDED — A PROMPT, NOT A ROSTER GATE ═══
 *
 * The least invasive answer (brief T4): the roster module does not know which duties are ionising
 * and gating assignments there would change another module's signature. The prompt is the RSO's
 * list and `activeDeclarations` (exported for RS10's HOD escalation sources). The RSO reassigns;
 * the system does not move a person's duty on a register entry. The room console names no one —
 * the declaration is confidential to the RSO's register.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, field: string): void {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (!DATE_RE.test(value) || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    throw new AerbError("invalid_validity", `${field} "${value}" is not a real date (YYYY-MM-DD)`, { field });
  }
}

/**
 * The part of one read's Hp(10) that fell after the declaration (and before it ended), pro-rated
 * by days — a quarterly badge declared mid-quarter counts only the days worn since. DECIDED: the
 * badge's Hp(10) is the conservative stand-in for the foetal dose (no abdomen badge is modelled).
 */
export function foetalShare(
  read: { periodStart: string; periodEnd: string; hp10: number },
  decl: { declaredOn: string; endedOn: string | null },
): number {
  const from = read.periodStart > decl.declaredOn ? read.periodStart : decl.declaredOn;
  const to = decl.endedOn !== null && decl.endedOn < read.periodEnd ? decl.endedOn : read.periodEnd;
  if (to < from) return 0;
  const days = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
  return read.hp10 * (days(from, to) / days(read.periodStart, read.periodEnd));
}

export interface DeclarePregnancyInput {
  userId: string;
  declaredOn: string;
  expectedOn: string;
  remarks?: string | null;
}

export async function declarePregnancy(
  tx: Tx, actor: Actor, input: DeclarePregnancyInput, opts: { now?: Date } = {},
): Promise<{ declarationId: string }> {
  await requireManage(tx, actor, "a pregnancy declaration is recorded by a person");
  assertDate(input.declaredOn, "declaredOn");
  assertDate(input.expectedOn, "expectedOn");
  const today = istDayString(opts.now ?? new Date());
  if (input.declaredOn > today) {
    throw new AerbError("invalid_validity", `declaredOn ${input.declaredOn} is in the future (today is ${today})`);
  }
  if (input.expectedOn < input.declaredOn) {
    throw new AerbError("invalid_validity", `the expected date ${input.expectedOn} is before the declaration ${input.declaredOn}`);
  }
  const [who] = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.id, input.userId));
  if (who === undefined) throw new AerbError("unknown_person", `no user ${input.userId}`, { userId: input.userId });
  const active = await tx.select({ id: aerbPregnancyDeclarations.id, declaredOn: aerbPregnancyDeclarations.declaredOn })
    .from(aerbPregnancyDeclarations)
    .where(and(eq(aerbPregnancyDeclarations.userId, input.userId), isNull(aerbPregnancyDeclarations.endedOn)));
  if (active[0] !== undefined) {
    throw new AerbError(
      "declaration_active",
      `${who.fullName} already has a declaration from ${active[0].declaredOn} — end it before recording another`,
      { declarationId: active[0].id },
    );
  }
  const declarationId = newId();
  try {
    await tx.insert(aerbPregnancyDeclarations).values({
      id: declarationId, userId: input.userId, declaredOn: input.declaredOn, expectedOn: input.expectedOn,
      remarks: input.remarks ?? null, createdBy: actor.id,
    });
  } catch (e) {
    if ((e as { code?: unknown }).code === "23505") {
      throw new AerbError("declaration_active", `${who.fullName}'s declaration was recorded by somebody else just now`);
    }
    throw e;
  }
  return { declarationId };
}

export async function endPregnancyDeclaration(
  tx: Tx, actor: Actor, declarationId: string, input: { onDate: string; reason: string },
): Promise<void> {
  await requireManage(tx, actor, "a pregnancy declaration is ended by a person");
  assertDate(input.onDate, "onDate");
  const [row] = await tx.select().from(aerbPregnancyDeclarations).where(eq(aerbPregnancyDeclarations.id, declarationId));
  if (row === undefined) throw new AerbError("unknown_person", `no declaration ${declarationId}`);
  if (row.endedOn !== null) {
    throw new AerbError("already_surrendered", `this declaration already ended on ${row.endedOn}`);
  }
  if (input.onDate < row.declaredOn) {
    throw new AerbError("invalid_validity", `it was declared on ${row.declaredOn} and cannot end on ${input.onDate}`);
  }
  await tx.update(aerbPregnancyDeclarations)
    .set({ endedOn: input.onDate, endReason: input.reason })
    .where(eq(aerbPregnancyDeclarations.id, declarationId));
}

export interface PregnancyDeclarationRow {
  id: string;
  userId: string;
  userName: string;
  declaredOn: string;
  expectedOn: string;
  endedOn: string | null;
  endReason: string | null;
  remarks: string | null;
  /** Active = not ended and the expected date not yet passed. */
  active: boolean;
  /** Ended by nobody, but the expected date has passed: the RSO should end it. */
  lapsed: boolean;
  /** Her Hp(10) since the declaration, pro-rated — the foetal-dose estimate. */
  foetalDoseMsv: string;
  foetalLimitMsv: number;
  overFoetalLimit: boolean;
  /** Reads counted, so "0.000" with none is visibly "nothing read yet", not "no dose". */
  readsCounted: number;
}

/** Every declaration, active first. */
export async function pregnancyDeclarations(
  db: Db | Tx, opts: { onDate?: string; activeOnly?: boolean } = {},
): Promise<PregnancyDeclarationRow[]> {
  const asOf = opts.onDate ?? istDayString(new Date());
  const rows = await (db as Db).select({
    id: aerbPregnancyDeclarations.id,
    userId: aerbPregnancyDeclarations.userId,
    userName: users.fullName,
    declaredOn: aerbPregnancyDeclarations.declaredOn,
    expectedOn: aerbPregnancyDeclarations.expectedOn,
    endedOn: aerbPregnancyDeclarations.endedOn,
    endReason: aerbPregnancyDeclarations.endReason,
    remarks: aerbPregnancyDeclarations.remarks,
  })
    .from(aerbPregnancyDeclarations)
    .innerJoin(users, eq(users.id, aerbPregnancyDeclarations.userId))
    .orderBy(asc(users.fullName));
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const reads = userIds.length === 0 ? [] : await (db as Db).select({
    userId: aerbTldBadges.userId, periodStart: aerbTldReads.periodStart, periodEnd: aerbTldReads.periodEnd,
    hp10: aerbTldReads.hp10Msv,
  })
    .from(aerbTldReads)
    .innerJoin(aerbTldBadges, eq(aerbTldBadges.id, aerbTldReads.badgeId))
    .where(inArray(aerbTldBadges.userId, userIds));

  const out = rows.map((r) => {
    const mine = reads.filter((x) => x.userId === r.userId)
      .map((x) => ({ periodStart: x.periodStart, periodEnd: x.periodEnd, hp10: Number(x.hp10) }));
    const shares = mine.map((m) => foetalShare(m, r)).filter((s, i) => s > 0 || foetalShare({ ...mine[i]!, hp10: 1 }, r) > 0);
    const dose = shares.reduce((a, s) => a + s, 0);
    const lapsed = r.endedOn === null && r.expectedOn < asOf;
    return {
      ...r,
      active: r.endedOn === null && !lapsed && r.declaredOn <= asOf,
      lapsed,
      foetalDoseMsv: dose.toFixed(3),
      foetalLimitMsv: PREGNANT_WORKER_FOETAL_LIMIT_MSV,
      overFoetalLimit: dose >= PREGNANT_WORKER_FOETAL_LIMIT_MSV,
      readsCounted: shares.length,
    };
  });
  const filtered = opts.activeOnly === true ? out.filter((r) => r.active || r.lapsed) : out;
  return filtered.sort((a, b) => Number(b.active) - Number(a.active));
}

/** The declared-pregnant workers today — the source RS10's HOD escalations can read. */
export async function activeDeclarations(db: Db | Tx, opts: { onDate?: string } = {}): Promise<PregnancyDeclarationRow[]> {
  return (await pregnancyDeclarations(db, { ...opts, activeOnly: true })).filter((r) => r.active);
}
