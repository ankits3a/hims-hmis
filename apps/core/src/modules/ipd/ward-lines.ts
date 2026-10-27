import { and, asc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  IPD_LINE_DUE_HOURS, IpdInsertLineInputSchema, IpdRemoveLineInputSchema, IpdReviewLineInputSchema, ipdIsInFuture, newId,
} from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdLineReviews, ipdLines } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withIdempotency } from "../billing";
import { holdsPermission, lockAdmission, provenanceOf } from "./admission-core";
import { admissionPlace } from "./admission-place";
import { IpdError } from "./errors";
import { IPD_NURSING_STATES } from "./nursing";
import { IPD_ASSESSMENT_RECORD, IPD_ROUND_SIGN } from "./permissions";
import { lineInserted, lineRemoved, lineReviewed } from "./ward-safety-events";
import type { Actor, IpdLineKind, IpdLineView } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * WM-2 (#983) — LINES: urinary catheter, central line and cannula. Each records its insertion (instant, site, who) and a
 * DUE-REMOVAL instant: a cannula 72 hours after insertion; a catheter and a central line 24 hours after insertion, moved
 * on 24 hours by each doctor's "keep" (DECIDED, standard practice). The doctor's round asks "still needed?" once per IST
 * day for every line in (`stillNeededAsked` until a review that day); `remove` on review takes it out at once.
 *
 * LINE-DAYS (DECIDED): a line counts one day for each IST calendar day on which it was in at any moment, at the ward
 * where it was inserted. The ward's line-days for a month are the sum over its lines of the days inside that month.
 */

type Opts = { now?: Date };
type LineRow = typeof ipdLines.$inferSelect;
const HOUR = 3_600_000;

function once<T>(db: Db, actor: Actor, act: string, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${act}`, key: key.toLowerCase() }, body, work, now);
}

async function requireAny(db: Db, actor: Actor, perms: readonly string[]): Promise<void> {
  for (const p of perms) if (await holdsPermission(db, actor, p)) return;
  throw new IpdError("ipd_forbidden", `this act needs one of the permissions ${perms.join(", ")}`, { permission: perms[0] });
}

/** IST calendar days from `from` to `to` inclusive (0 when `to` is before `from`). */
export function istDaysTouched(from: Date, to: Date): number {
  if (to.getTime() < from.getTime()) return 0;
  const a = Date.parse(`${istDayString(from)}T00:00:00Z`);
  const b = Date.parse(`${istDayString(to)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export async function insertIpdLine(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ lineId: string; dueRemovalAt: string }> {
  const input = IpdInsertLineInputSchema.parse(raw);
  await requireAny(db, actor, [IPD_ASSESSMENT_RECORD, IPD_ROUND_SIGN]);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.insertedAt, at)) throw new IpdError("line_time_invalid", "an insertion time cannot be in the future", { insertedAt: input.insertedAt });
  return once(db, actor, "insert_line", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!(IPD_NURSING_STATES as readonly string[]).includes(a.state)) throw new IpdError("patient_not_on_ward", "the patient is not on a ward bed", { state: a.state });
    const insertedAt = new Date(input.insertedAt);
    const dueRemovalAt = new Date(insertedAt.getTime() + IPD_LINE_DUE_HOURS[input.kind] * HOUR);
    const lineId = newId();
    await tx.insert(ipdLines).values({
      id: lineId, admissionId: a.id, patientId: a.patientId, wardId: (await admissionPlace(tx, a.id))?.wardId ?? null, kind: input.kind, site: input.site,
      insertedAt, insertedBy: actor.id, dueRemovalAt,
    });
    await appendEvent(tx, lineInserted.make({
      payload: { lineId, admissionId: a.id, kind: input.kind, dueRemovalAt: dueRemovalAt.toISOString(), provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { lineId, dueRemovalAt: dueRemovalAt.toISOString() };
  }), at);
}

async function lockLine(tx: Tx, lineId: string): Promise<LineRow> {
  const l0 = (await tx.select().from(ipdLines).where(eq(ipdLines.id, lineId)))[0];
  if (l0 === undefined) throw new IpdError("line_not_found", "no line has this id", { lineId });
  await lockAdmission(tx, l0.admissionId);
  const l = (await tx.select().from(ipdLines).where(eq(ipdLines.id, lineId)).for("update"))[0]!;
  if (l.removedAt !== null) throw new IpdError("line_removed", "this line is already out", { lineId });
  return l;
}

async function takeOut(tx: Tx, actor: Actor, l: LineRow, removedAt: Date, reason: string, at: Date): Promise<number> {
  await tx.update(ipdLines).set({ removedAt, removedBy: actor.id, removedReason: reason }).where(eq(ipdLines.id, l.id));
  const days = istDaysTouched(l.insertedAt, removedAt);
  await appendEvent(tx, lineRemoved.make({ payload: { lineId: l.id, admissionId: l.admissionId, days, provenance: provenanceOf(actor) }, actor, correlationId: l.admissionId, occurredAt: at }));
  return days;
}

/** The doctor's "still needed?": keep (the due-removal moves on for a catheter or central line) or remove now. */
export async function reviewIpdLine(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ lineId: string; dueRemovalAt: string | null }> {
  const input = IpdReviewLineInputSchema.parse(raw);
  await requireAny(db, actor, [IPD_ROUND_SIGN]);
  const at = opts.now ?? new Date();
  return once(db, actor, "review_line", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const l = await lockLine(tx, input.lineId);
    await tx.insert(ipdLineReviews).values({
      id: newId(), lineId: l.id, reviewDate: istDayString(at), decision: input.decision, reviewedBy: actor.id, reviewedAt: at, note: input.note ?? null,
    }).onConflictDoUpdate({ target: [ipdLineReviews.lineId, ipdLineReviews.reviewDate], set: { decision: input.decision, reviewedBy: actor.id, reviewedAt: at } });
    let due: Date | null = l.dueRemovalAt;
    if (input.decision === "remove") {
      await takeOut(tx, actor, l, at, input.note ?? "Not needed on the round", at);
      due = null;
    } else if (l.kind !== "cannula") {
      due = new Date(Math.max(l.dueRemovalAt.getTime(), at.getTime() + IPD_LINE_DUE_HOURS[l.kind as IpdLineKind] * HOUR));
      await tx.update(ipdLines).set({ dueRemovalAt: due }).where(eq(ipdLines.id, l.id));
    }
    await appendEvent(tx, lineReviewed.make({ payload: { lineId: l.id, decision: input.decision, provenance: provenanceOf(actor) }, actor, correlationId: l.admissionId, occurredAt: at }));
    return { lineId: l.id, dueRemovalAt: due?.toISOString() ?? null };
  }), at);
}

