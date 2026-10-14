import { asc, desc, eq, inArray, isNull, and } from "drizzle-orm";
import {
  IPD_TPA_CLAIM_AGEING_DAYS, IPD_TPA_CLAIM_FILE_DAYS, IPD_TPA_CLAIM_HOT_DAYS, IPD_TPA_ENHANCE_AT_BP, IPD_TPA_ROW_KINDS, IPD_TPA_SLA_MINUTES,
} from "@hmis/contracts";
import {
  ipdAdmissionPackages, ipdAdmissions, ipdChargeLines, ipdClaimDeductions, ipdPayerAuths, ipdPayerClaims, ipdTpaDocuments, ipdTpaQueries,
} from "../../kernel/db/schema";
import { readAdmission, requireIpdPermission } from "./admission-core";
import { nowIdentities, rankNowRows } from "./now-cards";
import { computePayerSplit } from "./payer-bill";
import { IPD_PAYER_MANAGE } from "./permissions";
import { claimEventsOf, defaultClaimPaise, missingClaimDocuments } from "./tpa";
import { packageShares } from "./tpa-packages";
import type {
  Actor, IpdClaimDeductionReason, IpdClaimState, IpdTpaBoard, IpdTpaBoardRow, IpdTpaClaim, IpdTpaDocumentKind, IpdTpaPanel, IpdTpaRowKind,
  IpdTpaStage,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DeskCard, DeskProviderCtx } from "../../kernel/desk/types";
import type { AdmissionRow } from "./admission-core";
import type { NowRow } from "./now-cards";

/**
 * #604 (decision 0075) — THE TPA DESK'S READS (SPEC-tpa-desk-2026-10-15 rules 1, 2, 7): the board, the per-admission
 * panel and the `ipd.tpa_due` Now card, all computed on read from the authorisation record, the queries, the claims and
 * the payer split. Nothing here writes. Money desk: `ipd.payer.manage` (no doctor role holds it, decision 0058).
 */

const APPROVED = new Set(["approved", "partially_approved", "final_approved"]);
const LIVE = ["requested", "reserved", "admitted", "transferring", "fit_declared", "discharging"] as const;
const PLACED = new Set(["admitted", "transferring", "fit_declared", "discharging"]);
const INSURED = new Set(["insurance_cashless", "corporate"]);
const SCHEME = new Set(["pmjay", "state_scheme"]);
const PREAUTH_STAGES = new Set<IpdTpaStage>(["preauth", "enhancement", "final"]);
const DAY = 24 * 60;

type AuthRow = typeof ipdPayerAuths.$inferSelect;
type QueryRow = typeof ipdTpaQueries.$inferSelect;
type ClaimRow = typeof ipdPayerClaims.$inferSelect;

const minutesBetween = (from: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
const severityOf = (wait: number, due: number, hot = 2 * due): IpdTpaBoardRow["severity"] => (wait >= hot ? "hot" : wait >= due ? "warn" : "ok");

/** The current authorisation (from the last payer change on), its state, and the request waiting on the payer. Pure. */
export function authStateOf(rowsNewestFirst: readonly AuthRow[]) {
  const change = rowsNewestFirst.findIndex((p) => p.entry === "payer_change");
  const current = change < 0 ? [...rowsNewestFirst] : rowsNewestFirst.slice(0, change + 1);
  const latest = current[0];
  const approvedIdx = current.findIndex((p) => APPROVED.has(p.status));
  const deniedIdx = current.findIndex((p) => p.entry === "denial" || p.status === "denied");
  const approved = approvedIdx >= 0 && (deniedIdx < 0 || approvedIdx < deniedIdx);
  const waiting = latest?.status === "requested"
    ? { stage: (latest.entry === "enhancement" ? "enhancement" : latest.entry === "final" ? "final" : "preauth") as IpdTpaStage, since: latest.recordedAt }
    : null;
  return {
    approved,
    approvedTotalPaise: approved ? current[approvedIdx]!.approvedTotalPaise : null,
    approvedAt: approved ? current[approvedIdx]!.recordedAt : null,
    preAuthNumber: current.find((p) => p.preAuthNumber !== null)?.preAuthNumber ?? null,
    waiting,
  };
}

/**
 * The insurer's clock for a waiting request: from the request, or from our latest answer to a query on it (the payer's
 * turnaround restarts from the last thing we sent). Null while one of its queries is open: the clock is then ours.
 */
function insurerClock(waiting: { since: Date }, queries: readonly QueryRow[]): Date | null {
  const onIt = queries.filter((q) => PREAUTH_STAGES.has(q.stage as IpdTpaStage) && q.raisedAt >= waiting.since);
  if (onIt.some((q) => q.answeredAt === null)) return null;
  const answers = onIt.map((q) => q.answeredAt!.getTime());
  return new Date(Math.max(waiting.since.getTime(), ...answers));
}

/** Claimable = the split's payer share + what the approval holds back (`over_approved_amount`). */
async function claimableOf(db: Db, a: AdmissionRow): Promise<number> {
  const lines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id))
    .orderBy(asc(ipdChargeLines.postedAt), asc(ipdChargeLines.id));
  const split = await computePayerSplit(db, a, lines);
  return Math.max(0, split.totals.payerPaise + split.totals.overApprovedPaise);
}

