import { Module } from "@nestjs/common";
import { TransportController } from "./transport.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. No subscription, no worker job. */
@Module({ controllers: [TransportController] })
export class TransportModule {}
