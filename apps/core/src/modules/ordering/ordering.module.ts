import { Module } from "@nestjs/common";
import { OrderingController } from "./ordering.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. The free-test order is the WORKER's consumer. */
@Module({ controllers: [OrderingController] })
export class OrderingModule {}
