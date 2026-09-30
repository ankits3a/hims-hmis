/**
 * ═══ UX-AUDIT 2026-09-29 · BOARD — THE PATIENT PROFILE'S PURE HALF ═══
 *
 * `docs/design/2026-09-29-patient-profile/patient-profile.html` (owner-approved) replaces the edit
 * form at `/patients/:id` with a profile: who (lane), where today and ONE dated timeline (centre),
 * the acts this seat may take (side). Everything here is a pure function of wire rows so the rules
 * the board states — printed dates, masked mobiles, one list with a source chip per row, folded by
 * the permissions the server already splits — are pinned without a DOM.
 */
import type { WireTimelineItem } from "../lib/opd-api";
import type { WireDueRow, WireInvoice } from "../lib/billing-api";
import type { WirePatientDispense, WirePatientImaging, WirePatientResult } from "../lib/brief-history";
import type { WirePatientReports } from "../lib/lab-api";
import type { WirePatientDocument } from "../lib/patients-api";
import { fmtPaise } from "../lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60 * 1000;

/** A CALENDAR date (`YYYY-MM-DD…`, e.g. a date of birth or a service day) → `12-Mar-1955`. No timezone shift. */
export function dmy(day: string | null | undefined): string {
  if (day === null || day === undefined) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (m === null) return "";
  return `${m[3]}-${MONTHS[Number(m[2]) - 1] ?? ""}-${m[1]}`;
}

