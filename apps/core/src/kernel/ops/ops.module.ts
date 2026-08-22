import { Module } from "@nestjs/common";
import { OpsController } from "./ops.controller";

/**
 * Controller only. AuthGuard and PermissionGuard are global APP_GUARDs registered ONCE by
 * AuthModule and their order is load-bearing (Plan 02) — registering either here would run a
 * second permission check against a request whose actor the first guard had not yet attached.
 * `TariffModule` and `AlertsModule` are the shipped precedents for this exact shape.
 *
 * No providers: `runConfigValidation` and the mode service are plain functions over the injected
 * `Db`, which is `@Global` from `AppModule`. T3 and T4 add nothing here either — their routes join
 * the one controller.
 */
@Module({ controllers: [OpsController] })
export class OpsModule {}
