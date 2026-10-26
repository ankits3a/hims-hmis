import { Module } from "@nestjs/common";
import { CanteenBedController, CanteenController } from "./canteen.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs; the bed page's doors are `@Public()`. */
@Module({ controllers: [CanteenController, CanteenBedController] })
export class CanteenModule {}
