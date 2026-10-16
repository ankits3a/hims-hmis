import { Module } from "@nestjs/common";
import { MaintenanceController } from "./maintenance.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. No subscription, no job. */
@Module({ controllers: [MaintenanceController] })
export class MaintenanceModule {}
