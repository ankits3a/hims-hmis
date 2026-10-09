import { api } from "./api";

/**
 * QUICK MODE (decision 0061) — the wire contract of `lab-quick.controller.ts`, transcribed. The
 * server resolves every range and flag on save; `previewFlag` below only colours a box while the
 * technologist types, and it is `ranges.ts`'s `flagFor`, line for line, so the colour and the saved
 * flag agree.
 */
export type QuickAnalyte = {
  analyteId: string; code: string; nameEn: string; unit: string | null; resultType: string;
  decimals: number; absurdLow: string | null; absurdHigh: string | null;
};
export type QuickTest = { serviceId: string; code: string; nameEn: string; analyteIds: string[] };
export type QuickCatalogue = { tests: QuickTest[]; analytes: QuickAnalyte[] };
export type QuickRange = {
  analyteId: string; low: string | null; high: string | null; text: string | null;
  criticalLow: string | null; criticalHigh: string | null; note: string | null;
};
export type QuickFlag = "L" | "H" | "LL" | "HH" | "N" | null;
export type QuickLine = {
  analyteId: string; code: string; nameEn: string; unit: string | null;
  value: string; low: string | null; high: string | null; refText: string | null; flag: QuickFlag;
};
export type QuickChosenTest = { serviceId: string; code: string; nameEn: string };
export type QuickPatient = { id: string; uhid: string; display: string; administrativeGender: string; dob: string | null };
export type QuickRow = {
  id: string; status: "waiting" | "reported"; patient: QuickPatient; encounterNo: string | null;
  tests: QuickChosenTest[]; collectedAt: string; collectedBy: string;
  reportedAt: string | null; reportedBy: string | null;
};
export type QuickReport = QuickRow & {
  analyteIds: string[]; groups: { title: string | null; analyteIds: string[] }[]; lines: QuickLine[]; summary: string;
};
export type QuickQueue = { waiting: QuickRow[]; reportedToday: QuickRow[] };
export type StartQuick = { patientId: string; encounterNo: string | null; serviceIds: string[]; bloodCollected: boolean };
export type SaveQuickResults = { lines: { analyteId: string; value: string }[]; summary: string };

export const quickCatalogue = (): Promise<QuickCatalogue> => api("GET", "/lab/quick/catalogue");
export const quickRanges = (patientId: string, analyteIds: readonly string[]): Promise<{ items: QuickRange[] }> =>
  api("GET", `/lab/quick/ranges?patientId=${encodeURIComponent(patientId)}&analyteIds=${analyteIds.map(encodeURIComponent).join(",")}`);
export const startQuick = (body: StartQuick): Promise<QuickRow> => api("POST", "/lab/quick/start", body);
export const quickQueue = (): Promise<QuickQueue> => api("GET", "/lab/quick/queue");
export const quickReport = (id: string): Promise<QuickReport> => api("GET", `/lab/quick/reports/${encodeURIComponent(id)}`);
/** Reported quick reports of one patient (profile, consult, the lab's saved reports) — `lab.results.read`. */
export const quickReportsForPatient = (patientId: string): Promise<{ items: QuickReport[] }> =>
  api("GET", `/lab/quick/patient/${encodeURIComponent(patientId)}`);
export const saveQuickResults = (id: string, body: SaveQuickResults): Promise<QuickReport> =>
  api("PUT", `/lab/quick/reports/${encodeURIComponent(id)}`, body);

/** The signed card QR, as `PatientPicker` verifies it. */
export type QrVerifyResult =
  | { ok: true; patient: { id: string; uhid: string; name: string; administrativeGender: string; dob: string | null } }
  | { ok: false; reason: string };
export const verifyCardQr = (payload: string): Promise<QrVerifyResult> => api("POST", "/patients/qr/verify", { payload });

const num = (s: string | null): number | null => (s === null ? null : Number(s));

export function previewFlag(value: string, r: QuickRange | undefined): QuickFlag {
  if (r === undefined || value.trim() === "") return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const cl = num(r.criticalLow), ch = num(r.criticalHigh);
  if (ch !== null && v >= ch) return "HH";
  if (cl !== null && v <= cl) return "LL";
  const lo = num(r.low), hi = num(r.high);
  if (lo === null && hi === null) return null;
  if (hi !== null && v > hi) return "H";
  if (lo !== null && v < lo) return "L";
  return "N";
}

/** "12.0000" -> "12", "4.5000" -> "4.5". */
export function trimNum(s: string | null): string {
  if (s === null) return "";
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function refText(r: { low: string | null; high: string | null; text: string | null } | undefined): string {
  if (r === undefined) return "";
  if (r.low !== null && r.high !== null) return `${trimNum(r.low)} – ${trimNum(r.high)}`;
  if (r.low !== null) return `≥ ${trimNum(r.low)}`;
  if (r.high !== null) return `≤ ${trimNum(r.high)}`;
  return r.text ?? "";
}

const FLAG_WORD: Record<string, string> = { L: "low", H: "high", LL: "CRITICALLY LOW", HH: "CRITICALLY HIGH" };

/**
 * The summary the screen proposes. Plain rules, no AI (DECIDED): each abnormal value in one line,
 * then one line for the rest. The technologist edits it freely; once edited it is not overwritten.
 */
export function draftSummary(lines: readonly QuickLine[]): string {
  const filled = lines.filter((l) => l.value.trim() !== "");
  if (filled.length === 0) return "";
  const abnormal = filled.filter((l) => l.flag !== null && l.flag !== "N");
  const normal = filled.filter((l) => l.flag === "N");
  const out = abnormal.map((l) => {
    const ref = refText({ low: l.low, high: l.high, text: l.refText });
    return `${l.nameEn} is ${FLAG_WORD[l.flag!]}: ${l.value}${l.unit ? ` ${l.unit}` : ""}${ref ? ` (ref ${ref})` : ""}.`;
  });
  if (abnormal.length === 0 && normal.length > 0) out.push("All reported parameters are within the reference range.");
  else if (normal.length > 0) out.push("Other reported parameters are within the reference range.");
  return out.join("\n");
}
