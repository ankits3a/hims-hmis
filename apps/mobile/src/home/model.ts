import {
  bestDay, capNeeds, clockWords, percentAgainst, toneOf,
  type ClockWords, type DayPoint, type Need, type NeedKind, type Tone,
} from "./rules";
import { longestWait, shortDay } from "../doctor/rules";
import type { WireQueueView } from "../doctor/rules";
import type { WireMyDuties, WireOnNowBoard } from "../roster/rules";
import type { WireBenchRow } from "../vitals/rules";
import type { Seat } from "../seats";

/**
 * APP HOME (owner 2026-10-07, decision 0042) — WHAT THE FIRST SCREEN SAYS, worked out from reads the
 * app already makes (the doctor's line, the bench, the slips, the roster, the approvals inbox, the
 * person's own brief). Pure: the same sources always give the same screen, so every rule here is a
 * test — which five cards lead, what the clock says, what a cashier may not see.
 *
 * Words never live here: every string is an i18n KEY and its parts. Patient names never do either —
 * a home screen is read over a shoulder, so cards carry counts, tokens and staff names only.
 */

export type Vars = Record<string, string | number>;
export type HomeAction =
  | { type: "seat"; key: Seat["key"] }
  | { type: "approval"; id: string; decide: "open" }
  | { type: "cover"; requestId: string; accept: boolean }
  | { type: "paper" };

export type NeedCard = Need & {
  /** The big figure before the title, when the card is a count. */
  count: number | null;
  titleKey: string; titleVars?: Vars;
  subKey: string | null; subVars?: Vars;
  /** Free text the server already aliased or that names STAFF (a requester, a colleague) — never a patient. */
  subText?: string | null;
  clock: ClockWords | null;
  /** One primary button; a cover request carries Yes and No. */
  actions: { labelKey: string; primary: boolean; action: HomeAction }[];
};

export type Tile = { key: string; labelKey: string; value: string | null; lockKey?: string; lockVars?: Vars };
export type Analytics = {
  titleKey: string; money: boolean; series: DayPoint[];
  week: string | null; usual: string | null; pct: number | null; best: DayPoint | null; total: string | null;
};
export type WorkTile = { key: Seat["key"]; badgeKey: string | null; badgeVars?: Vars; live: boolean };

export type WireApproval = {
  id: string; typeKey: string; amountPaise: number | null; requestedAt: string; dueAt: string | null;
  requesterName: string | null; requestNote: string | null;
  patient: { name: string | null; alias: string | null; restricted: boolean; uhid: string } | null;
};
export type WireBriefLite = {
  totals: Record<string, number>;
  clauses: { key: string; values: Record<string, string> }[];
  series?: { day: string; facts: Record<string, number> }[];
};
export type WirePaperItem = { encounterId: string; held: boolean; confirmed: boolean; since: string | null };
export type WireTeam = { members: { userId: string; name: string; today: Record<string, number>; month: Record<string, number>; daysWithActivity: number }[] };
export type Hospital = {
  byDepartment: { name: string; value: number }[];
  collectedTodayPaise: number | null;
  collections: DayPoint[];
};

export type Sources = {
  nowMs: number;
  permissions: readonly string[];
  seats: readonly Seat["key"][];
  queue?: WireQueueView | null;
  paper?: WirePaperItem[] | null;
  duties?: WireMyDuties | null;
  bench?: WireBenchRow[] | null;
  slips?: { waiting: number; retake: number; filed: number } | null;
  toType?: number | null;
  approvals?: WireApproval[] | null;
  day?: WireBriefLite | null;
  week?: WireBriefLite | null;
  month?: WireBriefLite | null;
  /** The cashier's drawer is not counted yet — the server sent no money (blind count, decision 0014). */
  blind?: boolean;
  receiptsToday?: number | null;
  hospital?: Hospital | null;
  onNow?: WireOnNowBoard | null;
  team?: WireTeam | null;
};

export type HomeModel = {
  needs: NeedCard[]; needsTotal: number; needsHidden: number; allNeeds: NeedCard[];
  tiles: Tile[];
  analytics: Analytics | null;
  hospital: Hospital | null;
  onDuty: { line: string; who: string | null }[];
  team: { name: string; userId: string; fact: string | null; primary: number; month: number; ratio: number }[];
  work: WorkTile[];
};

