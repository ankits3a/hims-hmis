import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { EmergencyController } from "./emergency.controller";
import { ER_TOPIC_SPACES, erTopicRouter } from "./realtime";

/**
 * ER lane 1 (#808) — the emergency module. Mounts the ER routes and registers the board's live topic. Guards are the
 * global AuthGuard/PermissionGuard: every route carries `@RequirePermission`. No worker job of its own: the pre-alert
 * lapse rides the bed-reservation minute job (`kernel/worker/jobs.ts`).
 */
@Injectable()
class EmergencyRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}

  onModuleInit(): void {
    for (const space of ER_TOPIC_SPACES) this.gateway.registerTopicSpace(space);
    this.gateway.registerRouter(erTopicRouter);
  }
}

@Module({
  imports: [RealtimeModule],
  controllers: [EmergencyController],
  providers: [EmergencyRealtimeRegistrar],
})
export class EmergencyModule {}
