import { Module } from "@nestjs/common";
import { LinenController } from "./linen.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. No worker job: the weekly variance is read. */
@Module({ controllers: [LinenController] })
export class LinenModule {}
