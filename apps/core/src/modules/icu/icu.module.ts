import { Module } from "@nestjs/common";
import { IcuController } from "./icu.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. The ICU clock is the WORKER's (`sweepIcuAlarms`). */
@Module({ controllers: [IcuController] })
export class IcuModule {}
