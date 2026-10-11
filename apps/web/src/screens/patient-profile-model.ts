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
import type { WirePatientReports, WireRecentLabOrder } from "../lib/lab-api";
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
  /** Owner 2026-10-05 — an OPD row's visit, so the row opens the visit card. */
  encounterId?: string;
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
  /** Owner 2026-10-11 — a lab visit's number: the row opens that visit's tests and reports. */
  labVisitNo?: string;
  /** Short tags drawn under the title (a lab visit's test codes: CBC · LFT · KFT). */
  tags?: string[];
};

export type TimelineSources = {
  visits?: WireTimelineItem[];
  /** `lab.results.read` — values, for a seat that may read them. */
  labResults?: WirePatientResult[];
  /** `lab.reports.print` — report rows WITHOUT values, for a counter seat. */
  labReports?: WirePatientReports;
  /** The person's lab orders (either lab grant) — names a lab visit's tests and folds its reports into it. */
  labOrders?: WireRecentLabOrder[];
  imaging?: WirePatientImaging[];
  invoices?: WireInvoice[];
  dues?: WireDueRow[];
  dispenses?: WirePatientDispense[];
  documents?: WirePatientDocument[];
};

export type Labels = {
  /** `opd.consult` holder: the diagnosis code and the medicine count are drawn. */
  clinical: boolean;
  /** Owner 2026-10-11 — the title of a lab counter walk-in visit row. */
  labVisit: string;
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
    /** Owner 2026-10-11 — a lab walk-in is a LAB row with no OPD visit card (no token, no OPD papers). */
    const lab = v.type === "lab";
    const codes = lab ? testCodesOf(src.labOrders, v.visitNo) : [];
    rows.push({
      key: `opd-${v.encounterId}`, source: lab ? "LAB" : "OPD", day: v.serviceDate, at: v.openedAt,
      ...(lab ? {} : { encounterId: v.encounterId }),
      ...(lab && v.visitNo !== undefined && v.visitNo !== "" ? { labVisitNo: v.visitNo } : {}),
      ...(codes.length > 0 ? { tags: codes } : {}),
      title: lab ? l.labVisit : who === "" ? "OPD" : who, sub: lab ? (who === "" ? null : who) : parts.length === 0 ? null : parts.join(" · "),
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
    /** A lab visit's reports open from the visit itself (owner 2026-10-11), not as rows of their own. */
    const folded = labVisitNos(src.visits);
    for (const r of src.labReports.reports) {
      if (folded.has(r.encounterNo)) continue;
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

/** The visit numbers of the person's lab visits (`type = 'lab'`). */
export function labVisitNos(visits: WireTimelineItem[] | undefined): Set<string> {
  return new Set((visits ?? []).filter((v) => v.type === "lab" && v.visitNo !== undefined && v.visitNo !== "").map((v) => v.visitNo!));
}

/** The test codes ordered on one visit, first-ordered first, once each; cancelled orders and restricted tests left out. */
export function testCodesOf(orders: WireRecentLabOrder[] | undefined, visitNo: string | undefined): string[] {
  if (orders === undefined || visitNo === undefined || visitNo === "") return [];
  const out: string[] = [];
  for (const o of [...orders].filter((x) => x.encounterNo === visitNo && x.stage !== "cancelled").sort((a, b) => (a.placedAt < b.placedAt ? -1 : 1))) {
    for (const t of o.tests) if (t.code !== "—" && !out.includes(t.code)) out.push(t.code);
  }
  return out;
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
  /**
   * Owner 2026-10-11 — only an OPD visit is "where they are now": a lab walk-in or a pharmacy visit is
   * never in an OPD queue (the lab's own work shows in the Today band as tests in progress).
   */
  return (visits ?? []).filter((v) => v.serviceDate === today && !ended.has(v.status) && (v.type ?? "opd") === "opd");
}
