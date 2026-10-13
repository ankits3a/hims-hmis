import { Module } from "@nestjs/common";
import { PassesController } from "./passes.controller";

/** E1.3 (#720) — the passes routes. Guards are the global AuthGuard/PermissionGuard; every route names its permission. */
@Module({ controllers: [PassesController] })
export class PassesModule {}
