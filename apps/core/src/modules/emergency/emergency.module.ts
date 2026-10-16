import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { EmergencyController } from "./emergency.controller";
import { EmergencyCopilotController } from "./copilot.controller";
import { ER_TOPIC_SPACES, erTopicRouter } from "./realtime";
import { registerErChargeSink, registerErEncounterResolver } from "./charge-sink";

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
    // Lane 3 (#810) — the `ER` episode prefix for the ordering door, and the ER charge sink (no invoice, no held report).
    registerErEncounterResolver();
    registerErChargeSink();
  }
}

@Module({
  imports: [RealtimeModule],
  // Lane 9 (#816): the copilot routes (`/er/copilot/*`) — the staff copilot's model config, reads and drafts only.
  controllers: [EmergencyController, EmergencyCopilotController],
  providers: [EmergencyRealtimeRegistrar],
})
export class EmergencyModule {}
