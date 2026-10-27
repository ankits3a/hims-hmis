/**
 * CN-1 CANTEEN (#977, decision 0088) — the permission strings, in one leaf file so manifest, intents and doors import no
 * cycle. Who holds them: `scripts/seed-roles.ts` and the README's "Canteen" prose.
 *   canteen.sell     the counter till: open, sell, close; confirm a bed order; ask for a family meal (canteen_cashier)
 *   canteen.manage   outlets, tills, menu, prices, cost centres, free-meal rules, bed-class meals, bed QRs (canteen_manager)
 *   canteen.finance  staff meal rules and cards, the variance approval, rent invoices, the deduction list and the
 *                    month's figures; decides family meals on the approvals engine (billing_manager)
 *   canteen.view     the day's tills and the menu (cashier, manager, finance)
 */
export const CANTEEN_SELL = "canteen.sell";
export const CANTEEN_MANAGE = "canteen.manage";
export const CANTEEN_FINANCE = "canteen.finance";
export const CANTEEN_VIEW = "canteen.view";
export const CANTEEN_PERMISSIONS = [CANTEEN_SELL, CANTEEN_MANAGE, CANTEEN_FINANCE, CANTEEN_VIEW] as const;
export const CANTEEN_CASHIER_ROLE = "canteen_cashier";
export const CANTEEN_MANAGER_ROLE = "canteen_manager";
