import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { IpdAdmissionsController } from "./admissions.controller";
import { IpdBedsController } from "./beds.controller";
import { registerIpdRefundVoucherGuard } from "./bill-void";
import { IpdBillDeskController } from "./billdesk.controller";
import { IpdChargesController } from "./charges.controller";
import { registerIpdReceiptGuard } from "./deposit";
import { registerIpdAdvanceRefundListener } from "./deposit-ladder";
import { IpdPayerController } from "./payer.controller";
import { IpdTransfersController } from "./transfers.controller";
import { IpdDischargeController } from "./discharge.controller";
import { IpdFamilyController } from "./family.controller";
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
    // E2.3 (#727, review 7) — an advance refund re-checks the deposit ladder of the patient's open admission.
    registerIpdAdvanceRefundListener();
    // #763 — a refund a bill void cancelled never issues its voucher (billing's voucher guard seam).
    registerIpdRefundVoucherGuard();
  }
}

@Module({
  imports: [RealtimeModule],
  controllers: [IpdBedsController, IpdAdmissionsController, IpdChargesController, IpdPayerController, IpdTransfersController, IpdDischargeController, IpdBillDeskController, IpdFamilyController],
  providers: [IpdRealtimeRegistrar],
})
export class IpdModule {}
