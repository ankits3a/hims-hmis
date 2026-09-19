import { api, apiDownload } from "./api";
import type { WireRenderedDocument } from "./print-api";

/**
 * THE OPD DAY REPORT — the wire shapes of `/opd/reports/day*` (apps/core/src/modules/opd/day-report.ts).
 *
 * Every figure is the server's: the screen, the CSV and the printable sheet are three renderings of
 * one load, so nothing here adds, splits or re-derives a count.
 */
export type PatientType = "new" | "revisit" | "renewal";

export type DayCounts = {
  booked: number;
  consulted: number;
  new: number;
  revisit: number;
  renewal: number;
  stillOpen: number;
};

export type DayDepartment = DayCounts & { departmentId: string; code: string; name: string };

export type OpdDayReport = {
  date: string;
  generatedAt: string;
  provisional: boolean;
  hospital: { name: string; addressLines: string[] };
  departments: DayDepartment[];
  totals: DayCounts;
  patientsConsulted: number;
  newPatients: number;
};

export type DayPatientRow = {
  visitNo: string;
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

export type OpdDepartmentDayReport = {
  date: string;
  generatedAt: string;
  provisional: boolean;
  hospital: { name: string; addressLines: string[] };
  department: DayDepartment;
  rows: DayPatientRow[];
};

const q = (date: string): string => `?date=${encodeURIComponent(date)}`;
const dept = (id: string): string => `/opd/reports/day/departments/${encodeURIComponent(id)}`;

export function fetchDayReport(date: string): Promise<OpdDayReport> {
  return api("GET", `/opd/reports/day${q(date)}`);
}

export function fetchDepartmentDayReport(departmentId: string, date: string): Promise<OpdDepartmentDayReport> {
  return api("GET", `${dept(departmentId)}${q(date)}`);
}

export function downloadDayReportCsv(date: string): Promise<void> {
  return apiDownload(`/opd/reports/day/csv${q(date)}`, `OPD-Day-Report-${date}.csv`);
}

export function downloadDepartmentCsv(departmentId: string, code: string, date: string): Promise<void> {
  return apiDownload(`${dept(departmentId)}/csv${q(date)}`, `OPD-Day-Report-${code}-${date}.csv`);
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
export async function openReportPdf(path: "day" | { departmentId: string }, date: string): Promise<"opened" | "blocked"> {
  const w = window.open("", "_blank", "width=900,height=960");
  if (w === null) return "blocked";
  w.document.write(`<!doctype html><title>Preparing report…</title><p style="font:14px system-ui;padding:24px;color:#5c6f66">Preparing the report…</p>`);
  try {
    const url = path === "day" ? `/opd/reports/day/document${q(date)}` : `${dept(path.departmentId)}/document${q(date)}`;
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
