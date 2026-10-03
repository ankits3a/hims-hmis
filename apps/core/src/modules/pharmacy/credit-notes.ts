import { and, desc, eq, inArray } from "drizzle-orm";
import { approvals, creditNotes, invoices, pharmacyCreditMoves, refundVouchers } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { istDateOf } from "./config";
import { requireReportPermission, REPORTS_READ } from "./report-range";
import { salesRegister } from "./sales-register";
import { pharmacyCreditOf } from "./store-credit";
import { userNames } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ReportInput } from "./sales-register";

/**
 * ═══ CREDIT NOTES: WHO GOT ONE, HOW MUCH, AND WHAT BECAME OF THE MONEY (owner 2026-10-03) ═══
 *
 * The owner asked where to see which patient was given a credit note in a day, week, month or custom
 * range, the total value, and — on a patient's profile — the credit available in their name.
 *
 * - The REGISTER is the pharmacy's credit notes in the range (the sales register's refund rows: same
 *   range, same store filter, same `pharmacy.reports.read`), each with what became of its money.
 * - What became of it (`settlement`): kept as pharmacy credit (`pharmacy_credit_moves`, owner ruling
 *   2026-10-02), or a refund — requested (approval pending), refused, approved with a voucher not yet
 *   paid, or paid. A credit note can be both kept and refunded only in part; the larger part names it.
 * - The PATIENT's view is every credit note on their bills, newest first, and the pharmacy credit
 *   available now (`pharmacyCreditOf`: what was kept, less what was used, never above their advance).
 */
export type Settlement = "kept_as_credit" | "refund_paid" | "refund_approved" | "refund_requested" | "refund_refused" | "none";
export type CreditNoteRow = {
  id: string; creditNoteNo: string; date: string; at: string; invoiceNo: string;
  patientId: string; patientName: string; uhid: string;
  kind: string; reason: string; netPaise: number; issuedByName: string;
  settlement: Settlement; keptPaise: number; refundPaise: number;
};
export type CreditNoteRegister = {
  from: string; to: string; preset: string;
  rows: CreditNoteRow[];
  byPatient: { patientId: string; patientName: string; uhid: string; count: number; netPaise: number; keptPaise: number; refundPaise: number }[];
  totals: { count: number; netPaise: number; keptPaise: number; refundRequestedPaise: number; refundPaidPaise: number };
};

type Money = { keptPaise: number; refundPaise: number; settlement: Settlement };

/** What became of each credit note's money. */
async function settlementsOf(db: Db, ids: readonly string[]): Promise<Map<string, Money>> {
  const out = new Map<string, Money>();
  if (ids.length === 0) return out;
  const [kept, asks, vouchers] = await Promise.all([
    db.select({ id: pharmacyCreditMoves.creditNoteId, amount: pharmacyCreditMoves.amountPaise }).from(pharmacyCreditMoves)
      .where(and(inArray(pharmacyCreditMoves.creditNoteId, [...ids]), eq(pharmacyCreditMoves.kind, "kept"))),
    db.select({ id: approvals.subjectId, status: approvals.status, amount: approvals.amountPaise }).from(approvals)
      .where(and(eq(approvals.subjectType, "billing_refund"), inArray(approvals.subjectId, [...ids]))),
    db.select({ id: refundVouchers.creditNoteId, status: refundVouchers.status, amount: refundVouchers.amountPaise }).from(refundVouchers)
      .where(inArray(refundVouchers.creditNoteId, [...ids])),
  ]);
  for (const id of ids) {
    const keptPaise = kept.filter((k) => k.id === id).reduce((s, k) => s + k.amount, 0);
    const v = vouchers.filter((x) => x.id === id);
    const a = asks.filter((x) => x.id === id);
    const refundPaise = v.length > 0 ? v.reduce((s, x) => s + x.amount, 0) : a.filter((x) => x.status !== "rejected").reduce((s, x) => s + (x.amount ?? 0), 0);
    let settlement: Settlement = "none";
    if (v.some((x) => x.status === "paid")) settlement = "refund_paid";
    else if (v.length > 0 || a.some((x) => x.status === "approved")) settlement = "refund_approved";
    else if (a.some((x) => x.status === "pending")) settlement = "refund_requested";
    else if (a.some((x) => x.status === "rejected")) settlement = "refund_refused";
    if (keptPaise > 0 && keptPaise >= refundPaise) settlement = "kept_as_credit";
    out.set(id, { keptPaise, refundPaise, settlement });
  }
  return out;
}

