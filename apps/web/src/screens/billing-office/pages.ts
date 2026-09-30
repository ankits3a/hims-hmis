/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE BILLING OFFICE'S HEADER MENU ═══
 *
 * The approved billing back office board (docs/design/2026-09-28-ux-audit/billing-back-office.html,
 * artboard 3): the five filter-style tabs are gone; the header carries Today and six sides, each side a
 * menu of pages. A page is addressed `/billing/office?view=<side>&page=<key>`, so a reload, a bookmark
 * and back/forward land on it. The old tab state — `?tab=refunds|recon|daybook|gstr1|orphans` — redirects
 * to the page that replaced it (`OLD_TABS`).
 *
 * The office holds no permission model of its own (the old screen's rule, kept): every page is listed
 * and the server refuses what the person may not do, in its own words.
 */
export type OfficeView = "today" | "refunds" | "receipts" | "recon" | "daybook" | "gstr1" | "unbilled";
export type OfficePage = { side: Exclude<OfficeView, "today">; key: string };

export const MENU: readonly OfficeView[] = ["today", "refunds", "receipts", "recon", "daybook", "gstr1", "unbilled"];

export const OFFICE_PAGES: readonly OfficePage[] = [
  { side: "refunds", key: "pay" },
  { side: "refunds", key: "request" },
  { side: "refunds", key: "waiting" },
  { side: "refunds", key: "all" },
  { side: "receipts", key: "void" },
  { side: "receipts", key: "paper" },
  { side: "recon", key: "upload" },
  { side: "recon", key: "mismatches" },
  { side: "daybook", key: "daybook" },
  { side: "gstr1", key: "gstr1" },
  { side: "unbilled", key: "unbilled" },
];

/** The board's keys for each side (artboard 3). */
export const SIDE_KEYS: Readonly<Partial<Record<OfficeView, string>>> = {
  refunds: "R", receipts: "V", recon: "C", daybook: "D", gstr1: "G", unbilled: "U",
};

/** The five tabs the office had before the board → the page that replaced each. */
export const OLD_TABS: Readonly<Record<string, { view: OfficeView; page: string }>> = {
  refunds: { view: "refunds", page: "pay" },
  recon: { view: "recon", page: "mismatches" },
  daybook: { view: "daybook", page: "daybook" },
  gstr1: { view: "gstr1", page: "gstr1" },
  orphans: { view: "unbilled", page: "unbilled" },
};

export function pagesOf(side: OfficeView): OfficePage[] {
  return OFFICE_PAGES.filter((p) => p.side === side);
}
