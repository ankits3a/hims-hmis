import { Module } from "@nestjs/common";
import { StoresController } from "./stores.controller";

/**
 * STORES S1 (#1111) — the Stores module's Nest wiring. App-only: it subscribes to nothing and runs no job,
 * so it is not in `worker.module.ts` (the `aerb` shape). S3's chaser and S7's planner will change that.
 */
@Module({
  controllers: [StoresController],
})
export class StoresModule {}
