import { Module } from "@nestjs/common";
import { PatientsController } from "./patients.controller";

// Controller only — AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02).
@Module({ controllers: [PatientsController] })
export class PatientsModule {}
