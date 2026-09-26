import { hasPermission } from "../../kernel/auth/permissions";
import { isIsoDate, istDateOf } from "./config";
import { PharmacyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE REPORTS' DATE RANGE, AND WHO MAY READ THEM ═══
 *
 * Every office report takes the same range: a preset — today, this week (Monday to today, the
 * Indian working week), this month, this financial year (1 April to today) — or a custom `from`..`to`,
 * IST calendar days, inclusive. A range is at most `MAX_RANGE_DAYS` long: a financial year and a day,
 * so a leap-year FY fits and nothing longer is read in one go.
 */
export const REPORT_PRESETS = ["today", "week", "month", "fy", "custom"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];
export const MAX_RANGE_DAYS = 366;

export const REPORTS_READ = "pharmacy.reports.read";
export const REPORTS_MARGIN = "pharmacy.reports.margin";

const DAY_MS = 86_400_000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The IST day `from`..`to` a preset names on `today` (itself an IST day). */
export function reportRange(
  preset: string | undefined, today: string, custom: { from?: string | null; to?: string | null } = {},
): { preset: ReportPreset; from: string; to: string } {
  const p = (preset ?? "today") as ReportPreset;
  if (!REPORT_PRESETS.includes(p)) throw new PharmacyError("invalid_range", `"${String(preset)}" is not a report range (${REPORT_PRESETS.join(", ")})`);
  if (p === "today") return { preset: p, from: today, to: today };
  if (p === "week") {
    const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
    return { preset: p, from: addDays(today, -((dow + 6) % 7)), to: today };
  }
  if (p === "month") return { preset: p, from: `${today.slice(0, 8)}01`, to: today };
  if (p === "fy") {
    const year = Number(today.slice(0, 4));
    const start = Number(today.slice(5, 7)) >= 4 ? year : year - 1;
    return { preset: p, from: `${String(start)}-04-01`, to: today };
  }
  const from = custom.from ?? "";
  const to = custom.to ?? "";
  if (!isIsoDate(from) || !isIsoDate(to)) throw new PharmacyError("invalid_range", "a custom range needs a from and a to date (YYYY-MM-DD)");
  if (from > to) throw new PharmacyError("invalid_range", `the range starts (${from}) after it ends (${to})`);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw new PharmacyError("invalid_range", `a report reads at most ${String(MAX_RANGE_DAYS)} days at a time; this range is ${String(days)}`);
  return { preset: p, from, to };
}

/** The IST day of an instant — the reports' "today". */
export const reportToday = (now: Date): string => istDateOf(now);

/**
 * The reports are read under `pharmacy.reports.read`; the margin figures under
 * `pharmacy.reports.margin` as well. Asserted inside every read, whatever the route checked — the
 * house rule for a gate on money.
 */
export async function requireReportPermission(db: Db, actor: Actor, permission: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, permission, "hospital"))) {
    throw new PharmacyError("permission_denied", `${what} needs ${permission}`, { permission });
  }
}

/** Whether this person may see cost and margin (a reader without it gets the same report without those columns). */
export async function mayReadMargin(db: Db, actor: Actor): Promise<boolean> {
  return actor.type === "user" && hasPermission(db, actor.id, REPORTS_MARGIN, "hospital");
}
