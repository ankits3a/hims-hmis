import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { ER_ESI_INFO } from "@hmis/contracts";
import {
  ER_OPEN_STATE_VALUES, erEpisodes, erMlcObligations, erMlcs, erNotes, erPreAlerts, erSpecialtyCalls, orderItems, orders, patients, resources,
} from "../../kernel/db/schema";
import { openCriticalsForEncounters } from "../lab";
import { getPatientSummaries } from "../patients";
import { readErBoard } from "./board";
import { istHm } from "./copilot-since";
import type { Actor, ErEsiLevel, ErNowCardKey } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DeskCard, DeskProviderCtx, DeskRow } from "../../kernel/desk/types";
import type { EpisodeRow } from "./core";

/**
 * ER lane 9 (#816) — THE ER NOW CARDS (spec §4.9; Doctor Desk seam E10 `er.casualty_now`). One desk provider per card
 * type, each gated in `manifest.ts` by the permission of the act that answers it. A card exists only while something is
 * owed: an empty card is not sent. Ranking is rules (severity, then the longest wait, then the id), as IPD's.
 *
 * Rows name the patient as the reader may see them (`getPatientSummaries`: the alias for a restricted record), an
 * unidentified patient by the alias, a sealed one by "Sealed patient" with no bay. No money on any card (0058).
 *
 * DECIDED (lane 9, standard practice): a call shows from 10 minutes unanswered (it climbs at 15); a result is "ready" when
 * a test completed after the episode's last note; a boarder shows at 2 hours (the bed manager's task) and is hot at 4;
 * the MLC intimation shows 15 minutes before it is due, the countersign 2 hours before; LWBS risk = ESI 4 or 5, no doctor
 * yet, 60 minutes or more since the gate.
 */

const MIN = 60_000;
export const ER_CALL_CARD_MIN = 10;
export const ER_BOARDING_CARD_MIN = 120;
export const ER_BOARDING_HOT_MIN = 240;
export const ER_MLC_INTIMATION_LEAD_MIN = 15;
export const ER_MLC_COUNTERSIGN_LEAD_MIN = 120;
export const ER_LWBS_RISK_MIN = 60;
const SEALED_LABEL = "Sealed patient";
const ROWS = 5;

type NowRow = DeskRow & { wait: number };
const SEV: Record<string, number> = { hot: 0, warn: 1 };

function rank(rows: readonly NowRow[]): DeskRow[] {
  return [...rows].sort((a, b) => (SEV[a.severity ?? ""] ?? 2) - (SEV[b.severity ?? ""] ?? 2) || b.wait - a.wait || a.id.localeCompare(b.id))
    .slice(0, ROWS).map((r): DeskRow => ({ id: r.id, badge: r.badge ?? null, title: r.title, subtitle: r.subtitle, action: r.action ?? null, href: r.href ?? null, severity: r.severity ?? null }));
}

const since = (from: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - from.getTime()) / MIN));
const card = (key: ErNowCardKey, titleKey: string, rows: NowRow[]): DeskCard[] =>
  rows.length === 0 ? [] : [{ key, band: "now", titleKey, rows: rank(rows), topics: ["er:board"] }];

type Who = { name: string; place: string };

/** Name (alias when restricted or unidentified), the ER number and the bay, as `reader` may see them. */
async function whoOf(db: Db, reader: Actor, eps: readonly EpisodeRow[]): Promise<Map<string, Who>> {
  const out = new Map<string, Who>();
  if (eps.length === 0) return out;
  const ids = [...new Set(eps.map((e) => e.patientId))];
  const people = new Map((await getPatientSummaries(db, reader, ids)).map((p) => [p.requestedId, p] as const));
  const sealed = new Set((await db.select({ id: patients.id }).from(patients).where(and(inArray(patients.id, ids), eq(patients.sensitiveContext, true)))).map((p) => p.id));
  const bayIds = eps.flatMap((e) => (e.bayId === null ? [] : [e.bayId]));
  const bays = new Map(bayIds.length === 0 ? [] : (await db.select({ id: resources.id, code: resources.code }).from(resources).where(inArray(resources.id, bayIds))).map((b) => [b.id, b.code] as const));
  for (const e of eps) {
    const p = people.get(e.patientId);
    const merged = p !== undefined && p.id !== e.patientId;
    if (sealed.has(e.patientId)) { out.set(e.id, { name: p?.alias?.trim() || SEALED_LABEL, place: "" }); continue; }
    const name = e.unidentified && !merged ? (e.alias ?? "—") : p?.restricted === true ? (p.alias ?? "—") : (p?.name ?? p?.alias ?? "—");
    // Walk 2026-10-16: the desk row is one short line at 390 px — the bay only (the ER number is on the patient's page).
    out.set(e.id, { name, place: e.bayId === null ? "" : bays.get(e.bayId) ?? "" });
  }
  return out;
}

