import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { IpdAdmissionsController } from "./admissions.controller";
import { IpdBedsController } from "./beds.controller";
import { registerIpdReceiptGuard } from "./deposit";
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
    // E1.2 review RED 3 — a ₹0 scheme inpatient is refused money on EVERY receipt route (billing's seam).
    registerIpdReceiptGuard();
  }
}

@Module({
  imports: [RealtimeModule],
  controllers: [IpdBedsController, IpdAdmissionsController],
  providers: [IpdRealtimeRegistrar],
})
export class IpdModule {}