/** An INSTANT (ISO with time) → its IST calendar day, `YYYY-MM-DD`. */
export function istDay(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** An INSTANT → `12-Mar-2026` in IST. */
export function dmyIst(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  return dmy(istDay(iso));
}

/** Masked mobile: the last four digits only (`•••••• 1236`). Never the full number on a read surface. */
export function maskMobile(phone: string | null | undefined): string {
  if (phone === null || phone === undefined || phone === "") return "";
  return `•••••• ${phone.replace(/\D/g, "").slice(-4)}`;
}

export type Source = "OPD" | "LAB" | "RAD" | "BILL" | "PHAR" | "DOC";

export type TimelineRow = {
  key: string;
  source: Source;
  /** IST calendar day, `YYYY-MM-DD` — the day heading the row sits under. */
  day: string;
  /** Sort key within the day, newest first (ISO instant or the day itself). */
  at: string;
  title: string;
  /** The part of the title drawn in brick red (an abnormal value, a critical impression). */
  alert?: string;
  sub: string | null;
  /** A right-aligned amount in paise (bills). */
  amountPaise?: number;
  /** A right-aligned plain word (a visit number). */
  note?: string;
  /** Gold row: money still owed on it. */
  owing?: boolean;
  /** A document the row can open. */
  documentId?: string;
};

export type TimelineSources = {
  visits?: WireTimelineItem[];
  /** `lab.results.read` — values, for a seat that may read them. */
  labResults?: WirePatientResult[];
  /** `lab.reports.print` — report rows WITHOUT values, for a counter seat. */
  labReports?: WirePatientReports;
  imaging?: WirePatientImaging[];
  invoices?: WireInvoice[];
  dues?: WireDueRow[];
  dispenses?: WirePatientDispense[];
  documents?: WirePatientDocument[];
};

export type Labels = {
  /** `opd.consult` holder: the diagnosis code and the medicine count are drawn. */
  clinical: boolean;
  visit: (visitNo: string) => string;
  medicines: (n: number) => string;
  labSigned: string;
  labResults: (n: number) => string;
  labReportVersion: (n: number) => string;
  paidDue: (paid: string, due: string) => string;
  settled: string;
  onCredit: string;
  pharmacy: (n: number) => string;
  docKind: (kind: string) => string;
  docScanned: string;
  high: string;
  low: string;
};

function flagWord(flag: string | null, l: Labels): string | null {
  if (flag === null || flag === "" || flag.toUpperCase() === "N") return null;
  const f = flag.toUpperCase();
  if (f.startsWith("H")) return l.high;
  if (f.startsWith("L")) return l.low;
  return f.toLowerCase();
}

/**
 * THE ONE TIMELINE. Every source is optional because every source is a separate, separately
 * permissioned read: a seat without the permission never asks, and its rows are simply absent —
 * the screen folds by what the server would refuse, never by hiding what it was sent.
 */
export function buildTimeline(src: TimelineSources, l: Labels): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const v of src.visits ?? []) {
    const who = [v.departmentName, v.doctorName].filter((x): x is string => x !== null && x !== "").join(" · ");
    const parts: string[] = [];
    if (v.diagnosis !== null && v.diagnosis !== "") parts.push(l.clinical && v.icd10Code !== null ? `${v.diagnosis} (${v.icd10Code})` : v.diagnosis);
    if (l.clinical && v.prescriptionLineCount > 0) parts.push(l.medicines(v.prescriptionLineCount));
    rows.push({
      key: `opd-${v.encounterId}`, source: "OPD", day: v.serviceDate, at: v.openedAt,
      title: who === "" ? "OPD" : who, sub: parts.length === 0 ? null : parts.join(" · "),
      ...(v.visitNo !== undefined && v.visitNo !== "" ? { note: l.visit(v.visitNo) } : {}),
    });
  }
  if (src.labResults !== undefined) {
    const byOrder = new Map<string, WirePatientResult[]>();
    for (const r of src.labResults) {
      const k = `${istDay(r.verifiedAt)}|${r.orderableName}`;
      byOrder.set(k, [...(byOrder.get(k) ?? []), r]);
    }
    for (const [k, rs] of byOrder) {
      const flagged = rs.filter((r) => flagWord(r.flag, l) !== null);
      const first = flagged[0];
      const alert = first === undefined ? undefined
        : `${first.analyteName === first.orderableName ? "" : `${first.analyteName} `}${first.value}${first.unit === null || first.unit === "" ? "" : ` ${first.unit}`} · ${flagWord(first.flag, l) ?? ""}`;
      const latest = rs.map((r) => r.verifiedAt).sort().at(-1) ?? "";
      rows.push({
        key: `lab-${k}`, source: "LAB", day: istDay(latest), at: latest,
        title: rs[0]!.orderableName, ...(alert !== undefined ? { alert } : {}),
        sub: flagged.length > 1 ? `${l.labResults(rs.length)} · +${String(flagged.length - 1)}` : l.labResults(rs.length),
      });
    }
  } else if (src.labReports !== undefined) {
    for (const r of src.labReports.reports) {
      const at = r.publishedAt ?? `${r.serviceDate}T00:00:00.000Z`;
      rows.push({
        key: `labr-${r.reportId}`, source: "LAB", day: r.publishedAt !== null ? istDay(r.publishedAt) : r.serviceDate, at,
        title: r.orderables.join(", "), sub: r.version > 1 ? `${l.labSigned} · ${l.labReportVersion(r.version)}` : l.labSigned,
      });
    }
  }
  for (const [i, r] of (src.imaging ?? []).entries()) {
    const impression = r.impression === null || r.impression.trim() === "" ? null : r.impression.trim();
    rows.push({
      key: `rad-${String(i)}-${r.signedAt}`, source: "RAD", day: istDay(r.signedAt), at: r.signedAt, title: r.studyName,
      ...(r.criticalCategory !== null && impression !== null ? { alert: impression } : {}),
      sub: r.criticalCategory !== null ? null : impression,
    });
  }
  const owing = new Map((src.dues ?? []).map((d) => [d.invoiceId, d.outstandingPaise]));
  for (const inv of src.invoices ?? []) {
    const due = owing.get(inv.id) ?? 0;
    const sub = due > 0
      ? l.paidDue(fmtPaise(inv.netPayablePaise - due), fmtPaise(due))
      : inv.creditExtended ? l.onCredit : l.settled;
    rows.push({
      key: `bill-${inv.id}`, source: "BILL", day: inv.serviceDay, at: inv.issuedAt,
      title: inv.invoiceNo, sub, amountPaise: inv.netPayablePaise, ...(due > 0 ? { owing: true } : {}),
    });
  }
  for (const d of src.dispenses ?? []) {
    rows.push({
      key: `phar-${d.prescriptionId}-${d.handedOverAt}`, source: "PHAR", day: istDay(d.handedOverAt), at: d.handedOverAt,
      title: l.pharmacy(d.lines.length), sub: d.lines.map((x) => x.drug).join(" · ") || null,
    });
  }
  for (const doc of src.documents ?? []) {
    rows.push({
      key: `doc-${doc.id}`, source: "DOC", day: istDay(doc.capturedAt), at: doc.capturedAt,
      title: l.docKind(doc.kind), sub: doc.note ?? l.docScanned, documentId: doc.id,
    });
  }
  return rows.sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Rows grouped under their day, newest day first (the input is already sorted). */
export function groupByDay(rows: TimelineRow[]): { day: string; rows: TimelineRow[] }[] {
  const out: { day: string; rows: TimelineRow[] }[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last !== undefined && last.day === r.day) last.rows.push(r);
    else out.push({ day: r.day, rows: [r] });
  }
  return out;
}

/** What the patient owes now: the total, and the oldest bill it started from. */
export function duesSummary(dues: WireDueRow[] | undefined): { totalPaise: number; oldest: WireDueRow | null; count: number } {
  const open = (dues ?? []).filter((d) => d.outstandingPaise > 0);
  const oldest = [...open].sort((a, b) => a.seq - b.seq)[0] ?? null;
  return { totalPaise: open.reduce((s, d) => s + d.outstandingPaise, 0), oldest, count: open.length };
}

/** Today's visits that are still open — "where are they now". */
export function openVisitsToday(visits: WireTimelineItem[] | undefined, today: string): WireTimelineItem[] {
  const ended = new Set(["completed", "closed", "cancelled", "abandoned", "ended", "no_show"]);
  return (visits ?? []).filter((v) => v.serviceDate === today && !ended.has(v.status));
}