export async function removeIpdLine(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ lineId: string; days: number }> {
  const input = IpdRemoveLineInputSchema.parse(raw);
  await requireAny(db, actor, [IPD_ASSESSMENT_RECORD, IPD_ROUND_SIGN]);
  const at = opts.now ?? new Date();
  return once(db, actor, "remove_line", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const l = await lockLine(tx, input.lineId);
    const removedAt = new Date(input.removedAt);
    if (removedAt < l.insertedAt || ipdIsInFuture(input.removedAt, at)) {
      throw new IpdError("line_time_invalid", "the removal time must be after insertion and not in the future", { removedAt: input.removedAt });
    }
    return { lineId: l.id, days: await takeOut(tx, actor, l, removedAt, input.reason, at) };
  }), at);
}

/** The lines in now for these admissions, each with its days so far and today's "still needed?". */
export async function linesOf(exec: Db | Tx, admissionIds: readonly string[], now: Date): Promise<IpdLineView[]> {
  if (admissionIds.length === 0) return [];
  const rows = await exec.select().from(ipdLines)
    .where(and(inArray(ipdLines.admissionId, [...admissionIds]), isNull(ipdLines.removedAt))).orderBy(asc(ipdLines.insertedAt));
  if (rows.length === 0) return [];
  const today = istDayString(now);
  const reviewed = new Set((await exec.select({ lineId: ipdLineReviews.lineId }).from(ipdLineReviews)
    .where(and(inArray(ipdLineReviews.lineId, rows.map((r) => r.id)), eq(ipdLineReviews.reviewDate, today)))).map((r) => r.lineId));
  return rows.map((l) => ({
    lineId: l.id, admissionId: l.admissionId, kind: l.kind as IpdLineKind, site: l.site, insertedAt: l.insertedAt.toISOString(),
    dueRemovalAt: l.dueRemovalAt.toISOString(), overdue: now > l.dueRemovalAt, days: istDaysTouched(l.insertedAt, now),
    stillNeededAsked: !reviewed.has(l.id),
  }));
}

/** The ward's line-days in [from, to): each line's IST days inside the window, up to its removal or `now`. */
export async function wardLineDays(exec: Db | Tx, wardId: string, from: Date, to: Date, now: Date): Promise<{ total: number; byLine: { lineId: string; days: number }[] }> {
  const rows = await exec.select().from(ipdLines).where(and(
    eq(ipdLines.wardId, wardId), lt(ipdLines.insertedAt, to), or(isNull(ipdLines.removedAt), gte(ipdLines.removedAt, from)),
  ));
  const cap = new Date(Math.min(to.getTime() - 1, now.getTime()));
  const byLine = rows.map((l) => {
    const start = l.insertedAt > from ? l.insertedAt : from;
    const end = l.removedAt !== null && l.removedAt < cap ? l.removedAt : cap;
    return { lineId: l.id, days: istDaysTouched(start, end) };
  }).filter((x) => x.days > 0);
  return { total: byLine.reduce((s, x) => s + x.days, 0), byLine };
}
