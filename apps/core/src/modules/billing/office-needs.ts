import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import {
  approvals, creditNotes, invoices, receipts, receiptTenders, refundVouchers, users,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { loadBillingConfig } from "./config";
import { chargeOrphans, dayBook } from "./daily-close";
import { listMismatches } from "./recon";
import { latestResolution, ownerQuestionFor, RECON_CHARGE_MANAGER_MAX_PAISE } from "./recon-resolve";
import { REFUND_APPROVAL_TYPE, REFUND_OWNER_ABOVE_PAISE, REFUND_OWNER_APPROVAL_TYPE } from "./refunds";
import { istDay } from "./time";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE BILLING OFFICE'S "NEEDS YOU TODAY" ═══
 *
 * The approved billing back office board replaces five filter-style tabs with ONE ranked list. This is
 * its feed: every waiting thing the office owns, most urgent first, each row carrying the source chip
 * the board draws (PAY · APPROVE · RECON · UNBILLED · DAY BOOK · GSTR-1), how long it has waited, the
 * patient as the confidential gate lets this caller see them (§14 — `getPatientSummaries`, a restricted
 * patient arrives as their alias), and the facts the opened item's steps need.
 *
 * `state: "waiting"` rows are the board's "Clocks running": a dispute with the bank, a refund or a
 * write-off that is the OWNER's to decide (OWNER RULINGS 2026-09-28). Nobody in the office can act on
 * them; they are watched, not worked.
 *
 * READ-ONLY. It writes nothing and closes nothing — the charge-orphan half is `chargeOrphans`, never
 * `runDailyClose`, for the reason FD-33 gives. No payee ID reference is read, ever.
 */

export type NeedSource = "PAY" | "APPROVE" | "RECON" | "UNBILLED" | "DAY BOOK" | "GSTR-1";
export type NeedTone = "rd" | "gd" | "no";
export type NeedKind =
  | "recon_mismatch" | "recon_disputed" | "recon_missing"
  | "pay_voucher" | "approve_refund" | "refund_owner"
  | "unbilled_visit" | "daybook_paper" | "gstr1_due";

export type NeedPatient = { patientId: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };

export type BillingNeedRow = {
  id: string;
  kind: NeedKind;
  source: NeedSource;
  state: "open" | "waiting";
  /** Lower is more urgent; ties break oldest first. */
  tier: number;
  /** When the clock started (ISO). Null for a due date. */
  since: string | null;
  /** Whole minutes waited at `now`, or null. */
  ageMinutes: number | null;
  /** For a due date: whole IST days left. */
  daysLeft: number | null;
  tone: NeedTone;
  patient: NeedPatient | null;
  /** Figures and printed numbers only — money in integer paise, dates ISO. Never an ID document. */
  params: Record<string, string | number | boolean | null | string[]>;
};

export type BillingOfficeNeeds = {
  asOf: string;
  day: string;
  rows: BillingNeedRow[];
  money: { toPayPaise: number; toPayCount: number; shortPaise: number };
  /** The two owner-ruled lines, so the screen says them without keeping its own copy. */
  limits: { reconChargeManagerMaxPaise: number; refundOwnerAbovePaise: number; reconTolerancePaise: number };
};

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;

function minutesSince(at: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / MINUTE));
}

function ageTone(minutes: number, goldAfter: number, redAfter: number): NeedTone {
  if (minutes >= redAfter) return "rd";
  if (minutes >= goldAfter) return "gd";
  return "no";
}

/** `2026-09-28` shifted by whole days — calendar arithmetic on the IST day string. */
function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() + by * DAY_MS).toISOString().slice(0, 10);
}

/**
 * GSTR-1 for a month is due on the 11th of the next. Through the 11th the office is filing LAST month's;
 * after it, this month's (due the 11th of next month) — the board's "September GSTR-1 due 11-Oct-2026" on
 * 28-Sep.
 */
export function gstr1Due(day: string): { month: string; due: string; daysLeft: number } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const filingMonth = d <= 11 ? new Date(Date.UTC(y, m - 2, 1)) : new Date(Date.UTC(y, m - 1, 1));
  const due = new Date(Date.UTC(filingMonth.getUTCFullYear(), filingMonth.getUTCMonth() + 1, 11));
  const today = new Date(`${day}T00:00:00Z`);
  return {
    month: filingMonth.toISOString().slice(0, 7),
    due: due.toISOString().slice(0, 10),
    daysLeft: Math.floor((due.getTime() - today.getTime()) / DAY_MS),
  };
}

