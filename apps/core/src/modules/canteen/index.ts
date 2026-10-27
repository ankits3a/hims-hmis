/** CN-1 CANTEEN (issue #977, decision 0088) — other modules import this one only through here (lint-enforced). */
export { canteenManifest } from "./manifest";
export {
  CANTEEN_CASHIER_ROLE, CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_MANAGER_ROLE, CANTEEN_PERMISSIONS, CANTEEN_SELL, CANTEEN_VIEW,
} from "./names";
export { CanteenModule } from "./canteen.module";
export { CanteenRefusal, canteenHttpStatus } from "./errors";
export {
  bedClassMealsPerDay, createCostCentre, createDish, createFreeRule, createOutlet, createStaffCategory, createTill, dishesOf, issueStaffCard,
  setBedClassMeals, setDishPrice, setStaffRule,
} from "./setup";
export type { DishView } from "./setup";
export { staffCardQr } from "./staff-card";
export { approveVariance, closeTill, getSale, openTill, sell } from "./sales";
export { bedMenu, cancelStaleBedOrders, confirmBedOrder, issueBedQr, placeBedOrder } from "./bed-qr";
export type { BedOrderContext } from "./bed-qr";
export { charityGrant, requestCharity } from "./charity";
export { CANTEEN_CHARITY_APPROVAL, registerCanteenApprovalTypes } from "./approval-types";
export { issueRentInvoice } from "./rent";
export { canteenDay, canteenMonthIncome, deductionsCsv, staffDeductions } from "./reads";
export { seedCanteenBasics } from "./seed";
