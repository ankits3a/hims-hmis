import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { ipdAdmissions, ipdEmarActs, ipdEmarDoses, ipdOrders } from "../../kernel/db/schema";
import { IPD_NURSING_STATES } from "./nursing";
import { nowIdentities, nowSubtitle, rankNowRows } from "./now-cards";
import type { DeskCard, DeskProviderCtx } from "../../kernel/desk/types";
import type { NowRow } from "./now-cards";

/**
 * E4.3 (#735) — the eMAR's two NURSE Now cards (spec §0B; MAP.md "OWED TO M4"), one provider and one permission each:
 *
 *   ipd.due_dose   `ipd.emar.give`  a scheduled dose whose window is open now (hot once past its due time), or a missed
 *                                   dose still inside its catch-up (hot)
 *   ipd.new_order  `ipd.emar.view`  a drug order placed in the last 6 hours with no dose recorded yet — waiting for the
 *                                   pharmacist, to be issued, or ready (a STAT order is hot)
 *
 * A card exists only while something is due. Rows carry the shared identity rule (`nowIdentities`): a sealed patient shows
 * no UHID and no bed. No drug or dose words on a desk row (a desk is read over a shoulder); the phone shows them.
 */
const minutesBetween = (a: Date, b: Date): number => Math.floor((b.getTime() - a.getTime()) / 60_000);
/** DECIDED: an order is "new" for this long after it was placed. */
export const IPD_NEW_ORDER_HOURS = 6;

async function onWard(ctx: DeskProviderCtx) {
  return ctx.db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.state, [...IPD_NURSING_STATES]));
}

export async function dueDoseCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const admissions = await onWard(ctx);
  if (admissions.length === 0) return [];
  const slots = await db.select().from(ipdEmarDoses).where(and(
    inArray(ipdEmarDoses.admissionId, admissions.map((a) => a.id)), inArray(ipdEmarDoses.status, ["scheduled", "missed"]), eq(ipdEmarDoses.prn, false),
    sql`coalesce(${ipdEmarDoses.reofferedAt}, ${ipdEmarDoses.dueAt}) - make_interval(mins => ${ipdEmarDoses.windowMinutes}) <= ${now.toISOString()}::timestamptz`,
    sql`coalesce(${ipdEmarDoses.reofferedAt}, ${ipdEmarDoses.dueAt}) + make_interval(mins => ${ipdEmarDoses.windowMinutes} * 3) >= ${now.toISOString()}::timestamptz`,
  ));
  const live = slots.filter((s) => s.status === "missed" || (s.reofferedAt ?? s.dueAt).getTime() + s.windowMinutes * 60_000 >= now.getTime());
  if (live.length === 0) return [];
  const byAdmission = new Map<string, typeof live>();
  for (const s of live) byAdmission.set(s.admissionId, [...(byAdmission.get(s.admissionId) ?? []), s]);
  const subjects = admissions.filter((a) => byAdmission.has(a.id));
  const who = await nowIdentities(db, ctx.reader, subjects);
  const rows: NowRow[] = subjects.map((a) => {
    const due = byAdmission.get(a.id)!;
    const missed = due.filter((s) => s.status === "missed").length;
    const oldest = due.reduce((m, s) => ((s.reofferedAt ?? s.dueAt) < m ? (s.reofferedAt ?? s.dueAt) : m), due[0]!.reofferedAt ?? due[0]!.dueAt);
    const late = minutesBetween(oldest, now);
    const words = missed > 0 ? `${String(missed)} missed · ${String(due.length)} due` : late > 0 ? `${String(due.length)} due · ${String(late)} min late` : `${String(due.length)} due`;
    return {
      id: a.id, badge: "℞", title: who.get(a.id)!.name, subtitle: nowSubtitle(who.get(a.id)!, words), action: "Give",
      href: "/ipd/my-shift", severity: missed > 0 || late > 0 ? "hot" : "warn", waitMinutes: Math.max(0, late),
    };
  });
  return [{ key: "ipd.due_dose", band: "now", titleKey: "desk.ipdDueDose.title", rows: rankNowRows(rows).slice(0, 5) }];
}

export async function newOrderCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const since = new Date(now.getTime() - IPD_NEW_ORDER_HOURS * 3_600_000);
  const orders = await db.select().from(ipdOrders).where(and(
    eq(ipdOrders.kind, "drug"), eq(ipdOrders.status, "active"), gte(ipdOrders.orderedAt, since), lt(ipdOrders.orderedAt, new Date(now.getTime() + 60_000)),
  ));
  if (orders.length === 0) return [];
  const acted = new Set((await db.select({ orderId: ipdEmarActs.orderId }).from(ipdEmarActs)
    .where(and(inArray(ipdEmarActs.orderId, orders.map((o) => o.id)), eq(ipdEmarActs.kind, "given")))).map((r) => r.orderId));
  const fresh = orders.filter((o) => !acted.has(o.id));
  if (fresh.length === 0) return [];
  const admissions = (await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, [...new Set(fresh.map((o) => o.admissionId))])))
    .filter((a) => (IPD_NURSING_STATES as readonly string[]).includes(a.state));
  if (admissions.length === 0) return [];
  const who = await nowIdentities(db, ctx.reader, admissions);
  const rows: NowRow[] = admissions.map((a) => {
    const mine = fresh.filter((o) => o.admissionId === a.id);
    const stat = mine.some((o) => o.frequency === "STAT");
    const waiting = mine.filter((o) => o.verification === "pending" || o.verification === "query").length;
    const toIssue = mine.filter((o) => o.verification === "verified" && o.issuedAt === null).length;
    const ready = mine.filter((o) => o.issuedAt !== null).length;
    const words = [
      waiting > 0 ? `${String(waiting)} with pharmacy` : null, toIssue > 0 ? `${String(toIssue)} to issue` : null, ready > 0 ? `${String(ready)} ready` : null,
    ].filter((x): x is string => x !== null).join(" · ");
    const oldest = mine.reduce((m, o) => (o.orderedAt < m ? o.orderedAt : m), mine[0]!.orderedAt);
    return {
      id: a.id, badge: "+", title: who.get(a.id)!.name, subtitle: nowSubtitle(who.get(a.id)!, `${stat ? "STAT · " : ""}${words}`), action: "Open",
      href: "/ipd/my-shift", severity: stat ? "hot" : "warn", waitMinutes: Math.max(0, minutesBetween(oldest, now)),
    };
  });
  return [{ key: "ipd.new_order", band: "now", titleKey: "desk.ipdNewOrder.title", rows: rankNowRows(rows).slice(0, 5) }];
}
