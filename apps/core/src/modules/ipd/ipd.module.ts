import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { IpdBedsController } from "./beds.controller";
import { IPD_TOPIC_SPACES, ipdTopicRouter } from "./realtime";

/**
 * E1.1 (#718) — the inpatient module. Mounts the bed routes and registers the bed board's live topic. Guards are
 * the global AuthGuard/PermissionGuard (the LabModule shape): every route carries `@RequirePermission`.
 */
@Injectable()
class IpdRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}

  onModuleInit(): void {
    for (const space of IPD_TOPIC_SPACES) this.gateway.registerTopicSpace(space);
    this.gateway.registerRouter(ipdTopicRouter);
  }
}

@Module({
  imports: [RealtimeModule],
  controllers: [IpdBedsController],
  providers: [IpdRealtimeRegistrar],
})
export class IpdModule {}
