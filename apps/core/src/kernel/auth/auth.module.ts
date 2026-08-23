import { Inject, Module, OnModuleInit } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DB, MODULE_REGISTRY } from "../tokens";
import { AuthController } from "./auth.controller";
import { UsersAdminController } from "./users-admin.controller";
import { RolesAdminController } from "./roles-admin.controller";
import { AuthGuard, PermissionGuard } from "./guards";
import { syncPermissions } from "./permissions";
import { seedSodPairs } from "./sod";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

@Module({
  // PLAN 11e T3/T4 — the two admin controllers. They are SPLIT rather than folded into
  // `AuthController` so that each dead permission string finally guards exactly the surface its
  // name claims: `auth.users.manage` on `/admin/users*`, `auth.roles.manage` on the role routes.
  // One controller carrying both would make the route→permission map a matter of reading
  // decorators one at a time, which is the shape §3.42's defect hid in.
  controllers: [AuthController, UsersAdminController, RolesAdminController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },       // runs first: identity
    { provide: APP_GUARD, useClass: PermissionGuard }, // runs second: RBAC
  ],
})
export class AuthModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await syncPermissions(this.db, this.registry);
    await seedSodPairs(this.db);
  }
}
