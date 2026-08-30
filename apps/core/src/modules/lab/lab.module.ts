import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { LabBenchController } from "./lab-bench.controller";
import { LabCatalogueController } from "./lab-catalogue.controller";
import { LabCollectionController } from "./lab-collection.controller";
import { LabDeskController } from "./lab-desk.controller";
import { LabVerifyController } from "./lab-verify.controller";
import { LAB_TOPIC_SPACES, labTopicRouter } from "./realtime";

/**
 * The laboratory module.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02), so
 * mounting a controller here mounts its permission checks with it — which is why every route T8
 * adds carries `@RequirePermission` and none carries a check of its own. The `OtModule` and
 * `MaterialsModule` shape.
 *
 * **T8 mounts the five controllers T2 declared this module would wait for**, and
 * `test/lab.e2e.test.ts` walks a refusal from every error family through them so `labHttpStatus` is
 * EXECUTED rather than asserted — the 500-escape specimen this repository has shipped three times.
 *
 * **It registers no encounter resolver**, and that is not an omission. The lab owns no encounter
 * letter: its walk-in is a `V` visit that OPD's resolver already answers (DD15, phase 0 E9), and
 * `openLabWalkin` lives in `modules/opd/encounters.ts` for exactly that reason — the module that
 * owns `V` mints `V`.
 */
@Injectable()
class LabRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}

  onModuleInit(): void {
    for (const space of LAB_TOPIC_SPACES) this.gateway.registerTopicSpace(space);
    this.gateway.registerRouter(labTopicRouter);
  }
}

@Module({
  imports: [RealtimeModule],
  controllers: [
    LabCatalogueController, LabDeskController, LabCollectionController, LabBenchController,
    LabVerifyController,
  ],
  providers: [LabRealtimeRegistrar],
})
export class LabModule {}
