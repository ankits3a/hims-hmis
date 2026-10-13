import { userNames } from "./admissions";
import { Logger } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { IPD_BILLDESK_REASONS } from "@hmis/contracts";
import {
  ipdAdmissions, ipdBedStays, ipdChargeExceptions, ipdDepositAlerts, ipdPayerAuths, patients, resources,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { holdsPermission, requireIpdPermission } from "./admission-core";
import { retryAdmissionCharges } from "./charges";
import { queueAllDailyTotals } from "./daily-totals";
import {
  IPD_LADDER_STATES, depositPosition, evaluateAllDepositLadders, evaluateDepositLadderSafely, icuBurnOf,
} from "./deposit-ladder";
import { IPD_BILLDESK_VIEW, IPD_CHARGES_REVERSE } from "./manifest";
import { SEALED_LABEL, rankNowRows } from "./now-cards";
import type {
  Actor, IpdBedClass, IpdBillDesk, IpdBillDeskReason, IpdBillDeskRow, IpdAdmissionState, IpdPayerKind,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DeskCard, DeskProviderCtx } from "../../kernel/desk/types";
import type { NowRow } from "./now-cards";
import type { AdmissionPostResult } from "./charges";
import type { DailyTotalsResult } from "./daily-totals";
import type { LadderOutcome } from "./deposit-ladder";

/**
 * E2.3 (#727) — THE BILL DESK (spec SPEC-ipd-core §4.9 H: "Exceptions only … A normal running bill makes no card").
 *
 * The candidates are found from the facts that make an exception — live ladder rows, open charge exceptions, unchecked
 * downtime deposits, denial entries, waiting authorisations, ICU-class stays, discharges under way — and only those
 * admissions have their split computed. An admission under 75 % with nothing open is never read.
 *
 * DECIDED (#727): "expected discharge today" = state `fit_declared` or `discharging` (no expected-discharge date exists
 * before the discharge lane); "auth pending > 24 h" = the latest authorisation entry is still `requested` and was recorded
 * more than 24 hours ago; an ICU-class stay with a day or less of deposit left at its burn rate is an exception.
 */
const AUTH_WAIT_MS = 24 * 3_600_000;
const log = new Logger("ipd.bill-desk");
/** Review 2 — what a sealed (sensitive-context) patient is called on the desk (one definition, `now-cards.ts`). */
export { SEALED_LABEL };
const ICU_LOW_DAYS = 1;
const DISCHARGE_STATES: readonly string[] = ["fit_declared", "discharging"];
const ICU_STAY_CLASSES = ["icu", "hdu", "nicu", "picu"];

/** Row order: the most urgent reason first (the contract's order), then the oldest fact. */
const RANK = new Map<IpdBillDeskReason, number>(IPD_BILLDESK_REASONS.map((r, i) => [r, i] as const));

type Candidate = { reasons: Set<IpdBillDeskReason>; since: Date | null };

function note(m: Map<string, Candidate>, id: string, reason: IpdBillDeskReason | null, at: Date | null): void {
  const c = m.get(id) ?? { reasons: new Set<IpdBillDeskReason>(), since: null };
  if (reason !== null) c.reasons.add(reason);
  if (at !== null && (c.since === null || at < c.since)) c.since = at;
  m.set(id, c);
}

export async function readBillDesk(db: Db, actor: Actor, now: Date = new Date()): Promise<IpdBillDesk> {
  await requireIpdPermission(db, actor, IPD_BILLDESK_VIEW);
  const cand = new Map<string, Candidate>();

  // Live ladder rows, on admissions still in a bed.
  for (const r of await db.select({ admissionId: ipdDepositAlerts.admissionId, level: ipdDepositAlerts.level, firedAt: ipdDepositAlerts.firedAt })
    .from(ipdDepositAlerts).innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdDepositAlerts.admissionId))
    .where(and(isNull(ipdDepositAlerts.rearmedAt), inArray(ipdAdmissions.state, [...IPD_LADDER_STATES])))) {
    note(cand, r.admissionId, r.level === "escalate" ? "deposit_90" : "deposit_75", r.firedAt);
  }
  // Open charge exceptions (an ended stay keeps its exception until it is posted or retried).
  for (const x of await db.select({ admissionId: ipdChargeExceptions.admissionId, reason: ipdChargeExceptions.reason, at: ipdChargeExceptions.firstSeenAt })
    .from(ipdChargeExceptions).where(isNull(ipdChargeExceptions.resolvedAt))) {
    note(cand, x.admissionId, x.reason as "rate_missing" | "tariff_missing" | "posting_failed" | "visit_backdated", x.at);
  }
  // E4.2 (#734): the backdated round visits, by admission, for the Charge / Waive buttons.
  const backdated = new Map<string, { exceptionId: string; serviceDate: string; consultantId: string }[]>();
  for (const x of await db.select({ id: ipdChargeExceptions.id, admissionId: ipdChargeExceptions.admissionId, key: ipdChargeExceptions.key, serviceDate: ipdChargeExceptions.serviceDate })
    .from(ipdChargeExceptions).where(and(isNull(ipdChargeExceptions.resolvedAt), eq(ipdChargeExceptions.reason, "visit_backdated")))) {
    const list = backdated.get(x.admissionId) ?? [];
    list.push({ exceptionId: x.id, serviceDate: x.serviceDate ?? "", consultantId: x.key.split(":")[3] ?? "" });
    backdated.set(x.admissionId, list);
  }
  const consultantNames = await userNames(db, [...backdated.values()].flat().map((b) => b.consultantId));
  // Downtime deposits nobody has checked yet.
  for (const a of await db.select({ id: ipdAdmissions.id, at: ipdAdmissions.admittedAt }).from(ipdAdmissions)
    .where(and(eq(ipdAdmissions.depositCheckPending, true), ne(ipdAdmissions.state, "cancelled")))) {
    note(cand, a.id, "deposit_check_pending", a.at);
  }
  // Authorisations: a denial (the split decides whether the cash consent is still missing) and a request waiting > 24 h.
  const open = [...IPD_LADDER_STATES] as string[];
  const auths = await db.select({ admissionId: ipdPayerAuths.admissionId, entry: ipdPayerAuths.entry, status: ipdPayerAuths.status, at: ipdPayerAuths.recordedAt })
    .from(ipdPayerAuths).innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdPayerAuths.admissionId))
    .where(inArray(ipdAdmissions.state, open)).orderBy(asc(ipdPayerAuths.recordedAt), asc(ipdPayerAuths.id));
  const latest = new Map<string, (typeof auths)[number]>();
  for (const r of auths) {
    latest.set(r.admissionId, r);
    if (r.entry === "denial") note(cand, r.admissionId, null, null);
  }
  for (const r of latest.values()) {
    if (r.status === "requested" && now.getTime() - r.at.getTime() > AUTH_WAIT_MS) note(cand, r.admissionId, "auth_pending_24h", r.at);
  }
  // ICU-class stays (the burn rate decides) and discharges under way (the balance decides).
  for (const s of await db.select({ admissionId: ipdBedStays.admissionId }).from(ipdBedStays)
    .innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdBedStays.admissionId))
    .where(and(isNull(ipdBedStays.endedAt), inArray(ipdBedStays.billedClass, ICU_STAY_CLASSES), inArray(ipdAdmissions.state, open)))) {
    note(cand, s.admissionId, null, null);
  }
  for (const a of await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions).where(inArray(ipdAdmissions.state, [...DISCHARGE_STATES]))) {
    note(cand, a.id, null, null);
  }

  const ids = [...cand.keys()];
  const admissions = ids.length === 0 ? [] : await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, ids));
  const people = new Map((await getPatientSummaries(db, actor, admissions.map((a) => a.patientId))).map((p) => [p.requestedId, p] as const));
  // Review 2: a sealed patient (D-31 sensitive context) is shown by alias or a neutral label — no name, UHID or bed.
  const sealed = admissions.length === 0 ? new Map<string, string | null>()
    : new Map((await db.select({ id: patients.id, alias: patients.alias }).from(patients)
      .where(and(inArray(patients.id, admissions.map((a) => a.patientId)), eq(patients.sensitiveContext, true)))).map((p) => [p.id, p.alias] as const));
  const stays = ids.length === 0 ? [] : await db.select({ admissionId: ipdBedStays.admissionId, bedId: ipdBedStays.bedId, billedClass: ipdBedStays.billedClass })
    .from(ipdBedStays).where(and(inArray(ipdBedStays.admissionId, ids), isNull(ipdBedStays.endedAt)));
  const beds = stays.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: resources.id, code: resources.code }).from(resources).where(inArray(resources.id, stays.map((s) => s.bedId))))
      .map((r) => [r.id, r.code] as const));

  const rows: IpdBillDeskRow[] = [];
  for (const a of admissions) {
    const c = cand.get(a.id)!;
    const pos = await depositPosition(db, a);
    const inBed = (IPD_LADDER_STATES as readonly string[]).includes(a.state);
    // Review 7: the deposit reasons are the LIVE ladder rows only — a re-armed level (a top-up) clears from the desk.
    if (c.reasons.has("deposit_90")) c.reasons.delete("deposit_75");
    if (pos.split.exceptions.includes("cash_consent_missing")) c.reasons.add("cash_consent_missing");
    const icuBurn = inBed ? await icuBurnOf(db, a, pos) : null;
    if (icuBurn !== null && icuBurn.daysLeft !== null && icuBurn.daysLeft <= ICU_LOW_DAYS) c.reasons.add("icu_low_days");
    if (DISCHARGE_STATES.includes(a.state) && pos.balancePaise < 0) c.reasons.add("discharge_balance");
    if (c.reasons.size === 0) continue;
    const p = people.get(a.patientId);
    const stay = stays.find((s) => s.admissionId === a.id);
    const isSealed = sealed.has(a.patientId);
    rows.push({
      admissionId: a.id, admissionNo: a.admissionNo, state: a.state as IpdAdmissionState,
      patient: isSealed
        ? { id: a.patientId, uhid: "", name: sealed.get(a.patientId)?.trim() || SEALED_LABEL }
        : { id: a.patientId, uhid: p?.uhid ?? "", name: p === undefined ? null : p.restricted ? p.alias : p.name },
      bedCode: isSealed || stay === undefined ? null : beds.get(stay.bedId) ?? null,
      billedClass: (stay?.billedClass ?? null) as IpdBedClass | null,
      payerKind: a.payerKind as IpdPayerKind | null,
      reasons: [...c.reasons].sort((x, y) => RANK.get(x)! - RANK.get(y)!),
      usedBp: pos.usedBp, patientPayablePaise: pos.patientPayablePaise, depositHeldPaise: pos.depositHeldPaise,
      balancePaise: pos.balancePaise, icuBurn, since: c.since?.toISOString() ?? null,
      ...(backdated.has(a.id) ? {
        backdatedVisits: backdated.get(a.id)!.map((b) => ({
          exceptionId: b.exceptionId, serviceDate: b.serviceDate, consultantName: consultantNames.get(b.consultantId) ?? b.consultantId,
        })),
      } : {}),
    });
  }
  rows.sort((x, y) => RANK.get(x.reasons[0]!)! - RANK.get(y.reasons[0]!)! || (x.since ?? "").localeCompare(y.since ?? ""));
  const counts = Object.fromEntries(IPD_BILLDESK_REASONS.map((r) => [r, rows.filter((x) => x.reasons.includes(r)).length])) as Record<IpdBillDeskReason, number>;
  return { asOf: now.toISOString(), counts, rows, canRetry: await holdsPermission(db, actor, IPD_CHARGES_REVERSE) };
}

