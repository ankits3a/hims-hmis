import { and, count, gte, inArray, lte, sql } from "drizzle-orm";
import type { AppointmentCounts, DayRange, OwnerAppointments, OwnerLearning } from "@hmis/contracts";
import { opdAppointments, opdDoctors, opdSuggestionEvents, opdTermMisses } from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { listNicknames } from "./alias-use";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE OWNER'S APPOINTMENTS AND LEARNING PAGES ═══ (owner, 2026-10-09: "Tele-calls and appointments
 * today. week, month, custom." · "Learning: nicknames learned this week, with Undo.")
 *
 * Both are COUNTS — no patient, no appointment number. Doctors are named (staff), as the OPD report
 * already names them to the same readers (`opd.reports.read`).
 *
 * APPOINTMENTS are cut on the slot's own IST day (`service_date`), whatever day the booking was made:
 *   came          — `checked_in`
 *   toCome        — `booked` (in a past range: booked and nobody marked it)
 *   missed        — `no_show`
 *   needRebooking — `needs_rebooking` (a doctor's leave stranded it)
 *   cancelled     — `cancelled`; counted beside the total, not in it
 * A `rescheduled` row is the OLD half of a move — its new row is counted on its own day — so it is in
 * neither. There is no tele-call split: this table has no channel column on this branch.
 */
const ZERO: AppointmentCounts = { total: 0, came: 0, toCome: 0, missed: 0, needRebooking: 0, cancelled: 0 };

function add(c: AppointmentCounts, status: string, n: number): void {
  if (status === "checked_in") c.came += n;
  else if (status === "booked") c.toCome += n;
  else if (status === "no_show") c.missed += n;
  else if (status === "needs_rebooking") c.needRebooking += n;
  else if (status === "cancelled") { c.cancelled += n; return; }
  else return;
  c.total += n;
}

async function tally(db: Db, range: DayRange): Promise<{ doctorId: string; status: string; n: number }[]> {
  const rows = await db.select({ doctorId: opdAppointments.doctorId, status: opdAppointments.status, n: count() })
    .from(opdAppointments)
    .where(and(gte(opdAppointments.serviceDate, range.from), lte(opdAppointments.serviceDate, range.to)))
    .groupBy(opdAppointments.doctorId, opdAppointments.status);
  return rows.map((r) => ({ doctorId: r.doctorId, status: r.status, n: Number(r.n) }));
}

export async function ownerAppointments(db: Db, range: DayRange, compare: DayRange | null): Promise<OwnerAppointments> {
  const rows = await tally(db, range);
  const totals = { ...ZERO };
  const byDoctor = new Map<string, AppointmentCounts>();
  for (const r of rows) {
    add(totals, r.status, r.n);
    const mine = byDoctor.get(r.doctorId) ?? { ...ZERO };
    add(mine, r.status, r.n);
    byDoctor.set(r.doctorId, mine);
  }
  const ids = [...byDoctor.keys()];
  const names = ids.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: opdDoctors.id, name: opdDoctors.displayName }).from(opdDoctors).where(inArray(opdDoctors.id, ids))).map((d) => [d.id, d.name]));
  let previous: OwnerAppointments["previous"] = null;
  if (compare !== null) {
    const before = { ...ZERO };
    for (const r of await tally(db, compare)) add(before, r.status, r.n);
    previous = { ...compare, total: before.total };
  }
  return {
    from: range.from, to: range.to, ...totals, previous,
    doctors: [...byDoctor.entries()].filter(([, c]) => c.total > 0)
      .map(([id, c]) => ({ id, name: names.get(id) ?? id, total: c.total, came: c.came }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
}

/**
 * What the suggestions learned in the last seven days: the nicknames (the same rows as the admin's
 * list — `listNicknames`), how often a doctor who ACTED on a suggestion tapped it (accepted ÷ accepted
 * + crossed off + picked something else; a chip nobody touched is not in it), and how many typed or
 * heard words matched nothing. The words themselves stay on the admin screen. `mayUndo` is the
 * existing gate on the undo routes (`opd.masters.manage`), reported so a screen draws no dead button.
 */
export async function ownerLearning(db: Db, actor: Actor, on: boolean, now: Date = new Date()): Promise<OwnerLearning> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const list = await listNicknames(db, { all: false, on }, now);
  const acts = await db.select({ outcome: opdSuggestionEvents.outcome, n: count() }).from(opdSuggestionEvents)
    .where(and(gte(opdSuggestionEvents.createdAt, since), lte(opdSuggestionEvents.createdAt, now), inArray(opdSuggestionEvents.outcome, ["accepted", "dismissed", "manual"])))
    .groupBy(opdSuggestionEvents.outcome);
  const accepted = Number(acts.find((a) => a.outcome === "accepted")?.n ?? 0);
  const acted = acts.reduce((n, a) => n + Number(a.n), 0);
  const [misses] = await db.select({ n: sql<number>`count(*)::int` }).from(opdTermMisses)
    .where(and(gte(opdTermMisses.createdAt, since), lte(opdTermMisses.createdAt, now)));
  return {
    on,
    mayUndo: actor.type === "user" && await hasPermission(db, actor.id, "opd.masters.manage", "hospital"),
    nicknames: list.items,
    tapped: acted === 0 ? null : { accepted, acted },
    misses: misses?.n ?? 0,
  };
}
