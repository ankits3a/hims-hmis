import { ApiError, NetworkError } from "../api";
import { doctorApi } from "../doctor/api";
import { rosterApi } from "../roster/api";
import { vitalsApi } from "../vitals/api";
import { istDay } from "../doctor/rules";
import type { Call } from "../doctor/api";
import type { Seat } from "../seats";
import type { Hospital, Sources, WireApproval, WireBriefLite, WirePaperItem, WireTeam } from "./model";

/**
 * APP HOME — the reads behind the first screen, asked together. Each one is asked only when the
 * person holds its permission, and each fails SOFT: a card whose read failed is simply not drawn,
 * the rest of the home still is. Only "nothing at all reached the server" is the offline state.
 *
 * Nothing here is new to the server except `/me/team`, the deadline on an approval and the month's
 * day-by-day line; every other figure is the one the person's own screen already shows.
 */

type Desk = { cards: { key: string; stats?: { key: string; value: string }[] }[] };
type Paper = { items: { encounterId: string; held: unknown; confirmedAt: string | null; paperCompletedAt: string | null }[] };
type Range = { rows: { key: Record<string, string | undefined>; measures: Record<string, number> }[] };

const MONEY = "billing.collectedPaise";
const VISITS = "opd.visitsOpened";

export type Loaded = { sources: Sources; reached: boolean };

const day = (ms: number): string => istDay(new Date(ms).toISOString());
const addDays = (d: string, n: number): string => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export async function loadHome(call: Call, permissions: readonly string[], seats: readonly Seat["key"][], nowMs: number): Promise<Loaded> {
  let reached = false;
  let offline = false;
  async function soft<T>(run: () => Promise<T>): Promise<T | null> {
    try { const v = await run(); reached = true; return v; } catch (e) {
      if (e instanceof NetworkError) offline = true;
      else if (e instanceof ApiError) reached = true;
      return null;
    }
  }
  const has = (p: string): boolean => permissions.includes(p);
  const today = day(nowMs);
  const doctor = doctorApi(call), roster = rosterApi(call), vitals = vitalsApi(call);

  const me = seats.includes("consult") ? await soft(() => doctor.me()) : null;
  const [queue, paper, duties, bench, slips, approvals, dayBrief, week, month, desk, team, onNow, byDept, byDay, depts] = await Promise.all([
    me === null ? null : soft(() => doctor.queue(me.id, today)),
    me === null ? null : soft(() => call<Paper>("GET", "/opd/paper/consults?scope=mine")),
    seats.includes("myDuties") ? soft(() => roster.myDuties()) : null,
    seats.includes("vitals") ? soft(() => vitals.bench(today)) : null,
    seats.includes("slips") && has("opd.consult.paper") ? soft(() => call<{ counts: { waiting: number; retake: number; filed: number } }>("GET", "/opd/slips/today")) : null,
    has("approvals.requests.read") ? soft(() => call<{ items: WireApproval[] }>("GET", "/approvals?status=pending&limit=50")) : null,
    soft(() => call<WireBriefLite>("GET", "/me/brief?period=day")),
    soft(() => call<WireBriefLite>("GET", "/me/brief?period=week")),
    soft(() => call<WireBriefLite>("GET", "/me/brief?period=month")),
    soft(() => call<Desk>("GET", "/me/desk")),
    soft(() => call<WireTeam>("GET", "/me/team")),
    has("staff.reports.read") && seats.includes("onNow") ? soft(() => roster.onNow()) : null,
    has("staff.reports.read") ? soft(() => call<Range>("GET", `/staff/range?from=${today}&to=${today}&groupBy=departmentId`)) : null,
    has("staff.reports.read") ? soft(() => call<Range>("GET", `/staff/range?from=${addDays(today, -29)}&to=${today}&groupBy=day`)) : null,
    has("staff.reports.read") ? soft(() => call<{ items?: { id: string; name: string }[] } | { id: string; name: string }[]>("GET", "/opd/departments")) : null,
  ]);

  const paperItems: WirePaperItem[] | null = paper === null ? null : paper.items.map((p) => ({
    encounterId: p.encounterId, held: p.held !== null && p.held !== undefined, confirmed: p.confirmedAt !== null, since: p.paperCompletedAt,
  }));

  /* Blind count: the cashier's card arrives WITHOUT a collected figure while the drawer is uncounted. */
  const money = desk?.cards.find((c) => c.key === "billing.myCollections") ?? null;
  const receipts = money?.stats?.find((s) => s.key === "desk.billing.receipts")?.value ?? null;
  const blind = money !== null && dayBrief !== null && dayBrief.totals["billing.collectedPaise"] === undefined;

  let hospital: Hospital | null = null;
  if (has("staff.reports.read") && (byDept !== null || byDay !== null)) {
    const list = depts === null ? [] : Array.isArray(depts) ? depts : (depts.items ?? []);
    const nameOf = new Map(list.map((d) => [d.id, d.name] as const));
    const collections = Array.from({ length: 30 }, (_, i) => {
      const d = addDays(today, i - 29);
      return { day: d, value: byDay?.rows.find((r) => r.key.day === d)?.measures[MONEY] ?? 0 };
    });
    hospital = {
      byDepartment: (byDept?.rows ?? [])
        .map((r) => ({ name: nameOf.get(r.key.departmentId ?? "") ?? r.key.departmentId ?? "—", value: r.measures[VISITS] ?? 0 }))
        .filter((r) => r.value > 0).sort((a, b) => b.value - a.value),
      collectedTodayPaise: byDay === null ? null : (collections[29]?.value ?? 0),
      collections,
    };
  }

  const sources: Sources = {
    nowMs, permissions, seats,
    queue: queue !== null && "ordered" in queue ? queue : null,
    paper: paperItems, duties, bench: bench?.items ?? null, slips: slips?.counts ?? null,
    approvals: approvals?.items ?? null, day: dayBrief, week, month,
    blind, receiptsToday: receipts === null ? null : Number(receipts),
    hospital, onNow, team,
  };
  return { sources, reached: reached || !offline };
}