/** DECIDED $ (rule 2): claimable ≥ 90 % of the approved total. */
const enhancementDue = (claimable: number, approved: number): boolean => approved > 0 && claimable * 10_000 >= approved * IPD_TPA_ENHANCE_AT_BP;

function claimStateOf(c: ClaimRow, events: readonly { kind: string }[]): IpdClaimState {
  if (c.status === "withdrawn") return "withdrawn";
  const k = events[0]?.kind;
  return k === undefined ? "to_submit" : k === "submitted" ? "with_payer" : (k as IpdClaimState);
}

type RawRow = Omit<IpdTpaBoardRow, "patientName"> & { patientId: string };

/** Every TPA row, unranked and without names (the card and the board share it). */
async function tpaRows(db: Db, now: Date): Promise<RawRow[]> {
  const out: RawRow[] = [];
  const live = await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.state, [...LIVE]));
  const liveIds = live.map((a) => a.id);
  const auths = liveIds.length === 0 ? [] : await db.select().from(ipdPayerAuths).where(inArray(ipdPayerAuths.admissionId, liveIds))
    .orderBy(desc(ipdPayerAuths.recordedAt), desc(ipdPayerAuths.id));
  const openQueries = await db.select().from(ipdTpaQueries).where(isNull(ipdTpaQueries.answeredAt));
  const claims = await db.select().from(ipdPayerClaims).where(inArray(ipdPayerClaims.status, ["pending", "filed", "rejected"]));
  const qAdmissionIds = [...new Set([...openQueries.map((q) => q.admissionId), ...claims.map((c) => c.admissionId)])];
  const extra = qAdmissionIds.filter((id) => !liveIds.includes(id));
  const admissions = new Map([...live, ...(extra.length === 0 ? [] : await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, extra)))]
    .map((a) => [a.id, a] as const));
  const liveQueries = liveIds.length === 0 ? [] : await db.select().from(ipdTpaQueries).where(inArray(ipdTpaQueries.admissionId, liveIds));

  const base = (a: AdmissionRow, preAuthNumber: string | null) => ({
    admissionId: a.id, admissionNo: a.admissionNo, patientId: a.patientId, payerKind: a.payerKind, preAuthNumber,
  });

  for (const a of live) {
    const rows = auths.filter((r) => r.admissionId === a.id);
    if (rows.length === 0) continue;
    const st = authStateOf(rows);
    if (st.waiting !== null) {
      const since = insurerClock(st.waiting, liveQueries.filter((q) => q.admissionId === a.id));
      if (since !== null) {
        const due = a.payerKind !== null && SCHEME.has(a.payerKind) && st.waiting.stage !== "final" ? IPD_TPA_SLA_MINUTES.scheme_preauth
          : IPD_TPA_SLA_MINUTES[st.waiting.stage as "preauth" | "enhancement" | "final"];
        const wait = minutesBetween(since, now);
        out.push({
          id: `preauth_waiting:${a.id}`, kind: "preauth_waiting", ...base(a, st.preAuthNumber), stage: st.waiting.stage, claimId: null, queryId: null,
          since: since.toISOString(), waitMinutes: wait, dueMinutes: due, severity: severityOf(wait, due),
          approvedTotalPaise: st.approvedTotalPaise, claimablePaise: null, claimedPaise: null,
        });
      }
    } else if (st.approved && PLACED.has(a.state) && a.payerKind !== null && INSURED.has(a.payerKind)) {
      const approved = st.approvedTotalPaise ?? 0;
      const claimable = await claimableOf(db, a);
      if (enhancementDue(claimable, approved)) {
        const since = st.approvedAt!;
        out.push({
          id: `enhancement_due:${a.id}`, kind: "enhancement_due", ...base(a, st.preAuthNumber), stage: "enhancement", claimId: null, queryId: null,
          since: since.toISOString(), waitMinutes: minutesBetween(since, now), dueMinutes: 0, severity: claimable >= approved ? "hot" : "warn",
          approvedTotalPaise: approved, claimablePaise: claimable, claimedPaise: null,
        });
      }
    }
  }

  for (const q of openQueries) {
    const a = admissions.get(q.admissionId);
    if (a === undefined) continue;
    const wait = minutesBetween(q.raisedAt, now);
    out.push({
      id: `query_open:${q.id}`, kind: "query_open", ...base(a, null), stage: q.stage as IpdTpaStage, claimId: q.claimId, queryId: q.id,
      since: q.raisedAt.toISOString(), waitMinutes: wait, dueMinutes: IPD_TPA_SLA_MINUTES.query_due,
      severity: severityOf(wait, IPD_TPA_SLA_MINUTES.query_due, IPD_TPA_SLA_MINUTES.query_hot),
      approvedTotalPaise: null, claimablePaise: null, claimedPaise: null,
    });
  }

  const events = await claimEventsOf(db, claims.map((c) => c.id));
  for (const c of claims) {
    const a = admissions.get(c.admissionId);
    if (a === undefined) continue;
    const ev = events.filter((e) => e.claimId === c.id);
    const state = claimStateOf(c, ev);
    if (state === "with_payer") {
      const sub = ev[0]!;
      const wait = minutesBetween(sub.at, now);
      out.push({
        id: `claim_with_payer:${c.id}`, kind: "claim_with_payer", ...base(a, c.preAuthNumber), stage: "claim", claimId: c.id, queryId: null,
        since: sub.at.toISOString(), waitMinutes: wait, dueMinutes: IPD_TPA_CLAIM_AGEING_DAYS * DAY,
        severity: severityOf(wait, IPD_TPA_CLAIM_AGEING_DAYS * DAY, IPD_TPA_CLAIM_HOT_DAYS * DAY),
        approvedTotalPaise: null, claimablePaise: null, claimedPaise: sub.claimedPaise,
      });
    } else if (state === "to_submit" || state === "rejected") {
      const since = ev[0]?.at ?? c.createdAt;
      const wait = minutesBetween(since, now);
      out.push({
        id: `claim_to_submit:${c.id}`, kind: "claim_to_submit", ...base(a, c.preAuthNumber), stage: "claim", claimId: c.id, queryId: null,
        since: since.toISOString(), waitMinutes: wait, dueMinutes: IPD_TPA_CLAIM_FILE_DAYS * DAY, severity: severityOf(wait, IPD_TPA_CLAIM_FILE_DAYS * DAY),
        approvedTotalPaise: null, claimablePaise: null, claimedPaise: await defaultClaimPaise(db, c),
      });
    }
  }
  return out;
}