const openEpisodes = (db: Db): Promise<EpisodeRow[]> => db.select().from(erEpisodes).where(inArray(erEpisodes.state, [...ER_OPEN_STATE_VALUES]));
const esiOf = (e: EpisodeRow): string => (e.esi === null ? "" : `ESI ${String(e.esi)}`);
/** One short line: the non-empty parts joined. */
const line = (...parts: string[]): string => parts.filter((x) => x !== "").join(" · ");
const triageHref = (id: string): string => `/er/triage?episode=${id}`;
const patientHref = (id: string): string => `/er/patient?episode=${id}`;

// ─────────────────────────── casualty now (E10): the department's pulse ───────────────────────────

export async function casualtyNowCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const b = await readErBoard(ctx.db, ctx.reader, { now: ctx.now });
  if (b.stats.inDepartment === 0 && b.stats.expected === 0) return [];
  return [{
    key: "emergency.casualty_now", band: "now", titleKey: "desk.erCasualtyNow.title", topics: ["er:board"],
    stats: [
      { key: "desk.erCasualtyNow.inDepartment", value: String(b.stats.inDepartment), href: "/er/board" },
      { key: "desk.erCasualtyNow.waitingTriage", value: String(b.stats.waitingTriage), compare: b.stats.longestTriageWaitMinutes === null ? null : `longest ${String(b.stats.longestTriageWaitMinutes)} min`, href: "/er/triage" },
      { key: "desk.erCasualtyNow.boarding", value: String(b.stats.boarding), href: "/er/board" },
      { key: "desk.erCasualtyNow.expected", value: String(b.stats.expected), href: "/er/desk" },
    ],
  }];
}

// ─────────────────────────── re-triage due ───────────────────────────

export async function retriageDueCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const eps = await ctx.db.select().from(erEpisodes).where(and(eq(erEpisodes.state, "triaged"), isNotNull(erEpisodes.retriageDueAt), lte(erEpisodes.retriageDueAt, ctx.now)));
  const who = await whoOf(ctx.db, ctx.reader, eps);
  return card("emergency.retriage_due", "desk.erRetriageDue.title", eps.map((e) => {
    const over = since(e.retriageDueAt!, ctx.now);
    return {
      id: e.id, badge: e.esi === null ? "!" : String(e.esi), title: who.get(e.id)!.name,
      subtitle: line(who.get(e.id)!.place, esiOf(e), `${String(over)} min over`),
      action: "Re-triage", href: triageHref(e.id), severity: over >= 15 ? "hot" : "warn", wait: over,
    };
  }));
}

// ─────────────────────────── door-to-doctor overdue ───────────────────────────

export async function doctorOverdueCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const eps = (await openEpisodes(ctx.db)).filter((e) => e.esi !== null && e.seenAt === null
    && e.arrivedAt.getTime() + ER_ESI_INFO[e.esi as ErEsiLevel].doctorWithinMin * MIN <= ctx.now.getTime());
  const who = await whoOf(ctx.db, ctx.reader, eps);
  return card("emergency.doctor_overdue", "desk.erDoctorOverdue.title", eps.map((e) => {
    const target = ER_ESI_INFO[e.esi as ErEsiLevel].doctorWithinMin;
    const waited = since(e.arrivedAt, ctx.now);
    return {
      id: e.id, badge: String(e.esi), title: who.get(e.id)!.name,
      subtitle: line(who.get(e.id)!.place, esiOf(e), `${String(waited)} min (target ${String(target)})`),
      action: "See patient", href: patientHref(e.id), severity: (e.esi ?? 9) <= 2 || waited >= target * 2 ? "hot" : "warn", wait: waited - target,
    };
  }));
}

// ─────────────────────────── specialty call unanswered ───────────────────────────

