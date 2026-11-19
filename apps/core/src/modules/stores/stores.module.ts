import { Module } from "@nestjs/common";
import { StoresAssetsController } from "./assets.controller";
import { StoresBuyingController } from "./buying.controller";
import { StoresBuyingDeskController } from "./buying-desk.controller";
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
  controllers: [StoresController, StoresAssetsController, StoresBuyingController, StoresBuyingDeskController],
})
export class StoresModule implements OnModuleInit {
  onModuleInit(): void {
    registerStoresPrinting();
  }
}