const KIND_RANK: Record<IpdTpaRowKind, number> = { query_open: 0, preauth_waiting: 1, enhancement_due: 2, claim_to_submit: 3, claim_with_payer: 4 };
const SEV_RANK = { hot: 0, warn: 1, ok: 2 } as const;

/** The TPA desk board: every row, worst first (severity, kind, longest wait, id). `ipd.payer.manage`. */
export async function readTpaBoard(db: Db, actor: Actor, now: Date = new Date()): Promise<IpdTpaBoard> {
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const raw = await tpaRows(db, now);
  const who = await nowIdentities(db, actor, [...new Map(raw.map((r) => [r.admissionId, { id: r.admissionId, patientId: r.patientId }])).values()]);
  const rows: IpdTpaBoardRow[] = raw
    .sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity] || KIND_RANK[x.kind] - KIND_RANK[y.kind] || y.waitMinutes - x.waitMinutes || x.id.localeCompare(y.id))
    .map((x) => {
      const r: Omit<RawRow, "patientId"> & { patientId?: string } = { ...x };
      delete r.patientId;
      return { ...r, patientName: who.get(r.admissionId)?.name ?? "—" };
    });
  const counts = Object.fromEntries(IPD_TPA_ROW_KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length])) as IpdTpaBoard["counts"];
  return { asOf: now.toISOString(), rows, counts };
}