export async function callUnansweredCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const calls = await ctx.db.select().from(erSpecialtyCalls).where(and(isNull(erSpecialtyCalls.answeredAt), lte(erSpecialtyCalls.calledAt, new Date(ctx.now.getTime() - ER_CALL_CARD_MIN * MIN))));
  if (calls.length === 0) return [];
  const eps = (await ctx.db.select().from(erEpisodes).where(and(inArray(erEpisodes.id, [...new Set(calls.map((c) => c.episodeId))]), inArray(erEpisodes.state, [...ER_OPEN_STATE_VALUES]))));
  const byId = new Map(eps.map((e) => [e.id, e] as const));
  const who = await whoOf(ctx.db, ctx.reader, eps);
  return card("emergency.call_unanswered", "desk.erCallUnanswered.title", calls.filter((c) => byId.has(c.episodeId)).map((c) => {
    const waited = since(c.calledAt, ctx.now);
    return {
      id: c.id, badge: c.departmentCode, title: who.get(c.episodeId)!.name,
      subtitle: line(who.get(c.episodeId)!.place, c.departmentCode, `${String(waited)} min`),
      action: "Open", href: patientHref(c.episodeId), severity: waited >= 15 ? "hot" : "warn", wait: waited,
    };
  }));
}

// ─────────────────────────── results ready, critical results ───────────────────────────

export async function resultReadyCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const eps = await openEpisodes(ctx.db);
  if (eps.length === 0) return [];
  const done = await ctx.db.select({ encounterNo: orders.encounterNo, completedAt: orderItems.completedAt }).from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(inArray(orders.encounterNo, eps.map((e) => e.episodeNo)), isNotNull(orderItems.completedAt), eq(orderItems.restricted, false)));
  if (done.length === 0) return [];
  const lastNote = new Map((await ctx.db.select({ episodeId: erNotes.episodeId, at: sql<Date>`max(${erNotes.recordedAt})` }).from(erNotes)
    .where(inArray(erNotes.episodeId, eps.map((e) => e.id))).groupBy(erNotes.episodeId)).map((r) => [r.episodeId, new Date(r.at)] as const));
  const ready = eps.flatMap((e) => {
    const after = lastNote.get(e.id);
    const fresh = done.filter((d) => d.encounterNo === e.episodeNo && (after === undefined || d.completedAt! > after));
    if (fresh.length === 0) return [];
    const first = fresh.reduce((m, d) => (d.completedAt! < m ? d.completedAt! : m), fresh[0]!.completedAt!);
    return [{ e, first, n: fresh.length }];
  });
  const who = await whoOf(ctx.db, ctx.reader, ready.map((r) => r.e));
  return card("emergency.result_ready", "desk.erResultReady.title", ready.map(({ e, first, n }) => ({
    id: e.id, badge: String(n), title: who.get(e.id)!.name, subtitle: line(who.get(e.id)!.place, `ready ${istHm(first)}`),
    action: "Review", href: patientHref(e.id), severity: null, wait: since(first, ctx.now),
  })));
}

export async function criticalResultCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const eps = await openEpisodes(ctx.db);
  const crit = await openCriticalsForEncounters(ctx.db, eps.map((e) => e.episodeNo));
  if (crit.length === 0) return [];
  const byNo = new Map(eps.map((e) => [e.episodeNo, e] as const));
  const who = await whoOf(ctx.db, ctx.reader, eps.filter((e) => crit.some((c) => c.encounterNo === e.episodeNo)));
  return card("emergency.critical_result", "desk.erCriticalResult.title", crit.map((c) => {
    const e = byNo.get(c.encounterNo)!;
    return {
      id: c.callId, badge: "!", title: who.get(e.id)!.name,
      subtitle: line(who.get(e.id)!.place, `${c.analyteCode} ${c.value}${c.unit === null ? "" : ` ${c.unit}`}`),
      action: "Open", href: patientHref(e.id), severity: "hot", wait: since(c.openedAt, ctx.now),
    };
  }));
}

// ─────────────────────────── boarding long ───────────────────────────

export async function boardingLongCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const eps = await ctx.db.select().from(erEpisodes).where(and(eq(erEpisodes.state, "disposition_decided"), isNotNull(erEpisodes.boardingSince),
    lte(erEpisodes.boardingSince, new Date(ctx.now.getTime() - ER_BOARDING_CARD_MIN * MIN))));
  const who = await whoOf(ctx.db, ctx.reader, eps);
  return card("emergency.boarding_long", "desk.erBoardingLong.title", eps.map((e) => {
    const waited = since(e.boardingSince!, ctx.now);
    return {
      id: e.id, badge: `${String(Math.floor(waited / 60))}h`, title: who.get(e.id)!.name,
      subtitle: line(who.get(e.id)!.place, `${String(waited)} min`),
      action: "Find a bed", href: "/ipd/beds", severity: waited >= ER_BOARDING_HOT_MIN ? "hot" : "warn", wait: waited,
    };
  }));
}

