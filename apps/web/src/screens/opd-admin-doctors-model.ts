import type { WireAdminDoctor, WireDepartment } from "../lib/opd-api";

/**
 * #1127 (owner 2026-11-19) — the Doctors tab's pure parts, beside the Users screen's own
 * (`admin-users-model.ts`): which filter tag holds a doctor, what the search box matches, and the
 * display name a picked staff member is offered. About 40 doctors filter in memory.
 */
export const DOCTOR_CHIPS = ["all", "active", "inactive", "noRegn", "noSchedule", "secondary"] as const;
export type DoctorChip = (typeof DOCTOR_CHIPS)[number];

/** A missing registration number or schedule is a warning only for a doctor who still works here. */
export function inDoctorChip(chip: DoctorChip, d: WireAdminDoctor): boolean {
  switch (chip) {
    case "all": return true;
    case "active": return d.active;
    case "inactive": return !d.active;
    case "noRegn": return d.active && (d.registrationNo ?? "").trim() === "";
    case "noSchedule": return d.active && !d.scheduledThisWeek;
    case "secondary": return d.secondary !== null && d.secondary !== undefined;
  }
}

/** Name, Doctor ID, username, registration number, or a department the doctor serves (primary or second). */
export function matchesDoctor(d: WireAdminDoctor, query: string, departments: readonly WireDepartment[]): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const deptName = (id: string | undefined): string => (id === undefined ? "" : departments.find((x) => x.id === id)?.name ?? "");
  return [d.displayName, d.code, d.username, d.registrationNo ?? "", deptName(d.departmentId), deptName(d.secondary?.departmentId)]
    .some((field) => field.toLowerCase().includes(q));
}

/** "Ravi Kumar" → "Dr. Ravi Kumar"; a name that already says Dr is left alone. */
export function suggestDoctorName(fullName: string): string {
  const name = fullName.trim();
  return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}

const localeOf = (language: string): string => (language.startsWith("hi") ? "hi-IN" : "en-IN");

/** An IST calendar date ("2026-08-20") as "Thu, 20 Aug". */
export function dayLabel(date: string, language: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(localeOf(language), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** A weekday number (0 = Sunday) as "Wed". 2026-01-04 was a Sunday. */
export function weekdayShort(weekday: number, language: string): string {
  return new Intl.DateTimeFormat(localeOf(language), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + weekday)));
}

/** An instant as "17 Aug 2026, 10:30 am" in IST. */
export function momentLabel(iso: string, language: string): string {
  return new Intl.DateTimeFormat(localeOf(language), {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}