async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x) => x !== ""))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

export async function billingOfficeNeeds(db: Db, actor: Actor, now: Date = new Date()): Promise<BillingOfficeNeeds> {
  const cfg = await loadBillingConfig(db);
  const day = istDay(now);
  const rows: BillingNeedRow[] = [];
  const patientIds: string[] = [];
  const patientOf = new Map<string, string>(); // row id → patient id

  // ── PAY: vouchers issued and not yet paid ──
  const vouchers = await db.select().from(refundVouchers).where(eq(refundVouchers.status, "issued")).orderBy(asc(refundVouchers.issuedAt));
  const voucherApprovals = vouchers.length === 0 ? [] : await db
    .select({ id: approvals.id, decidedBy: approvals.decidedBy, decidedAt: approvals.decidedAt, requestedAt: approvals.requestedAt, requesterId: approvals.requesterId })
    .from(approvals).where(inArray(approvals.id, vouchers.map((v) => v.approvalId)));
  const approvalById = new Map(voucherApprovals.map((a) => [a.id, a]));
  const invoiceIds = vouchers.map((v) => v.invoiceId).filter((x): x is string => x !== null);
  const invoiceNos = invoiceIds.length === 0 ? new Map<string, string>() : new Map(
    (await db.select({ id: invoices.id, no: invoices.invoiceNo }).from(invoices).where(inArray(invoices.id, invoiceIds))).map((r) => [r.id, r.no]),
  );
  const cnIds = vouchers.map((v) => v.creditNoteId).filter((x): x is string => x !== null);
  const cnNos = cnIds.length === 0 ? new Map<string, string>() : new Map(
    (await db.select({ id: creditNotes.id, no: creditNotes.creditNoteNo }).from(creditNotes).where(inArray(creditNotes.id, cnIds))).map((r) => [r.id, r.no]),
  );

  // ── APPROVE / owner's clocks: refund questions still pending. (A write-off question to the owner
  // rides its mismatch row below, so the one tender never shows twice.) ──
  const pending = await db.select().from(approvals).where(and(
    eq(approvals.status, "pending"),
    inArray(approvals.typeKey, [REFUND_APPROVAL_TYPE, REFUND_OWNER_APPROVAL_TYPE]),
  )).orderBy(asc(approvals.requestedAt));

  const names = await namesOf(db, [
    ...vouchers.map((v) => v.requestedBy),
    ...voucherApprovals.flatMap((a) => [a.decidedBy ?? "", a.requesterId]),
    ...pending.map((p) => p.requesterId),
  ]);

  for (const v of vouchers) {
    const a = approvalById.get(v.approvalId);
    const age = minutesSince(v.issuedAt, now);
    const id = `pay:${v.id}`;
    rows.push({
      id, kind: "pay_voucher", source: "PAY", state: "open", tier: 1,
      since: v.issuedAt.toISOString(), ageMinutes: age, daysLeft: null, tone: ageTone(age, DAY_MS / MINUTE, 3 * DAY_MS / MINUTE),
      patient: null,
      params: {
        voucherId: v.id, voucherNo: v.voucherNo, amountPaise: v.amountPaise, method: v.method, refundKind: v.kind,
        reasonClass: v.reasonClass, reason: v.reason,
        guardFlags: Array.isArray(v.guardFlags) ? (v.guardFlags as unknown[]).map(String) : [],
        invoiceNo: v.invoiceId === null ? null : invoiceNos.get(v.invoiceId) ?? null,
        creditNoteNo: v.creditNoteId === null ? null : cnNos.get(v.creditNoteId) ?? null,
        requestedAt: a?.requestedAt.toISOString() ?? null,
        requestedBy: names.get(a?.requesterId ?? "") ?? null,
        approvedAt: a?.decidedAt?.toISOString() ?? null,
        approvedBy: names.get(a?.decidedBy ?? "") ?? null,
        issuedAt: v.issuedAt.toISOString(),
        issuedBy: names.get(v.requestedBy) ?? null,
        bankAbovePaise: cfg.refundBankAbovePaise,
      },
    });
    patientIds.push(v.patientId); patientOf.set(id, v.patientId);
  }

  for (const p of pending) {
    const age = minutesSince(p.requestedAt, now);
    const owner = p.typeKey === REFUND_OWNER_APPROVAL_TYPE;
    const kind: NeedKind = owner ? "refund_owner" : "approve_refund";
    const id = `approval:${p.id}`;
    rows.push({
      id, kind, source: "APPROVE", state: owner ? "waiting" : "open", tier: 2,
      since: p.requestedAt.toISOString(), ageMinutes: age, daysLeft: null, tone: ageTone(age, 4 * 60, DAY_MS / MINUTE),
      patient: null,
      params: {
        approvalId: p.id, amountPaise: p.amountPaise ?? 0, note: p.requestNote ?? "", subjectId: p.subjectId,
        requestedBy: names.get(p.requesterId) ?? null,
      },
    });
    if (p.patientId !== null) { patientIds.push(p.patientId); patientOf.set(id, p.patientId); }
  }

  // ── RECON: mismatched tenders; a disputed one is a clock, not a task ──
  const mismatches = await listMismatches(db, actor);
  if (mismatches.length > 0) {
    const receiptRows = await db.select({ id: receipts.id, receivedAt: receipts.receivedAt })
      .from(receipts).where(inArray(receipts.id, mismatches.map((m) => m.receiptId)));
    const receivedAt = new Map(receiptRows.map((r) => [r.id, r.receivedAt]));
    for (const m of mismatches) {
      const last = await latestResolution(db, m.tenderId);
      const disputed = last?.outcome === "disputed";
      const shortPaise = m.expectedNetPaise - m.settledPaise;
      // OWNER RULING 2026-09-28 — above ₹50.00 the write-off is the owner's: while the question is with
      // the owner the row is a clock; once the owner says yes it is back on the list to be applied.
      const question = shortPaise > RECON_CHARGE_MANAGER_MAX_PAISE ? await ownerQuestionFor(db, m.tenderId, shortPaise) : { pending: null, granted: null };
      const ownerApproval = question.granted !== null ? "granted" : question.pending !== null ? "pending" : null;
      const since = m.reconciledAt ?? receivedAt.get(m.receiptId) ?? now;
      const age = minutesSince(since, now);
      const id = `recon:${m.tenderId}`;
      rows.push({
        id, kind: disputed ? "recon_disputed" : "recon_mismatch", source: "RECON",
        state: (disputed || ownerApproval === "pending") ? "waiting" : "open", tier: 0,
        since: since.toISOString(), ageMinutes: age, daysLeft: null, tone: "rd",
        patient: { patientId: m.patientId, uhid: m.uhid, name: m.name, alias: m.alias, restricted: m.restricted },
        params: {
          tenderId: m.tenderId, receiptNo: m.receiptNo, mode: m.mode, amountPaise: m.amountPaise,
          expectedNetPaise: m.expectedNetPaise, settledPaise: m.settledPaise, shortPaise,
          ownerApproval, ownerApprovalId: question.granted ?? question.pending,
          takenAt: receivedAt.get(m.receiptId)?.toISOString() ?? null,
          uploadedAt: m.reconciledAt === null ? null : m.reconciledAt.toISOString(),
          disputedAt: disputed && last !== null ? last.at.toISOString() : null,
        },
      });
    }
  }

  // ── RECON: statements not uploaded — UPI/card money still `captured` from a finished day ──
  const weekAgo = shiftDay(day, -7);
  const stale = await db
    .select({ serviceDay: receipts.serviceDay, mode: receiptTenders.mode, amountPaise: receiptTenders.amountPaise })
    .from(receiptTenders)
    .innerJoin(receipts, eq(receiptTenders.receiptId, receipts.id))
    .where(and(
      eq(receiptTenders.state, "captured"), inArray(receiptTenders.mode, ["upi", "card"]),
      lt(receipts.serviceDay, day), gte(receipts.serviceDay, weekAgo),
    ));
  const byDayMode = new Map<string, { day: string; mode: string; count: number; totalPaise: number }>();
  for (const s of stale) {
    const key = `${s.serviceDay}|${s.mode}`;
    const g = byDayMode.get(key) ?? { day: s.serviceDay, mode: s.mode, count: 0, totalPaise: 0 };
    g.count += 1; g.totalPaise += s.amountPaise;
    byDayMode.set(key, g);
  }
  for (const g of [...byDayMode.values()].sort((a, b) => a.day.localeCompare(b.day) || a.mode.localeCompare(b.mode))) {
    const since = new Date(`${shiftDay(g.day, 1)}T00:00:00+05:30`);
    const age = minutesSince(since, now);
    rows.push({
      id: `missing:${g.day}:${g.mode}`, kind: "recon_missing", source: "RECON", state: "open", tier: 5,
      since: since.toISOString(), ageMinutes: age, daysLeft: null, tone: ageTone(age, 2 * DAY_MS / MINUTE, 4 * DAY_MS / MINUTE),
      patient: null,
      params: { day: g.day, mode: g.mode, count: g.count, totalPaise: g.totalPaise },
    });
  }

  // ── UNBILLED: visits today and yesterday that owe a fee and carry no bill ──
  for (const d of [day, shiftDay(day, -1)]) {
    const orphans = await chargeOrphans(db, d);
    for (const o of orphans) {
      const since = new Date(`${o.serviceDate}T00:00:00+05:30`);
      const id = `unbilled:${o.encounterId}`;
      rows.push({
        id, kind: "unbilled_visit", source: "UNBILLED", state: "open", tier: 3,
        since: since.toISOString(), ageMinutes: minutesSince(since, now), daysLeft: null, tone: d === day ? "no" : "gd",
        patient: null,
        params: { encounterId: o.encounterId, visitNo: o.visitNo, visitType: o.visitType, serviceDate: o.serviceDate },
      });
      patientIds.push(o.patientId); patientOf.set(id, o.patientId);
    }
  }

  // ── DAY BOOK: receipts taken on paper during downtime, yesterday and today ──
  for (const d of [shiftDay(day, -1), day]) {
    const book = await dayBook(db, d);
    if (book.degraded.count === 0) continue;
    const since = new Date(`${d}T00:00:00+05:30`);
    rows.push({
      id: `paper:${d}`, kind: "daybook_paper", source: "DAY BOOK", state: "open", tier: 4,
      since: since.toISOString(), ageMinutes: minutesSince(since, now), daysLeft: null, tone: "no",
      patient: null,
      params: { day: d, count: book.degraded.count, totalPaise: book.degraded.totalPaise },
    });
  }

  // ── GSTR-1: the next due date ──
  const due = gstr1Due(day);
  rows.push({
    id: `gstr1:${due.month}`, kind: "gstr1_due", source: "GSTR-1", state: "open", tier: due.daysLeft <= 3 ? 1 : 6,
    since: null, ageMinutes: null, daysLeft: due.daysLeft, tone: due.daysLeft <= 3 ? "rd" : due.daysLeft <= 7 ? "gd" : "no",
    patient: null,
    params: { month: due.month, due: due.due },
  });

  // Patients, through the confidential gate, in ONE batch.
  if (patientIds.length > 0) {
    const summaries = await getPatientSummaries(db, actor, [...new Set(patientIds)]);
    const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
    for (const row of rows) {
      const pid = patientOf.get(row.id);
      if (pid === undefined) continue;
      const s = byPatient.get(pid);
      row.patient = { patientId: pid, uhid: s?.uhid ?? "", name: s?.name ?? null, alias: s?.alias ?? null, restricted: s?.restricted ?? false };
    }
  }

  rows.sort((a, b) => a.tier - b.tier || (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1) || a.id.localeCompare(b.id));

  const toPay = rows.filter((r) => r.kind === "pay_voucher");
  const open = rows.filter((r) => r.kind === "recon_mismatch" || r.kind === "recon_disputed");
  return {
    asOf: now.toISOString(),
    day,
    rows,
    money: {
      toPayCount: toPay.length,
      toPayPaise: toPay.reduce((s, r) => s + Number(r.params.amountPaise ?? 0), 0),
      shortPaise: open.reduce((s, r) => s + Math.max(0, Number(r.params.shortPaise ?? 0)), 0),
    },
    limits: {
      reconChargeManagerMaxPaise: RECON_CHARGE_MANAGER_MAX_PAISE,
      refundOwnerAbovePaise: REFUND_OWNER_ABOVE_PAISE,
      reconTolerancePaise: cfg.reconTolerancePaise,
    },
  };
}
