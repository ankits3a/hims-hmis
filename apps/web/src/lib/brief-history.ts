import { api } from "./api";

/**
 * ═══ CONSULT V2 — WHAT THE LAB, RADIOLOGY AND PHARMACY RECORDED, ON THE BRIEF (board `Main`) ═══
 *
 * Three patient-scoped reads, each on its owning module's route, gated and PHI-logged there:
 * signed lab values (`lab.results.read`), signed imaging reports (`radiology.reports.read`) and what
 * the pharmacy handed over (`opd.consult`). The brief turns them into two lines of the board:
 * "SINCE THEN · LAB AND RADIOLOGY" and the refill record under "ON NOW". Recorded facts only — D16.
 */
export type WirePatientResult = {
  orderableName: string; analyteName: string; value: string; unit: string | null; flag: string | null; verifiedAt: string;
};
export type WirePatientImaging = { studyName: string; impression: string | null; criticalCategory: string | null; signedAt: string };
export type WirePatientDispense = {
  prescriptionId: string; handedOverAt: string;
  lines: { drug: string; durationDays: number | null; qtyBase: number | null }[];
};

export const fetchPatientResults = (patientId: string): Promise<{ items: WirePatientResult[] }> =>
  api("GET", `/lab/results/patient/${encodeURIComponent(patientId)}`);
export const fetchPatientImaging = (patientId: string): Promise<{ items: WirePatientImaging[] }> =>
  api("GET", `/radiology/reports/patient/${encodeURIComponent(patientId)}`);
export const fetchPatientDispenses = (patientId: string): Promise<{ items: WirePatientDispense[] }> =>
  api("GET", `/pharmacy/doctor/patients/${encodeURIComponent(patientId)}/dispenses`);

/** The IST calendar day of an instant, `YYYY-MM-DD` — the same day the timeline's `serviceDate` names. */
export function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "19 Sep", as the board prints it — spelled here, because ICU's short month for September varies ("Sept"). */
export function shortDay(isoOrDay: string): string {
  const [, m, d] = (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? isoOrDay : istDay(isoOrDay)).split("-");
  return `${String(Number(d))} ${MONTHS[Number(m) - 1] ?? ""}`;
}

export type BriefResultLine = { what: string; kind: "lab" | "radiology"; day: string; abnormal: boolean };
export const BRIEF_RESULT_LINES = 6;

/**
 * The board's rule for the "since then" list:
 *  · results on or after the last consultation's day, newest first (the board lists an ECG taken on
 *    the day of the last visit under "since then"; a same-day result is part of what came after it);
 *  · none since, but something on file → the most recent one, marked `noneSince` ("HbA1c 8.1 · lab
 *    3 Jun · none since");
 *  · a first visit (no last consultation) → the most recent on file;
 *  · nothing at all → an empty list, and the screen says "No results on file".
 * A lab flag is abnormal whenever the bench set one (anything but `N`); an imaging report is when it
 * carries a critical category.
 */
export function briefResults(
  lab: WirePatientResult[], imaging: WirePatientImaging[], lastVisitDay: string | null,
): { lines: BriefResultLine[]; noneSince: boolean } {
  const all: (BriefResultLine & { at: string })[] = [
    ...lab.map((r) => ({
      what: `${r.analyteName} ${r.value}${r.unit === null || r.unit === "" ? "" : ` ${r.unit}`}`,
      kind: "lab" as const, at: r.verifiedAt, day: istDay(r.verifiedAt),
      abnormal: r.flag !== null && r.flag !== "" && r.flag.toUpperCase() !== "N",
    })),
    ...imaging.map((r) => ({
      what: r.impression === null || r.impression.trim() === "" ? r.studyName : `${r.studyName}: ${r.impression.trim()}`,
      kind: "radiology" as const, at: r.signedAt, day: istDay(r.signedAt), abnormal: r.criticalCategory !== null,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const strip = (l: BriefResultLine & { at: string }): BriefResultLine => ({ what: l.what, kind: l.kind, day: l.day, abnormal: l.abnormal });
  if (all.length === 0) return { lines: [], noneSince: false };
  if (lastVisitDay === null) return { lines: all.slice(0, BRIEF_RESULT_LINES).map(strip), noneSince: false };
  const since = all.filter((l) => l.day >= lastVisitDay);
  if (since.length === 0) return { lines: [strip(all[0]!)], noneSince: true };
  return { lines: since.slice(0, BRIEF_RESULT_LINES).map(strip), noneSince: false };
}

export type BriefRefill =
  | { kind: "none" }
  | { kind: "bought"; times: number; lastDay: string; days: number | null; dueDay: string | null };

/**
 * The refill record for the prescription the brief shows under "ON NOW": how many times the
 * pharmacy handed it over, the last time, and — when the Rx lines carry a duration — how many days
 * that covered and the day it runs out. The longest line's duration is the purchase's cover: a
 * 30-day antihypertensive and a 5-day antibiotic bought together last until the 30 days are up.
 */
export function briefRefill(prescriptionId: string, dispenses: WirePatientDispense[]): BriefRefill {
  const mine = dispenses.filter((d) => d.prescriptionId === prescriptionId).sort((a, b) => (a.handedOverAt < b.handedOverAt ? 1 : -1));
  const last = mine[0];
  if (last === undefined) return { kind: "none" };
  const durations = last.lines.map((l) => l.durationDays).filter((d): d is number => d !== null && d > 0);
  const days = durations.length === 0 ? null : Math.max(...durations);
  const lastDay = istDay(last.handedOverAt);
  const dueDay = days === null ? null : istDay(new Date(new Date(`${lastDay}T06:30:00.000Z`).getTime() + days * 86_400_000).toISOString());
  return { kind: "bought", times: mine.length, lastDay, days, dueDay };
}