/** Rupees from paise, Indian grouping, no decimals on a tile ("₹14,300"); the sheet shows the paise. */
export function rupees(paise: number, decimals = false): string {
  const n = paise / 100;
  return `₹${n.toLocaleString("en-IN", decimals ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 })}`;
}

const FACT_OF_SEAT: Partial<Record<Seat["key"], string>> = {
  consult: "opd.consultsCompleted", vitals: "opd.vitalsRecorded", counter: "opd.visitsOpened",
};
const CLAUSE_OF_FACT: Record<string, string> = {
  "opd.patientsRegistered": "brief.registered", "opd.visitsOpened": "brief.visits", "opd.consultsCompleted": "brief.consults",
  "opd.vitalsRecorded": "brief.vitals", "opd.appointmentsBooked": "brief.appointments", "billing.receipts": "brief.receipts",
  "billing.collectedPaise": "brief.collected",
};
const TILE_FACTS: { fact: string; labelKey: string; money?: boolean }[] = [
  { fact: "opd.consultsCompleted", labelKey: "home.tile.seen" },
  { fact: "opd.vitalsRecorded", labelKey: "home.tile.vitals" },
  { fact: "opd.visitsOpened", labelKey: "home.tile.visits" },
  { fact: "opd.patientsRegistered", labelKey: "home.tile.registered" },
  { fact: "opd.appointmentsBooked", labelKey: "home.tile.appointments" },
  { fact: "billing.receipts", labelKey: "home.tile.receipts" },
];

const ms = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string") return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};
const numberIn = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && s.replace(/[^0-9]/g, "") !== "" ? n : null;
};

function need(kind: NeedKind, id: string, nowMs: number, sinceMs: number, dueMs: number | null, tone: Tone, rest: Omit<NeedCard, keyof Need>): NeedCard {
  void nowMs;
  return { id: `${kind}:${id}`, kind, sinceMs, dueMs, tone, ...rest };
}

/** The person this approval is about, as the SERVER named them for this reader — the alias for a sealed record. */
export function approvalWho(a: WireApproval): string | null {
  if (a.patient === null) return null;
  return a.patient.restricted || a.patient.name === null ? a.patient.alias : a.patient.name;
}

