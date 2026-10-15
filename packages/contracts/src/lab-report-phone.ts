import { quickReportHtml } from "./lab-report-html";
import type { ReportHtmlInput } from "./lab-report-html";

/**
 * OWNER 2026-10-12 — THE PHONE'S SHARE PDF PAGE (spec `SPEC-phone-report-pdf-share-2026-10-12.md`):
 * the desk's printed quick report, from the one shared template, with the logo read from the
 * hospital's own site (the server this build talks to). Lives in contracts (zod-free, no Expo) so the web suite
 * can prove the desk's page and this one are byte for byte the same.
 */
export function phoneReportHtml(report: ReportHtmlInput, printedBy: string | null, apiBase: string, now: Date): string {
  const origin = apiBase.replace(/^(https?:\/\/[^/]+).*$/, "$1");
  return quickReportHtml(report, { printedBy, logoUrl: `${origin}/print/hospital-logo.png`, now });
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "");

/** `<UHID>-<sample no>.pdf` (the order number, then the report id, when there is no sample number). Never the name. */
export function reportPdfName(r: { id: string; patient: { uhid: string }; sampleNo?: string | null; orderNo?: string | null }): string {
  const no = safe(r.sampleNo ?? "") || safe(r.orderNo ?? "") || safe(r.id).slice(0, 12);
  return `${safe(r.patient.uhid) || "report"}-${no}.pdf`;
}
