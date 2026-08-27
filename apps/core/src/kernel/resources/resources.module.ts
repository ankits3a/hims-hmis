import { Module } from "@nestjs/common";
import { ResourcesController } from "./resources.controller";

/**
 * PLAN 13 T2 — the Nest module, installed by `app.module.ts`. **T5 HAS NOW MOUNTED
 * `ResourcesController` ON IT, and added NOTHING ELSE** — the enumerated-addition discipline
 * (§2.72), and the whole of T5's change to this file is one import and one array entry.
 *
 * AuthGuard and PermissionGuard are global
 * `APP_GUARD`s registered ONCE by `AuthModule` and their order is load-bearing (Plan 02):
 * registering either here would run a second permission check against a request whose actor the
 * first guard has not attached. `ops.module.ts` says so in as many words and is the shape to copy.
 *
 * No providers either: the registry's write and read surfaces are plain functions over an injected
 * `Db`/`Tx`, which is `@Global` from `AppModule` — the `OpsModule` shape, unchanged.
 */
@Module({ controllers: [ResourcesController] })
export class ResourcesModule {}
