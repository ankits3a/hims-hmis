/**
 * E4.4 DIET (issue #736, decision 0072) — other modules import this one only through here (lint-enforced).
 * Importing it DEFINES diet's task kinds and skill (`./kinds`), which both the API and the worker need.
 */
import "./kinds";
export { dietManifest } from "./manifest";
export {
  DIETICIAN_ROLE, DIET_ACTOR, DIET_CONSUMER, DIET_KITCHEN, DIET_MANAGE, DIET_NPO, DIET_ORDER, DIET_PERMISSIONS, DIET_SERVE, DIET_VIEW,
  DIET_CLINICAL_VIEW, KITCHEN_ROLE,
} from "./names";
export { DIET_DELIVERY_TASK, DIET_WARD_NOTICE_TASK, DIET_WARD_SKILL } from "./kinds";
export { DietModule } from "./diet.module";
export { DietRefusal, dietHttpStatus } from "./errors";
export { DIET_EVENTS } from "./events";
export { backfillOtNpo, dietConsumer, handleDietEvent } from "./consumer";
export { buildDueLists, buildLists, buildSlot, dispatchList, markPrinted, serveLine } from "./lists";
export { completeConsult, endStay, liftNpo, liftOtNpo, npoForOtBooking, orderDiet, syncOtNpo, requestConsult, setMealRound, startNpo } from "./orders";
export { consultQueue, dietWards, kitchenBoard, readList, wardSheet } from "./reads";
export { dueSlots, istDayStart, mealRounds, nextSlot, slotOf } from "./rounds";
export type { MealSlot } from "./rounds";
export { npoCovering, reconcileAdmission, trayFor } from "./trays";
export { dietConsultsCard } from "./desk";
