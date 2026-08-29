import { Module } from "@nestjs/common";
import { DeskController } from "./desk.controller";
import { StaffController } from "./staff.controller";

/**
 * Controller only, matching `SearchModule`: the global `APP_GUARD`s registered by `AuthModule` do
 * the authentication, `Db` and the module registry are `@Global` from `AppModule`, and the
 * composition is a plain function over them — there is nothing to provide here.
 */
@Module({ controllers: [DeskController, StaffController] })
export class DeskModule {}
