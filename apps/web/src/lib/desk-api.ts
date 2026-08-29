import { api, apiDownload } from "./api";

/**
 * The IST day comes from `opd-api.ts`'s `todayIst` and is NOT re-derived here. `IST_OFFSET_MS`
 * appears once in this package for the same reason `ist-clock-parity.test.ts` pins its census on
 * the server side (ledger §2.105): a second copy of the hospital's clock is a second thing that can
 * be wrong by half an hour, and the failure is invisible until a day boundary.
 */
export { todayIst } from "./opd-api";

/**
 * PLAN 07c T4 — THE WIRE SHAPE OF A PERSON'S HOME, mirroring `kernel/desk/types.ts`.
 *
 * The server owns every string on this screen that is a NUMBER — `value` arrives pre-formatted,
 * `compare` arrives as the sentence fragment it will be read as, and the totals row of a report
 * section is a row of strings like every other. That is not laziness: formatting money or a
 * duration on the client is a second place to round it, and the CSV, the print and the screen would
 * then be three. The client owns LAYOUT and nothing else.
 */
export type WireDeskStat = {
  key: string;
  value: string;
  compare?: string | null;
  tone?: "up" | "down" | "flat";
  /** Where the rows behind this figure are. `null`/absent ⇒ the figure has no drill (DD1). */
  href?: string | null;
};

export type WireDeskRow = {
  id: string;
  badge?: string | null;
  /** DATA — a name or a doctor, already aliased by the provider that put it here. Never a key. */
  title: string;
  /** An i18n KEY when the provider names a reason, plain text when it is data. */
  subtitle: string;
  action?: string | null;
  href?: string | null;
  severity?: "hot" | "warn" | null;
};

export type WireDeskCard = {
  key: string;
  band: "now" | "today";
  titleKey: string;
  rows?: WireDeskRow[];
  stats?: WireDeskStat[];
  /** Realtime topics that make this card stale (DD11). Subscribed to as a union across cards. */
  topics?: string[];
};

export type WireDesk = { date: string; cards: WireDeskCard[] };

export type WireReportSection = {
  key: string;
  titleKey: string;
  columnKeys: string[];
  rows: string[][];
  totals?: string[];
};

/** `provisional` is the SERVER's (T2 A4): the screen, the print and the CSV must not each decide. */
export type WireReport = { date: string; provisional: boolean; sections: WireReportSection[] };

const q = (date: string | undefined): string => (date === undefined ? "" : `?date=${date}`);

export function fetchDesk(date?: string): Promise<WireDesk> {
  return api<WireDesk>("GET", `/me/desk${q(date)}`);
}

export function fetchReport(date?: string): Promise<WireReport> {
  return api<WireReport>("GET", `/me/report${q(date)}`);
}

/**
 * PLAN 07c T3 — the export, taken through the one door (`apiDownload`, in `lib/api.ts`).
 *
 * The route is `/me/report.csv` and NOT `/me/report?format=csv`, so the audit event the server
 * appends is attached to a path that means "a file left the building" rather than to the path the
 * screen reads on every render. "Who exported what" is a question asked after an incident, and it
 * is answerable only if exporting is its own act.
 */
export function downloadReportCsv(date: string): Promise<void> {
  return apiDownload(`/me/report.csv?date=${date}`, `my-day-${date}.csv`);
}
