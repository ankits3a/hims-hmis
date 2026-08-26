import { Module } from "@nestjs/common";

/**
 * PLAN 13 T2 — the Nest module, installed by `app.module.ts` with NO CONTROLLER YET. T5 mounts
 * `ResourcesController` on it; this commit exists so the install order lands once rather than
 * twice, which is the `MembershipModule` / `PartnersModule` precedent from Plan 09 T1 exactly.
 *
 * **When T5 adds the controller, it adds NOTHING ELSE.** AuthGuard and PermissionGuard are global
 * `APP_GUARD`s registered ONCE by `AuthModule` and their order is load-bearing (Plan 02):
 * registering either here would run a second permission check against a request whose actor the
 * first guard has not attached. `ops.module.ts` says so in as many words and is the shape to copy.
 *
 * No providers either: the registry's write and read surfaces are plain functions over an injected
 * `Db`/`Tx`, which is `@Global` from `AppModule` — the `OpsModule` shape, unchanged.
 */
@Module({})
export class ResourcesModule {}