/** The words of a card row; English, server-side (the card titles are i18n keys). */
function cardWords(r: RawRow): string {
  const h = Math.floor(r.waitMinutes / 60);
  const clock = h > 0 ? `${String(h)} h ${String(r.waitMinutes % 60)} min` : `${String(r.waitMinutes)} min`;
  switch (r.kind) {
    case "preauth_waiting": return `${r.stage === "final" ? "Final approval" : r.stage === "enhancement" ? "Enhancement" : "Pre-auth"} waiting ${clock}`;
    case "query_open": return `Payer query open ${clock}`;
    case "enhancement_due": return `Enhancement due · ${String(Math.floor(((r.claimablePaise ?? 0) * 100) / Math.max(1, r.approvedTotalPaise ?? 1)))} % of approved`;
    case "claim_with_payer": return `Claim with payer ${String(Math.floor(r.waitMinutes / DAY))} days`;
    default: return `Claim to file ${String(Math.floor(r.waitMinutes / DAY))} days`;
  }
}

/**
 * `ipd.tpa_due` — the TPA desk's Now card (`ipd.payer.manage`, declared in `manifest.ts`): pre-auths and payer queries
 * past their due time, enhancements due, claims with the payer 30 days or more. The admission number, never a name (the
 * money-card rule, review #767). None when nothing is due.
 */
export async function tpaDueCard(ctx: Pick<DeskProviderCtx, "db" | "now">): Promise<DeskCard[]> {
  const raw = (await tpaRows(ctx.db, ctx.now)).filter((r) =>
    ((r.kind === "preauth_waiting" || r.kind === "query_open") && r.severity !== "ok")
    || r.kind === "enhancement_due"
    || (r.kind === "claim_with_payer" && r.severity !== "ok"));
  if (raw.length === 0) return [];
  const rows: NowRow[] = raw.map((r) => ({
    id: r.id, badge: "!", title: r.admissionNo ?? "—", subtitle: [r.preAuthNumber ?? "", cardWords(r)].filter((s) => s !== "").join(" · "),
    action: "Open", href: `/ipd/admissions/${r.admissionId}/bill`, severity: r.severity === "hot" ? "hot" : "warn", waitMinutes: r.waitMinutes,
  }));
  const n = (k: IpdTpaRowKind) => String(raw.filter((r) => r.kind === k).length);
  return [{
    key: "ipd.tpa_due", band: "now", titleKey: "desk.ipdTpaDue.title",
    stats: [
      { key: "desk.ipdTpaDue.preauth", value: String(raw.filter((r) => r.kind === "preauth_waiting" || r.kind === "query_open").length), href: "/ipd/tpa" },
      { key: "desk.ipdTpaDue.enhancement", value: n("enhancement_due"), href: "/ipd/tpa" },
      { key: "desk.ipdTpaDue.claims", value: n("claim_with_payer"), href: "/ipd/tpa" },
    ],
    rows: rankNowRows(rows).slice(0, 5),
  }];
}

