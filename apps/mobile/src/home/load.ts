import { ApiError, NetworkError } from "../api";
import { doctorApi } from "../doctor/api";
import { rosterApi } from "../roster/api";
import { vitalsApi } from "../vitals/api";
import { istDay } from "../doctor/rules";
import type { Call } from "../doctor/api";
import type { Seat } from "../seats";
import type { RecordingReport } from "./recorded";
import { loadOwnerReads } from "../owner/load";
import { ownerTilesFor, type OwnerReads, type OwnerTileKey } from "../owner/model";
import type { CountSince, Hospital, Sources, WireApproval, WireBriefLite, WireMyRequest, WirePaperItem, WireTeam } from "./model";

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

type Report = { sections: { key: string; columnKeys: string[]; rows: string[][] }[] };
type Appointments = { items: { serviceDate: string; status: string }[] };
type SentBack = { items: { recheck?: { askedAt: string } | null }[]; toType?: number };

/** What the header says about the person — theirs to read, from reads they already may make. */
export type HeaderFacts = { doctor: { displayName: string; departmentName: string | null; unit: string | null } | null; hospitalWide: boolean };
/** The owner's and the Medical Superintendent's tiles (owner 2026-10-09): which ones, and one read each. Null for everybody else. */
export type OwnerHome = { keys: OwnerTileKey[]; reads: OwnerReads };
export type Loaded = { sources: Sources; reached: boolean; header: HeaderFacts; unread: number | null; recording: RecordingReport | null; owner: OwnerHome | null };

/** "09:30" on `day` (IST) as an instant. */
const istAt = (d: string, hhmm: string): number | null => {
  const t = new Date(`${d}T${/^\d{2}:\d{2}$/.test(hhmm) ? hhmm : "00:00"}:00+05:30`).getTime();
  return Number.isNaN(t) ? null : t;
};
/** Still on the hospital's hands: seated, not yet with a doctor. */
const STILL_WAITING = new Set(["registered", "waiting"]);

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

  /* The tile home replaces the two hospital reads below (by department, 30 days of collections) with one read per tile. */
  const ownerKeys = ownerTilesFor(permissions);
  const tiles = ownerKeys !== null;
  const me = seats.includes("consult") ? await soft(() => doctor.me()) : null;
  const ownerReads = ownerKeys === null ? null : loadOwnerReads(call, ownerKeys, nowMs);
  const [queue, paper, duties, bench, slips, approvals, dayBrief, week, month, desk, team, onNow, byDept, byDay, depts, report, stranded, mine, sent, bell, units, recording] = await Promise.all([
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
    has("staff.reports.read") && !tiles ? soft(() => call<Range>("GET", `/staff/range?from=${today}&to=${today}&groupBy=departmentId`)) : null,
    has("staff.reports.read") && !tiles ? soft(() => call<Range>("GET", `/staff/range?from=${addDays(today, -29)}&to=${today}&groupBy=day`)) : null,
    (has("staff.reports.read") && !tiles) || me !== null ? soft(() => call<{ items?: { id: string; name: string }[] } | { id: string; name: string }[]>("GET", "/opd/departments")) : null,
    seats.includes("counter") ? soft(() => call<Report>("GET", `/me/report?date=${today}`)) : null,
    seats.includes("counter") && has("opd.appointments.read") ? soft(() => call<Appointments>("GET", "/opd/appointments?needsRebooking=true")) : null,
    has("approvals.requests.create") ? soft(() => call<{ items: WireMyRequest[] }>("GET", "/approvals/mine")) : null,
    has("opd.prescription.transcribe") ? soft(() => call<SentBack>("GET", "/opd/paper/sent-back")) : null,
    soft(() => call<{ unreadCount: number }>("GET", "/alerts")),
    me === null ? null : soft(() => doctor.doctorUnits(today)),
    /* Is today being recorded? The server decides what this login sees (owner 2026-10-07). */
    soft(() => call<RecordingReport>("GET", "/opd/reports/recording")),
  ]);

  /* The front desk's own two: who I seated is still waiting (my report's rows), whose booking is stranded. */
  let deskWaiting: CountSince | null = null;
  const visits = report?.sections.find((sec) => sec.key === "opd.myVisits") ?? null;
  if (visits !== null) {
    const statusAt = visits.columnKeys.indexOf("report.col.status"), timeAt = visits.columnKeys.indexOf("report.col.time");
    const waiting = visits.rows.filter((r) => STILL_WAITING.has(r[statusAt === -1 ? r.length - 1 : statusAt] ?? ""));
    const times = waiting.map((r) => istAt(today, r[timeAt === -1 ? 0 : timeAt] ?? "")).filter((t): t is number => t !== null);
    deskWaiting = { count: waiting.length, oldestMs: times.length === 0 ? null : Math.min(...times) };
  }
  let rebook: CountSince | null = null;
  if (stranded !== null) {
    const ahead = stranded.items.filter((a) => a.status === "needs_rebooking" && a.serviceDate >= today);
    const days = ahead.map((a) => istAt(a.serviceDate, "00:00")).filter((t): t is number => t !== null);
    rebook = { count: ahead.length, oldestMs: days.length === 0 ? null : Math.min(...days) };
  }
  let sentBack: CountSince | null = null;
  if (sent !== null) {
    const asked = sent.items.map((i) => (i.recheck == null ? null : new Date(i.recheck.askedAt).getTime())).filter((t): t is number => t !== null && !Number.isNaN(t));
    sentBack = { count: sent.items.length, oldestMs: asked.length === 0 ? null : Math.min(...asked) };
  }

  const paperItems: WirePaperItem[] | null = paper === null ? null : paper.items.map((p) => ({
    encounterId: p.encounterId, held: p.held !== null && p.held !== undefined, confirmed: p.confirmedAt !== null, since: p.paperCompletedAt,
  }));

  /* Blind count: the cashier's card arrives WITHOUT a collected figure while the drawer is uncounted. */
  const money = desk?.cards.find((c) => c.key === "billing.myCollections") ?? null;
  const receipts = money?.stats?.find((s) => s.key === "desk.billing.receipts")?.value ?? null;
  const blind = money !== null && dayBrief !== null && dayBrief.totals["billing.collectedPaise"] === undefined;

  let hospital: Hospital | null = null;
  /* Tiles: the hospital-wide header and the roster-gap card stay; the blocks they replaced carry nothing. */
  if (tiles) hospital = { byDepartment: [], collectedTodayPaise: null, collections: [] };
  else if (has("staff.reports.read") && (byDept !== null || byDay !== null)) {
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
    deskWaiting, rebook, myRequests: mine?.items ?? null, sentBack, toType: sent?.toType ?? null,
  };
  const deptList = depts === null ? [] : Array.isArray(depts) ? depts : (depts.items ?? []);
  const header: HeaderFacts = {
    doctor: me === null ? null : {
      displayName: me.displayName,
      departmentName: deptList.find((d) => d.id === me.departmentId)?.name ?? null,
      unit: units?.find((u) => u.userId === me.userId)?.short ?? null,
    },
    hospitalWide: hospital !== null,
  };
  let owner: OwnerHome | null = null;
  if (ownerKeys !== null && ownerReads !== null) {
    const reads = await ownerReads;
    owner = { keys: ownerKeys, reads: { ...reads, recorded: recording !== null && recording.totals !== null ? recording : null } };
  }
  return { sources, reached: reached || !offline, header, unread: bell === null ? null : bell.unreadCount, recording, owner };
}
