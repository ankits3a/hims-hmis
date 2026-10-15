import { addDayIso, istDayOf, tileDayQuery, type OwnerReads, type OwnerTileKey } from "./model";
import type { FlowReport, OwnerAppointments, OwnerLearning, OwnerMoney, OwnerPharmacy, StaffToday } from "./model";
import type { Call } from "../doctor/api";

/**
 * ONE REQUEST PER TILE, together, each failing soft (owner 2026-10-09). A tile whose read failed is
 * `null` — it draws "—" and still opens its page. A tile that is not this person's is never asked:
 * the Medical Superintendent's phone sends no request for money at all.
 *
 * Recorded is NOT asked here: the home already reads it for everybody (`loadHome`), which fills it in.
 */
type Range = { rows: { key: Record<string, string | undefined>; measures: Record<string, number> }[] };
const VISITS = "opd.visitsOpened";

export async function loadOwnerReads(
  call: Call, keys: readonly OwnerTileKey[], nowMs: number,
): Promise<OwnerReads> {
  const soft = async <T>(on: boolean, run: () => Promise<T>): Promise<T | null | undefined> => {
    if (!on) return undefined;
    try { return await run(); } catch { return null; }
  };
  const has = (k: OwnerTileKey): boolean => keys.includes(k);
  const today = istDayOf(nowMs);
  const lastWeek = addDayIso(today, -7);
  const q = tileDayQuery(nowMs);
  const [money, opd, appointments, pharmacy, staff, learning, wait] = await Promise.all([
    soft(has("money"), () => call<OwnerMoney>("GET", `/billing/reports/owner-money?${q}`)),
    soft(has("opd"), () => call<Range>("GET", `/staff/range?from=${lastWeek}&to=${today}&groupBy=day`)),
    soft(has("appointments"), () => call<OwnerAppointments>("GET", `/opd/reports/appointments-summary?${q}`)),
    soft(has("pharmacy"), () => call<OwnerPharmacy>("GET", `/pharmacy/office/reports/owner-summary?${q}`)),
    soft(has("staff"), () => call<StaffToday>("GET", "/roster/staff-today")),
    soft(has("learning"), () => call<OwnerLearning>("GET", "/opd/reports/learning")),
    /* Today against the same weekday last week — the server's own clock picks both days. */
    soft(has("wait"), () => call<FlowReport>("GET", "/opd/reports/flow?period=today")),
  ]);
  const visitsOn = (r: Range, day: string): number => r.rows.find((row) => row.key.day === day)?.measures[VISITS] ?? 0;
  return {
    money, appointments, pharmacy, staff, learning, wait,
    opd: opd == null ? opd : { today: visitsOn(opd, today), lastWeek: visitsOn(opd, lastWeek) },
  };
}
