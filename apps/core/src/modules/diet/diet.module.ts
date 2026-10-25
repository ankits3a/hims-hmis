import { Module } from "@nestjs/common";
import { DietController } from "./diet.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. The consumer and the meal clock are the WORKER's. */
@Module({ controllers: [DietController] })
export class DietModule {}
