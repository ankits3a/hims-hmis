import { Inject, Injectable, Module, OnModuleInit } from "@nestjs/common";
import { CONFIG, DB } from "../../kernel/tokens";
import { MembershipController } from "./membership.controller";
import { warnIfBenefitsArmedWithoutBook } from "./boot-check";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * The membership module.
 *
 * THE CONTROLLER JOINS THE DECORATOR IN THE SAME COMMIT AS THE ROUTES IT SERVES (T1's own note):
 * T3 mounts recognition, card lookup and the O-1 grace-honor path; T5 extends the same controller
 * with the import and reconcile routes. Shipping an empty controller earlier would have put a route
 * surface into a deployment before anything guarded it.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02),
 * so a module that mounts a controller mounts its permission checks with it — which is why every
 * route below carries `@RequirePermission` and none carries a permission check of its own.
 */
/**
 * Warns at boot when `MEMBER_BENEFITS_ENABLED` is armed over an empty holder book — see
 * `boot-check.ts` for why that is the only place the failure can be observed, and why it warns
 * rather than refusing. The whole decision lives there; this class is the wire.
 *
 * A THROW HERE WOULD STOP THE API, so the read is wrapped: a boot-time advisory must not be able to
 * take the process down for the thing it is advising about.
 */
@Injectable()
class MemberBenefitsBootCheck implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await warnIfBenefitsArmedWithoutBook(this.db, this.cfg.memberBenefitsEnabled, {
        warn: (m) => { console.warn(`membership: ${m}`); },
      });
    } catch {
      // An advisory that cannot read the table says nothing; it does not stop the hospital.
    }
  }
}

@Module({ controllers: [MembershipController], providers: [MemberBenefitsBootCheck] })
export class MembershipModule {}
