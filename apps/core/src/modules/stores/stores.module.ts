import { Module } from "@nestjs/common";
import { StoresAssetsController } from "./assets.controller";
import { StoresBuyerAgentController } from "./buyer-agent.controller";
import { StoresBuyingController } from "./buying.controller";
import { StoresBuyingDeskController } from "./buying-desk.controller";
import { StoresPayingController } from "./paying.controller";
import { StoresPlannerController } from "./planner.controller";
import { StoresController } from "./stores.controller";
import { registerStoresPrinting } from "./voucher";
import type { OnModuleInit } from "@nestjs/common";

/**
 * STORES S1 (#1111) — the Stores module's Nest wiring. App-only: it subscribes to nothing and runs no job,
 * so it is not in `worker.module.ts` (the `aerb` shape). S3's chaser and S7's planner will change that.
 * S2b (#1112): the issue voucher's renderer is registered here (the billing refund voucher's shape).
 */
@Module({
  // S4a (#1114): `/stores/assets/*` is its own controller (the passport), declared before nothing else under /stores.
  // S5a (#1115): the buying desk's front (`buying.controller.ts`); its paths do not overlap the other two.
  // S5b (#1115): the buying desk by hand (`buying-desk.controller.ts`): groups, RFQs, quotes, awards, committee, POs from awards.
  // S5c (#1115): the buyer agent's drafts, the quote PDF reader, the scorecard, exceptions, advances (`buyer-agent.controller.ts`).
  // S6a (#1116): the paying desk (`paying.controller.ts`, `/stores/pay/*`); it also loads the service-entry reader and the
  // payment-hold hooks materials asks (`service-entries.ts`, `holds.ts`, registered at import).
  // S7 (#1117): the stock planner (`planner.controller.ts`, `/stores/planner/*`).
  controllers: [
    StoresController, StoresAssetsController, StoresBuyingController, StoresBuyingDeskController, StoresBuyerAgentController, StoresPayingController,
    StoresPlannerController,
  ],
})
export class StoresModule implements OnModuleInit {
  onModuleInit(): void {
    registerStoresPrinting();
  }
}
