import { api } from "./api";

/**
 * GAP-CLOSURE B2 — the office's one "needs you today" list, transcribed from `office-needs.ts`.
 * A row is a code + data: the screen renders its title, sub-line, why and acts from
 * `pharmacyOffice.today.need.<kind>.*`. Money is integer paise; dates are `YYYY-MM-DD`.
 */
export type NeedSource = "BUY" | "PAY" | "RETURN" | "STOCK" | "LAW" | "PEOPLE";
export type NeedTone = "rd" | "gd" | "on" | "no";

export type WireNeedClock = {
  code: "days_left" | "days_late" | "days_ago" | "waited" | "window" | "today" | "open" | "draft" | "lapsed" | "missing";
  n?: number;
  tone: NeedTone;
};

export type WireNeedFact = { k: string; raw?: true; v: string | number; as: "text" | "money" | "date" | "count" };

export type WireNeedRef = {
  kind:
    | "po" | "purchasePlan" | "grnDesk" | "bill" | "run" | "payRun" | "return" | "writeoff" | "recall" | "returnPlan"
    | "grn" | "retailLicence" | "cabinet" | "pharmacist";
  id: string | null;
};

export type WireNeedRow = {
  id: string;
  source: NeedSource;
  kind: string;
  params: Record<string, string | number>;
  clock: WireNeedClock;
  ref: WireNeedRef;
  facts: WireNeedFact[];
  tier: number;
};

export type WireOfficeNeeds = {
  rows: WireNeedRow[];
  sides: NeedSource[];
  money: { dueThisWeekPaise: number; overduePaise: number; msmeDueThisWeek: number } | null;
  copilot: {
    po: { orders: number; lines: number; unassigned: number; unmatched: number; alreadyDrafted: number } | null;
    pay: { vendors: number; bills: number; totalPaise: number; blocked: number; until: string; creditPaise: number; covered: number } | null;
    returns: { vendors: number; lines: number; taxablePaise: number; toDestroy: number; toDestroyValuePaise: number } | null;
  };
};

export const fetchOfficeNeeds = (): Promise<WireOfficeNeeds> => api("GET", "/pharmacy/office/needs");

/** The grants that open at least one side of the list — the screen shows Today only to their holders. */
export const NEEDS_GRANTS = [
  "materials.po.raise", "materials.bills.manage", "materials.returns.manage", "materials.grn.qc", "pharmacy.retail.manage",
  "pharmacy.ndps.custody", "pharmacy.licences.manage", "pharmacy.register.read", "pharmacy.pharmacists.manage",
] as const;
