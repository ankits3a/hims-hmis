import { api } from "./api";

/**
 * PHARMACY STAGE D4 — the emergency trays, transcribed from `pharmacy/trays.ts`. Check a tray, restock a deficient
 * one and receive a restock: `pharmacy.trays.check`; set up a tray, name its keepers, keep its list:
 * `pharmacy.trays.manage`; reads need either. The result of a check is the server's; the screen only previews it.
 */
export const TRAYS_CHECK = "pharmacy.trays.check";
export const TRAYS_MANAGE = "pharmacy.trays.manage";
/** The stage's expiry margin (days), unless a template line says otherwise. */
export const TRAY_EXPIRY_MARGIN_DAYS = 30;
/** Who may keep a tray: those who check it. */
export const TRAY_KEEPER_ROLES = [
  "pharmacy", "pharmacy_assistant", "pharmacy_incharge", "ot_nurse", "recovery_nurse", "radiographer", "daycare_coordinator",
] as const;

export type TrayCheckKind = "daily_seal" | "monthly_full" | "after_use";
export type TrayCheckResult = "ok" | "deficient";
export type TrayScheduleState = "done" | "due" | "missed" | "not_due";

export type WireTrayTemplateLine = {
  id: string; itemId: string; itemCode: string; itemName: string; baseUom: string;
  parQty: number; minExpiryDays: number | null; active: boolean;
};
export type WireTrayCheckSummary = {
  id: string; no: string; kind: TrayCheckKind; result: TrayCheckResult; findings: string[]; checkedAt: string;
  restock: { transferId: string; status: string; restockedAt: string } | null;
};
export type WireTray = {
  id: string; code: string; name: string; location: string; custodianRoles: string[];
  template: WireTrayTemplateLine[];
  daily: TrayScheduleState; monthly: TrayScheduleState;
  lastCheck: WireTrayCheckSummary | null;
  needsRestock: boolean;
  expectedSeal: string | null;
  expiring: { itemId: string; itemName: string; batchNo: string; expiryDate: string; qty: number }[];
};
export type WireTrayCheckLine = {
  itemId: string; itemName: string; parQty: number; qtyPresent: number; earliestExpiry: string | null; batchNo: string | null;
  qtyExpiring: number; qtyUsed: number; qtyRestock: number;
};
export type WireTrayCheck = WireTrayCheckSummary & {
  trayId: string; sealSeen: string | null; sealNew: string | null; note: string | null; event: string | null; patientId: string | null;
  checkedByName: string | null; restockedByName: string | null;
  lines: WireTrayCheckLine[];
};

export type TrayCheckBody = {
  trayId: string; kind: TrayCheckKind; sealSeen?: string | null; sealNew?: string | null;
  lines?: { itemId: string; qtyPresent: number; earliestExpiry?: string | null; qtyExpiring?: number | null }[];
  patientId?: string | null; event?: string | null; note?: string | null;
};
export type RecordedTrayCheck = { checkId: string; no: string; result: TrayCheckResult; findings: string[]; consumed: number; deficit: number };

export const fetchTrays = (): Promise<{ items: WireTray[] }> => api("GET", "/pharmacy/trays");
export const fetchTrayChecks = (trayId: string): Promise<{ items: WireTrayCheck[] }> =>
  api("GET", `/pharmacy/trays/${encodeURIComponent(trayId)}/checks`);
export const fetchTrayItems = (q: string): Promise<{ items: { id: string; code: string; name: string; baseUom: string }[] }> =>
  api("GET", `/pharmacy/trays/items?q=${encodeURIComponent(q)}`);
export const recordTrayCheck = (body: TrayCheckBody, idempotencyKey: string): Promise<RecordedTrayCheck> =>
  api("POST", "/pharmacy/trays/checks", body, idempotencyKey);
export const restockTrayCheck = (checkId: string): Promise<{ transferId: string; units: number }> =>
  api("POST", `/pharmacy/trays/checks/${encodeURIComponent(checkId)}/restock`, {});
export const receiveTrayRestock = (checkId: string): Promise<{ status: string }> =>
  api("POST", `/pharmacy/trays/checks/${encodeURIComponent(checkId)}/receive`, {});
export const addTray = (body: { name: string; location: string; custodianRoles: string[] }): Promise<{ trayId: string; code: string }> =>
  api("POST", "/pharmacy/trays", body);
export const setTrayKeepers = (trayId: string, custodianRoles: string[]): Promise<{ trayId: string; code: string }> =>
  api("POST", `/pharmacy/trays/${encodeURIComponent(trayId)}/keepers`, { custodianRoles });
export const saveTrayLine = (trayId: string, body: { itemId: string; parQty: number; minExpiryDays?: number | null; active?: boolean }): Promise<{ templateId: string }> =>
  api("POST", `/pharmacy/trays/${encodeURIComponent(trayId)}/template`, body);

/** The IST calendar date `days` after `today` (both `YYYY-MM-DD`). */
export function plusDays(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What the server will find on one line — a PREVIEW for the sheet, never sent: short of par, or its earliest expiry
 * inside the margin. The server decides the check.
 */
export function previewLine(
  line: { parQty: number; minExpiryDays: number | null }, qtyPresent: number | null, earliestExpiry: string, today: string,
): { short: boolean; expiring: boolean } {
  const short = qtyPresent !== null && qtyPresent < line.parQty;
  const expiring = qtyPresent !== null && qtyPresent > 0 && /^\d{4}-\d{2}-\d{2}$/.test(earliestExpiry)
    && earliestExpiry <= plusDays(today, line.minExpiryDays ?? TRAY_EXPIRY_MARGIN_DAYS);
  return { short, expiring };
}
