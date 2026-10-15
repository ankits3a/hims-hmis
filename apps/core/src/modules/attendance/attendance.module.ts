import { Inject, Module } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { CONFIG } from "../../kernel/tokens";
import { AttendanceController } from "./attendance.controller";
import { MeIdentityController } from "./me-identity.controller";
import { describeAttendance } from "./secrets";
import { UsersIdentityController } from "./users-identity.controller";
import { BioattendWebhookController } from "./webhook.controller";
import type { AppConfig } from "../../kernel/config";

/**
 * Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs from AuthModule. The read
 * routes, the two Users-screen routes, the person's own "Add your Aadhaar" pair (`/me/identity`) and
 * the webhook (public to user auth, signed instead).
 * The sync itself is the WORKER's job (`syncAttendance`, `kernel/worker/jobs.ts`), not this module's.
 */
@Module({ controllers: [UsersIdentityController, MeIdentityController, AttendanceController, BioattendWebhookController] })
export class AttendanceModule implements OnModuleInit {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  /** One line at boot, so "attendance: not configured" is something an operator can read rather than infer. */
  onModuleInit(): void {
    console.log(describeAttendance(this.cfg.attendance));
  }
}