/**
 * The bill desk's Retry on a quarantined or failed posting: `retryAdmissionCharges` (billing manager,
 * `ipd.charges.reverse`), then the ladder for what it posted.
 */
export async function retryFromBillDesk(db: Db, actor: Actor, admissionId: string, now: Date = new Date()): Promise<AdmissionPostResult> {
  const r = await retryAdmissionCharges(db, actor, admissionId, { now });
  await evaluateDepositLadderSafely(db, admissionId, now, "retry");
  return r;
}

/**
 * The nightly run's second half (rides the `postNightlyIpdCharges` job, after the posting; no interval job of its own):
 * every admission in a bed is put through the deposit ladder, then the daily totals are queued.
 */
export async function runIpdBillDeskNightly(
  db: Db, now: Date,
): Promise<{ ladder: LadderOutcome[]; ladderFailed: string[]; dailyTotals: DailyTotalsResult | null }> {
  // Review 1: each half in its own try (and each admission in its own, inside): a failure is logged, never skips the rest.
  let ladder: LadderOutcome[] = [];
  let ladderFailed: string[] = [];
  try {
    ({ outcomes: ladder, failed: ladderFailed } = await evaluateAllDepositLadders(db, now));
  } catch (e) {
    log.error(`deposit ladder run failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let dailyTotals: DailyTotalsResult | null = null;
  try {
    dailyTotals = await queueAllDailyTotals(db, now);
  } catch (e) {
    log.error(`daily totals run failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ladder, ladderFailed, dailyTotals };
}

// ═══════════════════════════════════════ the desk's Now card ═══════════════════════════════════════

/** `deposit_low` for the bill desk's people (`ipd.billdesk.view`, declared in `manifest.ts`); none when no level is live. */
export async function depositLowCard(ctx: Pick<DeskProviderCtx, "db" | "now">): Promise<DeskCard[]> {
  const { db } = ctx;
  const live = await db.select({
    admissionId: ipdDepositAlerts.admissionId, level: ipdDepositAlerts.level, usedBp: ipdDepositAlerts.usedBp,
    admissionNo: ipdAdmissions.admissionNo, firedAt: ipdDepositAlerts.firedAt,
  }).from(ipdDepositAlerts).innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdDepositAlerts.admissionId))
    .where(and(isNull(ipdDepositAlerts.rearmedAt), inArray(ipdAdmissions.state, [...IPD_LADDER_STATES]), isNotNull(ipdAdmissions.admittedAt)))
    .orderBy(desc(ipdDepositAlerts.usedBp), asc(ipdDepositAlerts.firedAt));
  // One row per admission: its highest live level.
  const top = new Map<string, (typeof live)[number]>();
  for (const r of live) if (!top.has(r.admissionId) || r.level === "escalate") top.set(r.admissionId, r);
  if (top.size === 0) return [];
  const all = [...top.values()];
  const n90 = all.filter((r) => r.level === "escalate").length;
  const [exc] = await db.select({ n: count() }).from(ipdChargeExceptions).where(isNull(ipdChargeExceptions.resolvedAt));
  // The admission number, never a name: the desk is read over a shoulder (kept by review #767, DECIDED). E5.1 (#738)
  // only ranks the rows like every Now card: severity, then the longest-standing rung.
  const rows: NowRow[] = all.map((r) => ({
    id: r.admissionId, badge: "!", title: r.admissionNo ?? "—",
    subtitle: r.usedBp >= 1_000_000 ? "no deposit held" : `${String(Math.floor(r.usedBp / 100))} % of deposit used`,
    action: "Open bill", href: `/ipd/admissions/${r.admissionId}/bill`, severity: r.level === "escalate" ? "hot" : "warn",
    waitMinutes: Math.max(0, Math.floor((ctx.now.getTime() - r.firedAt.getTime()) / 60_000)),
  }));
  return [{
    key: "ipd.deposit_low", band: "now", titleKey: "desk.ipdDepositLow.title",
    stats: [
      { key: "desk.ipdDepositLow.over75", value: String(all.length - n90), href: "/ipd/bill-desk" },
      { key: "desk.ipdDepositLow.over90", value: String(n90), href: "/ipd/bill-desk" },
      { key: "desk.ipdDepositLow.exceptions", value: String(exc?.n ?? 0), href: "/ipd/bill-desk" },
    ],
    rows: rankNowRows(rows).slice(0, 5),
  }];
}