// ─────────────────────────── MLC: intimation and countersign owed ───────────────────────────

async function mlcOwed(ctx: DeskProviderCtx, kind: "police_intimation" | "faculty_countersign", leadMin: number, key: ErNowCardKey, titleKey: string, action: string): Promise<DeskCard[]> {
  const owed = await ctx.db.select({ o: erMlcObligations, m: erMlcs }).from(erMlcObligations).innerJoin(erMlcs, eq(erMlcs.id, erMlcObligations.mlcId))
    .where(and(eq(erMlcObligations.kind, kind), isNull(erMlcObligations.metAt), lte(erMlcObligations.dueAt, new Date(ctx.now.getTime() + leadMin * MIN))));
  if (owed.length === 0) return [];
  const eps = await ctx.db.select().from(erEpisodes).where(inArray(erEpisodes.id, [...new Set(owed.map((r) => r.m.episodeId))]));
  const who = await whoOf(ctx.db, ctx.reader, eps);
  return card(key, titleKey, owed.map(({ o, m }) => {
    const over = Math.floor((ctx.now.getTime() - o.dueAt.getTime()) / MIN);
    return {
      id: o.id, badge: "MLC", title: who.get(m.episodeId)?.name ?? m.mlcNo,
      subtitle: line(m.mlcNo, over > 0 ? `${String(over)} min over` : `due in ${String(-over)} min`),
      action, href: `/er/mlc?mlc=${m.id}`, severity: over > 0 ? "hot" : "warn", wait: over,
    };
  }));
}

export const mlcIntimationDueCard = (ctx: DeskProviderCtx): Promise<DeskCard[]> =>
  mlcOwed(ctx, "police_intimation", ER_MLC_INTIMATION_LEAD_MIN, "emergency.mlc_intimation_due", "desk.erMlcIntimationDue.title", "Record intimation");
export const mlcCountersignDueCard = (ctx: DeskProviderCtx): Promise<DeskCard[]> =>
  mlcOwed(ctx, "faculty_countersign", ER_MLC_COUNTERSIGN_LEAD_MIN, "emergency.mlc_countersign_due", "desk.erMlcCountersignDue.title", "Countersign");

// ─────────────────────────── pre-alerts ───────────────────────────

const PRE_ALERT_MODE: Record<string, string> = {
  ambulance_108: "108 ambulance", own_ambulance: "Hospital ambulance", inter_facility: "Inter-facility", police: "Police", referred_in: "Referral",
  opd_red_flag: "From OPD",
};

export async function preAlertCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const rows = await ctx.db.select().from(erPreAlerts).where(and(eq(erPreAlerts.state, "expected"), gt(erPreAlerts.expiresAt, ctx.now)));
  return card("emergency.pre_alert", "desk.erPreAlert.title", rows.map((p) => {
    const late = Math.floor((ctx.now.getTime() - p.expectedAt.getTime()) / MIN);
    return {
      id: p.id, badge: String(p.count - p.arrivedCount), title: `${PRE_ALERT_MODE[p.mode] ?? p.mode}${p.complaint === null ? "" : ` · ${p.complaint.slice(0, 60)}`}`,
      subtitle: late > 0 ? `${String(late)} min late` : `at ${istHm(p.expectedAt)}`,
      action: "ER desk", href: "/er/desk", severity: late > 0 ? "warn" : null, wait: late,
    };
  }));
}

// ─────────────────────────── LWBS risk ───────────────────────────

export async function lwbsRiskCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const eps = (await openEpisodes(ctx.db)).filter((e) => (e.state === "arrived" || e.state === "triaged") && e.seenAt === null
    && (e.esi === 4 || e.esi === 5) && since(e.arrivedAt, ctx.now) >= ER_LWBS_RISK_MIN);
  const who = await whoOf(ctx.db, ctx.reader, eps);
  return card("emergency.lwbs_risk", "desk.erLwbsRisk.title", eps.map((e) => {
    const waited = since(e.arrivedAt, ctx.now);
    return {
      id: e.id, badge: String(e.esi), title: who.get(e.id)!.name, subtitle: line(who.get(e.id)!.place, esiOf(e), `${String(waited)} min`),
      action: "Check on patient", href: triageHref(e.id), severity: waited >= 120 ? "hot" : "warn", wait: waited,
    };
  }));
}