export function buildHome(src: Sources): HomeModel {
  const now = src.nowMs;
  const cards: NeedCard[] = [];
  const has = (p: string): boolean => src.permissions.includes(p);

  /* ── the doctor's own line ── */
  const q = src.queue;
  if (q !== undefined && q !== null && q.counts.waiting > 0) {
    const longest = longestWait(q.ordered, new Date(now));
    const since = longest === null ? now : now - longest * 60_000;
    cards.push(need("doctor_queue", q.session.id, now, since, null, toneOf(now, since, null, { amberAfterMin: 20, redAfterMin: 40 }), {
      count: q.counts.waiting, titleKey: "home.need.queue", subKey: "home.need.queueSub",
      clock: clockWords(now, since, null), actions: [{ labelKey: "home.act.callNext", primary: true, action: { type: "seat", key: "consult" } }],
    }));
  }

  /* ── paper consultations: held medicines first, then the ones to look at ── */
  const paper = src.paper ?? [];
  const held = paper.filter((p) => p.held);
  if (held.length > 0) {
    const since = Math.min(...held.map((p) => ms(p.since) ?? now));
    cards.push(need("held_medicine", "today", now, since, null, toneOf(now, since, null, { amberAfterMin: 15, redAfterMin: 60 }), {
      count: held.length, titleKey: "home.need.held", subKey: "home.need.heldSub",
      clock: clockWords(now, since, null), actions: [{ labelKey: "home.act.decide", primary: true, action: { type: "paper" } }],
    }));
  }
  const toConfirm = paper.filter((p) => !p.held && !p.confirmed);
  if (toConfirm.length > 0) {
    const since = Math.min(...toConfirm.map((p) => ms(p.since) ?? now));
    cards.push(need("paper_confirm", "today", now, since, null, "neutral", {
      count: toConfirm.length, titleKey: "home.need.paper", subKey: "home.need.paperSub",
      clock: clockWords(now, since, null), actions: [{ labelKey: "home.act.look", primary: false, action: { type: "paper" } }],
    }));
  }

  /* ── cover and swap requests that are mine to answer — due by the duty's start ── */
  for (const r of src.duties?.requests ?? []) {
    if (!r.youMay.answer || r.status !== "asked") continue;
    const since = ms(r.requestedAt) ?? now;
    const due = ms(r.duty.startsAt);
    cards.push(need("cover_request", r.requestId, now, since, due, toneOf(now, since, due), {
      count: null, titleKey: r.kind === "swap" ? "home.need.swap" : "home.need.cover", titleVars: { name: r.requestedBy.name },
      subKey: null, subText: r.duty.istDate, clock: due === null ? clockWords(now, since, null) : clockWords(now, since, due, "due"),
      actions: [
        { labelKey: "home.act.yes", primary: true, action: { type: "cover", requestId: r.requestId, accept: true } },
        { labelKey: "home.act.no", primary: false, action: { type: "cover", requestId: r.requestId, accept: false } },
      ],
    }));
  }

  /* ── the vitals bench ── */
  const bench = src.bench ?? null;
  if (bench !== null) {
    const due = bench.filter((b) => b.recallAt !== null && (ms(b.recallAt) ?? Infinity) <= now);
    if (due.length > 0) {
      const oldest = Math.min(...due.map((b) => ms(b.recallAt) ?? now));
      cards.push(need("vitals_recheck", "today", now, oldest, oldest, "red", {
        count: due.length, titleKey: "home.need.recheck", subKey: "home.need.recheckSub",
        clock: clockWords(now, oldest, oldest, "due"), actions: [{ labelKey: "home.act.openBench", primary: true, action: { type: "seat", key: "vitals" } }],
      }));
    }
    const waiting = bench.filter((b) => !b.vitalsDone && b.benchState === null);
    if (waiting.length > 0) {
      cards.push(need("vitals_bench", "today", now, now, null, waiting.length >= 5 ? "amber" : "neutral", {
        count: waiting.length, titleKey: "home.need.bench", subKey: "home.need.benchSub", clock: null,
        actions: [{ labelKey: "home.act.scan", primary: due.length === 0, action: { type: "seat", key: "vitals" } }],
      }));
    }
  }

  /* ── the slip desk ── */
  if (src.slips !== undefined && src.slips !== null && src.slips.waiting + src.slips.retake > 0) {
    const n = src.slips.waiting + src.slips.retake;
    cards.push(need("slips_waiting", "today", now, now, null, n >= 5 ? "amber" : "neutral", {
      count: n, titleKey: "home.need.slips", subKey: src.slips.retake > 0 ? "home.need.slipsRetake" : "home.need.slipsSub", subVars: { n: src.slips.retake }, clock: null,
      actions: [{ labelKey: "home.act.scanSlip", primary: true, action: { type: "seat", key: "slips" } }],
    }));
  }

  /* ── approvals waiting on me, each with its own clock ── */
  for (const a of src.approvals ?? []) {
    const since = ms(a.requestedAt) ?? now;
    const due = ms(a.dueAt);
    const who = approvalWho(a);
    cards.push(need("approval", a.id, now, since, due, toneOf(now, since, due), {
      count: null, titleKey: `home.kind.${a.typeKey}`, titleVars: { amount: a.amountPaise === null ? "" : rupees(a.amountPaise) },
      subKey: a.requesterName === null ? null : "home.need.askedBy", subVars: { name: a.requesterName ?? "" }, subText: who,
      clock: clockWords(now, since, due),
      actions: has("approvals.requests.decide")
        ? [{ labelKey: "home.act.review", primary: true, action: { type: "approval", id: a.id, decide: "open" } }]
        : [],
    }));
  }

  /* ── a gap on tonight's roster, for whoever reads the whole board's holes ── */
  const holes = (src.onNow?.holes ?? []).filter((h) => (ms(h.from) ?? 0) > now - 60_000 && (ms(h.from) ?? Infinity) < now + 24 * 3_600_000);
  if (src.hospital !== undefined && src.hospital !== null && holes.length > 0) {
    const first = Math.min(...holes.map((h) => ms(h.from) ?? now));
    cards.push(need("roster_gap", "today", now, now, first, toneOf(now, first - 12 * 3_600_000, first), {
      count: holes.length, titleKey: "home.need.gap", subKey: null, subText: holes[0]!.departmentName,
      clock: clockWords(now, now, first, "starts"), actions: [{ labelKey: "home.act.see", primary: false, action: { type: "seat", key: "onNow" } }],
    }));
  }

  const capped = capNeeds(cards);

  /* ── my day: three numbers ── */
  const day = src.day?.totals ?? {};
  const tiles: Tile[] = [];
  if (q !== undefined && q !== null) {
    tiles.push({ key: "seen", labelKey: "home.tile.seen", value: String(q.counts.done) });
    tiles.push({ key: "waiting", labelKey: "home.tile.waiting", value: String(q.counts.waiting) });
    tiles.push({ key: "paper", labelKey: "home.tile.onPaper", value: String(paper.length) });
  }
  for (const f of TILE_FACTS) {
    if (tiles.length >= 3) break;
    if (q !== undefined && q !== null && f.fact === "opd.consultsCompleted") continue;
    const v = day[f.fact];
    if (v === undefined) continue;
    tiles.push({ key: f.fact, labelKey: f.labelKey, value: String(v) });
  }
  if (bench !== null && tiles.length < 3) tiles.push({ key: "bench", labelKey: "home.tile.bench", value: String(bench.filter((b) => !b.vitalsDone).length) });
  if (src.slips !== undefined && src.slips !== null && tiles.length < 3) tiles.push({ key: "slips", labelKey: "home.tile.slips", value: String(src.slips.filed) });
  /* Money: the cashier's own, and it is LOCKED until the drawer is counted. The owner's is the hospital's. */
  const collected = day["billing.collectedPaise"];
  if (src.hospital !== undefined && src.hospital !== null) {
    /* The owner's day is the HOSPITAL's: OPD today, collected today, what waits for a yes. */
    tiles.length = 0;
    tiles.push({ key: "opdToday", labelKey: "home.tile.opdToday", value: String(src.hospital.byDepartment.reduce((n, d) => n + d.value, 0)) });
    if (src.hospital.collectedTodayPaise !== null) tiles.push({ key: "collected", labelKey: "home.tile.collected", value: rupees(src.hospital.collectedTodayPaise) });
    tiles.push({ key: "approvals", labelKey: "home.tile.approvals", value: String(src.approvals?.length ?? 0) });
  } else if (src.blind === true) {
    /* The money tile always shows for a cashier — it takes the third place rather than falling off the row. */
    tiles.splice(2);
    tiles.push({ key: "collected", labelKey: "home.tile.collected", value: null, lockKey: "home.tile.afterCount", lockVars: { n: src.receiptsToday ?? 0 } });
  } else if (collected !== undefined) {
    tiles.splice(2);
    tiles.push({ key: "collected", labelKey: "home.tile.collected", value: rupees(collected) });
  }
  if (src.approvals !== undefined && src.approvals !== null && src.approvals.length > 0 && tiles.length < 4) {
    tiles.push({ key: "approvals", labelKey: "home.tile.approvals", value: String(src.approvals.length) });
  }
  const shownTiles = tiles.slice(0, 3);

  /* ── the last 30 days ── */
  let analytics: Analytics | null = null;
  if (src.hospital !== undefined && src.hospital !== null && src.hospital.collections.some((p) => p.value > 0)) {
    const s = src.hospital.collections;
    const last7 = s.slice(-7).reduce((n, p) => n + p.value, 0);
    const prior = s.slice(0, -7);
    const usual = prior.length >= 14 ? Math.round((prior.reduce((n, p) => n + p.value, 0) / prior.length) * 7) : null;
    const best = bestDay(s);
    analytics = {
      titleKey: "home.d30.collections", money: true, series: s, week: rupees(last7), usual: usual === null ? null : rupees(usual),
      pct: percentAgainst(last7, usual), best, total: rupees(s.reduce((n, p) => n + p.value, 0)),
    };
  } else if (src.month !== undefined && src.month !== null) {
    const fact = src.seats.map((k) => FACT_OF_SEAT[k]).find((f): f is string => f !== undefined && src.month!.totals[f] !== undefined)
      ?? TILE_FACTS.map((f) => f.fact).find((f) => src.month!.totals[f] !== undefined) ?? null;
    if (fact !== null) {
      const series = (src.month.series ?? []).map((d) => ({ day: d.day, value: d.facts[fact] ?? 0 }));
      const weekTotal = src.week?.totals[fact];
      const compared = src.week?.clauses.find((c) => c.key === `${CLAUSE_OF_FACT[fact] ?? "?"}.compared`);
      const usual = numberIn(compared?.values.median);
      analytics = {
        titleKey: "home.d30.title", money: false, series,
        week: weekTotal === undefined ? null : String(weekTotal), usual: usual === null ? null : String(usual),
        pct: weekTotal === undefined ? null : percentAgainst(weekTotal, usual), best: bestDay(series), total: String(src.month.totals[fact] ?? 0),
      };
    }
  }

  /* ── who is on duty (the owner's list) ── */
  const onDuty = src.hospital === undefined || src.hospital === null ? [] : (src.onNow?.departments ?? []).slice(0, 4).map((d) => ({
    line: d.unitOnTake === null ? d.name : `${d.name} · ${d.unitOnTake.name}`,
    who: d.inTheBuilding[0]?.name ?? d.inOpd?.find((p) => p.now)?.name ?? null,
  }));

  /* ── my team: each person by the thing THEY do most (a nurse by vitals, a clerk by visits) ── */
  const members = src.team?.members ?? [];
  const team = members.map((m) => {
    const fact = TILE_FACTS.map((f) => f.fact).reduce<string | null>((best, f) => ((m.month[f] ?? 0) > (best === null ? 0 : (m.month[best] ?? 0)) ? f : best), null);
    const primary = fact === null ? 0 : (m.today[fact] ?? 0), month = fact === null ? 0 : (m.month[fact] ?? 0);
    const usual = m.daysWithActivity > 0 ? month / m.daysWithActivity : 0;
    return { name: m.name, userId: m.userId, fact, primary, month, ratio: usual <= 0 ? 0 : Math.max(0, Math.min(1, primary / usual)) };
  });

  /* ── my work: every screen this person may open, with what is live on it ── */
  const next = (src.duties?.duties ?? []).find((d) => d.upcoming);
  const work: WorkTile[] = src.seats.map((key): WorkTile => {
    if (key === "consult" && q !== undefined && q !== null) return { key, badgeKey: "home.workBadge.waiting", badgeVars: { n: q.counts.waiting }, live: q.counts.waiting > 0 };
    if (key === "vitals" && bench !== null) { const n = bench.filter((b) => !b.vitalsDone).length; return { key, badgeKey: "home.workBadge.bench", badgeVars: { n }, live: n > 0 }; }
    if (key === "slips" && src.slips !== undefined && src.slips !== null) { const n = src.slips.waiting + src.slips.retake; return { key, badgeKey: "home.workBadge.slips", badgeVars: { n }, live: n > 0 }; }
    if (key === "myDuties" && next !== undefined) return { key, badgeKey: "home.workBadge.nextDuty", badgeVars: { day: shortDay(next.istDate) }, live: false };
    if (key === "onNow" && src.onNow !== undefined && src.onNow !== null && holes.length > 0) return { key, badgeKey: "home.workBadge.gaps", badgeVars: { n: holes.length }, live: true };
    return { key, badgeKey: null, live: false };
  });

  return {
    needs: capped.shown, needsTotal: capped.total, needsHidden: capped.hidden, allNeeds: capNeedsAll(cards),
    tiles: shownTiles, analytics, hospital: src.hospital ?? null, onDuty, team, work,
  };
}

function capNeedsAll(cards: NeedCard[]): NeedCard[] {
  // The "See all" list: the same order, uncapped.
  const shown = capNeeds(cards);
  const rest = cards.filter((c) => !shown.shown.includes(c));
  return [...shown.shown, ...capNeeds(rest).shown, ...rest.filter((c) => !capNeeds(rest).shown.includes(c))];
}
