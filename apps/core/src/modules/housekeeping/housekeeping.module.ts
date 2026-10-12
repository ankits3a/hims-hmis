import { Module } from "@nestjs/common";
import { HousekeepingController } from "./housekeeping.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. The bed subscription is the WORKER's. */
@Module({ controllers: [HousekeepingController] })
export class HousekeepingModule {}
