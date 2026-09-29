import { NEEDS_GRANTS } from "../../lib/office-needs-api";
import type { OfficeView } from "./today";

/**
 * ═══ GAP-CLOSURE B3 — EVERY SCREEN, ONE MENU ═══
 *
 * The owner-approved Menu artboard (`docs/design/2026-09-28-pharmacy-office/Menu.dc.html`, 28 Sep
 * 2026): the fourteen "stores" nav leaves fold into the office's header menu. Each entry is a PAGE of
 * a side, addressed as `/pharmacy/office?view=<side>&page=<key>`, so a reload, a bookmark and
 * back/forward all land on it.
 *
 * `perms` is exactly the permission the entry's old nav row required (`router.tsx` NAV before B3), or
 * the grants the office's own side already checked; holding ANY of them shows the entry. `was` is the
 * address the screen had before, which now redirects here (`OFFICE_REDIRECTS`), shown grey in the menu
 * so a person who knew the old path finds it.
 *
 * Kept free of React so `router.tsx` can read the redirect map and the grant set without pulling the
 * screens in twice.
 */
export type OfficePage = { side: OfficeView; key: string; perms: readonly string[]; was: string | null };

export const OFFICE_PAGES: readonly OfficePage[] = [
  { side: "buy", key: "orders", perms: ["materials.po.raise"], was: null },
  { side: "buy", key: "reorder", perms: ["pharmacy.dispense.read"], was: "/pharmacy/reorder" },
  { side: "buy", key: "vendors", perms: ["materials.vendors.manage"], was: "/materials/vendors" },
  { side: "pay", key: "bills", perms: ["materials.bills.manage"], was: null },
  { side: "returns", key: "returns", perms: ["materials.returns.manage", "materials.writeoffs.manage", "materials.recall.manage"], was: null },
  { side: "stock", key: "grn", perms: ["materials.stock.read"], was: "/materials/grn" },
  { side: "stock", key: "opening", perms: ["materials.grn.capture"], was: "/materials/grn" },
  { side: "stock", key: "counts", perms: ["materials.counts.perform"], was: "/materials/counts" },
  { side: "stock", key: "transfers", perms: ["materials.stock.read"], was: "/materials/transfers" },
  { side: "stock", key: "ledger", perms: ["materials.stock.read"], was: null },
  { side: "stock", key: "downtime", perms: ["pharmacy.downtime.enter"], was: "/pharmacy/downtime" },
  // Stage D3 / D4 — the fridge log and the emergency trays.
  { side: "stock", key: "cold", perms: ["pharmacy.coldchain.record", "pharmacy.coldchain.manage"], was: null },
  { side: "stock", key: "trays", perms: ["pharmacy.trays.check", "pharmacy.trays.manage"], was: null },
  { side: "items", key: "master", perms: ["materials.items.manage"], was: "/materials/items" },
  { side: "items", key: "sells", perms: ["pharmacy.sale_items.manage"], was: "/pharmacy/items" },
  { side: "items", key: "formulary", perms: ["formulary.manage"], was: "/formulary/admin" },
  { side: "items", key: "duplicates", perms: ["materials.items.merge"], was: null },
  { side: "items", key: "labels", perms: ["pharmacy.sale_items.manage"], was: null },
  { side: "law", key: "h1", perms: ["pharmacy.register.read"], was: "/pharmacy/registers/h1" },
  { side: "law", key: "controlled", perms: ["pharmacy.ndps.custody", "pharmacy.licences.manage", "pharmacy.register.read"], was: null },
  { side: "law", key: "retail", perms: ["pharmacy.retail.manage"], was: "/pharmacy/retail-licence" },
  { side: "law", key: "pharmacists", perms: ["pharmacy.pharmacists.manage"], was: "/pharmacy/pharmacists" },
  { side: "law", key: "messages", perms: ["pharmacy.messages.manage"], was: null },
  // Stage D1 / D2 — the ADR register (PvPI) and the medication error and near-miss log.
  { side: "law", key: "adr", perms: ["pharmacy.adr.record", "pharmacy.adr.manage"], was: null },
  { side: "law", key: "incidents", perms: ["pharmacy.incidents.record", "pharmacy.incidents.review"], was: null },
  { side: "reports", key: "reports", perms: ["pharmacy.reports.read"], was: null },
];

/**
 * The old address of every folded screen → its page in the office. `/materials/grn` lands on the
 * goods receipt, whose screen also carries the opening-stock sheet.
 */
export const OFFICE_REDIRECTS: Readonly<Record<string, { view: OfficeView; page: string }>> = {
  "/pharmacy/reorder": { view: "buy", page: "reorder" },
  "/materials/vendors": { view: "buy", page: "vendors" },
  "/materials/grn": { view: "stock", page: "grn" },
  "/materials/counts": { view: "stock", page: "counts" },
  "/materials/transfers": { view: "stock", page: "transfers" },
  "/pharmacy/downtime": { view: "stock", page: "downtime" },
  "/materials/items": { view: "items", page: "master" },
  "/pharmacy/items": { view: "items", page: "sells" },
  "/formulary/admin": { view: "items", page: "formulary" },
  "/pharmacy/registers/h1": { view: "law", page: "h1" },
  "/pharmacy/retail-licence": { view: "law", page: "retail" },
  "/pharmacy/pharmacists": { view: "law", page: "pharmacists" },
};

/**
 * Every grant that shows the person at least one side or entry — the office's nav row is offered to a
 * holder of ANY of these (a pharmacist whose only reach is the H1 register or the pharmacists' list
 * still gets the office), never to anybody else.
 */
export const OFFICE_GRANTS: readonly string[] = [...new Set([...NEEDS_GRANTS, ...OFFICE_PAGES.flatMap((p) => p.perms)])];

/** The board's key for each side that has a menu (Menu artboard). Today has none. */
export const SIDE_KEYS: Readonly<Partial<Record<OfficeView, string>>> = {
  buy: "B", pay: "Y", returns: "R", stock: "S", items: "I", law: "L", reports: "P",
};
