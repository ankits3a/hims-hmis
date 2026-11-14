import { api } from "./api";
import type { Pack, SupplierKind } from "./returns-api";

/**
 * #1063 — the weekly expiry action list's wire (`/pharmacy/office/expiry-actions*`), transcribed from
 * `apps/core/src/modules/pharmacy/expiry-actions.ts`. Money is integer paise, quantities are base units, instants are
 * ISO strings (shown in IST).
 */
export type ExpiryActionKind = "return" | "move" | "at_risk" | "write_off";
export const EXPIRY_ACTION_KINDS: readonly ExpiryActionKind[] = ["return", "move", "at_risk", "write_off"];

export type ExpiryActionWhy =
  | "inside_window" | "near_expiry" | "recalled" | "other_counter_sells" | "will_not_sell"
  | "past_window" | "no_supplier" | "damage_tray" | "on_document" | "controlled";

export type WireExpiryActionRow = {
  key: string;
  storeResourceId: string; storeCode: string; storeName: string;
  counter: "opd" | "retail" | "ndps"; tray: "loose" | "damage" | null;
  itemId: string; itemCode: string; itemName: string; baseUom: string; pack: Pack;
  batchId: string; batchNo: string; expiryDate: string; daysToExpiry: number; expired: boolean;
  qtyBase: number; actionQtyBase: number; costPerBasePaise: number; valuePaise: number; estimated: boolean;
  vendorId: string | null; supplierName: string; supplierKind: SupplierKind;
  action: ExpiryActionKind | null; why: ExpiryActionWhy;
  returnableUntil: string | null;
  moveTo: { storeResourceId: string; storeCode: string; storeName: string } | null;
  document: { kind: "return" | "write_off"; id: string; no: string; status: string } | null;
  salesPerDay: number | null;
};

export type WireExpiryActionGroup = { count: number; valuePaise: number; estimated: boolean; rows: WireExpiryActionRow[] };

export type WireExpiryRunState = {
  lastRunAt: string | null; lastTrigger: "schedule" | "run_now" | null; batchesChecked: number | null;
  returnsCreated: number | null; returnsExtended: number | null; linesAdded: number | null; nextRunAt: string;
};

export type WireExpiryActionList = {
  asOf: string; horizonDays: number; salesWindowDays: number; batchesChecked: number;
  groups: Record<ExpiryActionKind, WireExpiryActionGroup>;
  ndps: WireExpiryActionGroup;
  run: WireExpiryRunState;
};

export const fetchExpiryActions = (): Promise<WireExpiryActionList> => api("GET", "/pharmacy/office/expiry-actions");

/** Run now: drafts the Return group (one open agent draft per supplier); answers the list as it now stands. */
export const runExpiryActions = async (): Promise<WireExpiryActionList> =>
  (await api<{ list: WireExpiryActionList }>("POST", "/pharmacy/office/expiry-actions/run", {})).list;

/** A person's tap on Move: the batch to the other counter, as a transfer through IN-TRANSIT. */
export const moveExpiryBatch = (storeResourceId: string, batchId: string): Promise<{ transferId: string }> =>
  api("POST", "/pharmacy/office/expiry-actions/move", { storeResourceId, batchId });

/** An instant in IST, short: "6 Jan, 10:30". */
export function istShort(iso: string, locale = "en-IN"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

/** A drug's expiry is a month: "May 27". */
export function expiryMonthLabel(isoDate: string, locale = "en-IN"): string {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", year: "2-digit" }).format(new Date(Date.UTC(y, m - 1, 1)));
}
