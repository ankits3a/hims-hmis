import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { OpdMastersController } from "./opd-masters.controller";
import { OpdQueueController } from "./opd-queue.controller";
import { OpdVisitsController } from "./opd-visits.controller";
import { OPD_TOPIC_SPACES, opdTopicRouter } from "./realtime";

/**
 * The module tells the kernel gateway which topic prefixes exist (each with the permission a subscriber must
 * hold) and how an OPD event maps to topics. The kernel knows no module; registration happens at module init,
 * before the gateway's onApplicationBootstrap starts the tail.
 */
@Injectable()
class OpdRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}

  onModuleInit(): void {
    for (const s of OPD_TOPIC_SPACES) this.gateway.registerTopicSpace(s);
    this.gateway.registerRouter(opdTopicRouter);
  }
}

// Controllers + the realtime registrar. AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule.
@Module({
  imports: [RealtimeModule],
  controllers: [OpdMastersController, OpdVisitsController, OpdQueueController],
  providers: [OpdRealtimeRegistrar],
})
export class OpdModule {}
