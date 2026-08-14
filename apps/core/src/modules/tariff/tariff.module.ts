import { Module } from "@nestjs/common";
import { TariffController } from "./tariff.controller";

// Controller only — AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02).
@Module({ controllers: [TariffController] })
export class TariffModule {}
