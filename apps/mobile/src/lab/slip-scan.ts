import { ApiError, NetworkError } from "../api";
import type { Call, QuickChosenTest, QuickPatient } from "./api";

/**
 * SPEC #934 ON THE PHONE — the wire contract of `lab-slips.controller.ts` and the small rules of the
 * Scan slip flow, kept apart from the screen so they can be tested without a camera. Nothing is
 * decided here that the server does not decide again: the phone reads, the server maps and matches.
 */

/** The slip's long edge: slips are long and narrow, and their 5-pt thermal text needs the pixels (the desk's pages use 1600). */
export const SLIP_EDGE = 2400;
/**
 * The JPEG budget. The server refuses past 1.5 MB, but the API's JSON body limit is 1 MB and the image
 * rides base64 (× 4/3), so the phone keeps the bytes under ~720 kB: inside both, with room for the body.
 */
export const SLIP_UPLOAD_BYTES = 720_000;
/** A gallery photo older than this (or with no date) asks "Is it today's slip?" before it is sent. */
export const SLIP_OLD_PHOTO_MS = 24 * 60 * 60_000;
/** How long the phone polls a scan the server is still reading. */
export const SLIP_POLL_MS = 2_000;
export const SLIP_POLL_LIMIT = 45;

export type SlipSetup = { reading: boolean; analysers: { id: string; name: string }[] };
export type SlipChips = {
  name: "same" | "close" | "differs" | "unread"; age: "same" | "pm1" | "differs" | "unread";
  gender: "same" | "differs" | "unread"; time: "before_print" | "after_print" | null;
};
export type SlipCandidate = {
  quickReportId: string; patient: QuickPatient; sampleNo: string | null; collectedAt: string; status: string; tests: string[];
  chips: SlipChips; preselected: boolean;
};
export type SlipHeader = { name: string | null; patientId: string | null; sampleId: string | null; gender: string | null; age: string | null; printedAt: string | null };
export type SlipCounts = { rows: number; placed: number; crossCheck: number; ignoredBySetting: number; ignored: number; notPlaced: number; openChecks: number };
export type SlipScanView = {
  id: string; status: "reading" | "read" | "failed" | "waiting" | "attached" | "discarded"; source: string;
  instrumentId: string; instrumentName: string; error: string | null;
  header: SlipHeader | null; counts: SlipCounts;
  match: { idKind: string; hint: "type_sample_no" | null; noOpenReport?: boolean };
  differences: ("id" | "name" | "gender" | "age")[]; candidates: SlipCandidate[]; requestedReportId: string | null;
  attached: null | { quickReportId: string; matchKind: string; patient: QuickPatient; sampleNo: string | null; tests: QuickChosenTest[] };
};
export type SlipWaiting = { id: string; status: string; capturedAt: string; instrumentName: string; name: string | null; idKind: string; rowCount: number };
export type SlipUpload = {
  image: string; mimeType: "image/jpeg"; source: "camera" | "gallery"; instrumentId: string;
  photoTakenAt: string | null; quickReportId: string | null;
};
export type SlipRowAct = { action: "checked" } | { action: "ignore"; reason: string } | { action: "place"; analyteId: string };

/** The marker a slip leaves on a report line (`QuickLine.slip` on the server). */
export type LineSlip = { scanId: string; row: number; checks: string[]; checkedBy?: string; slipValue?: string; edited?: boolean; kept?: boolean };
export type SlipRowBrief = { position: number; code: string; value: string | null; unit: string | null; reason: string | null; analyteName: string | null };
export type SlipBench = {
  scanId: string; matchKind: string | null; counts: SlipCounts;
  notPlaced: SlipRowBrief[]; ignoredBySetting: SlipRowBrief[]; rowsMissing: string[];
};

const enc = encodeURIComponent;

export function slipApi(call: Call) {
  return {
    setup: () => call<SlipSetup>("GET", "/lab/slips/setup"),
    scan: (body: SlipUpload) => call<SlipScanView>("POST", "/lab/slips", body),
    get: (id: string) => call<SlipScanView>("GET", `/lab/slips/${enc(id)}`),
    waiting: () => call<{ items: SlipWaiting[] }>("GET", "/lab/slips?status=waiting"),
    attach: (id: string, body: { quickReportId: string; confirmed?: boolean }) => call<SlipScanView>("POST", `/lab/slips/${enc(id)}/attach`, body),
    row: (id: string, n: number, body: SlipRowAct) => call<SlipScanView>("POST", `/lab/slips/${enc(id)}/rows/${String(n)}`, body),
    reread: (id: string) => call<SlipScanView>("POST", `/lab/slips/${enc(id)}/reread`, {}),
    discard: (id: string, reason: string) => call<SlipScanView>("POST", `/lab/slips/${enc(id)}/discard`, { reason }),
    image: (id: string) => call<{ mimeType: string; imageBase64: string }>("GET", `/lab/slips/${enc(id)}/image`),
  };
}
export type SlipApi = ReturnType<typeof slipApi>;

/**
 * The EXIF date a gallery photo carries ("2026:10:21 11:20:05", the phone's own clock), or null.
 * Stored on the scan as `photoTakenAt` and shown; never trusted for anything else.
 */
export function exifTakenAt(exif: Record<string, unknown> | null | undefined): Date | null {
  const raw = exif?.DateTimeOriginal ?? exif?.DateTimeDigitized ?? exif?.DateTime;
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (m === null) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Older than a day, or no date at all: ask before sending. */
export function isOldPhoto(takenAt: Date | null, now: number): boolean {
  return takenAt === null || now - takenAt.getTime() > SLIP_OLD_PHOTO_MS;
}

/** "SITA DEVI · F · 34Y" — what the slip prints that disagrees with the report the bench has open. */
export function slipSays(view: Pick<SlipScanView, "header" | "differences">): string {
  const h = view.header;
  if (h === null) return "";
  const parts: string[] = [];
  if (view.differences.includes("name") && h.name) parts.push(h.name);
  if (view.differences.includes("gender") && h.gender) parts.push(h.gender);
  if (view.differences.includes("age") && h.age) parts.push(h.age);
  if (view.differences.includes("id")) { const id = h.patientId || h.sampleId; if (id) parts.push(id); }
  return parts.join(" · ");
}

/** Rows that still need a person: open checks and rows not placed. */
export const rowsNeedingEyes = (c: SlipCounts): number => c.openChecks + c.notPlaced;

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A slip refusal in a few words. */
export function slipRefusal(e: unknown, t: T): string {
  if (e instanceof NetworkError) return t("labSlip.offline");
  if (e instanceof ApiError) {
    const known: Record<string, string> = {
      slip_reading_off: "labSlip.off", slip_spend_cap: "labSlip.spendCap", slip_image_too_large: "labSlip.tooLarge",
      report_closed: "labSlip.reportClosed", slip_reason_required: "labSlip.discardWhy", slip_checks_open: "labSlip.checksOpen",
    };
    const key = known[e.code];
    if (key !== undefined) return t(key);
    if (e.status === 403) return t("quickLab.err.forbidden");
    return e.code;
  }
  return t("labSlip.failedOther");
}
