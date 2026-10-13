import type { Actor } from "@hmis/contracts";

/** The module's names, in one leaf file so the manifest, the kinds and the consumer import no cycle. */
export const DIET_VIEW = "diet.view";
export const DIET_ORDER = "diet.order";
export const DIET_NPO = "diet.npo";
export const DIET_SERVE = "diet.serve";
export const DIET_KITCHEN = "diet.kitchen";
export const DIET_MANAGE = "diet.manage";
export const DIET_PERMISSIONS = [DIET_VIEW, DIET_ORDER, DIET_NPO, DIET_SERVE, DIET_KITCHEN, DIET_MANAGE] as const;

/** The worker's consumer for IPD's admission events and OT's booking events (`workerConsumers`). */
export const DIET_CONSUMER = "diet.reconcile";
/** Who builds the lists at the cut-off, and who acts on an event's behalf. */
export const DIET_ACTOR: Actor = { type: "system", id: "diet-kitchen" };

/** The two new roles (scripts/seed-roles.ts): the dietician and the kitchen's food-service staff. */
export const DIETICIAN_ROLE = "dietician";
export const KITCHEN_ROLE = "kitchen_staff";

/** IPD's events diet listens to (contract names; `diet.test.ts` holds them equal to IPD's exports). */
export const IPD_ADMITTED_EVENT = "ipd.admission.admitted";
export const IPD_BED_SWAPPED_EVENT = "ipd.bed.swapped";
/** OT's events (`modules/ot/events.ts`): a booking sets NPO for the surgery day; a cancellation lifts it. */
export const OT_BOOKED_EVENT = "daycare.booked";
export const OT_CANCELLED_EVENT = "case.cancelled";
