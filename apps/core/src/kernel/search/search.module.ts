import { Module } from "@nestjs/common";
import { SearchController } from "./search.controller";

/**
 * Controller only, matching `OpsModule`/`TariffModule`/`AlertsModule`: AuthGuard and
 * PermissionGuard are global `APP_GUARD`s registered ONCE by `AuthModule` and their order is
 * load-bearing (Plan 02). `Db` and the module registry are `@Global` from `AppModule`, and the
 * fan-out is a plain function over them — there is nothing to provide here.
 */
@Module({ controllers: [SearchController] })
export class SearchModule {}
