import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { newId } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import { rosterModeDeclarations } from "../../kernel/db/schema/roster";
import type { RosterMode } from "../../kernel/db/schema/roster";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";

/**
 * PHASE R (R8) — **SKELETON MODE (D4): SAYING OUT LOUD THAT THE ROTA NO LONGER DESCRIBES THE
 * BUILDING.**
 *
 * Read the schema header first; the shape is the argument. Three things this module is careful
 * about, and each is a way the obvious implementation would have gone wrong:
 *
 * **It expires daily, so nothing has to remember to turn it off.** There is no `until`, no "active"
 * boolean and no end date. A declaration names one IST day. A hospital still short tomorrow
 * declares tomorrow, and the cost of forgetting is one day rather than forever — which is the
 * failure mode every emergency flag in every hospital system eventually has.
 *
 * **It marks nobody absent.** Bulk abstention is `recordAbsences` with kind `abstaining`, which R4
 * built and guards. The mode says *the hospital is short*; the absences say *who is not coming*.
 * Fusing them would let one declaration mark a department away, and then the resolvers would be
 * answering a question nobody asked them.
 *
 * **Withdrawal is a stamp, and the day's list is the checklist.** Nobody afterwards asks "is it on
 * now" — they ask who declared it, and when it stopped.
 */

export type RosterModeDeclarationRow = typeof rosterModeDeclarations.$inferSelect;

export type DeclareModeInput = {
  /** NULL or omitted = the whole hospital. */
  readonly departmentId?: string | null;
  readonly istDate: string;
  readonly reason: string;
  readonly mode?: RosterMode;
};

async function dbNow(tx: Tx): Promise<Date> {
  const r = await tx.execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

const assertIstDate = (d: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new RosterError("invalid_window", `"${d}" is not a calendar day`, { date: d });
  }
};

/**
 * THE MEDICAL SUPERINTENDENT, OR A NAMED DELEGATE, SAYS SO.
 *
 * `declare` is the act — the same one a holiday goes through, and one `rosterActPolicy` reserves
 * for a person. **No machine may put a hospital on skeleton cover**, however sure it is: the whole
 * content of the declaration is that somebody is answerable for it.
 */
export async function declareSkeletonMode(
  tx: Tx, actor: Actor, input: DeclareModeInput,
): Promise<RosterModeDeclarationRow> {
  assertIstDate(input.istDate);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new RosterError(
      "invalid_window",
      "a declaration without a reason is not a declaration — somebody reads this at handover",
      { istDate: input.istDate },
    );
  }

  const departmentId = input.departmentId ?? null;
  await requireRosterAct(
    tx, actor, "declare", departmentId === null ? {} : { departmentId },
  );

  // Idempotent per (day, scope): declaring twice in a crisis is likelier than not, and the second
  // call must not produce a second row for the same day that a withdrawal would then have to chase.
  const existing = await (tx as Db).select().from(rosterModeDeclarations).where(and(
    eq(rosterModeDeclarations.istDate, input.istDate),
    departmentId === null
      ? isNull(rosterModeDeclarations.departmentId)
      : eq(rosterModeDeclarations.departmentId, departmentId),
    isNull(rosterModeDeclarations.withdrawnAt),
  ));
  if (existing[0] !== undefined) return existing[0];

  const [row] = await tx.insert(rosterModeDeclarations).values({
    id: newId(),
    departmentId,
    mode: input.mode ?? "skeleton",
    istDate: input.istDate,
    reason,
    declaredBy: actor.id,
    createdBy: actor.id,
    updatedBy: actor.id,
  }).returning();
  return row!;
}

export async function withdrawSkeletonMode(
  tx: Tx, actor: Actor, declarationId: string, reason: string,
): Promise<RosterModeDeclarationRow> {
  const row = (await (tx as Db).select().from(rosterModeDeclarations)
    .where(eq(rosterModeDeclarations.id, declarationId)))[0];
  if (row === undefined) {
    throw new RosterError("unknown_mode_declaration", undefined, { declarationId });
  }
  if (row.withdrawnAt !== null) {
    throw new RosterError("mode_already_withdrawn", undefined, {
      declarationId, withdrawnBy: row.withdrawnBy, withdrawnAt: row.withdrawnAt.toISOString(),
    });
  }
  await requireRosterAct(
    tx, actor, "declare", row.departmentId === null ? {} : { departmentId: row.departmentId },
  );

  const now = await dbNow(tx);
  const [updated] = await tx.update(rosterModeDeclarations).set({
    withdrawnAt: now, withdrawnBy: actor.id, withdrawReason: reason.trim() || null,
    updatedBy: actor.id, updatedAt: now,
  }).where(eq(rosterModeDeclarations.id, declarationId)).returning();
  return updated!;
}

/**
 * Is this department on skeleton cover on this day?
 *
 * A hospital-wide declaration answers for every department, so the read is "mine OR the whole
 * hospital's" — a department cannot be off skeleton cover on a day the hospital is on it.
 */
export async function skeletonModeOn(
  exec: Db | Tx, departmentId: string | null, istDate: string,
): Promise<boolean> {
  assertIstDate(istDate);
  const rows = await (exec as Db).select().from(rosterModeDeclarations).where(and(
    eq(rosterModeDeclarations.istDate, istDate),
    isNull(rosterModeDeclarations.withdrawnAt),
  ));
  return rows.some((r) => r.departmentId === null || r.departmentId === departmentId);
}

/** The day's declarations, withdrawn ones included — the checklist somebody walks at handover. */
export async function modeDeclarations(
  exec: Db | Tx, istDate: string,
): Promise<RosterModeDeclarationRow[]> {
  assertIstDate(istDate);
  return (exec as Db).select().from(rosterModeDeclarations)
    .where(eq(rosterModeDeclarations.istDate, istDate))
    .orderBy(asc(rosterModeDeclarations.departmentId), asc(rosterModeDeclarations.declaredAt));
}
