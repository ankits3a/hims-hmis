import { api, apiDownload } from "./api";
import type { WireRenderedDocument } from "./print-api";

/**
 * THE OPD REPORT — the wire shapes of `/opd/reports/consultations*`
 * (apps/core/src/modules/opd/report.ts).
 *
 * Every figure is the server's: the screen, the CSV and the printable sheet are three renderings of
 * one load, so nothing here adds, splits or re-derives a count. **The PERIOD is the server's too**:
 * this asks for `day`, `week` or `month` on an anchor day and is told which days were counted. A week
 * is Monday to Saturday (owner, 2026-09-20) and that rule lives where the sheet is printed, not here.
 */
export type PatientType = "new" | "revisit" | "renewal";
export type ReportPeriod = "day" | "week" | "month";

export type DayCounts = {
  booked: number;
  consulted: number;
  new: number;
  revisit: number;
  renewal: number;
  stillOpen: number;
};

export type DayDepartment = DayCounts & { departmentId: string; code: string; name: string };

export type ExcludedSunday = { date: string; consulted: number };

export type ReportRange = { period: ReportPeriod; anchor: string; from: string; to: string };

export type OpdReport = ReportRange & {
  generatedAt: string;
  provisional: boolean;
  hospital: { name: string; addressLines: string[] };
  departments: DayDepartment[];
  totals: DayCounts;
  patientsConsulted: number;
  newPatients: number;
  excludedSunday: ExcludedSunday | null;
};

export type DayPatientRow = {
  visitNo: string;
  date: string;
  time: string;
  name: string;
  restricted: boolean;
  uhid: string;
  age: string;
  gender: string;
  shortAddress: string;
  patientType: PatientType;
  doctor: string;
};

export type OpdDepartmentReport = ReportRange & {
  generatedAt: string;
  provisional: boolean;
  hospital: { name: string; addressLines: string[] };
  department: DayDepartment;
  rows: DayPatientRow[];
  excludedSunday: ExcludedSunday | null;
};

/** What the screen holds while the reader chooses: a named period on a day. */
export type Selection = { period: ReportPeriod; date: string };

const q = (sel: Selection): string => `?period=${sel.period}&date=${encodeURIComponent(sel.date)}`;
const base = "/opd/reports/consultations";
const dept = (id: string): string => `${base}/departments/${encodeURIComponent(id)}`;

export function fetchReport(sel: Selection): Promise<OpdReport> {
  return api("GET", `${base}${q(sel)}`);
}

export function fetchDepartmentReport(departmentId: string, sel: Selection): Promise<OpdDepartmentReport> {
  return api("GET", `${dept(departmentId)}${q(sel)}`);
}

/** The server names the file; this is only the fallback if the header is missing. */
function fallbackName(sel: Selection, code?: string): string {
  const period = sel.period === "day" ? "Day" : sel.period === "week" ? "Week" : "Month";
  return `OPD-${period}-Report${code === undefined ? "" : `-${code}`}-${sel.date}.csv`;
}

export function downloadReportCsv(sel: Selection): Promise<void> {
  return apiDownload(`${base}/csv${q(sel)}`, fallbackName(sel));
}

export function downloadDepartmentCsv(departmentId: string, code: string, sel: Selection): Promise<void> {
  return apiDownload(`${dept(departmentId)}/csv${q(sel)}`, fallbackName(sel, code));
}

/**
 * ═══ THE PDF: THE LETTERHEAD SHEET, INTO THE BROWSER'S OWN "SAVE AS PDF" ═══
 *
 * The owner ruled the browser's print dialog is how this hospital makes a PDF (2026-09-06), and the
 * server hands back self-contained HTML for it. The window is opened IN THE CLICK, before the fetch:
 * a window opened after an `await` has lost the click that allowed it and a pop-up blocker is
 * entitled to refuse it. The sheet's `<title>` is the file name the dialog offers.
 *
 * Returns "blocked" when the browser refused the window, so the caller can say so instead of
 * leaving a button that did nothing.
 */
export async function openReportPdf(target: "report" | { departmentId: string }, sel: Selection): Promise<"opened" | "blocked"> {
  const w = window.open("", "_blank", "width=900,height=960");
  if (w === null) return "blocked";
  w.document.write(`<!doctype html><title>Preparing report…</title><p style="font:14px system-ui;padding:24px;color:#5c6f66">Preparing the report…</p>`);
  try {
    const url = target === "report" ? `${base}/document${q(sel)}` : `${dept(target.departmentId)}/document${q(sel)}`;
    const doc = await api<WireRenderedDocument>("GET", url);
    w.document.open();
    w.document.write(doc.html);
    w.document.close();
    /* Print once the crest has laid out — a half-drawn letterhead is what reaches the PDF otherwise. */
    const go = (): void => { w.focus(); w.print(); };
    if (w.document.readyState === "complete") setTimeout(go, 50);
    else w.addEventListener("load", go, { once: true });
    return "opened";
  } catch (e) {
    w.close();
    throw e;
  }
}
