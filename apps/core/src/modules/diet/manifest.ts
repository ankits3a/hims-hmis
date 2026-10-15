import { dietConsultsCard } from "./desk";
import { IPD_ADMISSION_ENDED_EVENT_NAMES, IPD_TRANSFER_ACCEPTED_EVENT_NAME } from "../ipd";
import {
  DIET_CLINICAL_VIEW, DIET_CONSUMER, DIET_KITCHEN, DIET_MANAGE, DIET_NPO, DIET_ORDER, DIET_SERVE, DIET_VIEW, IPD_ADMITTED_EVENT, IPD_BED_SWAPPED_EVENT,
  OT_BOOKED_EVENT, OT_CANCELLED_EVENT, OT_LIST_PUBLISHED_EVENT, OT_POSTPONED_EVENT,
} from "./names";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E4.4 DIET (#736, decision 0072) — six permissions (who holds them: `scripts/seed-roles.ts`, README "Diet and
 * kitchen" prose):
 *   diet.view     the ward diet sheet and the kitchen board (doctor, nurse, dietician, kitchen staff)
 *   diet.order    order a diet (doctor, dietician)
 *   diet.npo      set or lift NPO — a safety act a nurse may make (nurse, doctor, dietician)
 *   diet.serve    tap a tray delivered or refused at the bed (nurse, ward attendant, dietician)
 *   diet.kitchen  build, print and dispatch the meal lists (kitchen staff, dietician)
 *   diet.manage   the meal rounds' cut-offs and the consult queue (dietician)
 *   diet.clinical.view  the order note, the NPO reason and who set them (doctor, dietician; ward nurses at integration)
 *
 * ONE CONSUMER, `diet.reconcile`, INSTALLED IN BOTH PROCESSES (the passes shape): IPD's admitted, transfer accepted,
 * bed swapped and four stay-ending events, and OT's booking, cancellation and list publication. Its handler is `workerConsumers`'
 * `diet.reconcile` entry, landed in the same commit; `seedCursors` seeds its cursor at `max(seq)` on deploy.
 * The meal clock (lists built at the cut-off) rides the worker's task-clock tick (`kernel/worker/jobs.ts`).
 */
export const dietManifest: ModuleManifest = {
  key: "diet",
  title: "Diet and kitchen",
  menu: [
    { label: "Diet sheet", path: "/diet/ward", permission: DIET_VIEW },
    { label: "Kitchen", path: "/diet/kitchen", permission: DIET_KITCHEN },
    { label: "Diet consults", path: "/diet/consults", permission: DIET_MANAGE },
  ],
  permissions: [DIET_VIEW, DIET_ORDER, DIET_NPO, DIET_SERVE, DIET_KITCHEN, DIET_MANAGE, DIET_CLINICAL_VIEW],
  subscriptions: [
    { event: IPD_ADMITTED_EVENT, consumer: DIET_CONSUMER },
    { event: IPD_TRANSFER_ACCEPTED_EVENT_NAME, consumer: DIET_CONSUMER },
    { event: IPD_BED_SWAPPED_EVENT, consumer: DIET_CONSUMER },
    ...IPD_ADMISSION_ENDED_EVENT_NAMES.map((event) => ({ event, consumer: DIET_CONSUMER })),
    { event: OT_BOOKED_EVENT, consumer: DIET_CONSUMER },
    { event: OT_CANCELLED_EVENT, consumer: DIET_CONSUMER },
    { event: OT_LIST_PUBLISHED_EVENT, consumer: DIET_CONSUMER },
    { event: OT_POSTPONED_EVENT, consumer: DIET_CONSUMER },
  ],
  desk: [
    // The dietician's Now card: consults waiting, oldest first (no money; alias for a sealed patient).
    { key: "diet.consults", permission: DIET_MANAGE, load: async (ctx) => dietConsultsCard(ctx) },
  ],
};
