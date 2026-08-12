import { Inject, Module, OnModuleInit } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DB, MODULE_REGISTRY } from "../tokens";
import { AuthController } from "./auth.controller";
import { AuthGuard, PermissionGuard } from "./guards";
import { syncPermissions } from "./permissions";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

@Module({
  controllers: [AuthController],
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
  }
}
