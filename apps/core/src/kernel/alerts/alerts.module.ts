import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../realtime/gateway";
import { RealtimeModule } from "../realtime/realtime.module";
import { AlertsController } from "./alerts.controller";
import { RemindersController } from "../reminders/reminders.controller";
import { alertsTopicRouter, alertsTopicSpace } from "./realtime";

/**
 * Same shape as `OpdRealtimeRegistrar`: the owner of the topics tells the kernel gateway which
 * prefixes exist and how its events map to topics, at module init — before the gateway's
 * onApplicationBootstrap starts the tail. The kernel gateway knows nothing about alerts.
 */
@Injectable()
class AlertsRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}

  onModuleInit(): void {
    this.gateway.registerTopicSpace(alertsTopicSpace);
    this.gateway.registerRouter(alertsTopicRouter);
  }
}

// Guards are NOT registered here — AuthGuard and PermissionGuard are global APP_GUARDs
// registered once by AuthModule (order load-bearing, Plan 02).
@Module({
  imports: [RealtimeModule],
  // E1.2 — personal reminders ride here: a fired reminder IS a bell row of its person's, and mounting
  // them in the bell's module keeps app.module.ts (a file every lane shares) untouched.
  controllers: [AlertsController, RemindersController],
  providers: [AlertsRealtimeRegistrar],
})
export class AlertsModule {}
