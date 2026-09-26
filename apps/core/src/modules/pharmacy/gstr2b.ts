import { billsForReconciliation, vendorBillKey } from "../materials";
import { PharmacyError } from "./errors";
import { REPORTS_READ, reportRange, reportToday, requireReportPermission } from "./report-range";
import type { ReconBill } from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — GSTR-2B AGAINST THE BOOKS ═══
 *
 * The accountant downloads the month's GSTR-2B from the GST portal (the JSON, or the Excel's B2B
 * sheet saved as CSV) and hands it to the office. Nothing is fetched from anywhere: the file is read,
 * each supplier invoice in it is set against the supplier bills we booked (P3), and every document
 * lands in one bucket:
 *
 *   - `matched`     — same supplier GSTIN, same invoice number (case, spaces, `-`, `/`, `.` ignored —
 *                     P3's own duplicate key), same date, and taxable value and each tax head within
 *                     `TOLERANCE_PAISE` (₹1: the portal and the books round separately);
 *   - `mismatch`    — the same GSTIN and invoice number, but the date or an amount differs;
 *   - `only_2b`     — the supplier filed it and we have not booked it (claimable input tax we are
 *                     not claiming, or a bill nobody entered);
 *   - `only_books`  — booked by us, not in this 2B (the supplier has not filed: input tax at risk).
 *
 * Only B2B invoices are matched. Credit and debit notes (the 2B's CDNR) are listed apart with their
 * value for the accountant to read against our debit notes. The file is never stored.
 */
export const TOLERANCE_PAISE = 100;
/** A 2B for one month is a few hundred documents; this bounds what one upload may ask about. */
const MAX_DOCS = 20_000;

export type TwoBDoc = {
  gstin: string; tradeName: string; invoiceNo: string; invoiceKey: string; date: string;
  taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; valuePaise: number;
};
export type TwoBNote = TwoBDoc & { noteType: string };
export type ParsedTwoB = { period: string | null; gstin: string | null; docs: TwoBDoc[]; notes: TwoBNote[] };

const paise = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** `24-09-2026`, `24/09/2026` or `2026-09-24` → `2026-09-24`; anything else is kept as written (it will not match). */
export function isoDateOf(v: unknown): string {
  const s = String(v ?? "").trim();
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (dmy !== null) return `${dmy[3]!}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (ymd !== null) return `${ymd[1]!}-${ymd[2]!}-${ymd[3]!}`;
  const mon = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/.exec(s);
  if (mon !== null) {
    const m = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(mon[2]!.toUpperCase()) + 1;
    if (m > 0) return `${mon[3]!}-${String(m).padStart(2, "0")}-${mon[1]!.padStart(2, "0")}`;
  }
  return s;
}

type Rec = Record<string, unknown>;
const asArray = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

/** The invoice-level figures, or the items' sum when a version carries them only per rate. */
function money(inv: Rec): { taxable: number; igst: number; cgst: number; sgst: number } {
  if (inv.txval !== undefined) return { taxable: paise(inv.txval), igst: paise(inv.igst), cgst: paise(inv.cgst), sgst: paise(inv.sgst) };
  const items = [...asArray(inv.items), ...asArray(inv.itms).map((i) => (i.itm_det ?? i) as Rec)];
  return items.reduce<{ taxable: number; igst: number; cgst: number; sgst: number }>(
    (s, i) => ({ taxable: s.taxable + paise(i.txval), igst: s.igst + paise(i.igst ?? i.iamt), cgst: s.cgst + paise(i.cgst ?? i.camt), sgst: s.sgst + paise(i.sgst ?? i.samt) }),
    { taxable: 0, igst: 0, cgst: 0, sgst: 0 },
  );
}

function docOf(ctin: string, tradeName: string, no: string, dt: unknown, m: { taxable: number; igst: number; cgst: number; sgst: number }, val: unknown): TwoBDoc {
  return {
    gstin: ctin.trim().toUpperCase(), tradeName: tradeName.trim(), invoiceNo: no.trim(), invoiceKey: vendorBillKey(no), date: isoDateOf(dt),
    taxablePaise: m.taxable, igstPaise: m.igst, cgstPaise: m.cgst, sgstPaise: m.sgst,
    valuePaise: val === undefined || val === null || val === "" ? m.taxable + m.igst + m.cgst + m.sgst : paise(val),
  };
}

/** The portal's GSTR-2B JSON (`data.docdata.b2b[].inv[]`, `…cdnr[].nt[]`); GSTR-2A's `b2b[].inv[].itms[]` reads too. */
export function parseGstr2bJson(text: string): ParsedTwoB {
  let root: Rec;
  try {
    root = JSON.parse(text) as Rec;
  } catch {
    throw new PharmacyError("gst_statement_unreadable", "the file is not JSON — download the GSTR-2B JSON from the GST portal, or save the Excel's B2B sheet as CSV");
  }
  const data = (root.data ?? root) as Rec;
  const docdata = (data.docdata ?? data) as Rec;
  const docs: TwoBDoc[] = [];
  for (const s of asArray(docdata.b2b)) {
    const ctin = String(s.ctin ?? "");
    for (const inv of asArray(s.inv)) docs.push(docOf(ctin, String(s.trdnm ?? ""), String(inv.inum ?? ""), inv.dt ?? inv.idt, money(inv), inv.val));
  }
  const notes: TwoBNote[] = [];
  for (const s of asArray(docdata.cdnr)) {
    const ctin = String(s.ctin ?? "");
    for (const nt of asArray(s.nt)) {
      notes.push({ ...docOf(ctin, String(s.trdnm ?? ""), String(nt.ntnum ?? nt.nt_num ?? ""), nt.dt ?? nt.nt_dt, money(nt), nt.val), noteType: String(nt.typ ?? nt.ntty ?? "") });
    }
  }
  if (docs.length === 0 && notes.length === 0 && !Array.isArray(docdata.b2b)) {
    throw new PharmacyError("gst_statement_unreadable", "no B2B section in this JSON — is it the GSTR-2B download?");
  }
  const rtnprd = data.rtnprd ?? root.rtnprd ?? data.ret_period ?? root.ret_period;
  return { period: rtnprd === undefined ? null : String(rtnprd), gstin: data.gstin === undefined ? null : String(data.gstin), docs, notes };
}

/** One CSV line into cells: quoted cells may carry commas and doubled quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const COLUMN: Record<"gstin" | "name" | "no" | "date" | "value" | "taxable" | "igst" | "cgst" | "sgst", RegExp> = {
  gstin: /gstin/i, name: /trade|legal|supplier name|trdnm/i, no: /invoice\s*(number|no)|^inum$/i, date: /invoice\s*date|^dt$/i,
  value: /invoice\s*value|^val$/i, taxable: /taxable|^txval$/i, igst: /integrated|^igst/i, cgst: /central|^cgst/i, sgst: /state|^sgst/i,
};

/**
 * The GSTR-2B Excel's B2B sheet saved as CSV (or any CSV with those columns). The portal's sheet has
 * title rows above the header; the header is the first row naming a GSTIN and an invoice number.
 */
export function parseGstr2bCsv(text: string): ParsedTwoB {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const headerAt = lines.findIndex((l) => { const c = cells(l); return c.some((x) => COLUMN.gstin.test(x)) && c.some((x) => COLUMN.no.test(x)); });
  if (headerAt < 0) throw new PharmacyError("gst_statement_unreadable", "no header row with a supplier GSTIN and an invoice number — save the GSTR-2B Excel's B2B sheet as CSV");
  const header = cells(lines[headerAt]!);
  const at = (k: keyof typeof COLUMN): number => header.findIndex((h) => COLUMN[k].test(h));
  const col = { gstin: at("gstin"), name: at("name"), no: at("no"), date: at("date"), value: at("value"), taxable: at("taxable"), igst: at("igst"), cgst: at("cgst"), sgst: at("sgst") };
  if (col.taxable < 0 || col.date < 0) throw new PharmacyError("gst_statement_unreadable", "the CSV needs the invoice date and taxable value columns");
  const docs: TwoBDoc[] = [];
  for (const l of lines.slice(headerAt + 1)) {
    const c = cells(l);
    const gstin = c[col.gstin] ?? "";
    if (!/^[0-9A-Z]{15}$/i.test(gstin.trim())) continue; // a sub-header or a total row
    const m = { taxable: paise(c[col.taxable]), igst: col.igst < 0 ? 0 : paise(c[col.igst]), cgst: col.cgst < 0 ? 0 : paise(c[col.cgst]), sgst: col.sgst < 0 ? 0 : paise(c[col.sgst]) };
    docs.push(docOf(gstin, col.name < 0 ? "" : (c[col.name] ?? ""), c[col.no] ?? "", c[col.date], m, col.value < 0 ? undefined : c[col.value]));
  }
  return { period: null, gstin: null, docs, notes: [] };
}

export type ReconBucket = "matched" | "mismatch" | "only_2b" | "only_books";
export type ReconDiff = { field: "date" | "taxable" | "igst" | "cgst" | "sgst"; twoB: string | number; books: string | number };
export type ReconRow = {
  bucket: ReconBucket;
  gstin: string; supplier: string; invoiceNo: string;
  twoB: { date: string; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; valuePaise: number } | null;
  books: { billId: string; billNo: string; date: string; status: string; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number } | null;
  diffs: ReconDiff[];
};

/**
 * THE MATCH, PURE. `bills` are the books; a bill whose vendor has no GSTIN on record cannot be found
 * in a 2B and is always `only_books`. Two 2B documents with one key both look for the same bill:
 * the first takes it, the second is `only_2b` (a supplier's duplicate filing).
 */
export function matchGstr2b(docs: readonly TwoBDoc[], bills: readonly ReconBill[]): ReconRow[] {
  const keyOf = (gstin: string, invoiceKey: string): string => `${gstin}|${invoiceKey}`;
  const open = new Map<string, ReconBill[]>();
  for (const b of bills) {
    if (b.gstin === null || b.gstin.trim() === "") continue;
    const k = keyOf(b.gstin.trim().toUpperCase(), vendorBillKey(b.vendorBillNo));
    open.set(k, [...(open.get(k) ?? []), b]);
  }
  const taken = new Set<string>();
  const rows: ReconRow[] = [];
  for (const d of docs) {
    const candidates = (open.get(keyOf(d.gstin, d.invoiceKey)) ?? []).filter((b) => !taken.has(b.id));
    const twoB = { date: d.date, taxablePaise: d.taxablePaise, igstPaise: d.igstPaise, cgstPaise: d.cgstPaise, sgstPaise: d.sgstPaise, valuePaise: d.valuePaise };
    if (candidates.length === 0) {
      rows.push({ bucket: "only_2b", gstin: d.gstin, supplier: d.tradeName, invoiceNo: d.invoiceNo, twoB, books: null, diffs: [] });
      continue;
    }
    const diffsOf = (b: ReconBill): ReconDiff[] => {
      const out: ReconDiff[] = [];
      if (b.billDate !== d.date) out.push({ field: "date", twoB: d.date, books: b.billDate });
      for (const [field, x, y] of [["taxable", d.taxablePaise, b.taxablePaise], ["igst", d.igstPaise, b.igstPaise], ["cgst", d.cgstPaise, b.cgstPaise], ["sgst", d.sgstPaise, b.sgstPaise]] as const) {
        if (Math.abs(x - y) > TOLERANCE_PAISE) out.push({ field, twoB: x, books: y });
      }
      return out;
    };
    const best = [...candidates].sort((a, b) => diffsOf(a).length - diffsOf(b).length)[0]!;
    taken.add(best.id);
    const diffs = diffsOf(best);
    rows.push({
      bucket: diffs.length === 0 ? "matched" : "mismatch", gstin: d.gstin, supplier: best.vendorName || d.tradeName, invoiceNo: d.invoiceNo, twoB,
      books: {
        billId: best.id, billNo: best.billNo, date: best.billDate, status: best.status, taxablePaise: best.taxablePaise,
        igstPaise: best.igstPaise, cgstPaise: best.cgstPaise, sgstPaise: best.sgstPaise, totalPaise: best.totalPaise,
      },
      diffs,
    });
  }
  return rows;
}

export type Gstr2bRecon = {
  from: string; to: string; preset: string; period: string | null; gstin: string | null;
  counts: Record<ReconBucket, number>;
  rows: ReconRow[];
  totals: {
    twoB: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number };
    books: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number };
  };
  notes: { count: number; valuePaise: number; rows: TwoBNote[] };
};

export type Gstr2bInput = { format: "json" | "csv"; content: string; preset?: string; from?: string | null; to?: string | null };

/**
 * Read the file, set it against the books. The books are the bills dated in the chosen range (the
 * 2B's month, usually) — plus, for a document the supplier filed late, any bill dated back to the
 * earliest document in the file, so a bill we booked last month is not reported missing.
 */
export async function gstr2bReconcile(db: Db, actor: Actor, input: Gstr2bInput, now: Date = new Date()): Promise<Gstr2bRecon> {
  await requireReportPermission(db, actor, REPORTS_READ, "the GSTR-2B reconciliation");
  const range = reportRange(input.preset ?? "month", reportToday(now), input);
  const parsed = input.format === "csv" ? parseGstr2bCsv(input.content) : parseGstr2bJson(input.content);
  if (parsed.docs.length + parsed.notes.length > MAX_DOCS) {
    throw new PharmacyError("gst_statement_unreadable", `the file carries ${String(parsed.docs.length + parsed.notes.length)} documents; one month's 2B is read at a time (at most ${String(MAX_DOCS)})`);
  }
  const earliest = parsed.docs.reduce((m, d) => (/^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date < m ? d.date : m), range.from);
  const bills = await billsForReconciliation(db, earliest, range.to);
  const rows = matchGstr2b(parsed.docs, bills);
  const matchedIds = new Set(rows.map((r) => r.books?.billId).filter((x): x is string => x !== undefined));
  for (const b of bills) {
    if (matchedIds.has(b.id) || b.billDate < range.from) continue;
    rows.push({
      bucket: "only_books", gstin: b.gstin ?? "", supplier: b.vendorName, invoiceNo: b.vendorBillNo, twoB: null,
      books: { billId: b.id, billNo: b.billNo, date: b.billDate, status: b.status, taxablePaise: b.taxablePaise, igstPaise: b.igstPaise, cgstPaise: b.cgstPaise, sgstPaise: b.sgstPaise, totalPaise: b.totalPaise },
      diffs: [],
    });
  }
  const order: Record<ReconBucket, number> = { mismatch: 0, only_2b: 1, only_books: 2, matched: 3 };
  rows.sort((a, b) => order[a.bucket] - order[b.bucket] || a.supplier.localeCompare(b.supplier) || a.invoiceNo.localeCompare(b.invoiceNo));
  const counts: Record<ReconBucket, number> = { matched: 0, mismatch: 0, only_2b: 0, only_books: 0 };
  for (const r of rows) counts[r.bucket] += 1;
  const sum = (side: "twoB" | "books") => rows.reduce((s, r) => {
    const m = r[side];
    return m === null ? s : { taxablePaise: s.taxablePaise + m.taxablePaise, igstPaise: s.igstPaise + m.igstPaise, cgstPaise: s.cgstPaise + m.cgstPaise, sgstPaise: s.sgstPaise + m.sgstPaise };
  }, { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 });
  return {
    from: range.from, to: range.to, preset: range.preset, period: parsed.period, gstin: parsed.gstin, counts, rows,
    totals: { twoB: sum("twoB"), books: sum("books") },
    notes: { count: parsed.notes.length, valuePaise: parsed.notes.reduce((s, n) => s + n.valuePaise, 0), rows: parsed.notes },
  };
}
