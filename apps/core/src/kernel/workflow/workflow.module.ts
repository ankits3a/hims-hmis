import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";

// Guards are NOT registered here — AuthGuard and PermissionGuard are global APP_GUARDs
// registered once by AuthModule (order load-bearing, Plan 02).
@Module({ controllers: [WorkflowController] })
export class WorkflowModule {}
