import { desc, eq, inArray, or } from "drizzle-orm";
import {
  allocations, creditNotes, imagingStudies, invoiceLines, invoices, labItems, opdEncounters, pharmacyDispenses,
  pharmacyRetailSales, receiptTenders, receipts, users,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { settlementState } from "./settlement";
import { istDay } from "./time";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { Settlement } from "./settlement";

/**
 * ═══ ALL OF A PATIENT'S BILLS, AND ANY ONE OF THEM IN FULL (owner 2026-10-03) ═══
 *
 * The profile's left lane: "All bills" — every invoice in the patient's name, filterable by department, and
 * a bill opened to its whole billing information. Read under `billing.invoice.read` (the front desk's narrow
 * dues string does not open the invoice history — owner ruling 2026-09-30).
 *
 * DEPARTMENTS (DECIDED, from what the books already link — a bill may carry more than one):
 *   pharmacy  — a desk ticket or walk-in sale points at it, or a line is a pharmacy line;
 *   lab       — a lab item points at it;
 *   imaging   — a line is an imaging study's tariff service;
 *   ot        — a procedure line;
 *   ipd       — a room-rent line, or an IPD encounter;
 *   emergency — an ER encounter;
 *   opd       — a consultation line, or an OPD encounter with nothing above;
 *   other     — anything else (registration, membership, devices…).
 */
export const BILL_DEPARTMENTS = ["pharmacy", "opd", "emergency", "ipd", "lab", "imaging", "ot", "other"] as const;
export type BillDepartment = (typeof BILL_DEPARTMENTS)[number];

export type PatientBillRow = {
  invoiceId: string; invoiceNo: string; date: string; departments: BillDepartment[]; encounterNo: string | null;
  lines: number; summary: string; netPaise: number; gstPaise: number; creditedPaise: number; paidPaise: number; settlement: Settlement;
};

async function departmentsByInvoice(db: Db, heads: { id: string; encounterId: string | null }[], lineRows: { invoiceId: string; serviceId: string; category: string }[]): Promise<Map<string, BillDepartment[]>> {
  const ids = heads.map((h) => h.id);
  const encounterRefs = [...new Set(heads.map((h) => h.encounterId).filter((x): x is string => x !== null))];
  const serviceIds = [...new Set(lineRows.map((l) => l.serviceId))];
  const [desk, walkIn, lab, imaging, encs] = await Promise.all([
    db.selectDistinct({ id: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.invoiceId, ids)),
    db.selectDistinct({ id: pharmacyRetailSales.invoiceId }).from(pharmacyRetailSales).where(inArray(pharmacyRetailSales.invoiceId, ids)),
    db.selectDistinct({ id: labItems.invoiceId }).from(labItems).where(inArray(labItems.invoiceId, ids)),
    serviceIds.length === 0 ? [] : db.selectDistinct({ id: imagingStudies.serviceId }).from(imagingStudies).where(inArray(imagingStudies.serviceId, serviceIds)),
    encounterRefs.length === 0 ? [] : db.select({ id: opdEncounters.id, visitNo: opdEncounters.visitNo, type: opdEncounters.type }).from(opdEncounters)
      .where(or(inArray(opdEncounters.visitNo, encounterRefs), inArray(opdEncounters.id, encounterRefs))),
  ]);
  const pharmacy = new Set([...desk, ...walkIn].map((r) => r.id));
  const labSet = new Set(lab.map((r) => r.id));
  const imagingServices = new Set(imaging.map((r) => r.id));
  const encType = new Map<string, string>();
  for (const e of encs) { encType.set(e.id, e.type); encType.set(e.visitNo, e.type); }
  const out = new Map<string, BillDepartment[]>();
  for (const h of heads) {
    const lines = lineRows.filter((l) => l.invoiceId === h.id);
    const d = new Set<BillDepartment>();
    const type = h.encounterId === null ? undefined : encType.get(h.encounterId);
    if (pharmacy.has(h.id) || lines.some((l) => l.category.startsWith("pharmacy"))) d.add("pharmacy");
    if (labSet.has(h.id)) d.add("lab");
    if (lines.some((l) => imagingServices.has(l.serviceId))) d.add("imaging");
    if (lines.some((l) => l.category === "procedure")) d.add("ot");
    if (lines.some((l) => l.category === "room_rent") || type === "ipd") d.add("ipd");
    if (type === "er" || type === "emergency") d.add("emergency");
    if (lines.some((l) => l.category === "consultation") || (d.size === 0 && type === "opd")) d.add("opd");
    if (d.size === 0) d.add("other");
    out.set(h.id, BILL_DEPARTMENTS.filter((x) => d.has(x)));
  }
  return out;
}

async function moneyByInvoice(db: Db, ids: readonly string[]): Promise<{ credited: Map<string, number>; paid: Map<string, number> }> {
  const credited = new Map<string, number>();
  const paid = new Map<string, number>();
  if (ids.length === 0) return { credited, paid };
  const [notes, allocs] = await Promise.all([
    db.select({ invoiceId: creditNotes.invoiceId, net: creditNotes.netPaise }).from(creditNotes).where(inArray(creditNotes.invoiceId, [...ids])),
    db.select({ invoiceId: allocations.invoiceId, amount: allocations.amountPaise, kind: allocations.kind }).from(allocations).where(inArray(allocations.invoiceId, [...ids])),
  ]);
  for (const n of notes) credited.set(n.invoiceId, (credited.get(n.invoiceId) ?? 0) + n.net);
  for (const a of allocs) paid.set(a.invoiceId, (paid.get(a.invoiceId) ?? 0) + (a.kind === "reverse" ? -a.amount : a.amount));
  return { credited, paid };
}

export async function patientBills(db: Db, actor: Actor, patientId: string): Promise<{ bills: PatientBillRow[] }> {
  const [who] = await getPatientSummaries(db, actor, [patientId]);
  if (who === undefined) return { bills: [] };
  const heads = await db.select().from(invoices).where(eq(invoices.patientId, patientId)).orderBy(desc(invoices.issuedAt)).limit(300);
  if (heads.length === 0) return { bills: [] };
  const ids = heads.map((h) => h.id);
  const lineRows = await db.select({ invoiceId: invoiceLines.invoiceId, serviceId: invoiceLines.serviceId, serviceName: invoiceLines.serviceName, category: invoiceLines.category, lineNo: invoiceLines.lineNo })
    .from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)).orderBy(invoiceLines.lineNo);
  const [depts, money] = await Promise.all([departmentsByInvoice(db, heads, lineRows), moneyByInvoice(db, ids)]);
  return {
    bills: heads.map((h) => {
      const lines = lineRows.filter((l) => l.invoiceId === h.id);
      const names = lines.map((l) => l.serviceName);
      const creditedPaise = money.credited.get(h.id) ?? 0;
      const paidPaise = money.paid.get(h.id) ?? 0;
      return {
        invoiceId: h.id, invoiceNo: h.invoiceNo, date: istDay(h.issuedAt), departments: depts.get(h.id) ?? ["other"], encounterNo: h.encounterId,
        lines: lines.length, summary: names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${String(names.length - 2)}`,
        netPaise: h.netPayablePaise, gstPaise: h.cgstPaise + h.sgstPaise, creditedPaise, paidPaise,
        settlement: settlementState(h.netPayablePaise, creditedPaise, paidPaise),
      };
    }),
  };
}

export type PatientBillDetail = {
  invoiceId: string; invoiceNo: string; issuedAt: string; issuedByName: string; departments: BillDepartment[]; encounterNo: string | null;
  intendedPayer: string; buyerGstin: string | null;
  lines: { lineNo: number; serviceName: string; category: string; sacCode: string; qty: number; unitPaise: number; grossPaise: number; discountPaise: number; taxablePaise: number; rateBps: number; cgstPaise: number; sgstPaise: number; netPaise: number }[];
  totals: { grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number };
  payments: { receiptNo: string; at: string; amountPaise: number; kind: string; modes: string[] }[];
  creditNotes: { creditNoteNo: string; at: string; kind: string; reason: string; netPaise: number }[];
  settlement: Settlement; creditedPaise: number; paidPaise: number;
};

/** One bill, whole: who issued it, every line with its tax, the totals, every payment and credit note, and where it stands. */
export async function patientBillDetail(db: Db, actor: Actor, invoiceId: string): Promise<PatientBillDetail | null> {
  const [h] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (h === undefined) return null;
  const [who] = await getPatientSummaries(db, actor, [h.patientId]);
  if (who === undefined) return null;
  const [lines, notes, allocs, issuer] = await Promise.all([
    db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, h.id)).orderBy(invoiceLines.lineNo),
    db.select().from(creditNotes).where(eq(creditNotes.invoiceId, h.id)).orderBy(creditNotes.issuedAt),
    db.select({ receiptId: allocations.receiptId, amount: allocations.amountPaise, kind: allocations.kind, at: allocations.at, receiptNo: receipts.receiptNo })
      .from(allocations).innerJoin(receipts, eq(receipts.id, allocations.receiptId)).where(eq(allocations.invoiceId, h.id)).orderBy(allocations.at),
    db.select({ name: users.fullName }).from(users).where(eq(users.id, h.issuedBy)),
  ]);
  const receiptIds = [...new Set(allocs.map((a) => a.receiptId))];
  const tenders = receiptIds.length === 0 ? [] : await db.select({ receiptId: receiptTenders.receiptId, mode: receiptTenders.mode }).from(receiptTenders).where(inArray(receiptTenders.receiptId, receiptIds));
  const depts = await departmentsByInvoice(db, [h], lines.map((l) => ({ invoiceId: l.invoiceId, serviceId: l.serviceId, category: l.category })));
  const creditedPaise = notes.reduce((s, n) => s + n.netPaise, 0);
  const paidPaise = allocs.reduce((s, a) => s + (a.kind === "reverse" ? -a.amount : a.amount), 0);
  return {
    invoiceId: h.id, invoiceNo: h.invoiceNo, issuedAt: h.issuedAt.toISOString(), issuedByName: issuer[0]?.name ?? h.issuedBy,
    departments: depts.get(h.id) ?? ["other"], encounterNo: h.encounterId, intendedPayer: h.intendedPayer, buyerGstin: h.buyerGstin,
    lines: lines.map((l) => ({
      lineNo: l.lineNo, serviceName: l.serviceName, category: l.category, sacCode: l.sacCode, qty: l.qty, unitPaise: l.unitPaise, grossPaise: l.grossPaise,
      discountPaise: l.discountPaise, taxablePaise: l.taxableBasePaise, rateBps: l.rateBps, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, netPaise: l.netPaise,
    })),
    totals: { grossPaise: h.grossPaise, discountPaise: h.discountPaise, taxablePaise: h.taxableBasePaise, cgstPaise: h.cgstPaise, sgstPaise: h.sgstPaise, roundingPaise: h.roundingPaise, netPaise: h.netPayablePaise },
    payments: allocs.map((a) => ({
      receiptNo: a.receiptNo, at: a.at.toISOString(), amountPaise: a.kind === "reverse" ? -a.amount : a.amount, kind: a.kind,
      modes: [...new Set(tenders.filter((t) => t.receiptId === a.receiptId).map((t) => t.mode))],
    })),
    creditNotes: notes.map((n) => ({ creditNoteNo: n.creditNoteNo, at: n.issuedAt.toISOString(), kind: n.kind, reason: n.reason, netPaise: n.netPaise })),
    settlement: settlementState(h.netPayablePaise, creditedPaise, paidPaise), creditedPaise, paidPaise,
  };
}