/** The per-admission TPA panel on the bill page. `ipd.payer.manage`. */
export async function readTpaPanel(db: Db, actor: Actor, admissionId: string, now: Date = new Date()): Promise<IpdTpaPanel> {
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const a = await readAdmission(db, admissionId);
  const auths = await db.select().from(ipdPayerAuths).where(eq(ipdPayerAuths.admissionId, a.id)).orderBy(desc(ipdPayerAuths.recordedAt), desc(ipdPayerAuths.id));
  const queries = await db.select().from(ipdTpaQueries).where(eq(ipdTpaQueries.admissionId, a.id)).orderBy(desc(ipdTpaQueries.raisedAt), desc(ipdTpaQueries.id));
  const docs = await db.select().from(ipdTpaDocuments).where(and(eq(ipdTpaDocuments.admissionId, a.id), isNull(ipdTpaDocuments.detachedAt)))
    .orderBy(asc(ipdTpaDocuments.attachedAt), asc(ipdTpaDocuments.id));
  const pk = await db.select().from(ipdAdmissionPackages).where(and(eq(ipdAdmissionPackages.admissionId, a.id), isNull(ipdAdmissionPackages.removedAt)));
  const shares = packageShares(pk);
  const claims = await db.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.admissionId, a.id)).orderBy(asc(ipdPayerClaims.createdAt), asc(ipdPayerClaims.id));
  const events = await claimEventsOf(db, claims.map((c) => c.id));
  const deductions = claims.length === 0 ? [] : await db.select().from(ipdClaimDeductions).where(inArray(ipdClaimDeductions.claimId, claims.map((c) => c.id)))
    .orderBy(asc(ipdClaimDeductions.line));

  const st = authStateOf(auths);
  let waiting: IpdTpaPanel["waiting"] = null;
  if (st.waiting !== null) {
    const since = insurerClock(st.waiting, queries) ?? st.waiting.since;
    const due = a.payerKind !== null && SCHEME.has(a.payerKind) && st.waiting.stage !== "final" ? IPD_TPA_SLA_MINUTES.scheme_preauth
      : IPD_TPA_SLA_MINUTES[st.waiting.stage as "preauth" | "enhancement" | "final"];
    waiting = { stage: st.waiting.stage, since: since.toISOString(), waitMinutes: minutesBetween(since, now), dueMinutes: due };
  }
  let claimable: number | null = null;
  let due = false;
  if (st.approved && st.waiting === null && PLACED.has(a.state) && a.payerKind !== null && INSURED.has(a.payerKind)) {
    claimable = await claimableOf(db, a);
    due = enhancementDue(claimable, st.approvedTotalPaise ?? 0);
  }

  const claimViews: IpdTpaClaim[] = [];
  for (const c of claims) {
    const ev = events.filter((e) => e.claimId === c.id);
    const state = claimStateOf(c, ev);
    const sub = ev.find((e) => e.kind === "submitted");
    const paid = ev[0] !== undefined && (ev[0].kind === "settled" || ev[0].kind === "short_paid") ? ev[0] : undefined;
    const ded = paid === undefined ? [] : deductions.filter((d) => d.claimEventId === paid.id);
    const dedPaise = ded.reduce((s, d) => s + d.amountPaise, 0);
    const def = await defaultClaimPaise(db, c);
    const claimed = sub?.claimedPaise ?? null;
    claimViews.push({
      id: c.id, finalBillId: c.finalBillId, state, claimRef: sub?.claimRef ?? null, submittedAt: sub?.at.toISOString() ?? null,
      ageDays: state === "with_payer" && sub !== undefined ? Math.floor(minutesBetween(sub.at, now) / DAY) : null,
      billPayerPaise: c.claimPaise, claimedPaise: claimed, defaultClaimPaise: def,
      netPaidPaise: paid?.netPaidPaise ?? null, tdsPaise: paid?.tdsPaise ?? null, utrRef: paid?.utrRef ?? null, settledOn: paid?.settledOn ?? null,
      deductions: ded.map((d) => ({ reason: d.reason as IpdClaimDeductionReason, amountPaise: d.amountPaise, note: d.note })),
      deductionsPaise: dedPaise,
      packageVariancePaise: c.claimPaise - (claimed ?? def),
      unexplainedPaise: paid === undefined || claimed === null ? null : claimed - (paid.netPaidPaise! + paid.tdsPaise! + dedPaise),
      rejectionReason: ev[0]?.kind === "rejected" ? ev[0].reason : null,
      missingDocuments: state === "to_submit" || state === "rejected" ? await missingClaimDocuments(db, a.id, c.id) as IpdTpaDocumentKind[] : [],
    });
  }

  return {
    admissionId: a.id, admissionNo: a.admissionNo, payerKind: a.payerKind, isScheme: a.payerKind !== null && SCHEME.has(a.payerKind),
    preAuthNumber: st.preAuthNumber, approvedTotalPaise: st.approvedTotalPaise, waiting, enhancementDue: due, claimablePaise: claimable,
    auths: [...auths].reverse().map((r) => ({
      id: r.id, entry: r.entry, status: r.status, preAuthNumber: r.preAuthNumber, approvedAmountPaise: r.approvedAmountPaise,
      approvedTotalPaise: r.approvedTotalPaise, recordedAt: r.recordedAt.toISOString(),
    })),
    queries: queries.map((q) => ({
      id: q.id, stage: q.stage as IpdTpaStage, claimId: q.claimId, raisedAt: q.raisedAt.toISOString(), queryText: q.queryText,
      answeredAt: q.answeredAt?.toISOString() ?? null, responseText: q.responseText,
      waitMinutes: minutesBetween(q.raisedAt, q.answeredAt ?? now),
    })),
    documents: docs.map((d) => ({
      id: d.id, stage: d.stage as IpdTpaStage, kind: d.kind as IpdTpaDocumentKind, patientDocumentId: d.patientDocumentId, claimId: d.claimId,
      attachedAt: d.attachedAt.toISOString(),
    })),
    packages: shares.map((p) => ({ id: p.id, code: p.code, name: p.name, ratePaise: p.ratePaise, shareBp: p.shareBp, amountPaise: p.amountPaise })),
    packageAmountPaise: shares.reduce((s, p) => s + p.amountPaise, 0),
    claims: claimViews,
  };
}