export async function creditNoteRegister(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<CreditNoteRegister> {
  await requireReportPermission(db, actor, REPORTS_READ, "the credit note register");
  const sales = await salesRegister(db, actor, { ...input, groupBy: "document" }, now);
  const refunds = sales.rows.filter((r) => r.kind === "refund");
  const ids = refunds.map((r) => r.id);
  const [money, notes] = await Promise.all([
    settlementsOf(db, ids),
    ids.length === 0 ? [] : db.select({ id: creditNotes.id, kind: creditNotes.kind, reason: creditNotes.reason }).from(creditNotes).where(inArray(creditNotes.id, ids)),
  ]);
  const noteOf = new Map(notes.map((n) => [n.id, n] as const));
  const rows: CreditNoteRow[] = refunds.map((r) => {
    const m = money.get(r.id) ?? { keptPaise: 0, refundPaise: 0, settlement: "none" as const };
    return {
      id: r.id, creditNoteNo: r.docNo, date: r.date, at: r.at, invoiceNo: r.invoiceNo,
      patientId: r.patientId, patientName: r.patientName, uhid: r.uhid,
      kind: noteOf.get(r.id)?.kind ?? "refund", reason: noteOf.get(r.id)?.reason ?? "", netPaise: r.netPaise, issuedByName: r.operatorName,
      settlement: m.settlement, keptPaise: m.keptPaise, refundPaise: m.refundPaise,
    };
  });
  const groups = new Map<string, CreditNoteRegister["byPatient"][number]>();
  for (const r of rows) {
    const g = groups.get(r.patientId) ?? { patientId: r.patientId, patientName: r.patientName, uhid: r.uhid, count: 0, netPaise: 0, keptPaise: 0, refundPaise: 0 };
    g.count += 1; g.netPaise += r.netPaise; g.keptPaise += r.keptPaise; g.refundPaise += r.refundPaise;
    groups.set(r.patientId, g);
  }
  return {
    from: sales.from, to: sales.to, preset: sales.preset, rows,
    byPatient: [...groups.values()].sort((a, b) => b.netPaise - a.netPaise || a.patientName.localeCompare(b.patientName)),
    totals: {
      count: rows.length,
      netPaise: rows.reduce((s, r) => s + r.netPaise, 0),
      keptPaise: rows.reduce((s, r) => s + r.keptPaise, 0),
      refundRequestedPaise: rows.reduce((s, r) => s + r.refundPaise, 0),
      refundPaidPaise: rows.filter((r) => r.settlement === "refund_paid").reduce((s, r) => s + r.refundPaise, 0),
    },
  };
}

export type PatientCredit = {
  /** Pharmacy credit the patient can spend at the desk now. */
  availablePaise: number;
  notes: Omit<CreditNoteRow, "patientId" | "patientName" | "uhid">[];
  totalNetPaise: number;
};

/** Every credit note on the patient's bills, newest first, and the pharmacy credit available now. */
export async function patientCredit(db: Db, actor: Actor, patientId: string): Promise<PatientCredit> {
  // The read is gated at the route; the summary read below also enforces the confidential seal.
  const [who] = await getPatientSummaries(db, actor, [patientId]);
  if (who === undefined) return { availablePaise: 0, notes: [], totalNetPaise: 0 };
  const rows = await db.select({
    id: creditNotes.id, creditNoteNo: creditNotes.creditNoteNo, issuedAt: creditNotes.issuedAt, invoiceNo: invoices.invoiceNo,
    kind: creditNotes.kind, reason: creditNotes.reason, netPaise: creditNotes.netPaise, issuedBy: creditNotes.issuedBy,
  }).from(creditNotes).innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
    .where(eq(invoices.patientId, patientId)).orderBy(desc(creditNotes.issuedAt)).limit(200);
  const [money, names, credit] = await Promise.all([
    settlementsOf(db, rows.map((r) => r.id)), userNames(db, rows.map((r) => r.issuedBy)), pharmacyCreditOf(db, patientId),
  ]);
  const notes = rows.map((r) => {
    const m = money.get(r.id) ?? { keptPaise: 0, refundPaise: 0, settlement: "none" as const };
    const at = r.issuedAt.toISOString();
    return {
      id: r.id, creditNoteNo: r.creditNoteNo, date: istDateOf(r.issuedAt), at, invoiceNo: r.invoiceNo,
      kind: r.kind, reason: r.reason, netPaise: r.netPaise, issuedByName: names.get(r.issuedBy) ?? r.issuedBy,
      settlement: m.settlement, keptPaise: m.keptPaise, refundPaise: m.refundPaise,
    };
  });
  return { availablePaise: credit.availablePaise, notes, totalNetPaise: notes.reduce((s, n) => s + n.netPaise, 0) };
}
