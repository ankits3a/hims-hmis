import type { WaitingKind } from "../../../../packages/contracts/src/waiting";

/**
 * #681 — THE PHONE'S RESULTS VIEWER, read-only, opened from Open loops.
 *
 * Imaging reads the doctor's results inbox the web consult draws (`GET /radiology/results`) and opens
 * a report with `GET /radiology/reports/:id` — the same read the web makes, which stamps the first read
 * and so closes "Imaging unread". Lab reads `GET /lab/results/mine` (the set "Lab reports back" counts)
 * and opens one with `GET /lab/results/mine/:id`, which stamps the treating doctor's read under the web's
 * rule (#930), so the report leaves that set. The server applies the restricted-test rule and the
 * alias rule; neither route carries money, and this file declares no money field, so none is drawn.
 */
export type ResultsKind = "lab" | "imaging";

/** Which Open loops lines open the viewer. A critical is read here but acknowledged on the computer. */
export function viewerOf(kind: WaitingKind): ResultsKind | null {
  if (kind === "lab.reportsBack") return "lab";
  if (kind === "radiology.unreadMine" || kind === "radiology.criticalsMine") return "imaging";
  return null;
}

export type ImagingRow = {
  reportId: string; accessionNo: string; studyName: string; patientName: string; uhid: string;
  publishedAt: string | null; amended: boolean; state: "unread" | "read" | "acted";
  critical: { acknowledgedAt: string | null } | null; criticalCategory: string | null;
  signerName: string | null;
};
export type ImagingReport = {
  reportId: string; accessionNo: string; version: number; body: unknown; impression: string | null;
  criticalCategory: string | null; signedAt: string | null; amendmentReason: string | null; patientName: string;
};
export type LabRow = {
  reportId: string; orderNo: string; patientName: string; uhid: string; publishedAt: string;
  amended: boolean; tests: string[]; abnormal: number;
};
export type LabLine = { name: string; value: string; unit: string | null; flag: string | null; refLow: string | null; refHigh: string | null; refText: string | null };
export type LabReport = {
  reportId: string; orderNo: string; patientName: string; uhid: string; publishedAt: string; amended: boolean; partial: boolean;
  panels: { name: string; lines: LabLine[] }[]; signedBy: string | null; signedAt: string | null;
};

type Call = <R>(method: "GET", path: string) => Promise<R>;

export function resultsApi(call: Call) {
  return {
    imagingList: async (): Promise<ImagingRow[]> => (await call<{ rows: ImagingRow[] }>("GET", "/radiology/results")).rows,
    imagingOpen: async (id: string): Promise<ImagingReport | null> => (await call<{ report: ImagingReport | null }>("GET", `/radiology/reports/${encodeURIComponent(id)}`)).report,
    labList: async (): Promise<LabRow[]> => (await call<{ items: LabRow[] }>("GET", "/lab/results/mine")).items,
    labOpen: async (id: string): Promise<LabReport> => (await call<{ report: LabReport }>("GET", `/lab/results/mine/${encodeURIComponent(id)}`)).report,
  };
}

/** The report's sections in the web's order: every non-empty text but the impression, then the impression. */
export function imagingSections(r: ImagingReport): { key: string; text: string }[] {
  const body = typeof r.body === "object" && r.body !== null ? (r.body as Record<string, unknown>) : {};
  return Object.entries(body)
    .filter(([k, v]) => k !== "impression" && typeof v === "string" && v.trim() !== "")
    .map(([k, v]) => ({ key: k.replace(/_/g, " "), text: String(v) }));
}

/** A lab line's reference, as printed: "low–high", or the text range. */
export function refOf(l: LabLine): string | null {
  if (l.refLow !== null && l.refHigh !== null) return `${l.refLow}–${l.refHigh}`;
  return l.refText;
}

/** Out of range: any flag but normal. */
export const outOfRange = (l: LabLine): boolean => l.flag !== null && l.flag !== "" && l.flag !== "N";
