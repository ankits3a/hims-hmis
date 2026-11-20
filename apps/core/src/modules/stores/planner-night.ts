import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { argsHash } from "../../kernel/copilot/act";
import { withTx } from "../../kernel/db/client";
import { copilotActs, orgDepartments, storesPlannerDrafts, storesPlannerWarnings } from "../../kernel/db/schema";
import { recordAct } from "./access";
import { issuePacks, listStoresItems } from "./items";
import { planCentral } from "./planner-central";
import {
  PLANNER_AGENT, PROPOSAL_CAP, SHELF_NET_USE, activeLines, dailyUseAt, draftsHalted, historyAt, insertForecast, judgeShelfItem, liveWarning,
  mayOpenProposal, onHandAt, onWayAt, openDrafts, openProposalKeys, parsAt, plannerSettingsOf, shelvesOfDepartment,
} from "./planner-core";
import { HISTORY_WEEKS, meanAbsError, weeksOfHistory, weightedUsePerDay } from "./planner-math";
import { PLANNER_TOOLS } from "./planner";
import { suggestPars } from "./par-suggestions";
import { listShelves } from "./shelves";
import { raisePlannerTicketInTx } from "./tickets";
import type { ShelfSummary, StoresItemView } from "./types";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S7 (#1117, flow 1; decisions 2–9, 11, 12) — THE PLANNER'S NIGHT, 02:00 IST
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Rides S3's minute sweep (`runStoresChaser` → `runPlannerNightIfDue`, the buyer's and auditor's precedent: no new job
 * name). The night of D (the morning's IST date) runs once, at the first minute from 02:00 to 07:00 IST that finds no
 * `planner_night` act for it, in one transaction under an advisory lock (one pool client). In order:
 *   1. every Stores shelf item: a forecast row (decisions 2–4), then its warning or its end (5) and a draft line (6);
 *   2. open top-up drafts unsent for 24 h re-checked: a line whose warning ended is withdrawn, an empty draft too ("No
 *      longer needed");
 *   3. slow and dead stock (9): a shelf item with stock and no use in 90 days goes on the department's slow-stock card;
 *   4. the quarter's par suggestions (8), once per shelf item and quarter;
 *   5. the central store's shortfalls as `planner` purchase requests (7);
 *   6. T3 (11), only for a department the owner approved and the materials head switched on — OFF by default.
 * The copilot's draft halt stops 2–6 and every draft line; forecasts and warnings (T0) still run. Nothing here uses a model.
 */
export type PlannerNightRun = {
  halted: boolean; forecasts: number; warnings: number; drafts: string[]; withdrawn: number; slow: number; parSuggestions: number;
  centralPrs: string[]; t3Sent: number; halts: { departmentId: string; open: number }[];
};
export const PLANNER_NIGHT_FROM_HOUR = 2;
export const PLANNER_NIGHT_UNTIL_HOUR = 7;
export const SLOW_DAYS = 90;
const DAY_MS = 86_400_000;
const RECHECK_MS = DAY_MS;

const ex = (db: Db | Tx): Db => db as Db;

/** OPD visits per IST day over the 56 days before today (index 0 = yesterday), for a department that runs a clinic. */
async function visitsOf(db: Db | Tx, opdDepartmentId: string, today: string): Promise<number[]> {
  const rows = (await ex(db).execute(sql`select (${today}::date - service_date)::int - 1 as d, count(*)::int as n from opd_encounters
    where department_id = ${opdDepartmentId} and status <> 'abandoned' and service_date < ${today}::date and service_date >= (${today}::date - 56)
    group by 1`)).rows as { d: number; n: number }[];
  const out = Array.from({ length: 56 }, () => 0);
  for (const r of rows) if (r.d >= 0 && r.d < 56) out[r.d] = Number(r.n);
  return out;
}

/** Decision 4: a month factor from the same month last year, only with 12 months of history. Null otherwise. */
async function seasonFactor(db: Db | Tx, storeId: string, itemId: string, now: Date): Promise<number | null> {
  const yearAgo = new Date(now.getTime() - 365 * DAY_MS);
  const [r] = (await ex(db).execute(sql`select
      coalesce(sum(case when sl.occurred_at >= ${yearAgo.toISOString()}::timestamptz and sl.occurred_at < ${new Date(yearAgo.getTime() + 30 * DAY_MS).toISOString()}::timestamptz then ${SHELF_NET_USE} else 0 end), 0)::float8 as month,
      coalesce(sum(case when sl.occurred_at >= ${yearAgo.toISOString()}::timestamptz and sl.occurred_at < ${now.toISOString()}::timestamptz then ${SHELF_NET_USE} else 0 end), 0)::float8 as year
    from stock_ledger sl where sl.resource_id = ${storeId} and sl.item_id = ${itemId}`)).rows as { month: number; year: number }[];
  const avg30 = (Number(r?.year ?? 0) / 365) * 30;
  if (avg30 <= 0) return null;
  return Number(r?.month ?? 0) / avg30;
}

async function nightShelf(
  tx: Tx, shelf: ShelfSummary & { departmentId: string; departmentCode: string }, items: Map<string, StoresItemView>, now: Date, drafts: boolean, run: PlannerNightRun,
): Promise<void> {
  const hist = await historyAt(tx, shelf.id, now, "shelf");
  const pars = await parsAt(tx, shelf.id);
  const ids = [...new Set([...hist.keys(), ...pars.keys()])].filter((i) => items.get(i)?.trackMode === "shelf");
  if (ids.length === 0) return;
  const [have, way, packs] = await Promise.all([onHandAt(tx, shelf.id, ids), onWayAt(tx, shelf.id), issuePacks(tx, ids)]);
  const today = istDayString(now);
  const [dept] = await tx.select({ opd: orgDepartments.opdDepartmentId }).from(orgDepartments).where(eq(orgDepartments.id, shelf.departmentId));
  const visits = dept?.opd == null ? null : await visitsOf(tx, dept.opd, today);
  const visits56 = visits === null ? 0 : visits.reduce((a, b) => a + b, 0);
  const ctx = { id: shelf.id, departmentId: shelf.departmentId, departmentCode: shelf.departmentCode };
  for (const id of ids) {
    const h = hist.get(id) ?? { firstAt: null, weekly: Array.from({ length: HISTORY_WEEKS }, () => 0), total: 0 };
    const weeks = weeksOfHistory(h.firstAt, now);
    let method: "learning" | "plain" | "workload" = "learning";
    let usePerDay: number;
    let error: Record<string, number> | null = null;
    let factor: number | null = null;
    if (weeks < HISTORY_WEEKS) {
      const days = h.firstAt === null ? 1 : Math.max(1, (now.getTime() - h.firstAt.getTime()) / DAY_MS);
      usePerDay = h.total / days;
    } else {
      method = "plain";
      usePerDay = weightedUsePerDay(h.weekly);
      if (visits !== null && visits56 > 0) {
        // Decision 3: the workload form only when it beat plain use on the last 4 weeks' error (measured, stored).
        const daily = await dailyUseAt(tx, shelf.id, id, today, 28);
        const perVisit = h.total / visits56;
        const plainErr = meanAbsError(daily, daily.map(() => usePerDay));
        const workErr = meanAbsError(daily, visits.slice(0, 28).map((v) => v * perVisit));
        error = { plain: plainErr, workload: workErr };
        if (workErr < plainErr) {
          method = "workload";
          const same = [6, 13, 20, 27].map((d) => visits[d] ?? 0);
          usePerDay = perVisit * (same.reduce((a, b) => a + b, 0) / same.length);
        }
      }
      if (h.firstAt !== null && now.getTime() - h.firstAt.getTime() >= 365 * DAY_MS) {
        factor = await seasonFactor(tx, shelf.id, id, now);
        if (factor !== null) usePerDay *= factor;
      }
    }
    const par = pars.get(id) ?? null;
    const onHand = have.get(id) ?? 0;
    const onWay = way.get(id) ?? 0;
    const f = await insertForecast(tx, {
      storeId: shelf.id, itemId: id, departmentId: shelf.departmentId, scope: "shelf", method, weeks, usePerDay, onHand, onWay,
      minBase: par?.minBase ?? null, reorderBase: par?.reorderBase ?? null, maxBase: par?.maxBase ?? null,
      hoursToZero: usePerDay > 0 ? (onHand + onWay) / (usePerDay / 24) : null,
      inputs: {
        window: { from: new Date(now.getTime() - HISTORY_WEEKS * 7 * DAY_MS).toISOString(), to: now.toISOString() }, weekly: h.weekly, method, error, factor,
        firstAt: h.firstAt?.toISOString() ?? null, visits56: visits === null ? null : visits56,
      },
      at: now,
    });
    run.forecasts += 1;
    const r = await judgeShelfItem(tx, ctx, { id, pack: packs.get(id)?.multiplier ?? 1 }, f, par, "night", now, { drafts });
    if (r.warned) run.warnings += 1;
    if (r.draftId !== null && !run.drafts.includes(r.draftId)) run.drafts.push(r.draftId);
  }
}

/** Decision 6: a top-up draft unsent for 24 h is re-checked; a line whose warning ended goes, and an empty draft is withdrawn. */
async function withdrawStale(tx: Tx, shelfIds: readonly string[], now: Date): Promise<number> {
  let withdrawn = 0;
  for (const d of await openDrafts(tx, shelfIds, "topup")) {
    if (now.getTime() - d.at.getTime() < RECHECK_MS) continue;
    const lines = await activeLines(tx, [d.draftId]);
    let left = lines.length;
    for (const l of lines) {
      const live = await liveWarning(tx, l.storeId, l.itemId!);
      if (live !== null && live.id === l.warningId) continue;
      left -= 1;
      await tx.insert(storesPlannerDrafts).values({
        id: newId(), draftId: d.draftId, kind: "line_withdrawn", proposal: "topup", storeId: d.storeId, departmentId: d.departmentId, itemId: l.itemId,
        reason: "stock_arrived", by: PLANNER_AGENT.id, at: now,
      });
      await recordAct(tx, PLANNER_AGENT, now, { act: "planner_withdraw", storeId: d.storeId, itemId: l.itemId, refId: d.draftId, reason: "stock_arrived" });
    }
    if (left === 0) {
      await tx.insert(storesPlannerDrafts).values({
        id: newId(), draftId: d.draftId, kind: "withdrawn", proposal: "topup", storeId: d.storeId, departmentId: d.departmentId, reason: "stock_arrived",
        by: PLANNER_AGENT.id, at: now,
      });
      await recordAct(tx, PLANNER_AGENT, now, { act: "planner_withdraw", storeId: d.storeId, refId: d.draftId, reason: "no_longer_needed" });
      withdrawn += 1;
    }
  }
  return withdrawn;
}

/** Decision 9: shelf items with stock and no use in 90 days, each put on a slow-stock card at most once in 90 days. */
async function slowShelf(tx: Tx, shelf: ShelfSummary & { departmentId: string; departmentCode: string }, now: Date): Promise<number> {
  const since = new Date(now.getTime() - SLOW_DAYS * DAY_MS);
  const rows = (await tx.execute(sql`select sl.item_id, min(sl.occurred_at) as first,
      coalesce(sum(case when sl.occurred_at >= ${since.toISOString()}::timestamptz then ${SHELF_NET_USE} else 0 end), 0)::int as used
    from stock_ledger sl join items i on i.id = sl.item_id and i.track_mode = 'shelf'
    where sl.resource_id = ${shelf.id} group by sl.item_id`)).rows as { item_id: string; first: string | Date; used: number }[];
  const have = await onHandAt(tx, shelf.id);
  const idle = rows.filter((r) => new Date(r.first).getTime() <= since.getTime() && Number(r.used) === 0 && (have.get(r.item_id) ?? 0) > 0).map((r) => r.item_id);
  if (idle.length === 0) return 0;
  const recent = new Set((await tx.select({ itemId: storesPlannerDrafts.itemId }).from(storesPlannerDrafts).where(and(
    eq(storesPlannerDrafts.storeId, shelf.id), eq(storesPlannerDrafts.proposal, "slow"), eq(storesPlannerDrafts.kind, "line"),
    sql`${storesPlannerDrafts.at} > ${since.toISOString()}::timestamptz`,
  ))).map((r) => r.itemId));
  const add = idle.filter((i) => !recent.has(i));
  if (add.length === 0) return 0;
  let [open] = await openDrafts(tx, [shelf.id], "slow");
  if (open === undefined) {
    if (!(await mayOpenProposal(tx, shelf.departmentId, shelf.departmentCode, "slow", now))) return 0;
    const draftId = newId();
    open = {
      id: draftId, draftId, kind: "open", proposal: "slow", storeId: shelf.id, departmentId: shelf.departmentId, itemId: null, qty: null, warningId: null,
      forecastId: null, indentId: null, reason: null, data: null, by: PLANNER_AGENT.id, at: now,
    };
    await tx.insert(storesPlannerDrafts).values(open);
  }
  for (const itemId of add) {
    await tx.insert(storesPlannerDrafts).values({
      id: newId(), draftId: open.draftId, kind: "line", proposal: "slow", storeId: shelf.id, departmentId: shelf.departmentId, itemId,
      qty: have.get(itemId) ?? null, by: PLANNER_AGENT.id, at: now, data: { noUseDays: SLOW_DAYS },
    });
  }
  await recordAct(tx, PLANNER_AGENT, now, { act: "planner_slow", storeId: shelf.id, refId: open.draftId, lines: add.map((itemId) => ({ itemId, onHand: have.get(itemId) ?? 0 })) });
  return add.length;
}

/** Decision 11, T3: a department's open top-up sections sent without the in-charge's tap — the HOD still approves. */
async function autoSend(tx: Tx, departmentId: string, now: Date): Promise<number> {
  let sent = 0;
  for (const d of await openDrafts(tx, await shelvesOfDepartment(tx, departmentId), "topup")) {
    const lines = await activeLines(tx, [d.draftId]);
    if (lines.length === 0) continue;
    const warns = lines.map((l) => l.warningId).filter((x): x is string => x !== null);
    const urgent = warns.length > 0 && (await tx.select({ u: storesPlannerWarnings.urgent }).from(storesPlannerWarnings).where(inArray(storesPlannerWarnings.id, warns))).some((w) => w.u);
    const ticket = await raisePlannerTicketInTx(tx, PLANNER_AGENT, {
      shelfId: d.storeId, lines: lines.map((l) => ({ itemId: l.itemId!, qtyBase: l.qty! })), priority: urgent ? "urgent" : "routine", draftId: d.draftId,
    }, now);
    const confirmId = `st_${d.draftId}`;
    const actId = newId();
    const sentLines = lines.map((l) => ({ itemId: l.itemId!, plannerQty: l.qty!, qty: l.qty! }));
    await tx.insert(copilotActs).values({
      id: actId, at: now, actorId: PLANNER_AGENT.id, tool: PLANNER_TOOLS.t3, subjectPatientId: null, argsHash: argsHash({ draftId: d.draftId, lines: sentLines }),
      proposalId: d.draftId, confirmId, resultModule: "stores", resultRowId: ticket.id,
    });
    await tx.insert(storesPlannerDrafts).values({
      id: newId(), draftId: d.draftId, kind: "sent", proposal: "topup", storeId: d.storeId, departmentId, indentId: ticket.id, by: PLANNER_AGENT.id, at: now,
      data: { lines: sentLines, t3: true, confirmId, actId },
    });
    await recordAct(tx, PLANNER_AGENT, now, {
      act: "planner_send", storeId: d.storeId, refId: d.draftId, after: { indentId: ticket.id, indentNo: ticket.indentNo, t3: true, confirmId, actId }, lines: sentLines,
    });
    sent += 1;
  }
  return sent;
}

export async function runPlannerNight(db: Db, now: Date = new Date()): Promise<PlannerNightRun> {
  const run: PlannerNightRun = { halted: false, forecasts: 0, warnings: 0, drafts: [], withdrawn: 0, slow: 0, parSuggestions: 0, centralPrs: [], t3Sent: 0, halts: [] };
  const halted = await draftsHalted(db, now);
  run.halted = halted;
  const items = new Map((await listStoresItems(db)).map((i) => [i.id, i] as const));
  const shelves = (await listShelves(db)).filter((s): s is ShelfSummary & { departmentId: string; departmentCode: string } => s.departmentId !== null && s.departmentCode !== null);
  const paused = new Map<string, boolean>();
  for (const d of new Set(shelves.map((s) => s.departmentId))) paused.set(d, (await plannerSettingsOf(db, d)).paused);
  const live = shelves.filter((s) => paused.get(s.departmentId) !== true);
  // One shelf per transaction: one pool client at a time, and a failure at one shelf leaves the others' rows standing.
  for (const s of live) await withTx(db, (tx) => nightShelf(tx, s, items, now, !halted, run));
  if (!halted) {
    run.withdrawn = await withTx(db, (tx) => withdrawStale(tx, live.map((s) => s.id), now));
    for (const s of live) run.slow += await withTx(db, (tx) => slowShelf(tx, s, now));
    run.parSuggestions = await suggestPars(db, now);
    run.centralPrs = (await planCentral(db, now)).prIds;
    for (const d of new Set(live.map((s) => s.departmentId))) {
      const st = await plannerSettingsOf(db, d);
      if (st.t3 && st.ownerApproved) run.t3Sent += await withTx(db, (tx) => autoSend(tx, d, now));
    }
  }
  for (const d of new Set(shelves.map((s) => s.departmentId))) {
    const n = (await openProposalKeys(db, d)).length;
    if (n >= PROPOSAL_CAP) run.halts.push({ departmentId: d, open: n });
  }
  await withTx(db, (tx) => recordAct(tx, PLANNER_AGENT, now, {
    act: "planner_night", refId: null,
    after: {
      night: plannerNightOf(now) ?? istDayString(now), halted, forecasts: run.forecasts, warnings: run.warnings, drafts: run.drafts.length, withdrawn: run.withdrawn,
      slow: run.slow, parSuggestions: run.parSuggestions, centralPrs: run.centralPrs, t3Sent: run.t3Sent, halts: run.halts,
    },
  }));
  return run;
}

/** The night of the IST morning between 02:00 and 07:00; null at any other hour. */
export function plannerNightOf(now: Date): string | null {
  const { start } = istDayWindow(now);
  const hours = (now.getTime() - start.getTime()) / 3_600_000;
  return hours >= PLANNER_NIGHT_FROM_HOUR && hours < PLANNER_NIGHT_UNTIL_HOUR ? istDayString(now) : null;
}

/** On the chaser's minute: run the night once (a `planner_night` act marks it run), under an advisory lock. */
export async function runPlannerNightIfDue(db: Db, now: Date = new Date()): Promise<PlannerNightRun | null> {
  const night = plannerNightOf(now);
  if (night === null) return null;
  const since = new Date(now.getTime() - 36 * 3_600_000);
  const ran = async (exec: Db | Tx): Promise<boolean> => (await ex(exec).execute(sql`
    select 1 from events where name = 'stores.act_recorded' and recorded_at >= ${since.toISOString()}::timestamptz
      and payload->>'act' = 'planner_night' and payload->'after'->>'night' = ${night} limit 1`)).rows.length > 0;
  if (await ran(db)) return null;
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('stores-planner-night'))`);
    if (await ran(tx)) return null;
    return runPlannerNight(tx as unknown as Db, now);
  });
}
